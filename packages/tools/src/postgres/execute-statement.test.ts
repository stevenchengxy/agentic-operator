import { describe, expect, it, vi } from "vitest";
import {
  assertSinglePostgresStatement,
  executePostgresStatement,
  type PostgresExecuteOptions,
} from "./execute-statement";

function harness(result: {
  command?: string;
  rowCount?: number;
  rows?: unknown[];
}) {
  const queries: Array<
    string | { name?: string; text: string; values?: unknown[] }
  > = [];
  const query = vi.fn(
    async (
      input: string | { name?: string; text: string; values?: unknown[] },
    ) => {
      queries.push(input);
      return typeof input === "string" ? { rows: [], rowCount: 0 } : result;
    },
  );
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  const poolFactory: NonNullable<PostgresExecuteOptions["poolFactory"]> = vi.fn(
    () => ({
      connect: async () => ({ query, release }),
      end,
    }),
  );
  return { queries, query, release, end, poolFactory };
}

const baseEnv = {
  TENANT_PG_URL: "postgres://user:password@db.example.test/app",
  TENANT_PG_STATEMENTS: JSON.stringify({
    "candidate.find": {
      sql: "SELECT id, name FROM candidates WHERE id = $1",
      params: ["candidate_id"],
      mode: "read",
      max_rows: 10,
    },
    "candidate.updateStatus": {
      sql: "UPDATE candidates SET status = $1 WHERE id = $2 RETURNING id, status",
      params: ["status", "candidate_id"],
      mode: "write",
      max_rows: 1,
    },
  }),
};

const baseConfig = {
  connection_url_env: "TENANT_PG_URL",
  statement_catalog_env: "TENANT_PG_STATEMENTS",
};

describe("postgres.executeStatement", () => {
  it("executes a catalog read in a DB-enforced READ ONLY transaction", async () => {
    const h = harness({
      command: "SELECT",
      rowCount: 1,
      rows: [{ id: "cand-1" }],
    });
    const result = await executePostgresStatement(
      {
        operation: "candidate.find",
        values: { candidate_id: "cand-1' OR true --" },
      },
      baseConfig,
      { env: baseEnv, poolFactory: h.poolFactory },
    );

    expect(result).toEqual({
      operation: "candidate.find",
      mode: "read",
      command: "SELECT",
      row_count: 1,
      rows: [{ id: "cand-1" }],
    });
    expect(h.queries[0]).toBe("BEGIN READ ONLY");
    expect(h.queries[1]).toMatchObject({
      text: "SELECT id, name FROM candidates WHERE id = $1",
      values: ["cand-1' OR true --"],
    });
    expect(h.queries[2]).toBe("COMMIT");
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.end).toHaveBeenCalledOnce();
  });

  it("rejects raw SQL/connection input before opening a pool", async () => {
    const h = harness({});
    await expect(
      executePostgresStatement(
        {
          operation: "candidate.find",
          values: { candidate_id: "x" },
          sql: "DROP TABLE candidates",
        },
        baseConfig,
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
    ).rejects.toThrow(/does not accept 'sql'/);
    expect(h.poolFactory).not.toHaveBeenCalled();
  });

  it("requires exact named values and disallows writes unless trusted config opts in", async () => {
    await expect(
      executePostgresStatement(
        { operation: "candidate.find", values: { wrong: "x" } },
        baseConfig,
        { env: baseEnv, poolFactory: harness({}).poolFactory },
      ),
    ).rejects.toThrow(/exactly: candidate_id/);

    await expect(
      executePostgresStatement(
        {
          operation: "candidate.updateStatus",
          values: { status: "active", candidate_id: "cand-1" },
        },
        baseConfig,
        { env: baseEnv, poolFactory: harness({}).poolFactory },
      ),
    ).rejects.toThrow(/allow_write=true/);

    const h = harness({
      command: "UPDATE",
      rowCount: 1,
      rows: [{ id: "cand-1", status: "active" }],
    });
    const result = await executePostgresStatement(
      {
        operation: "candidate.updateStatus",
        values: { status: "active", candidate_id: "cand-1" },
      },
      { ...baseConfig, allow_write: true },
      { env: baseEnv, poolFactory: h.poolFactory },
    );
    expect(result.mode).toBe("write");
    expect(h.queries[0]).toBe("BEGIN");
  });

  it("rejects multi-statement catalogs and rolls back row-limit failures", async () => {
    expect(() =>
      assertSinglePostgresStatement("SELECT ';' AS value; -- one statement"),
    ).not.toThrow();
    expect(() =>
      assertSinglePostgresStatement("SELECT 1; DELETE FROM candidates"),
    ).toThrow(/one statement/);

    const h = harness({
      command: "SELECT",
      rowCount: 2,
      rows: [{ id: 1 }, { id: 2 }],
    });
    const limitedEnv = {
      ...baseEnv,
      TENANT_PG_STATEMENTS: JSON.stringify({
        list: {
          sql: "SELECT id FROM candidates",
          params: [],
          mode: "read",
          max_rows: 1,
        },
      }),
    };
    await expect(
      executePostgresStatement({ operation: "list", values: {} }, baseConfig, {
        env: limitedEnv,
        poolFactory: h.poolFactory,
      }),
    ).rejects.toThrow(/more than 1 rows/);
    expect(h.queries.at(-1)).toBe("ROLLBACK");
  });

  it("requires connection URL and statement catalog to come from env refs", async () => {
    const h = harness({});
    await expect(
      executePostgresStatement(
        { operation: "candidate.find", values: { candidate_id: "x" } },
        {
          connection_url: "postgres://inline/forbidden",
          statement_catalog_env: "TENANT_PG_STATEMENTS",
        },
        { env: baseEnv, poolFactory: h.poolFactory },
      ),
    ).rejects.toThrow(/literal SQL\/URLs are forbidden/);
    expect(h.poolFactory).not.toHaveBeenCalled();
  });
});
