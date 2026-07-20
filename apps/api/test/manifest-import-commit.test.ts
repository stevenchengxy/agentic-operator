/**
 * manifest-import — commit-mode coverage.
 *
 * Drives the full path:
 *   - validate happy-v2 (so we know it would commit clean)
 *   - commit happy-v2 cold (no prior live)
 *   - assert: workflow_versions row + deployment row inserted
 *   - assert: agents + agent_versions rows reflect the imported manifest
 *   - assert: event_listeners exist for every trigger
 *   - assert: WORKFLOW_DEPLOYED row appended to the events ledger
 *   - assert: a workflow_v<N+1>.json appeared on disk (or the response says so)
 *   - commit the same manifest again (no-op style) and assert idempotent diff
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { and, desc, eq } from "drizzle-orm";
import {
  agents,
  agentVersions,
  apiTokens,
  auditLog,
  deployments,
  deployments as deploymentsTable,
  eventListeners,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { createHash } from "node:crypto";
import { buildTestEnv, type TestEnv } from "./harness";
import { reregisterInngest } from "../src/services/inngest-registry";
import { __test as manifestImportTest } from "../src/services/manifest-import";

const FIXTURES = path.resolve(__dirname, "fixtures", "manifests");

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
}

function seedTenantWithToken(slug: string): { tenantId: string; token: string } {
  const db = getDb();
  let row = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
  if (!row) {
    const id = makeId("ten");
    db.insert(tenants).values({ id, slug, name: slug, color: "#000" }).run();
    row = db.select().from(tenants).where(eq(tenants.id, id)).all()[0]!;
  }
  const token = "tok-" + makeId("tok");
  const hash = createHash("sha256").update(token).digest("hex");
  db.insert(apiTokens)
    .values({
      id: makeId("tok"),
      tenantId: row.id,
      hash,
      name: `mi-commit-${slug}`,
      scopes: ["*"],
    })
    .run();
  return { tenantId: row.id, token };
}

interface CommitEnvelope {
  ok: boolean;
  data?: {
    ok: true;
    workflow_version_id: string;
    deployment_id: string;
    target: string;
    inngest_fns_registered: number;
    file_written: string;
    prior_deployment_id: string | null;
    note: string;
  };
  error?: { code: string; message: string; hint?: string };
}

describe("manifest-import: commit mode", () => {
  let env: TestEnv;
  // Use the dev tenant (`__system`); see manifest-import-validate.test.ts
  // for the rationale.
  const slug = "__system";
  let tenantId: string;

  beforeAll(async () => {
    env = await buildTestEnv();
    void seedTenantWithToken;
    const db = getDb();
    tenantId = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .all()[0]!.id;
    // Drop any pending stage rows left from prior test files.
    db.delete(deploymentsTable)
      .where(
        and(
          eq(deploymentsTable.tenantId, tenantId),
          eq(deploymentsTable.status, "pending"),
        ),
      )
      .run();
  });

  it("honours the explicit durable import-staging root", () => {
    const previous = process.env.AGENTIC_IMPORTS_DIR;
    const configured = path.join(tmpdir(), "agentic-models", ".imports");
    try {
      process.env.AGENTIC_IMPORTS_DIR = configured;
      expect(path.resolve(manifestImportTest.importsRoot())).toBe(
        path.resolve(configured),
      );
    } finally {
      if (previous === undefined) delete process.env.AGENTIC_IMPORTS_DIR;
      else process.env.AGENTIC_IMPORTS_DIR = previous;
    }
  });

  it("cold commit of happy-v2 inserts a live deployment and writes a file", async () => {
    const workflow = await loadFixture("happy-v2.json");

    // validate first (assert ok)
    const v = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "validate", workflow }),
    });
    expect(v.status).toBe(200);

    // commit
    const res = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      // confirm_overwrite=true because __system already has agents from prior
      // tests; the import will be considered an overwrite of a live workflow.
      body: JSON.stringify({ mode: "commit", workflow, confirm_overwrite: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommitEnvelope;
    expect(body.ok).toBe(true);
    expect(body.data!.ok).toBe(true);
    expect(body.data!.workflow_version_id).toMatch(/^wfv-/);
    expect(body.data!.deployment_id).toMatch(/^dpl-/);
    // __system may already have a live deployment from prior tests.

    // DB assertions
    const db = getDb();
    const wfvRow = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, body.data!.workflow_version_id))
      .all()[0];
    expect(wfvRow).toBeDefined();
    const live = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(live.length).toBe(1);
    expect(live[0]!.id).toBe(body.data!.deployment_id);

    // Agent rows
    const wfRow = db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          eq(workflows.slug, "__system-default"),
        ),
      )
      .all()[0]!;
    const agentRows = db
      .select()
      .from(agents)
      .where(eq(agents.workflowId, wfRow.id))
      .all();
    // At minimum the 5 imported kebab ids should appear (after prior test
    // runs they may already exist; upserts dedupe on workflow_id+kebab_id).
    const kebabs = agentRows.map((r) => r.kebabId);
    for (const k of ["intake-v2", "validate-payload-v2", "enrich-v2", "decide-v2", "notify-v2"]) {
      expect(kebabs).toContain(k);
    }

    // Agent versions
    const agvRows = db
      .select()
      .from(agentVersions)
      .where(eq(agentVersions.workflowVersionId, body.data!.workflow_version_id))
      .all();
    expect(agvRows.length).toBe(5);

    // Event listeners
    for (const a of agentRows) {
      const listeners = db
        .select()
        .from(eventListeners)
        .where(eq(eventListeners.agentId, a.id))
        .all();
      // Every imported agent had ≥1 trigger; live data may have extra
      // agents from prior tests (none here, but still safe).
      if (
        a.kebabId === "intake-v2" ||
        a.kebabId === "notify-v2" ||
        a.kebabId === "decide-v2" ||
        a.kebabId === "enrich-v2" ||
        a.kebabId === "validate-payload-v2"
      ) {
        expect(listeners.length).toBeGreaterThanOrEqual(1);
      }
    }

    // Manifest-commit audit row. The `events` table is reserved for the
    // Inngest ledger now (see manifest-import.ts §Observability); commit
    // audit traffic lives in `audit_log` with action="manifest.import.commit".
    const auditEv = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, "manifest.import.commit"),
        ),
      )
      .all();
    expect(auditEv.length).toBeGreaterThanOrEqual(1);

    // Disk file written
    if (body.data!.file_written && !body.data!.file_written.startsWith("(failed")) {
      const st = await stat(body.data!.file_written);
      expect(st.isFile()).toBe(true);
    }
  });

  it("subsequent commit of the same manifest demotes the prior and inserts a new one", async () => {
    const workflow = await loadFixture("happy-v2.json");

    const res = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "commit", workflow, confirm_overwrite: true }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as CommitEnvelope;
    expect(body.data!.prior_deployment_id).not.toBeNull();

    // Exactly one live row remains for this tenant.
    const db = getDb();
    const live = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(live).toHaveLength(1);
  });

  // Regression: re-validate + re-commit of an identical-content manifest
  // used to crash on `SQLITE_CONSTRAINT_UNIQUE:
  // workflow_versions.workflow_id, workflow_versions.version`. The pending
  // wfv's promotion UPDATE collided with the prior commit's `auto-<hash>`
  // row. The fix redirects the pending deployment at the existing wfv and
  // drops the orphan pending wfv inside the same atomic tx.
  it("re-validate + re-commit of an identical manifest reuses the prior wfv", async () => {
    const workflow = await loadFixture("happy-v2.json");
    const db = getDb();

    // Ensure prior live wfv exists with version auto-<hash>.
    const priorLive = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all()[0]!;
    const priorWfvId = priorLive.versionId;
    const priorWfvRow = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, priorWfvId))
      .all()[0]!;
    expect(priorWfvRow.version).toMatch(/^auto-/);

    // Phase A: re-validate creates a NEW pending wfv with `pending-<dpl>`.
    const v = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "validate", workflow }),
    });
    expect(v.status).toBe(200);
    const vBody = (await v.json()) as {
      ok: boolean;
      data: { deployment_id: string; workflow_version_id: string };
    };
    const newDpl = vBody.data.deployment_id;
    const pendingWfvId = vBody.data.workflow_version_id;
    expect(pendingWfvId).not.toBe(priorWfvId);
    const pendingRow = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, pendingWfvId))
      .all()[0]!;
    expect(pendingRow.version).toBe(`pending-${newDpl}`);

    // Phase B: commit. Pre-fix this returned 500 with the UNIQUE error.
    const c = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "commit",
        workflow,
        deployment_id: newDpl,
        confirm_overwrite: true,
      }),
    });
    expect(c.status).toBe(200);
    const cBody = (await c.json()) as CommitEnvelope;
    expect(cBody.ok).toBe(true);
    expect(cBody.data!.ok).toBe(true);
    // The commit should redirect at the existing wfv, not the orphan pending.
    expect(cBody.data!.workflow_version_id).toBe(priorWfvId);
    expect(cBody.data!.deployment_id).toBe(newDpl);
    expect(cBody.data!.prior_deployment_id).toBe(priorLive.id);

    // The orphaned pending wfv must be gone (cascade-safe — no agent_versions
    // had been written against it yet).
    const orphan = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, pendingWfvId))
      .all();
    expect(orphan).toHaveLength(0);

    // Still exactly one live deployment.
    const live = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(live).toHaveLength(1);
    expect(live[0]!.versionId).toBe(priorWfvId);
  });

  // Regression: a `skip` resolution on an agent-level structural blocker
  // drops that agent, but the remaining manifest is still not deployable when
  // its logic action has no real tenant prompt. The database/file phase used
  // to commit before runtime bootstrap discovered that error, leaving the
  // invalid head live and poisoning every later boot. A failed activation must
  // now restore the exact last-good live deployment and its runtime registry.
  it("runtime-invalid resolved manifest restores the last-good deployment", async () => {
    const workflow = await loadFixture("orphan-plus-happy.json");

    // Sanity: a raw commit (no resolutions) is refused with orphan_actor.
    const refused = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "commit",
        workflow,
        confirm_overwrite: true,
      }),
    });
    expect(refused.status).toBe(400);
    const refusedBody = (await refused.json()) as {
      ok: boolean;
      error?: { code?: string };
    };
    expect(refusedBody.ok).toBe(false);
    expect(refusedBody.error?.code).toBe("blocking_issues");

    const db = getDb();
    const priorLive = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all()[0]!;
    expect(priorLive.filePath).toBeTruthy();
    const modelDir = path.dirname(priorLive.filePath!);
    const filesBefore = (await readdir(modelDir)).sort();
    const deploymentIdsBefore = new Set(
      db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.tenantId, tenantId),
            eq(deployments.target, "workflow"),
          ),
        )
        .all()
        .map((row) => row.id),
    );
    const wf = db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenantId),
          eq(workflows.slug, "__system-default"),
        ),
      )
      .all()[0]!;
    const agentsBefore = db
      .select()
      .from(agents)
      .where(eq(agents.workflowId, wf.id))
      .all();
    const listenersBefore = agentsBefore
      .flatMap((agent) =>
        db
          .select()
          .from(eventListeners)
          .where(eq(eventListeners.agentId, agent.id))
          .all(),
      )
      .map((row) => `${row.agentId}:${row.eventName}`)
      .sort();

    // The skip resolution itself is honoured, then strict runtime bootstrap
    // rejects the surviving prompt-less logic action.
    const res = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "commit",
        workflow,
        confirm_overwrite: true,
        conflict_resolutions: [
          { path: "agents[0].tool_use", action: "skip" },
        ],
      }),
    });
    expect(res.status).toBe(500);

    const liveAfter = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(liveAfter).toHaveLength(1);
    expect(liveAfter[0]).toMatchObject({
      id: priorLive.id,
      versionId: priorLive.versionId,
      filePath: priorLive.filePath,
      status: "live",
    });
    expect((await readdir(modelDir)).sort()).toEqual(filesBefore);

    const newDeployments = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
        ),
      )
      .all()
      .filter((row) => !deploymentIdsBefore.has(row.id));
    expect(newDeployments).toHaveLength(1);
    expect(newDeployments[0]).toMatchObject({
      status: "rolled_back",
      filePath: null,
    });

    const agentsAfter = db
      .select()
      .from(agents)
      .where(eq(agents.workflowId, wf.id))
      .all();
    for (const prior of agentsBefore) {
      expect(agentsAfter.find((agent) => agent.id === prior.id)).toEqual(prior);
    }
    for (const created of agentsAfter.filter(
      (agent) => !agentsBefore.some((prior) => prior.id === agent.id),
    )) {
      expect(created.enabled).toBe(false);
      expect(
        db
          .select()
          .from(eventListeners)
          .where(eq(eventListeners.agentId, created.id))
          .all(),
      ).toHaveLength(0);
    }
    const listenersAfter = agentsAfter
      .flatMap((agent) =>
        db
          .select()
          .from(eventListeners)
          .where(eq(eventListeners.agentId, agent.id))
          .all(),
      )
      .map((row) => `${row.agentId}:${row.eventName}`)
      .sort();
    expect(listenersAfter).toEqual(listenersBefore);

    const failureAudit = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, "manifest.import.fail_swap"),
        ),
      )
      .orderBy(desc(auditLog.at))
      .all()[0]!;
    expect(failureAudit.targetId).toBe(newDeployments[0]!.id);
    expect(failureAudit.metaJson).toMatchObject({
      recovery_complete: true,
      artifact_cleanup_ok: true,
      database_restore_ok: true,
      local_registry_restore_ok: true,
      broker_restore_ok: true,
    });
    expect(
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "manifest.import.commit"),
            eq(auditLog.targetId, newDeployments[0]!.id),
          ),
        )
        .all(),
    ).toHaveLength(0);

    // A fresh rebuild against the restored disk head proves this failure did
    // not merely fix the SQL status while leaving boot poisoned.
    await expect(
      reregisterInngest({ tenantSlug: slug, scope: "tenant" }),
    ).resolves.toMatchObject({ scope: "tenant" });
  });

  it("broker rejection keeps the restored DB and file head even when recovery sync also fails", async () => {
    const workflow = (await loadFixture("happy-v2.json")) as {
      agents: Array<Record<string, unknown>>;
    };

    const db = getDb();
    const priorLive = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all()[0]!;

    // Exercise the wizard promotion branch, including its hardest collision:
    // validating content identical to the live manifest creates a pending WFV;
    // phase 3 redirects at the existing auto-<hash> WFV and deletes that
    // pending WFV. Compensation must recreate both pending rows exactly.
    const validation = await env.fetch(
      `/v1/tenants/${slug}/manifest-import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "validate", workflow }),
      },
    );
    expect(validation.status).toBe(200);
    const validationBody = (await validation.json()) as {
      ok: boolean;
      data: { deployment_id: string; workflow_version_id: string };
    };
    const pendingBefore = db
      .select()
      .from(deployments)
      .where(eq(deployments.id, validationBody.data.deployment_id))
      .all()[0]!;
    const pendingWfvBefore = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, validationBody.data.workflow_version_id))
      .all()[0]!;
    expect(pendingBefore.status).toBe("pending");
    expect(pendingWfvBefore.version).toBe(
      `pending-${validationBody.data.deployment_id}`,
    );

    const modelDir = path.dirname(priorLive.filePath!);
    const filesBefore = (await readdir(modelDir)).sort();
    const idsBefore = new Set(
      db
        .select({ id: deployments.id })
        .from(deployments)
        .where(
          and(
            eq(deployments.tenantId, tenantId),
            eq(deployments.target, "workflow"),
          ),
        )
        .all()
        .map((row) => row.id),
    );

    const oldDisabled = process.env.INNGEST_SYNC_DISABLED;
    const oldOrigin = process.env.INNGEST_SERVE_ORIGIN;
    process.env.INNGEST_SYNC_DISABLED = "0";
    process.env.INNGEST_SERVE_ORIGIN = "http://127.0.0.1:1";
    let res: Response;
    try {
      res = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "commit",
          workflow,
          deployment_id: validationBody.data.deployment_id,
          confirm_overwrite: true,
        }),
      });
    } finally {
      if (oldDisabled === undefined) delete process.env.INNGEST_SYNC_DISABLED;
      else process.env.INNGEST_SYNC_DISABLED = oldDisabled;
      if (oldOrigin === undefined) delete process.env.INNGEST_SERVE_ORIGIN;
      else process.env.INNGEST_SERVE_ORIGIN = oldOrigin;
    }
    expect(res!.status).toBe(500);

    const liveAfter = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(liveAfter).toHaveLength(1);
    expect(liveAfter[0]).toMatchObject({
      id: priorLive.id,
      versionId: priorLive.versionId,
      filePath: priorLive.filePath,
    });
    expect((await readdir(modelDir)).sort()).toEqual(filesBefore);
    const deploymentsAfter = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
        ),
      )
      .all();
    expect(deploymentsAfter.filter((row) => !idsBefore.has(row.id))).toHaveLength(0);
    expect(
      deploymentsAfter.find((row) => row.id === pendingBefore.id),
    ).toEqual(pendingBefore);
    expect(
      db
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, pendingWfvBefore.id))
        .all()[0],
    ).toEqual(pendingWfvBefore);

    const failureAudit = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, "manifest.import.fail_swap"),
        ),
      )
      .orderBy(desc(auditLog.at))
      .all()[0]!;
    expect(failureAudit.targetId).toBe(pendingBefore.id);
    expect(failureAudit.metaJson).toMatchObject({
      recovery_complete: false,
      artifact_cleanup_ok: true,
      database_restore_ok: true,
      local_registry_restore_ok: true,
      broker_restore_ok: false,
    });

    // Restoring test-mode broker suppression and rebuilding must still work;
    // the failed recovery PUT did not reverse the DB/file compensation.
    await expect(
      reregisterInngest({ tenantSlug: slug, scope: "tenant" }),
    ).resolves.toMatchObject({ scope: "tenant" });
  });

  it("filesystem activation failure never leaves the rejected manifest live", async () => {
    const isolatedSlug = `rename-failure-${makeId("ten").slice(-8)}`;
    const { tenantId: isolatedTenantId } = seedTenantWithToken(isolatedSlug);
    const workflow = await loadFixture("happy-v2.json");
    const tempRoot = await mkdtemp(path.join(tmpdir(), "agentic-manifest-rename-"));
    const modelsDir = path.join(tempRoot, "models");
    const importsDir = path.join(tempRoot, "imports");
    const blockedTenantModelPath = path.join(modelsDir, `${isolatedSlug}-v1`);
    await mkdir(modelsDir, { recursive: true });
    await mkdir(importsDir, { recursive: true });
    // A non-directory at the exact tenant model path makes the phase-4 mkdir
    // fail deterministically on every supported filesystem.
    await writeFile(blockedTenantModelPath, "pre-existing non-directory\n", "utf8");

    const oldModelsDir = process.env.AGENTIC_MODELS_DIR;
    const oldImportsDir = process.env.AGENTIC_IMPORTS_DIR;
    // The manifest can be staged, but its durable model destination cannot be
    // reserved. This exercises the phase-3 -> phase-4 compensation boundary.
    process.env.AGENTIC_MODELS_DIR = modelsDir;
    process.env.AGENTIC_IMPORTS_DIR = importsDir;
    let response: Response;
    try {
      response = await env.fetch(
        `/v1/tenants/${isolatedSlug}/manifest-import`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agentic-tenant": isolatedSlug,
          },
          body: JSON.stringify({
            mode: "commit",
            workflow,
            confirm_overwrite: true,
          }),
        },
      );
    } finally {
      if (oldModelsDir === undefined) delete process.env.AGENTIC_MODELS_DIR;
      else process.env.AGENTIC_MODELS_DIR = oldModelsDir;
      if (oldImportsDir === undefined) delete process.env.AGENTIC_IMPORTS_DIR;
      else process.env.AGENTIC_IMPORTS_DIR = oldImportsDir;
    }

    expect(response!.status).toBe(500);
    const db = getDb();
    const tenantDeployments = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, isolatedTenantId),
          eq(deployments.target, "workflow"),
        ),
      )
      .all();
    expect(tenantDeployments).toHaveLength(1);
    expect(tenantDeployments[0]).toMatchObject({
      status: "rolled_back",
      filePath: null,
    });
    expect(tenantDeployments.some((row) => row.status === "live")).toBe(false);
    expect(await readFile(blockedTenantModelPath, "utf8")).toBe(
      "pre-existing non-directory\n",
    );
    expect(await readdir(importsDir)).toEqual([]);

    const failureAudit = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, isolatedTenantId),
          eq(auditLog.action, "manifest.import.fail_rename"),
        ),
      )
      .orderBy(desc(auditLog.at))
      .all()[0]!;
    expect(failureAudit.metaJson).toMatchObject({
      recovery_complete: true,
      database_restore_ok: true,
    });
    expect(
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.action, "manifest.import.commit"),
            eq(auditLog.targetId, tenantDeployments[0]!.id),
          ),
        )
        .all(),
    ).toHaveLength(0);

    await rm(tempRoot, { recursive: true, force: true });
  });
});
