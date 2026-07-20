import { describe, expect, it, vi } from "vitest";
import {
  executePostgresTransaction,
  PostgresTransactionError,
  type PostgresTransactionOptions,
} from "./execute-transaction";

type QueryInput =
  | string
  | {
      name?: string;
      text: string;
      values?: unknown[];
      query_timeout?: number;
    };

function harness(
  respond: (input: QueryInput, statementIndex: number) => unknown | Promise<unknown>,
) {
  const queries: QueryInput[] = [];
  let statementIndex = 0;
  const query = vi.fn(async (input: QueryInput) => {
    queries.push(input);
    if (
      typeof input === "string" ||
      /^(?:BEGIN|COMMIT|ROLLBACK)(?:\s|$)/.test(input.text)
    ) {
      return { rows: [], rowCount: 0 };
    }
    const response = await respond(input, statementIndex);
    statementIndex += 1;
    return response as {
      command?: string;
      rowCount?: number;
      rows?: unknown[];
    };
  });
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  const connect = vi.fn(async () => ({ query, release }));
  const poolFactory: NonNullable<
    PostgresTransactionOptions["poolFactory"]
  > = vi.fn(() => ({ connect, end }));
  return { queries, query, release, end, connect, poolFactory };
}

const statementCatalog = {
  "candidate.find": {
    sql: "SELECT id, status FROM candidates WHERE id = $1",
    params: ["candidate_id"],
    mode: "read",
    max_rows: 1,
  },
  "application.find": {
    sql: "SELECT id, candidate_id FROM applications WHERE id = $1",
    params: ["application_id"],
    mode: "read",
    max_rows: 1,
  },
  "candidate.updateStatus": {
    sql: "UPDATE candidates SET status = $1 WHERE id = $2 RETURNING id, status",
    params: ["status", "candidate_id"],
    mode: "write",
    max_rows: 1,
  },
  "audit.insert": {
    sql: "INSERT INTO audit_log (candidate_id, action) VALUES ($1, $2) RETURNING id",
    params: ["candidate_id", "action"],
    mode: "write",
    max_rows: 1,
  },
};

const baseEnv = {
  TENANT_PG_URL: "postgres://user:password@db.example.test/app",
  TENANT_PG_STATEMENTS: JSON.stringify(statementCatalog),
};

const baseConfig = {
  connection_url_env: "TENANT_PG_URL",
  statement_catalog_env: "TENANT_PG_STATEMENTS",
};

function queryText(input: QueryInput | undefined): string | undefined {
  return typeof input === "string" ? input : input?.text;
}

