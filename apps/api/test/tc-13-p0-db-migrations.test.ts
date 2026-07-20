/**
 * TC-13 — Phase 0 DB + migration regression suite.
 *
 * Covers:
 *   - P0-MIG-01: migrations run on boot before any DB write. By the time
 *                we issue any /v1/* request the schema is fully applied —
 *                including the temporal columns introduced in P0-DB-01.
 *   - P0-DB-01:  agents, agent_versions, event_listeners, event_types,
 *                and entity_types carry `created_at` + `updated_at`.
 *
 * Acceptance proof: query sqlite_master + PRAGMA table_info to confirm
 * the columns exist on every named table after the API has bootstrapped.
 *
 * (Numbered tc-13 to avoid colliding with the runtime engineer's
 * tc-7-manifest-schema-fields.test.ts that landed in parallel.)
 */

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { agents, getDb } from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

describe("TC-13: Phase 0 DB migrations + temporal columns", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  const TABLES_WITH_TEMPORAL_COLUMNS = [
    "agents",
    "agent_versions",
    "event_listeners",
    "event_types",
    "entity_types",
  ];

  it("P0-MIG-01: bootstrap applied migrations (otherwise harness would crash)", async () => {
    // If migrations had NOT run on boot, the testAgent invoke a few tests
    // back would have crashed inside bootstrapCodeAgents trying to write
    // into agents/agent_versions. Confirm the path is alive end-to-end by
    // hitting /v1/agents.
    const res = await env.fetch("/v1/agents?kind=all");
    expect(res.status).toBe(200);
  });

  it("P0-CODEACT-AUTH: durable per-agent authorization ledger exists", () => {
    const row = getDb().$client
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='factory_codeact_authorizations'",
      )
      .get() as { name?: string } | undefined;
    expect(row?.name).toBe("factory_codeact_authorizations");
  });

  for (const table of TABLES_WITH_TEMPORAL_COLUMNS) {
    it(`P0-DB-01: ${table} has created_at + updated_at columns`, () => {
      const db = getDb();
      // Drizzle exposes the underlying better-sqlite3 connection via
      // db.$client; using a raw PRAGMA is the most direct schema check.
      const rows = (
        db.$client.prepare(`PRAGMA table_info('${table}')`).all() as Array<{
          name: string;
        }>
      ).map((r) => r.name);
      expect(rows).toContain("created_at");
      expect(rows).toContain("updated_at");
    });
  }

  it("P0-DB-01: inserting an agent populates created_at and updated_at", () => {
    const db = getDb();
    // testAgent was inserted by bootstrapCodeAgents. Its temporal columns
    // must be non-null after the migration backfilled existing rows.
    const row = db
      .select()
      .from(agents)
      .where(eq(agents.kebabId, "testAgent"))
      .all()[0];
    expect(row).toBeDefined();
    expect(row!.createdAt).toBeInstanceOf(Date);
    expect(row!.updatedAt).toBeInstanceOf(Date);
    expect(row!.createdAt!.getTime()).toBeGreaterThan(0);
    expect(row!.updatedAt!.getTime()).toBeGreaterThan(0);
  });
});
