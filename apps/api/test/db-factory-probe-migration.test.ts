import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const requireFromDb = createRequire(path.join(repoRoot, "packages", "db", "package.json"));
const Database = requireFromDb("better-sqlite3") as new (file: string) => RawSqlite;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function migrationsThrough(root: string, lastIdx: number): Promise<string> {
  const folder = path.join(root, `migrations-${lastIdx}`);
  const meta = path.join(folder, "meta");
  await mkdir(meta, { recursive: true });
  const journal = JSON.parse(await readFile(path.join(fullMigrations, "meta", "_journal.json"), "utf8")) as {
    version: string;
    dialect: string;
    entries: Array<{ idx: number; tag: string }>;
  };
  const entries = journal.entries.filter((entry) => entry.idx <= lastIdx);
  await writeFile(path.join(meta, "_journal.json"), `${JSON.stringify({ ...journal, entries }, null, 2)}\n`);
  await Promise.all(entries.map((entry) => copyFile(
    path.join(fullMigrations, `${entry.tag}.sql`),
    path.join(folder, `${entry.tag}.sql`),
  )));
  return folder;
}

function applyMigrations(file: string, folder: string): RawSqlite {
  const sqlite = new Database(file);
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle(sqlite), { migrationsFolder: folder });
  return sqlite;
}

