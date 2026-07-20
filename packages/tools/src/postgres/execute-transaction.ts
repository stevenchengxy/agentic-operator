/**
 * postgres.executeTransaction — atomically execute an ordered batch of named,
 * server-owned PostgreSQL statements.
 *
 * The caller controls only `operations[].operation` and parameter values. SQL,
 * connection URLs, statement modes, and row caps all come from trusted config
 * and its environment-backed statement catalog.
 */

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import {
  defineTool,
  type ToolWriteProbeExecutionContext,
  type ToolWriteProbeLifecycle,
  type ToolWriteProbeLifecycleInput,
} from "@agentic/agent-kit";
import type { WriteProbeSafetyContract } from "@agentic/shared";
import { readEnvironmentReference } from "../config/env-ref";
import {
  assertPostgresProbeRows,
  parseStatementCatalog,
  postgresProbeExecutionFromContext,
  postgresUrl,
  preparePostgresWriteProbe,
  valuesFor,
  type PreparedPostgresWriteProbe,
  type StatementDefinition,
  type StatementMode,
} from "./execute-statement";

type JsonRecord = Record<string, unknown>;

interface QueryResultLike {
  command?: string;
  rowCount?: number | null;
  rows?: unknown[];
}

interface QueryConfigLike {
  name?: string;
  text: string;
  values?: unknown[];
  query_timeout?: number;
}

interface PgClientLike {
  query(query: string | QueryConfigLike): Promise<QueryResultLike>;
  release(): void;
}

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export interface PostgresTransactionOptions {
  env?: Record<string, string | undefined>;
  poolFactory?: (config: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    application_name: string;
  }) => PgPoolLike;
  now?: () => number;
  writeProbeExecution?: ToolWriteProbeExecutionContext;
}

export interface PostgresTransactionStepResult {
  index: number;
  operation: string;
  mode: StatementMode;
  command: string;
  row_count: number;
  rows: unknown[];
}

export interface PostgresTransactionResult {
  mode: StatementMode;
  committed: true;
  operation_count: number;
  operation_order: string[];
  /** Stable lookup by the server-catalog operation name. */
  operation_results: Record<string, PostgresTransactionStepResult>;
}

export class PostgresTransactionError extends Error {
  readonly code: string;
  readonly operation?: string;
  readonly operationIndex?: number;

  constructor(
    code: string,
    message: string,
    context: { operation?: string; operationIndex?: number } = {},
  ) {
    super(message);
    this.name = "PostgresTransactionError";
    this.code = code;
    this.operation = context.operation;
    this.operationIndex = context.operationIndex;
  }
}

interface PreparedOperation {
  operation: string;
  definition: StatementDefinition;
  values: unknown[];
  maxRows: number;
}

const OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_ROWS = 1_000;
const ABSOLUTE_MAX_ROWS = 10_000;
const DEFAULT_MAX_OPERATIONS = 20;
const ABSOLUTE_MAX_OPERATIONS = 100;
const DEFAULT_MAX_BATCH_BYTES = 1024 * 1024;
const ABSOLUTE_MAX_BATCH_BYTES = 10 * 1024 * 1024;

const POSTGRES_PROBE_FIELD = "_agent_factory_postgres_probe";

export const POSTGRES_EXECUTE_TRANSACTION_PROBE_SAFETY = {
  testDataContract: {
    kind: "synthetic_canary",
    marker: {
      kind: "argument",
      path: `${POSTGRES_PROBE_FIELD}.marker`,
      valuePrefix: "af-pg-marker-",
    },
  },
  idempotency: {
    kind: "argument",
    path: `${POSTGRES_PROBE_FIELD}.idempotency_key`,
    valuePrefix: "af-pg-idempotency-",
  },
  isolation: {
    namespace: {
      kind: "argument",
      path: `${POSTGRES_PROBE_FIELD}.namespace`,
      valuePrefix: "af-pg-namespace-",
    },
    target: {
      kind: "argument",
      path: `${POSTGRES_PROBE_FIELD}.target`,
      valuePrefix: "af-pg-target-",
    },
  },
  cleanup: {
    kind: "handler",
    handler: "postgres.executeTransaction.canary.cleanup",
  },
  absenceProof: {
    kind: "handler",
    handler: "postgres.executeTransaction.canary.readback",
  },
} as const satisfies WriteProbeSafetyContract;

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}.`);
  }
  return value as number;
}

function assertExactKeys(
  record: JsonRecord,
  expected: readonly string[],
  field: string,
): void {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${field} must contain exactly: ${expected.join(", ")}.`);
  }
}

