import { describe, expect, it, vi } from "vitest";
import { prepareWriteProbeCanary } from "@agentic/shared";
import type {
  ToolWriteProbeExecutionContext,
  ToolWriteProbeLifecycleInput,
} from "@agentic/agent-kit";
import {
  createPostgresExecuteStatementWriteProbeLifecycle,
  executePostgresStatement,
  postgresWriteProbeStatementCatalog,
  POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY,
  type PostgresExecuteOptions,
} from "./execute-statement";
import {
  createPostgresExecuteTransactionWriteProbeLifecycle,
  executePostgresTransaction,
  POSTGRES_EXECUTE_TRANSACTION_PROBE_SAFETY,
  type PostgresTransactionOptions,
} from "./execute-transaction";

type QueryInput = string | {
  name?: string;
  text: string;
  values?: unknown[];
  query_timeout?: number;
};

const operations = {
  create: "agentFactoryProbe.create",
  readback: "agentFactoryProbe.readback",
  cleanup: "agentFactoryProbe.cleanup",
} as const;

const probeNamespace = "agent_factory_probe_test";
const probeCatalog = postgresWriteProbeStatementCatalog({
  namespace: probeNamespace,
  createOperation: operations.create,
  readbackOperation: operations.readback,
  cleanupOperation: operations.cleanup,
});

const env = {
  BUSINESS_PG_URL: "postgres://business:secret@business.example.test/app",
  BUSINESS_PG_STATEMENTS: JSON.stringify({
    "business.read": {
      sql: "SELECT $1::text AS value",
      params: ["value"],
      mode: "read",
      max_rows: 1,
    },
  }),
  PROBE_PG_URL: "postgres://probe:secret@probe.example.test/canaries",
  PROBE_PG_STATEMENTS: JSON.stringify(probeCatalog),
};

const config = {
  connection_url_env: "BUSINESS_PG_URL",
  statement_catalog_env: "BUSINESS_PG_STATEMENTS",
  allow_write: true,
  write_probe_connection_url_env: "PROBE_PG_URL",
  write_probe_statement_catalog_env: "PROBE_PG_STATEMENTS",
  write_probe_namespace: probeNamespace,
  write_probe_create_operation: operations.create,
  write_probe_readback_operation: operations.readback,
  write_probe_cleanup_operation: operations.cleanup,
};

const execution: ToolWriteProbeExecutionContext = {
  agentName: "agent-factory-probe",
  actionName: "postgres.executeStatement",
  correlationId: "probe:0123456789ab",
  tenantSlug: "tenant-domain-probe-scope",
  eventName: "probe:postgres.executeStatement",
};

function canaryArgs(
  safety: typeof POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY
    | typeof POSTGRES_EXECUTE_TRANSACTION_PROBE_SAFETY,
  args: Record<string, unknown>,
) {
  const prepared = prepareWriteProbeCanary({
    args,
    contract: safety,
    seed: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  });
  if (!prepared.ok) throw new Error(prepared.reason);
  return prepared.canary;
}

function databaseHarness() {
  const rows = new Map<string, Record<string, unknown>>();
  const connectionStrings: string[] = [];
  const statements: string[] = [];
  let maximumRows = 0;
  let insertCalls = 0;

  const poolFactory = vi.fn((poolConfig: { connectionString: string }) => {
    connectionStrings.push(poolConfig.connectionString);
    return {
      async connect() {
        return {
          async query(input: QueryInput) {
            const text = typeof input === "string" ? input : input.text;
            statements.push(text);
            if (/^(?:BEGIN|COMMIT|ROLLBACK)(?:\s|$)/.test(text)) {
              return { command: text.split(/\s/)[0], rowCount: 0, rows: [] };
            }
            const values = typeof input === "string" ? [] : input.values ?? [];
            const [namespace, target, marker, idempotencyKey] = values;
            const key = `${String(namespace)}\0${String(target)}`;
            const expected = {
              namespace,
              target,
              marker,
              idempotency_key: idempotencyKey,
            };
            if (text.startsWith("INSERT INTO")) {
              insertCalls += 1;
              rows.set(key, expected);
              maximumRows = Math.max(maximumRows, rows.size);
              return { command: "INSERT", rowCount: 1, rows: [{ ...expected }] };
            }
            if (text.startsWith("SELECT")) {
              const row = rows.get(key);
              const matches = row && JSON.stringify(row) === JSON.stringify(expected);
              return { command: "SELECT", rowCount: matches ? 1 : 0, rows: matches ? [{ ...row }] : [] };
            }
            if (text.startsWith("DELETE FROM")) {
              const row = rows.get(key);
              const matches = row && JSON.stringify(row) === JSON.stringify(expected);
              if (matches) rows.delete(key);
              return { command: "DELETE", rowCount: matches ? 1 : 0, rows: matches ? [{ ...row }] : [] };
            }
            throw new Error("unexpected SQL in test harness");
          },
          release() {},
        };
      },
      async end() {},
    };
  });
  return {
    rows,
    connectionStrings,
    statements,
    poolFactory,
    get maximumRows() { return maximumRows; },
    get insertCalls() { return insertCalls; },
  };
}

function lifecycleInput(input: {
  toolName: "postgres.executeStatement" | "postgres.executeTransaction";
  args: Record<string, unknown>;
  canary: ReturnType<typeof canaryArgs>;
  contract: typeof POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY
    | typeof POSTGRES_EXECUTE_TRANSACTION_PROBE_SAFETY;
  execution: ToolWriteProbeExecutionContext;
  createResult: unknown;
}): ToolWriteProbeLifecycleInput {
  return {
    toolName: input.toolName,
    args: input.args,
    config,
    contract: input.contract,
    canary: input.canary,
    execution: input.execution,
    createResult: input.createResult,
  };
}

