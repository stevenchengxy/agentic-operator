/**
 * TC-11 — bootstrap idempotency + ON CONFLICT DO NOTHING.
 *
 * Targets:
 *   - P0-RT-07: re-running bootstrapTenant with an unchanged manifest does
 *     NOT roll back the live deployment.
 *   - P0-RT-07: `AGENTIC_REBOOTSTRAP=force` forces a fresh deployment row.
 *   - P0-MIG-02: rebooting back-to-back doesn't crash on uniqueness conflicts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  bootstrapTenant,
  assertTenantRegistryComplete,
} from "@agentic/runtime";
import raasTenant from "@tenants/raas";
import {
  agents,
  agentVersions,
  deployments,
  getDb,
  tenants,
  workflows,
} from "@agentic/db";

const MODEL_DIR = (process.env.AGENTIC_MODELS_DIR ?? "./models") + "/RAAS-v1";

/**
 * Sprint 4 — F-S3-1 follow-up: lock down the raas registry contract so a
 * future test that mutates the shared `raasTenant` object (e.g. by deleting
 * a prompt key in a partial cleanup) trips a clear failure HERE instead of
 * surfacing as the cryptic "27 logic action(s) have no tenant definePrompt"
 * boot error inside `bootstrapTenant`. Keep this list in sync with the
 * `logic` actions in the latest deployed RAAS manifest (currently
 * `workflow_v5.json`); the boot validator itself re-derives this list at
 * runtime, so a manifest edit forces this test to update too. In v5 the old
 * LLM-owned invitation composition/notification pair was deliberately
 * replaced by a real RoboHire send + durable receipt + deterministic route.
 */
const REQUIRED_RAAS_PROMPTS: readonly string[] = [
  "assessFeasibilityAndDifficulty",
  "generateClarificationAndStrategy",
  "prepareClarificationMaterial",
  "recordAndValidateResult",
  "generateJDContent",
  "handleRequisitionMapping",
  "assignRecruitTasks",
  "validateCompleteness",
  "validateCandidacy",
  "检查客户规则",
  "validateRedlineAndBlacklist",
  "matchHardRequirements",
  "evaluateBonusAndCheckReflux",
  "decideMatchOutcome",
  "receiveInterviewResult",
  "analyzeInterviewResult",
  "evaluateWithModel",
  "generateEvaluationReport",
  "selectTemplateAndFormat",
  "generateRefinedResume",
  "checkCompleteness",
  "requestMissingInfo",
  "generateFinalPackage",
  "prepareSubmissionData",
  "handleSubmissionResult",
];

describe("TC-11: bootstrap idempotency (P0-RT-07 + P0-MIG-02)", () => {
  beforeAll(async () => {
    // Make sure the api/server has run (which seeds the __system tenant etc.).
    const { buildTestEnv } = await import("./harness");
    await buildTestEnv();
  });

  beforeEach(() => {
    // Assert that the in-memory raas registry is intact. There is no global
    // prompt cache to reset; keeping a no-op reset hook only hid dead code.
    assertTenantRegistryComplete("raas", raasTenant, REQUIRED_RAAS_PROMPTS);
  });

  afterEach(() => {
    delete process.env.AGENTIC_REBOOTSTRAP;
  });

  it("two back-to-back bootstrapTenant calls don't crash on uniqueness conflicts", async () => {
    // First boot (baseline). The harness already booted once, so we expect
    // both calls to be no-ops for the deployment row.
    const a = await bootstrapTenant({
      tenantSlug: "raas",
      modelDir: MODEL_DIR,
      tenantRegistry: raasTenant,
    });
    const b = await bootstrapTenant({
      tenantSlug: "raas",
      modelDir: MODEL_DIR,
      tenantRegistry: raasTenant,
    });
    expect(a.workflowVersion.id).toBe(b.workflowVersion.id);
    expect(a.deploymentInserted).toBe(false);
    expect(b.deploymentInserted).toBe(false);
  });

  it("does NOT roll back the prior live deployment on a no-op reboot (P0-RT-07)", async () => {
    const db = getDb();
    const tenant = db.select().from(tenants).where(eq(tenants.slug, "raas")).all()[0]!;
    const beforeLive = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenant.id),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    await bootstrapTenant({ tenantSlug: "raas", modelDir: MODEL_DIR, tenantRegistry: raasTenant });
    const afterLive = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenant.id),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(afterLive.length).toBe(beforeLive.length);
    // And the live deployment id is the SAME row, not a fresh insert.
    if (beforeLive[0] && afterLive[0]) {
      expect(afterLive[0].id).toBe(beforeLive[0].id);
    }
  });

  it("AGENTIC_REBOOTSTRAP=force inserts a fresh deployment row", async () => {
    process.env.AGENTIC_REBOOTSTRAP = "force";
    const db = getDb();
    const tenant = db.select().from(tenants).where(eq(tenants.slug, "raas")).all()[0]!;
    const before = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenant.id),
          eq(deployments.target, "workflow"),
        ),
      )
      .all();
    const beforeLiveCount = before.filter((d) => d.status === "live").length;

    const result = await bootstrapTenant({ tenantSlug: "raas", modelDir: MODEL_DIR, tenantRegistry: raasTenant });

    const after = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenant.id),
          eq(deployments.target, "workflow"),
        ),
      )
      .all();
    const afterLiveCount = after.filter((d) => d.status === "live").length;

    expect(result.deploymentInserted).toBe(true);
    expect(after.length).toBe(before.length + 1);
    // Exactly one live row remains.
    expect(afterLiveCount).toBe(Math.max(1, beforeLiveCount));
  });

  it("agents/agent_versions inserts don't double-add on second boot", async () => {
    const db = getDb();
    const wf = db
      .select()
      .from(workflows)
      .where(eq(workflows.slug, "raas-default"))
      .all()[0]!;
    const a1 = db
      .select()
      .from(agents)
      .where(eq(agents.workflowId, wf.id))
      .all()
      .length;
    const av1 = db.select().from(agentVersions).all().length;
    await bootstrapTenant({ tenantSlug: "raas", modelDir: MODEL_DIR, tenantRegistry: raasTenant });
    const a2 = db
      .select()
      .from(agents)
      .where(eq(agents.workflowId, wf.id))
      .all()
      .length;
    const av2 = db.select().from(agentVersions).all().length;
    expect(a2).toBe(a1);
    expect(av2).toBe(av1);
  });
});
