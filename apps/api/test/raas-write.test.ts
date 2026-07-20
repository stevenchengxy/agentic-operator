import { describe, expect, it, vi } from "vitest";
import {
  executeEntityWrite,
  writeEntities,
} from "@agentic/recruitment-capabilities";
import type { PostgresExecuteOptions } from "@agentic/tools/postgres";

function mockPool(rows: Array<Record<string, unknown>>) {
  const queries: unknown[] = [];
  const query = vi.fn(async (input: unknown) => {
    queries.push(input);
    // BEGIN/COMMIT are passed as strings; the real statement returns rows.
    return typeof input === "string" ? { rows: [], rowCount: 0 } : { rows, rowCount: rows.length };
  });
  const release = vi.fn();
  const end = vi.fn(async () => undefined);
  const poolFactory: NonNullable<PostgresExecuteOptions["poolFactory"]> = vi.fn(
    () => ({ connect: async () => ({ query, release }), end }),
  );
  return { queries, poolFactory };
}

const env = {
  RAAS_POSTGRES_URL: "postgres://user:password@raas.example.test/raas",
  RAAS_WRITE_STATEMENTS: JSON.stringify({
    "job_posting.sync": {
      sql: "INSERT INTO job_posting (jr_id, body) VALUES ($1, $2) ON CONFLICT (jr_id) DO UPDATE SET body = EXCLUDED.body RETURNING id",
      params: ["jr_id", "body"],
      mode: "write",
      max_rows: 1,
    },
    "requirement.load": {
      sql: "SELECT id FROM job_requisition WHERE id = $1",
      params: ["jr_id"],
      mode: "read",
      max_rows: 1,
    },
  }),
};

const config = {
  tenant_slug: "agents-generation",
  system_name: "RAAS_System",
  connection_url_env: "RAAS_POSTGRES_URL",
  statement_catalog_env: "RAAS_WRITE_STATEMENTS",
  allowed_operations: ["job_posting.sync"],
};

describe("entities.write (decision-free statement-catalog transport)", () => {
  it("declares a generic database capability without a tenant namespace", () => {
    const capability = writeEntities.factory?.capabilities?.[0];
    expect(capability?.systems).toEqual(["*"]);
    expect(capability?.systemConfigKey).toBe("system_name");
    expect(capability?.roles).toContain("write");
    expect(writeEntities.factory?.operation).toBe("write");
    expect(writeEntities.factory?.sandboxPolicy).toBe("requires_attempt_grant");
  });

  it("executes an allow-listed write statement with allow_write enabled", async () => {
    const { poolFactory } = mockPool([{ id: "jp-1" }]);
    const result = await executeEntityWrite(
      { operation: "job_posting.sync", values: { jr_id: "jr-1", body: "JD text" } },
      config,
      { env, poolFactory },
    );
    expect(result.operation).toBe("job_posting.sync");
    expect(result.rows).toEqual([{ id: "jp-1" }]);
    expect(result.source).toBe("postgres-statement-catalog");
  });

  it("fails closed when the named catalog entry is read-only", async () => {
    const { poolFactory } = mockPool([]);
    await expect(
      executeEntityWrite(
        { operation: "requirement.load", values: { jr_id: "jr-1" } },
        { ...config, allowed_operations: ["requirement.load"] },
        { env, poolFactory },
      ),
    ).rejects.toThrow(/not a write statement/);
  });

  it("rejects unknown/unsafe config keys", async () => {
    const { poolFactory } = mockPool([{ id: "jp-1" }]);
    await expect(
      executeEntityWrite(
        { operation: "job_posting.sync", values: { jr_id: "jr-1", body: "x" } },
        { ...config, raw_sql: "DROP TABLE job_posting" },
        { env, poolFactory },
      ),
    ).rejects.toThrow(/unknown or unsafe config/);
  });

  it("requires exactly operation + values in the input", async () => {
    const { poolFactory } = mockPool([{ id: "jp-1" }]);
    await expect(
      executeEntityWrite(
        { operation: "job_posting.sync", values: {}, extra: 1 },
        config,
        { env, poolFactory },
      ),
    ).rejects.toThrow(/must contain exactly operation, values/);
  });
});