describe("PostgreSQL disposable write-probe lifecycle", () => {
  it("uses only the dedicated statement connection/catalog and proves create, idempotency, readback, delete, and absence", async () => {
    const h = databaseHarness();
    const canary = canaryArgs(
      POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY,
      { operation: operations.create, values: {} },
    );
    const args = canary.args;
    const options: PostgresExecuteOptions = {
      env,
      poolFactory: h.poolFactory as NonNullable<PostgresExecuteOptions["poolFactory"]>,
    };
    const created = await executePostgresStatement(args, config, {
      ...options,
      writeProbeExecution: execution,
    });
    expect(created.rows).toHaveLength(1);
    expect(h.connectionStrings).toEqual([env.PROBE_PG_URL]);

    const lifecycle = createPostgresExecuteStatementWriteProbeLifecycle(options);
    const input = lifecycleInput({
      toolName: "postgres.executeStatement",
      args,
      canary,
      contract: POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY,
      execution,
      createResult: created,
    });
    await expect(lifecycle.cleanup(input)).resolves.toMatchObject({
      completed: true,
      evidence: {
        idempotencyRetryVerified: true,
        preCleanupReadbackVerified: true,
        deletedRows: 1,
      },
    });
    await expect(lifecycle.readback(input)).resolves.toEqual({
      absent: true,
      evidence: { exactCanaryRows: 0 },
    });
    expect(h.insertCalls).toBe(2);
    expect(h.maximumRows).toBe(1);
    expect(h.rows.size).toBe(0);
    expect(h.connectionStrings.every((value) => value === env.PROBE_PG_URL)).toBe(true);
    expect(h.statements.some((sql) => /business\.read|business/i.test(sql))).toBe(false);
  });

  it("supports the same lifecycle for atomic transactions without accepting model canary values", async () => {
    const h = databaseHarness();
    const transactionExecution: ToolWriteProbeExecutionContext = {
      ...execution,
      actionName: "postgres.executeTransaction",
      eventName: "probe:postgres.executeTransaction",
    };
    const canary = canaryArgs(
      POSTGRES_EXECUTE_TRANSACTION_PROBE_SAFETY,
      { operations: [{ operation: operations.create, values: {} }] },
    );
    const args = canary.args;
    const options: PostgresTransactionOptions = {
      env,
      poolFactory: h.poolFactory as NonNullable<PostgresTransactionOptions["poolFactory"]>,
    };
    const created = await executePostgresTransaction(args, config, {
      ...options,
      writeProbeExecution: transactionExecution,
    });
    const lifecycle = createPostgresExecuteTransactionWriteProbeLifecycle(options);
    const input = lifecycleInput({
      toolName: "postgres.executeTransaction",
      args,
      canary,
      contract: POSTGRES_EXECUTE_TRANSACTION_PROBE_SAFETY,
      execution: transactionExecution,
      createResult: created,
    });
    await expect(lifecycle.cleanup(input)).resolves.toMatchObject({ completed: true });
    await expect(lifecycle.readback(input)).resolves.toMatchObject({ absent: true });
    expect(h.insertCalls).toBe(2);
    expect(h.maximumRows).toBe(1);
    expect(h.rows.size).toBe(0);
    expect(h.connectionStrings.every((value) => value === env.PROBE_PG_URL)).toBe(true);
  });

  it("fails closed before I/O for forged probe input, shared business refs, extra operations, or changed SQL", async () => {
    const h = databaseHarness();
    const canary = canaryArgs(
      POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY,
      { operation: operations.create, values: {} },
    );
    await expect(executePostgresStatement(
      canary.args,
      config,
      { env, poolFactory: h.poolFactory as NonNullable<PostgresExecuteOptions["poolFactory"]> },
    )).rejects.toThrow(/trusted Agent Factory probe boundary/);

    await expect(executePostgresStatement(canary.args, {
      ...config,
      write_probe_connection_url_env: "BUSINESS_PG_URL",
    }, {
      env,
      poolFactory: h.poolFactory as NonNullable<PostgresExecuteOptions["poolFactory"]>,
      writeProbeExecution: execution,
    })).rejects.toThrow(/distinct from business runtime/);

    const withExtra = {
      ...probeCatalog,
      "business.delete": {
        sql: "DELETE FROM business_records WHERE id = $1",
        params: ["id"],
        mode: "write",
        max_rows: 1,
      },
    };
    await expect(executePostgresStatement(canary.args, config, {
      env: { ...env, PROBE_PG_STATEMENTS: JSON.stringify(withExtra) },
      poolFactory: h.poolFactory as NonNullable<PostgresExecuteOptions["poolFactory"]>,
      writeProbeExecution: execution,
    })).rejects.toThrow(/must contain exactly/);

    const changed = structuredClone(probeCatalog);
    changed[operations.cleanup]!.sql = changed[operations.cleanup]!.sql.replace(
      "agent_factory_write_probe_canaries",
      "business_records",
    );
    await expect(executePostgresStatement(canary.args, config, {
      env: { ...env, PROBE_PG_STATEMENTS: JSON.stringify(changed) },
      poolFactory: h.poolFactory as NonNullable<PostgresExecuteOptions["poolFactory"]>,
      writeProbeExecution: execution,
    })).rejects.toThrow(/does not match the code-owned/);
    expect(h.poolFactory).not.toHaveBeenCalled();
  });
});