describe("postgres.executeTransaction", () => {
  it("executes every read on one connection, commits once, and preserves named results", async () => {
    const h = harness((_query, index) =>
      index === 0
        ? {
            command: "SELECT",
            rowCount: 1,
            rows: [{ id: "cand-1", status: "active" }],
          }
        : {
            command: "SELECT",
            rowCount: 1,
            rows: [{ id: "app-1", candidate_id: "cand-1" }],
          },
    );

    const result = await executePostgresTransaction(
      {
        operations: [
          {
            operation: "candidate.find",
            values: { candidate_id: "cand-1' OR true --" },
          },
          {
            operation: "application.find",
            values: { application_id: "app-1" },
          },
        ],
      },
      baseConfig,
      { env: baseEnv, poolFactory: h.poolFactory },
    );

    expect(result).toMatchObject({
      mode: "read",
      committed: true,
      operation_count: 2,
      operation_order: ["candidate.find", "application.find"],
      operation_results: {
        "candidate.find": {
          index: 0,
          operation: "candidate.find",
          mode: "read",
          command: "SELECT",
          row_count: 1,
          rows: [{ id: "cand-1", status: "active" }],
        },
        "application.find": {
          index: 1,
          operation: "application.find",
          mode: "read",
          command: "SELECT",
          row_count: 1,
          rows: [{ id: "app-1", candidate_id: "cand-1" }],
        },
      },
    });
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.queries[0]).toMatchObject({ text: "BEGIN READ ONLY" });
    expect(h.queries[1]).toMatchObject({
      text: statementCatalog["candidate.find"].sql,
      values: ["cand-1' OR true --"],
    });
    expect(h.queries[2]).toMatchObject({
      text: statementCatalog["application.find"].sql,
      values: ["app-1"],
    });
    expect(h.queries[3]).toMatchObject({ text: "COMMIT" });
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });

  it("requires trusted allow_write before opening a pool and commits mixed batches with BEGIN", async () => {
    const args = {
      operations: [
        {
          operation: "candidate.find",
          values: { candidate_id: "cand-1" },
        },
        {
          operation: "candidate.updateStatus",
          values: { status: "screened", candidate_id: "cand-1" },
        },
      ],
    };
    const rejected = harness(() => ({}));
    await expect(
      executePostgresTransaction(args, baseConfig, {
        env: baseEnv,
        poolFactory: rejected.poolFactory,
      }),
    ).rejects.toThrow(/allow_write=true/);
    expect(rejected.poolFactory).not.toHaveBeenCalled();

    const h = harness((_query, index) =>
      index === 0
        ? { command: "SELECT", rowCount: 1, rows: [{ id: "cand-1" }] }
        : {
            command: "UPDATE",
            rowCount: 1,
            rows: [{ id: "cand-1", status: "screened" }],
          },
    );
    const result = await executePostgresTransaction(
      args,
      { ...baseConfig, allow_write: true },
      { env: baseEnv, poolFactory: h.poolFactory },
    );
    expect(result.mode).toBe("write");
    expect(h.queries[0]).toMatchObject({ text: "BEGIN" });
    expect(queryText(h.queries.at(-1))).toBe("COMMIT");
  });

  it("rolls back the complete transaction at the failing operation and sanitizes database errors", async () => {
    const h = harness((_query, index) => {
      if (index === 1) {
        return Promise.reject(
          Object.assign(new Error("secret DB host and SQL details"), {
            code: "23505;DROP",
          }),
        );
      }
      return { command: "UPDATE", rowCount: 1, rows: [{ id: "cand-1" }] };
    });

    const failure = executePostgresTransaction(
      {
        operations: [
          {
            operation: "candidate.updateStatus",
            values: { status: "screened", candidate_id: "cand-1" },
          },
          {
            operation: "audit.insert",
            values: { candidate_id: "cand-1", action: "screened" },
          },
        ],
      },
      { ...baseConfig, allow_write: true },
      { env: baseEnv, poolFactory: h.poolFactory },
    );
    await expect(failure).rejects.toMatchObject({
      name: "PostgresTransactionError",
      code: "database_execution_failed",
      operation: "audit.insert",
      operationIndex: 1,
    });
    await expect(failure).rejects.not.toThrow(/secret DB host|password|INSERT INTO/);
    expect(queryText(h.queries.at(-1))).toBe("ROLLBACK");
    expect(h.queries.map(queryText)).not.toContain("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });

  it("rejects raw SQL/URLs, extra input fields, non-JSON values, and literal trusted config before connecting", async () => {
    const attempts: Array<Promise<unknown>> = [];
    const h = harness(() => ({}));
    attempts.push(
      executePostgresTransaction(
        { operations: [], sql: "DROP TABLE candidates" },
        baseConfig,
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.find",
              values: { candidate_id: "cand-1" },
              query: "SELECT 1",
            },
          ],
        },
        baseConfig,
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.find",
              values: { candidate_id: undefined },
            },
          ],
        },
        baseConfig,
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.find",
              values: { candidate_id: "cand-1" },
            },
          ],
        },
        {
          ...baseConfig,
          connection_url: "postgres://inline/forbidden",
        },
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
    );

    const settled = await Promise.allSettled(attempts);
    expect(settled.every(({ status }) => status === "rejected")).toBe(true);
    expect(
      settled.map((item) =>
        item.status === "rejected" ? String(item.reason) : "",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/input must contain exactly: operations/),
        expect.stringMatching(/operations\[0\].*exactly: operation, values/),
        expect.stringMatching(/only JSON values/),
        expect.stringMatching(/does not accept literal 'connection_url'/),
      ]),
    );
    expect(h.poolFactory).not.toHaveBeenCalled();
  });

  it("enforces catalog membership, exact params, single statements, allowed operations, and unique result names", async () => {
    const h = harness(() => ({}));
    const cases: Array<Promise<unknown>> = [
      executePostgresTransaction(
        {
          operations: [
            { operation: "unknown.operation", values: {} },
          ],
        },
        baseConfig,
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
      executePostgresTransaction(
        {
          operations: [
            { operation: "candidate.find", values: { wrong: "cand-1" } },
          ],
        },
        baseConfig,
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.find",
              values: { candidate_id: "cand-1" },
            },
          ],
        },
        { ...baseConfig, allowed_operations: ["application.find"] },
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.find",
              values: { candidate_id: "cand-1" },
            },
            {
              operation: "candidate.find",
              values: { candidate_id: "cand-2" },
            },
          ],
        },
        baseConfig,
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
      executePostgresTransaction(
        { operations: [{ operation: "unsafe", values: {} }] },
        baseConfig,
        {
          env: {
            ...baseEnv,
            TENANT_PG_STATEMENTS: JSON.stringify({
              unsafe: {
                sql: "SELECT 1; DELETE FROM candidates",
                params: [],
                mode: "read",
              },
            }),
          },
          poolFactory: h.poolFactory,
        },
      ),
    ];

    const settled = await Promise.allSettled(cases);
    expect(
      settled.map((item) =>
        item.status === "rejected" ? String(item.reason) : "",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not in the server statement catalog/),
        expect.stringMatching(/values must contain exactly: candidate_id/),
        expect.stringMatching(/outside config.allowed_operations/),
        expect.stringMatching(/appears more than once/),
        expect.stringMatching(/exactly one statement/),
      ]),
    );
    expect(h.poolFactory).not.toHaveBeenCalled();
  });

  it("enforces operation, byte, row, and total timeout limits with rollback", async () => {
    const preflight = harness(() => ({}));
    await expect(
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.find",
              values: { candidate_id: "cand-1" },
            },
            {
              operation: "application.find",
              values: { application_id: "app-1" },
            },
          ],
        },
        { ...baseConfig, max_operations: 1 },
        { env: baseEnv, poolFactory: preflight.poolFactory },
      ),
    ).rejects.toThrow(/configured limit of 1/);
    await expect(
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.find",
              values: { candidate_id: "cand-1" },
            },
          ],
        },
        { ...baseConfig, max_batch_bytes: 1 },
        { env: baseEnv, poolFactory: preflight.poolFactory },
      ),
    ).rejects.toThrow(/1-byte limit/);
    expect(preflight.poolFactory).not.toHaveBeenCalled();

    const rowLimit = harness(() => ({
      command: "SELECT",
      rowCount: 2,
      rows: [{ id: "cand-1" }, { id: "cand-2" }],
    }));
    await expect(
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.find",
              values: { candidate_id: "cand-1" },
            },
          ],
        },
        baseConfig,
        { env: baseEnv, poolFactory: rowLimit.poolFactory },
      ),
    ).rejects.toMatchObject({
      code: "result_row_limit_exceeded",
      operation: "candidate.find",
      operationIndex: 0,
    });
    expect(queryText(rowLimit.queries.at(-1))).toBe("ROLLBACK");

    const affectedRowLimit = harness(() => ({
      command: "UPDATE",
      rowCount: 2,
      rows: [],
    }));
    await expect(
      executePostgresTransaction(
        {
          operations: [
            {
              operation: "candidate.updateStatus",
              values: { status: "screened", candidate_id: "cand-1" },
            },
          ],
        },
        { ...baseConfig, allow_write: true },
        { env: baseEnv, poolFactory: affectedRowLimit.poolFactory },
      ),
    ).rejects.toMatchObject({ code: "result_row_limit_exceeded" });
    expect(queryText(affectedRowLimit.queries.at(-1))).toBe("ROLLBACK");

    let currentTime = 0;
    const timed = harness((_query, index) => {
      if (index === 0) currentTime = 31;
      return { command: "SELECT", rowCount: 1, rows: [{ id: "x" }] };
    });
    const timedResult = executePostgresTransaction(
      {
        operations: [
          {
            operation: "candidate.find",
            values: { candidate_id: "cand-1" },
          },
          {
            operation: "application.find",
            values: { application_id: "app-1" },
          },
        ],
      },
      { ...baseConfig, timeout_ms: 30 },
      {
        env: baseEnv,
        poolFactory: timed.poolFactory,
        now: () => currentTime,
      },
    );
    await expect(timedResult).rejects.toBeInstanceOf(PostgresTransactionError);
    await expect(timedResult).rejects.toMatchObject({
      code: "transaction_timeout",
      operation: "application.find",
      operationIndex: 1,
    });
    expect(queryText(timed.queries.at(-1))).toBe("ROLLBACK");
    expect(
      timed.queries.filter(
        (query) =>
          typeof query !== "string" &&
          !/^(?:BEGIN|COMMIT|ROLLBACK)(?:\s|$)/.test(query.text),
      ),
    ).toHaveLength(1);
  });
});
