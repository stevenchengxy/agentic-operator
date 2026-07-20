import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { getRawSqlite } from "@agentic/db";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const fullMigrations = path.join(repoRoot, "packages", "db", "drizzle");
const roots: string[] = [];
type RawSqlite = ReturnType<typeof getRawSqlite>;
const requireFromDb = createRequire(
  path.join(repoRoot, "packages", "db", "package.json"),
);
const Database = requireFromDb("better-sqlite3") as new (
  file: string,
) => RawSqlite;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function migrationsThrough(
  root: string,
  lastIdx: number,
): Promise<string> {
  const folder = path.join(root, `migrations-${lastIdx}`);
  const meta = path.join(folder, "meta");
  await mkdir(meta, { recursive: true });
  const journal = JSON.parse(
    await readFile(path.join(fullMigrations, "meta", "_journal.json"), "utf8"),
  ) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  await writeFile(
    path.join(meta, "_journal.json"),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
  );
  await Promise.all(
    entries.map((entry) =>
      copyFile(
        path.join(fullMigrations, `${entry.tag}.sql`),
        path.join(folder, `${entry.tag}.sql`),
      ),
    ),
  );
  return folder;
}

function applyMigrations(file: string, folder: string): RawSqlite {
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  return sqlite;
}

function seedPre0044(sqlite: RawSqlite): void {
  const insertTenant = sqlite.prepare(
    "INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)",
  );
  insertTenant.run("ten-system", "__system", "System");
  insertTenant.run("ten-zhaopin", "zhaopin", "RAAS-v1");
  insertTenant.run("ten-unrelated", "unrelated", "Unrelated");

  const insertWorkflow = sqlite.prepare(
    "INSERT INTO workflows (id, tenant_id, slug, name, created_at) VALUES (?, ?, ?, ?, ?)",
  );
  insertWorkflow.run(
    "wf-system",
    "ten-system",
    "__system",
    "System code agents",
    10,
  );
  // A same-name system-tenant workflow must never be accepted as canonical.
  insertWorkflow.run(
    "wf-system-decoy",
    "ten-system",
    "decoy",
    "Decoy system workflow",
    11,
  );
  insertWorkflow.run(
    "wf-zhaopin-code",
    "ten-zhaopin",
    "__code_agents__",
    "Legacy tenant copies",
    20,
  );
  insertWorkflow.run(
    "wf-unrelated-code",
    "ten-unrelated",
    "__code_agents__",
    "Unrelated code agents",
    30,
  );
  insertWorkflow.run(
    "wf-unrelated-custom",
    "ten-unrelated",
    "custom-code",
    "Same-name but non-stale workflow",
    31,
  );

  const insertAgent = sqlite.prepare(`
    INSERT INTO agents
      (id, workflow_id, kebab_id, name, title, actor, kind, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'Agent', 'code', 1, ?, ?)
  `);
  insertAgent.run(
    "agt-system-reasoning",
    "wf-system",
    "reasoningAgent",
    "reasoningAgent",
    "Canonical reasoning",
    100,
    101,
  );
  insertAgent.run(
    "agt-system-report",
    "wf-system",
    "reportGenerator",
    "reportGenerator",
    "Canonical report",
    102,
    103,
  );
  insertAgent.run(
    "agt-system-decoy-reasoning",
    "wf-system-decoy",
    "reasoningAgent",
    "reasoningAgent",
    "Wrong workflow",
    104,
    105,
  );
  insertAgent.run(
    "agt-zhaopin-reasoning",
    "wf-zhaopin-code",
    "reasoningAgent",
    "reasoningAgent",
    "Stale reasoning",
    200,
    201,
  );
  insertAgent.run(
    "agt-zhaopin-report",
    "wf-zhaopin-code",
    "reportGenerator",
    "reportGenerator",
    "Stale report",
    202,
    203,
  );
  insertAgent.run(
    "agt-unrelated",
    "wf-unrelated-code",
    "unrelatedAgent",
    "unrelatedAgent",
    "Unrelated agent",
    300,
    301,
  );
  insertAgent.run(
    "agt-unrelated-same-name",
    "wf-unrelated-custom",
    "reasoningAgent",
    "reasoningAgent",
    "Unrelated same-name agent",
    302,
    303,
  );

  const insertWorkflowVersion = sqlite.prepare(`
    INSERT INTO workflow_versions
      (id, workflow_id, version, manifest_json, actions_json, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
  `);
  insertWorkflowVersion.run(
    "wfv-system-current",
    "wf-system",
    "code-current",
    '{"workflow":"system-current"}',
    '{"actions":"system-current"}',
    400,
  );
  insertWorkflowVersion.run(
    "wfv-zhaopin-r1",
    "wf-zhaopin-code",
    "legacy-r1",
    '{"workflow":"reasoning-v1"}',
    '{"actions":"reasoning-v1"}',
    1_001,
  );
  insertWorkflowVersion.run(
    "wfv-zhaopin-r2",
    "wf-zhaopin-code",
    "legacy-r2",
    '{"workflow":"reasoning-v2"}',
    '{"actions":"reasoning-v2"}',
    2_002,
  );
  insertWorkflowVersion.run(
    "wfv-zhaopin-report",
    "wf-zhaopin-code",
    "legacy-report",
    '{"workflow":"report-v1"}',
    '{"actions":"report-v1"}',
    3_003,
  );
  insertWorkflowVersion.run(
    "wfv-unrelated",
    "wf-unrelated-code",
    "unrelated-v1",
    '{"workflow":"unrelated"}',
    '{"actions":"unrelated"}',
    4_004,
  );
  // This orphan caught the old migration's over-broad deletion of every empty
  // __code_agents__ workflow version.
  insertWorkflowVersion.run(
    "wfv-unrelated-orphan",
    "wf-unrelated-code",
    "unrelated-orphan",
    '{"workflow":"unrelated-orphan"}',
    null,
    4_005,
  );
  insertWorkflowVersion.run(
    "wfv-unrelated-same-name",
    "wf-unrelated-custom",
    "same-name-v1",
    '{"workflow":"same-name-unrelated"}',
    null,
    4_006,
  );

  const insertAgentVersion = sqlite.prepare(`
    INSERT INTO agent_versions
      (id, agent_id, workflow_version_id, manifest_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertAgentVersion.run(
    "agv-system-reasoning-current",
    "agt-system-reasoning",
    "wfv-system-current",
    '{"revision":"system-current-reasoning"}',
    500,
    501,
  );
  insertAgentVersion.run(
    "agv-system-report-current",
    "agt-system-report",
    "wfv-system-current",
    '{"revision":"system-current-report"}',
    502,
    503,
  );
  insertAgentVersion.run(
    "agv-zhaopin-r1",
    "agt-zhaopin-reasoning",
    "wfv-zhaopin-r1",
    '{"revision":"reasoning-v1","marker":1}',
    1_101,
    1_111,
  );
  insertAgentVersion.run(
    "agv-zhaopin-r2",
    "agt-zhaopin-reasoning",
    "wfv-zhaopin-r2",
    '{"revision":"reasoning-v2","marker":2}',
    2_202,
    2_222,
  );
  insertAgentVersion.run(
    "agv-zhaopin-report",
    "agt-zhaopin-report",
    "wfv-zhaopin-report",
    '{"revision":"report-v1","marker":3}',
    3_303,
    3_333,
  );
  insertAgentVersion.run(
    "agv-unrelated",
    "agt-unrelated",
    "wfv-unrelated",
    '{"revision":"unrelated"}',
    4_404,
    4_444,
  );
  insertAgentVersion.run(
    "agv-unrelated-same-name",
    "agt-unrelated-same-name",
    "wfv-unrelated-same-name",
    '{"revision":"same-name-unrelated"}',
    4_406,
    4_446,
  );

  const insertRun = sqlite.prepare(`
    INSERT INTO runs
      (id, tenant_id, agent_id, agent_version_id, status, correlation_id, is_test)
    VALUES (?, ?, ?, ?, 'ok', ?, 0)
  `);
  insertRun.run(
    "run-reasoning-v1",
    "ten-zhaopin",
    "agt-zhaopin-reasoning",
    "agv-zhaopin-r1",
    "cor-r1",
  );
  insertRun.run(
    "run-reasoning-v2",
    "ten-zhaopin",
    "agt-zhaopin-reasoning",
    "agv-zhaopin-r2",
    "cor-r2",
  );
  insertRun.run(
    "run-report-v1",
    "ten-zhaopin",
    "agt-zhaopin-report",
    "agv-zhaopin-report",
    "cor-report",
  );
  insertRun.run(
    "run-reasoning-no-version",
    "ten-zhaopin",
    "agt-zhaopin-reasoning",
    null,
    "cor-null",
  );
  insertRun.run(
    "run-unrelated-same-name",
    "ten-unrelated",
    "agt-unrelated-same-name",
    "agv-unrelated-same-name",
    "cor-unrelated",
  );

  const insertDeployment = sqlite.prepare(`
    INSERT INTO deployments
      (id, tenant_id, target, version_id, status, deployed_at, note)
    VALUES (?, ?, 'code_agent', ?, ?, ?, ?)
  `);
  insertDeployment.run(
    "dpl-system-current",
    "ten-system",
    "agv-system-reasoning-current",
    "live",
    700,
    "canonical live",
  );
  insertDeployment.run(
    "dpl-reasoning-v1",
    "ten-zhaopin",
    "agv-zhaopin-r1",
    "rolled_back",
    1_700,
    "reasoning v1 audit",
  );
  insertDeployment.run(
    "dpl-reasoning-v2",
    "ten-zhaopin",
    "agv-zhaopin-r2",
    "live",
    2_700,
    "reasoning v2 audit",
  );
  insertDeployment.run(
    "dpl-report-v1",
    "ten-zhaopin",
    "agv-zhaopin-report",
    "live",
    3_700,
    "report v1 audit",
  );
  insertDeployment.run(
    "dpl-unrelated",
    "ten-unrelated",
    "agv-unrelated",
    "live",
    4_700,
    "unrelated audit",
  );

  sqlite
    .prepare(
      "INSERT INTO events (id, tenant_id, name, source_agent_id, received_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      "evt-stale-source",
      "ten-zhaopin",
      "RULE_CHECKED",
      "agt-zhaopin-reasoning",
      5_000,
    );
}

describe("0044 system-agent scope cleanup migration", () => {
  it("re-homes every historical version without losing provenance or unrelated tenant data", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agentic-system-scope-migration-"),
    );
    roots.push(root);
    const through43 = await migrationsThrough(root, 43);
    const file = path.join(root, "upgrade.db");
    const legacy = applyMigrations(file, through43);
    seedPre0044(legacy);
    legacy.close();

    const upgraded = applyMigrations(file, fullMigrations);
    try {
      const historical = upgraded
        .prepare(
          `
          SELECT
            av.id,
            av.agent_id AS agentId,
            av.manifest_json AS agentManifest,
            av.created_at AS agentCreatedAt,
            av.updated_at AS agentUpdatedAt,
            wv.workflow_id AS workflowId,
            wv.manifest_json AS workflowManifest,
            wv.actions_json AS actionsJson,
            wv.created_at AS workflowCreatedAt
          FROM agent_versions av
          INNER JOIN workflow_versions wv ON wv.id = av.workflow_version_id
          WHERE av.id LIKE 'agv-scope-history-%'
          ORDER BY av.id
        `,
        )
        .all();
      expect(historical).toEqual([
        {
          id: "agv-scope-history-agv-zhaopin-r1",
          agentId: "agt-system-reasoning",
          agentManifest: '{"revision":"reasoning-v1","marker":1}',
          agentCreatedAt: 1_101,
          agentUpdatedAt: 1_111,
          workflowId: "wf-system",
          workflowManifest: '{"workflow":"reasoning-v1"}',
          actionsJson: '{"actions":"reasoning-v1"}',
          workflowCreatedAt: 1_001,
        },
        {
          id: "agv-scope-history-agv-zhaopin-r2",
          agentId: "agt-system-reasoning",
          agentManifest: '{"revision":"reasoning-v2","marker":2}',
          agentCreatedAt: 2_202,
          agentUpdatedAt: 2_222,
          workflowId: "wf-system",
          workflowManifest: '{"workflow":"reasoning-v2"}',
          actionsJson: '{"actions":"reasoning-v2"}',
          workflowCreatedAt: 2_002,
        },
        {
          id: "agv-scope-history-agv-zhaopin-report",
          agentId: "agt-system-report",
          agentManifest: '{"revision":"report-v1","marker":3}',
          agentCreatedAt: 3_303,
          agentUpdatedAt: 3_333,
          workflowId: "wf-system",
          workflowManifest: '{"workflow":"report-v1"}',
          actionsJson: '{"actions":"report-v1"}',
          workflowCreatedAt: 3_003,
        },
      ]);

      const runs = upgraded
        .prepare(
          `
          SELECT id, tenant_id AS tenantId, agent_id AS agentId,
            agent_version_id AS agentVersionId
          FROM runs
          ORDER BY id
        `,
        )
        .all();
      expect(runs).toEqual([
        {
          id: "run-reasoning-no-version",
          tenantId: "ten-zhaopin",
          agentId: "agt-system-reasoning",
          agentVersionId: null,
        },
        {
          id: "run-reasoning-v1",
          tenantId: "ten-zhaopin",
          agentId: "agt-system-reasoning",
          agentVersionId: "agv-scope-history-agv-zhaopin-r1",
        },
        {
          id: "run-reasoning-v2",
          tenantId: "ten-zhaopin",
          agentId: "agt-system-reasoning",
          agentVersionId: "agv-scope-history-agv-zhaopin-r2",
        },
        {
          id: "run-report-v1",
          tenantId: "ten-zhaopin",
          agentId: "agt-system-report",
          agentVersionId: "agv-scope-history-agv-zhaopin-report",
        },
        {
          id: "run-unrelated-same-name",
          tenantId: "ten-unrelated",
          agentId: "agt-unrelated-same-name",
          agentVersionId: "agv-unrelated-same-name",
        },
      ]);

      const deployments = upgraded
        .prepare(
          `
          SELECT id, tenant_id AS tenantId, version_id AS versionId, status,
            deployed_at AS deployedAt, note
          FROM deployments
          ORDER BY id
        `,
        )
        .all();
      expect(deployments).toEqual([
        {
          id: "dpl-reasoning-v1",
          tenantId: "ten-zhaopin",
          versionId: "agv-scope-history-agv-zhaopin-r1",
          status: "rolled_back",
          deployedAt: 1_700,
          note: "reasoning v1 audit",
        },
        {
          id: "dpl-reasoning-v2",
          tenantId: "ten-zhaopin",
          versionId: "agv-scope-history-agv-zhaopin-r2",
          status: "rolled_back",
          deployedAt: 2_700,
          note: "reasoning v2 audit",
        },
        {
          id: "dpl-report-v1",
          tenantId: "ten-zhaopin",
          versionId: "agv-scope-history-agv-zhaopin-report",
          status: "rolled_back",
          deployedAt: 3_700,
          note: "report v1 audit",
        },
        {
          id: "dpl-system-current",
          tenantId: "ten-system",
          versionId: "agv-system-reasoning-current",
          status: "live",
          deployedAt: 700,
          note: "canonical live",
        },
        {
          id: "dpl-unrelated",
          tenantId: "ten-unrelated",
          versionId: "agv-unrelated",
          status: "live",
          deployedAt: 4_700,
          note: "unrelated audit",
        },
      ]);

      expect(
        upgraded
          .prepare(
            "SELECT source_agent_id AS sourceAgentId FROM events WHERE id = 'evt-stale-source'",
          )
          .get(),
      ).toEqual({ sourceAgentId: "agt-system-reasoning" });

      expect(
        upgraded
          .prepare(
            "SELECT id FROM agents WHERE id IN ('agt-zhaopin-reasoning', 'agt-zhaopin-report')",
          )
          .all(),
      ).toEqual([]);
      expect(
        upgraded
          .prepare("SELECT id FROM workflows WHERE id = 'wf-zhaopin-code'")
          .get(),
      ).toBeUndefined();

      // Both kinds of unrelated workflow survive byte-for-byte: another
      // __code_agents__ workflow (including its orphan history) and a same-name
      // reasoningAgent outside the stale workflow slug.
      expect(
        upgraded
          .prepare(
            `
            SELECT id, workflow_id AS workflowId, version, manifest_json AS manifestJson
            FROM workflow_versions
            WHERE id IN ('wfv-unrelated', 'wfv-unrelated-orphan', 'wfv-unrelated-same-name')
            ORDER BY id
          `,
          )
          .all(),
      ).toEqual([
        {
          id: "wfv-unrelated",
          workflowId: "wf-unrelated-code",
          version: "unrelated-v1",
          manifestJson: '{"workflow":"unrelated"}',
        },
        {
          id: "wfv-unrelated-orphan",
          workflowId: "wf-unrelated-code",
          version: "unrelated-orphan",
          manifestJson: '{"workflow":"unrelated-orphan"}',
        },
        {
          id: "wfv-unrelated-same-name",
          workflowId: "wf-unrelated-custom",
          version: "same-name-v1",
          manifestJson: '{"workflow":"same-name-unrelated"}',
        },
      ]);
      expect(
        upgraded
          .prepare(
            "SELECT id FROM agents WHERE id = 'agt-system-decoy-reasoning'",
          )
          .get(),
      ).toEqual({ id: "agt-system-decoy-reasoning" });

      expect(upgraded.pragma("foreign_key_check")).toEqual([]);
    } finally {
      upgraded.close();
    }
  });
});