function expectDefinitionScopedProbeIndex(sqlite: RawSqlite): void {
  const indexes = sqlite.prepare("PRAGMA index_list('factory_tool_probes')").all() as Array<{ name: string }>;
  expect(indexes.map((index) => index.name)).toContain("factory_tool_probes_scope_tool_definition_uq");
  expect(indexes.map((index) => index.name)).not.toContain("factory_tool_probes_scope_tool_uq");
  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_integration_profiles'").get()).toBeTruthy();
  const profileColumns = sqlite.prepare("PRAGMA table_info('factory_integration_profiles')").all() as Array<{ name: string }>;
  expect(profileColumns.map((column) => column.name)).toContain("environment");
  const profileIndexes = sqlite.prepare("PRAGMA index_list('factory_integration_profiles')").all() as Array<{ name: string }>;
  expect(profileIndexes.map((index) => index.name)).toContain("factory_integration_profiles_scope_key_uq");

  sqlite.prepare("INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)").run("ten-migration", "migration", "Migration");
  const insert = sqlite.prepare("INSERT INTO factory_tool_probes (id, tenant_id, domain_key, tool_name, status, definition_hash) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run("probe-a", "ten-migration", "RAAS-v1", "ontology.writeInstance", "verified", "hash-a");
  insert.run("probe-b", "ten-migration", "RAAS-v1", "ontology.writeInstance", "verified", "hash-b");
  expect(sqlite.prepare("SELECT count(*) AS count FROM factory_tool_probes WHERE tenant_id = ?").get("ten-migration")).toMatchObject({ count: 2 });
  expect(() => insert.run("probe-a-duplicate", "ten-migration", "RAAS-v1", "ontology.writeInstance", "verified", "hash-a")).toThrow(/UNIQUE/);

  expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='factory_sandbox_model_grants'").get()).toBeTruthy();
  const grantInsert = sqlite.prepare(`
    INSERT INTO factory_sandbox_model_grants
      (attempt_id, bundle_hash, tenant_id, tenant_slug, max_calls, max_total_tokens, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  grantInsert.run("attempt-ok", "bundle-ok", "ten-migration", "migration", 2, 10_000, Date.now() + 60_000);
  expect(() => grantInsert.run("attempt-invalid", "bundle-invalid", "ten-migration", "migration", 0, 10_000, Date.now() + 60_000))
    .toThrow(/CHECK/);
}

describe("factory probe/profile migrations", () => {
  it("runs every migration from an empty SQLite database", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentic-fresh-migrations-"));
    roots.push(root);
    const sqlite = applyMigrations(path.join(root, "fresh.db"), fullMigrations);
    try {
      expectDefinitionScopedProbeIndex(sqlite);
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a database with the legacy per-tool unique index", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentic-upgrade-migrations-"));
    roots.push(root);
    const legacyFolder = await migrationsThrough(root, 39);
    const file = path.join(root, "upgrade.db");
    const legacy = applyMigrations(file, legacyFolder);
    const legacyIndexes = legacy.prepare("PRAGMA index_list('factory_tool_probes')").all() as Array<{ name: string }>;
    expect(legacyIndexes.map((index) => index.name)).toContain("factory_tool_probes_scope_tool_uq");
    legacy.close();

    const upgraded = applyMigrations(file, fullMigrations);
    try {
      expectDefinitionScopedProbeIndex(upgraded);
    } finally {
      upgraded.close();
    }
  });

  it("upgrades legacy profiles as invalid production audit rows and allows a separate sandbox key", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentic-profile-environment-migration-"));
    roots.push(root);
    const preEnvironmentFolder = await migrationsThrough(root, 45);
    const file = path.join(root, "profile-upgrade.db");
    const legacy = applyMigrations(file, preEnvironmentFolder);
    legacy.prepare("INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)").run("ten-profile", "profile", "Profile");
    legacy.prepare(`
      INSERT INTO factory_integration_profiles
        (id, tenant_id, domain_key, tool_name, profile_key, config_json, confirmed_by,
         confirmed_at, tool_definition_digest, config_digest, authorization_protocol_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "profile-legacy",
      "ten-profile",
      "RAAS-v1",
      "vendor.lookup",
      "primary",
      "{}",
      "usr-old",
      1,
      "definition-v2",
      "config-v2",
      2,
    );
    legacy.close();

    const upgraded = applyMigrations(file, fullMigrations);
    try {
      expect(upgraded.prepare("SELECT environment, authorization_protocol_version FROM factory_integration_profiles WHERE id = ?").get("profile-legacy"))
        .toEqual({ environment: "production", authorization_protocol_version: 0 });
      const insert = upgraded.prepare(`
        INSERT INTO factory_integration_profiles
          (id, tenant_id, domain_key, tool_name, profile_key, environment, config_json,
           confirmed_by, confirmed_at, tool_definition_digest, config_digest, authorization_protocol_version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insert.run("profile-sandbox", "ten-profile", "RAAS-v1", "vendor.lookup", "primary", "sandbox", "{}", "usr-new", 2, "definition-v3", "config-v3", 3);
      expect(() => insert.run("profile-production-duplicate", "ten-profile", "RAAS-v1", "vendor.lookup", "primary", "production", "{}", "usr-new", 3, "definition-v3", "config-v3", 3)).toThrow(/UNIQUE/);
      expect(upgraded.prepare("SELECT count(*) AS count FROM factory_integration_profiles WHERE profile_key = ?").get("primary"))
        .toEqual({ count: 2 });
    } finally {
      upgraded.close();
    }
  });

  it("backfills an unguessable sandbox lease token when upgrading 0051 to 0052", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agentic-sandbox-fence-migration-"));
    roots.push(root);
    const preFenceFolder = await migrationsThrough(root, 51);
    const file = path.join(root, "sandbox-fence-upgrade.db");
    const legacy = applyMigrations(file, preFenceFolder);
    legacy.prepare("INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)")
      .run("ten-sandbox-legacy", "af-sbx-legacy", "Legacy sandbox");
    legacy.prepare(`
      INSERT INTO factory_sandbox_attempts
        (id, owner_tenant_id, owner_tenant_slug, target_domain_id,
         candidate_fingerprint, sandbox_tenant_id, sandbox_tenant_slug,
         app_id, status, lease_owner, lease_expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "attempt-legacy-fence",
      "ten-owner-legacy",
      "owner-legacy",
      "Agents-generation",
      "candidate:legacy",
      "ten-sandbox-legacy",
      "af-sbx-00000000-00000000-000000000000-sb",
      "factory-test-af-sbx-00000000-00000000-000000000000-sb",
      "active",
      "legacy-process-owner",
      Date.now() + 60_000,
    );
    legacy.close();

    const upgraded = applyMigrations(file, fullMigrations);
    try {
      const row = upgraded.prepare(`
        SELECT lease_token AS leaseToken, fence_generation AS fenceGeneration
        FROM factory_sandbox_attempts WHERE id = ?
      `).get("attempt-legacy-fence") as { leaseToken: string; fenceGeneration: number };
      expect(row.fenceGeneration).toBe(1);
      expect(row.leaseToken).toMatch(/^[a-f0-9]{64}$/);
      const indexes = upgraded.prepare("PRAGMA index_list('factory_sandbox_attempts')")
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name))
        .toContain("factory_sandbox_attempts_owner_fence_idx");
    } finally {
      upgraded.close();
    }
  });

  it("upgrades 0052 CodeAct rows fail-closed and separates evidence from activation", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "agentic-codeact-activation-migration-"),
    );
    roots.push(root);
    const through52 = await migrationsThrough(root, 52);
    const file = path.join(root, "codeact-activation-upgrade.db");
    const legacy = applyMigrations(file, through52);
    legacy
      .prepare("INSERT INTO tenants (id, slug, name) VALUES (?, ?, ?)")
      .run("ten-codeact-legacy", "codeact-legacy", "Legacy CodeAct");
    legacy
      .prepare(
        "INSERT INTO workflows (id, tenant_id, slug, name) VALUES (?, ?, ?, ?)",
      )
      .run("wf-codeact-legacy", "ten-codeact-legacy", "codeact-legacy-default", "Legacy");
    legacy
      .prepare(
        "INSERT INTO workflow_versions (id, workflow_id, version, manifest_json) VALUES (?, ?, ?, ?)",
      )
      .run("wfv-codeact-legacy", "wf-codeact-legacy", "auto-deadbeef", "[]");
    legacy
      .prepare(
        "INSERT INTO deployments (id, tenant_id, target, version_id, status, note) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        "dpl-codeact-legacy",
        "ten-codeact-legacy",
        "workflow",
        "wfv-codeact-legacy",
        "live",
        "agent-factory-promotion:fpr-evidence",
      );
    legacy.prepare(`
      INSERT INTO factory_codeact_authorizations
        (id, promotion_id, tenant_id, tenant_slug, domain_id, agent_slug,
         promotion_version_id, regression_suite_fingerprint, code_sha256,
         deployment_id, workflow_version_id, review_receipt_id,
         review_selection_hash, regression_artifact, promotion_record_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "fca-codeact-legacy",
      "fpr-evidence",
      "ten-codeact-legacy",
      "codeact-legacy",
      "domain-a",
      "agent-a",
      "version-a",
      `regression-suite:v1:${"a".repeat(64)}`,
      "b".repeat(64),
      "dpl-codeact-legacy",
      "wfv-codeact-legacy",
      "review-evidence",
      `promotion-selection:v1:${"c".repeat(64)}`,
      "factory-drafts/domain-a/versions/version-a/regression.json",
      `factory-promotion-regression:v2:${"d".repeat(64)}`,
    );
    legacy.close();

    const upgraded = applyMigrations(file, fullMigrations);
    try {
      const row = upgraded.prepare(`
        SELECT agent_manifest_sha256 AS agentHash,
               workflow_manifest_sha256 AS workflowHash,
               activation_promotion_id AS activationPromotionId,
               activation_review_receipt_id AS activationReviewReceiptId
        FROM factory_codeact_authorizations WHERE id = ?
      `).get("fca-codeact-legacy");
      expect(row).toEqual({
        agentHash: "",
        workflowHash: "",
        activationPromotionId: "fpr-evidence",
        activationReviewReceiptId: "review-evidence",
      });
      const indexes = upgraded
        .prepare("PRAGMA index_list('factory_codeact_authorizations')")
        .all() as Array<{ name: string }>;
      expect(indexes.map((index) => index.name)).toContain(
        "factory_codeact_authorizations_deployment_agent_uq",
      );
      expect(indexes.map((index) => index.name)).not.toContain(
        "factory_codeact_authorizations_promotion_agent_uq",
      );
      expect(indexes.map((index) => index.name)).not.toContain(
        "factory_codeact_authorizations_identity_uq",
      );
    } finally {
      upgraded.close();
    }
  });
});