function assertJsonValue(
  value: unknown,
  path: string,
  ancestors: Set<object> = new Set(),
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new Error(`${path} must contain only finite JSON numbers.`);
  }
  if (typeof value !== "object") {
    throw new Error(`${path} must contain only JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new Error(`${path} must not contain circular references.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertJsonValue(item, `${path}[${index}]`, ancestors),
    );
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects.`);
    }
    for (const [key, item] of Object.entries(value as JsonRecord)) {
      assertJsonValue(item, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function transactionHelper<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(
        error.message.replaceAll(
          "postgres.executeStatement",
          "postgres.executeTransaction",
        ),
      );
    }
    throw error;
  }
}

function parseAllowedOperations(config: JsonRecord): Set<string> | undefined {
  if (config.allowed_operations === undefined) return undefined;
  if (
    !Array.isArray(config.allowed_operations) ||
    !config.allowed_operations.every(
      (value) => typeof value === "string" && OPERATION_RE.test(value),
    )
  ) {
    throw new Error(
      "postgres.executeTransaction config.allowed_operations must contain only valid operation names.",
    );
  }
  return new Set(config.allowed_operations as string[]);
}

function rejectLiteralOrCallerSql(args: JsonRecord, config: JsonRecord): void {
  assertExactKeys(args, ["operations"], "postgres.executeTransaction input");
  for (const forbidden of [
    "connection_url",
    "connectionString",
    "statement_catalog",
    "sql",
    "query",
    "statement",
    "url",
  ]) {
    if (forbidden in config) {
      throw new Error(
        `postgres.executeTransaction trusted config does not accept literal '${forbidden}'; use environment references and the server statement catalog.`,
      );
    }
  }
}

function prepareOperations(
  args: JsonRecord,
  config: JsonRecord,
  catalog: Record<string, StatementDefinition>,
): { operations: PreparedOperation[]; mode: StatementMode } {
  if (!Array.isArray(args.operations) || args.operations.length === 0) {
    throw new Error(
      "postgres.executeTransaction operations must be a non-empty array.",
    );
  }
  const maxOperations = positiveInteger(
    config.max_operations,
    DEFAULT_MAX_OPERATIONS,
    ABSOLUTE_MAX_OPERATIONS,
    "postgres.executeTransaction config.max_operations",
  );
  if (args.operations.length > maxOperations) {
    throw new Error(
      `postgres.executeTransaction operations exceed the configured limit of ${maxOperations}.`,
    );
  }

  for (const [index, item] of args.operations.entries()) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error(
        `postgres.executeTransaction operations[${index}] must be an object.`,
      );
    }
    assertExactKeys(
      item as JsonRecord,
      ["operation", "values"],
      `postgres.executeTransaction operations[${index}]`,
    );
    assertJsonValue(
      (item as JsonRecord).values,
      `postgres.executeTransaction operations[${index}].values`,
    );
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(args.operations);
  } catch {
    throw new Error(
      "postgres.executeTransaction operations must be JSON-serializable.",
    );
  }
  const maxBatchBytes = positiveInteger(
    config.max_batch_bytes,
    DEFAULT_MAX_BATCH_BYTES,
    ABSOLUTE_MAX_BATCH_BYTES,
    "postgres.executeTransaction config.max_batch_bytes",
  );
  if (Buffer.byteLength(serialized, "utf8") > maxBatchBytes) {
    throw new Error(
      `postgres.executeTransaction operations exceed the configured ${maxBatchBytes}-byte limit.`,
    );
  }

  const allowed = parseAllowedOperations(config);
  const configMaxRows = positiveInteger(
    config.max_rows,
    DEFAULT_MAX_ROWS,
    ABSOLUTE_MAX_ROWS,
    "postgres.executeTransaction config.max_rows",
  );
  const seen = new Set<string>();
  const prepared: PreparedOperation[] = [];
  let hasWrite = false;

  for (const [index, rawItem] of args.operations.entries()) {
    const item = rawItem as JsonRecord;
    const operation = item.operation;
    if (typeof operation !== "string" || !OPERATION_RE.test(operation)) {
      throw new Error(
        `postgres.executeTransaction operations[${index}].operation is missing or invalid.`,
      );
    }
    if (seen.has(operation)) {
      throw new Error(
        `postgres.executeTransaction operation '${operation}' appears more than once; operation names must be unique so results stay addressable.`,
      );
    }
    seen.add(operation);
    const definition = catalog[operation];
    if (!definition) {
      throw new Error(
        `postgres.executeTransaction operation '${operation}' is not in the server statement catalog.`,
      );
    }
    if (allowed && !allowed.has(operation)) {
      throw new Error(
        `postgres.executeTransaction operation '${operation}' is outside config.allowed_operations.`,
      );
    }
    if (definition.mode === "write") hasWrite = true;
    const orderedValues = transactionHelper(() =>
      valuesFor(definition, item.values),
    );
    prepared.push({
      operation,
      definition,
      values: orderedValues,
      maxRows: Math.min(
        definition.max_rows ?? configMaxRows,
        configMaxRows,
        ABSOLUTE_MAX_ROWS,
      ),
    });
  }

  if (hasWrite && config.allow_write !== true) {
    throw new Error(
      "postgres.executeTransaction contains a write operation and requires trusted config.allow_write=true.",
    );
  }
  return { operations: prepared, mode: hasWrite ? "write" : "read" };
}

export async function executePostgresTransaction(
  args: JsonRecord,
  config: JsonRecord,
  options: PostgresTransactionOptions = {},
): Promise<PostgresTransactionResult> {
  let preparedProbe: PreparedPostgresWriteProbe | undefined;
  if (options.writeProbeExecution) {
    preparedProbe = preparePostgresWriteProbe({
      toolName: "postgres.executeTransaction",
      args,
      config,
      execution: options.writeProbeExecution,
      env: options.env,
    });
    args = preparedProbe.transactionArgs("create");
    config = preparedProbe.config;
  } else if (POSTGRES_PROBE_FIELD in args) {
    throw new Error(
      "postgres.executeTransaction reserved write-probe input is accepted only from the trusted Agent Factory probe boundary.",
    );
  }
  rejectLiteralOrCallerSql(args, config);
  const env = options.env ?? process.env;
  const catalogRaw = readEnvironmentReference(
    env,
    config.statement_catalog_env,
    "postgres.executeTransaction config.statement_catalog_env",
  );
  const catalog = transactionHelper(() => parseStatementCatalog(catalogRaw));
  const prepared = prepareOperations(args, config, catalog);
  const connectionString = transactionHelper(() =>
    postgresUrl(
      readEnvironmentReference(
        env,
        config.connection_url_env,
        "postgres.executeTransaction config.connection_url_env",
      ),
    ),
  );
  const timeoutMs = positiveInteger(
    config.timeout_ms,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "postgres.executeTransaction config.timeout_ms",
  );
  const poolFactory =
    options.poolFactory ??
    ((poolConfig) => new Pool(poolConfig) as unknown as PgPoolLike);
  const pool = poolFactory({
    connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    idleTimeoutMillis: 1_000,
    application_name: "agentic_postgres_execute_transaction",
  });
  const now = options.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let client: PgClientLike | undefined;
  let activeOperation: PreparedOperation | undefined;
  let activeIndex: number | undefined;

  const remainingMs = (): number => {
    const remaining = Math.floor(deadline - now());
    if (remaining <= 0) {
      throw new PostgresTransactionError(
        "transaction_timeout",
        "postgres.executeTransaction exceeded its transaction timeout and was rolled back.",
        {
          ...(activeOperation
            ? { operation: activeOperation.operation }
            : {}),
          ...(activeIndex === undefined ? {} : { operationIndex: activeIndex }),
        },
      );
    }
    return remaining;
  };

  try {
    client = await pool.connect();
    await client.query({
      text: prepared.mode === "read" ? "BEGIN READ ONLY" : "BEGIN",
      query_timeout: remainingMs(),
    });
    const operationResults: Record<string, PostgresTransactionStepResult> =
      Object.create(null) as Record<string, PostgresTransactionStepResult>;

    for (const [index, operation] of prepared.operations.entries()) {
      activeOperation = operation;
      activeIndex = index;
      const statementHash = createHash("sha256")
        .update(operation.definition.sql)
        .digest("hex")
        .slice(0, 16);
      const result = await client.query({
        name: `agentic_tx_${operation.operation.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 36)}_${statementHash}`,
        text: operation.definition.sql,
        values: operation.values,
        query_timeout: remainingMs(),
      });
      const rows = Array.isArray(result.rows) ? result.rows : [];
      const rowCount =
        typeof result.rowCount === "number" ? result.rowCount : rows.length;
      if (Math.max(rows.length, rowCount) > operation.maxRows) {
        throw new PostgresTransactionError(
          "result_row_limit_exceeded",
          `postgres.executeTransaction operation '${operation.operation}' affected or returned more than ${operation.maxRows} rows; the complete transaction was rolled back.`,
          { operation: operation.operation, operationIndex: index },
        );
      }
      operationResults[operation.operation] = {
        index,
        operation: operation.operation,
        mode: operation.definition.mode,
        command:
          typeof result.command === "string" ? result.command : "UNKNOWN",
        row_count: rowCount,
        rows,
      };
    }

    activeOperation = undefined;
    activeIndex = undefined;
    await client.query({ text: "COMMIT", query_timeout: remainingMs() });
    if (preparedProbe) {
      const create = operationResults[preparedProbe.operations.create];
      assertPostgresProbeRows(
        create?.rows ?? [],
        preparedProbe.envelope,
        1,
        "transaction create",
      );
    }
    return {
      mode: prepared.mode,
      committed: true,
      operation_count: prepared.operations.length,
      operation_order: prepared.operations.map(({ operation }) => operation),
      operation_results: operationResults,
    };
  } catch (error) {
    if (client) {
      try {
        await client.query({
          text: "ROLLBACK",
          query_timeout: Math.min(timeoutMs, 5_000),
        });
      } catch {
        // Preserve the original failure and never expose connection details.
      }
    }
    if (error instanceof PostgresTransactionError) throw error;
    const pgCode =
      error &&
      typeof error === "object" &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
            .replace(/[^A-Za-z0-9_-]/g, "")
            .slice(0, 32)
        : "unknown";
    const errorMessage =
      error instanceof Error ? error.message.toLowerCase() : "";
    const timeout =
      pgCode === "57014" ||
      errorMessage === "query read timeout" ||
      errorMessage === "query timeout";
    throw new PostgresTransactionError(
      timeout ? "transaction_timeout" : "database_execution_failed",
      timeout
        ? "postgres.executeTransaction timed out and the complete transaction was rolled back."
        : `postgres.executeTransaction database execution failed${
            activeOperation ? ` for operation '${activeOperation.operation}'` : ""
          } (code: ${pgCode}); the complete transaction was rolled back.`,
      {
        ...(activeOperation ? { operation: activeOperation.operation } : {}),
        ...(activeIndex === undefined ? {} : { operationIndex: activeIndex }),
      },
    );
  } finally {
    client?.release();
    await pool.end();
  }
}

function probeLifecycleInput(
  input: ToolWriteProbeLifecycleInput,
  env?: Record<string, string | undefined>,
): PreparedPostgresWriteProbe {
  if (input.toolName !== "postgres.executeTransaction") {
    throw new Error("postgres.executeTransaction lifecycle received a different tool.");
  }
  return preparePostgresWriteProbe({
    toolName: "postgres.executeTransaction",
    args: input.args,
    config: input.config,
    execution: input.execution,
    env,
    contract: input.contract,
    expectedCanary: input.canary,
  });
}

export function createPostgresExecuteTransactionWriteProbeLifecycle(
  options: PostgresTransactionOptions = {},
): ToolWriteProbeLifecycle {
  const lifecycleOptions: PostgresTransactionOptions = {
    ...(options.env ? { env: options.env } : {}),
    ...(options.poolFactory ? { poolFactory: options.poolFactory } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  return {
    identity: { id: "postgres.executeTransaction/write-probe", revision: "1" },
    async cleanup(input) {
      const probe = probeLifecycleInput(input, options.env);
      let verificationError: unknown;
      try {
        const retry = await executePostgresTransaction(
          probe.transactionArgs("create"),
          probe.config,
          lifecycleOptions,
        );
        assertPostgresProbeRows(
          retry.operation_results[probe.operations.create]?.rows ?? [],
          probe.envelope,
          1,
          "transaction idempotency retry",
        );
        const readback = await executePostgresTransaction(
          probe.transactionArgs("readback"),
          probe.config,
          lifecycleOptions,
        );
        assertPostgresProbeRows(
          readback.operation_results[probe.operations.readback]?.rows ?? [],
          probe.envelope,
          1,
          "transaction pre-cleanup readback",
        );
      } catch (error) {
        verificationError = error;
      }
      const cleanup = await executePostgresTransaction(
        probe.transactionArgs("cleanup"),
        probe.config,
        lifecycleOptions,
      );
      assertPostgresProbeRows(
        cleanup.operation_results[probe.operations.cleanup]?.rows ?? [],
        probe.envelope,
        1,
        "transaction cleanup",
      );
      if (verificationError) throw verificationError;
      return {
        completed: true,
        evidence: {
          idempotencyRetryVerified: true,
          preCleanupReadbackVerified: true,
          deletedRows: 1,
        },
      };
    },
    async readback(input) {
      const probe = probeLifecycleInput(input, options.env);
      const readback = await executePostgresTransaction(
        probe.transactionArgs("readback"),
        probe.config,
        lifecycleOptions,
      );
      assertPostgresProbeRows(
        readback.operation_results[probe.operations.readback]?.rows ?? [],
        probe.envelope,
        0,
        "transaction absence readback",
      );
      return {
        absent: true,
        evidence: { exactCanaryRows: 0 },
      };
    },
  };
}

export const postgresExecuteTransactionWriteProbeLifecycle =
  createPostgresExecuteTransactionWriteProbeLifecycle();

const stepResultSchema = z.object({
  index: z.number().int().nonnegative(),
  operation: z.string(),
  mode: z.enum(["read", "write"]),
  command: z.string(),
  row_count: z.number().int().nonnegative(),
  rows: z.array(z.unknown()),
});

export const postgresExecuteTransaction = defineTool({
  name: "postgres.executeTransaction",
  description:
    "Atomically execute an ordered batch of unique named PostgreSQL catalog operations on one connection. " +
    "Input is exactly {operations:[{operation,values}]}; raw SQL and connection URLs are rejected, and any failure rolls back every operation.",
  output: z.object({
    mode: z.enum(["read", "write"]),
    committed: z.literal(true),
    operation_count: z.number().int().positive(),
    operation_order: z.array(z.string()),
    operation_results: z.record(z.string(), stepResultSchema),
  }),
  factoryWriteProbeLifecycle: postgresExecuteTransactionWriteProbeLifecycle,
  async handler(ctx) {
    return {
      data: await executePostgresTransaction(
        (ctx.event?.data ?? {}) as JsonRecord,
        (ctx.config ?? {}) as JsonRecord,
        { writeProbeExecution: postgresProbeExecutionFromContext(ctx) },
      ),
      meta: {
        statement_source: "server-environment-catalog",
        parameterized: true,
        atomic: true,
      },
    };
  },
});
