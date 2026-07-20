import path from "node:path";
import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, eventTypes, getDb, tenants, workflows } from "@agentic/db";
import {
  agentRegistry,
  bootstrapCodeAgents,
  ensureCodeAgentBinding,
} from "@agentic/agents";
import "@agentic/agents/system";
import { bootstrapTenant } from "@agentic/runtime";
import zhaopinTenant, { LEGACY_RAAS_FUNCTION_IDS } from "@tenants/zhaopin";

const modelDir = path.join(
  process.env.AGENTIC_MODELS_DIR ?? path.resolve(__dirname, "../../../models"),
  "zhaopin-v1",
);

const expected = [
  {
    name: "createJD",
    id: "create-jd-agent",
    // 3 (was 1): recoverable transient generate-jd faults (5xx/429/network/
    // stage-failed) get real retry room, while the manifest's on_error ladder
    // turns deterministic rejections (input_invalid/upstream_rejected/
    // output_invalid) into NonRetriable terminal failures that never burn
    // these attempts — the old AO's B2+B4 error-judgment fix.
    retries: 3,
    triggers: ["REQUIREMENT_LOGGED", "CLARIFICATION_READY", "JD_REJECTED"],
  },
  {
    name: "processResume",
    id: "resume-parser-agent",
    retries: 0,
    triggers: ["RESUME_DOWNLOADED"],
  },
  {
    name: "ruleCheckForCandidateIdentity",
    id: "rule-check-candidate-identity-agent",
    retries: 1,
    triggers: ["CANDIDATE_IDENTITY_REQUESTED"],
  },
  {
    name: "ruleCheckForMatchResume",
    id: "rule-check-agent",
    retries: 3,
    triggers: ["RESUME_PROCESSED"],
  },
  {
    name: "matchResume",
    id: "match-resume-agent",
    retries: 2,
    triggers: ["MATCH_RULE_CHECK_PASSED"],
  },
  {
    name: "inviteInternalInterview",
    id: "interview-inviter-agent",
    retries: 2,
    triggers: ["INTERVIEW_INVITATION_REQUESTED"],
  },
] as const;

function functionId(fn: unknown): string | undefined {
  const typed = fn as {
    id?: (() => string) | string;
    opts?: { id?: string };
  };
  return typeof typed.id === "function"
    ? typed.id.call(fn)
    : typeof typed.id === "string"
      ? typed.id
      : typed.opts?.id;
}

function zhaopinCatalog() {
  return getDb()
    .select({
      name: agents.name,
      kind: agents.kind,
      workflow: workflows.slug,
    })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .innerJoin(tenants, eq(tenants.id, workflows.tenantId))
    .where(eq(tenants.slug, "zhaopin"))
    .all();
}

describe("RAAS-v1 six-function Inngest deployment contract", () => {
  let functions: unknown[] = [];

  beforeAll(async () => {
    await bootstrapCodeAgents();
    const result = await bootstrapTenant({
      tenantSlug: "zhaopin",
      modelDir,
      tenantRegistry: zhaopinTenant,
    });
    functions = result.functions;
  });

  it("registers exactly the six running legacy functions with stable ids and bare triggers", () => {
    expect(LEGACY_RAAS_FUNCTION_IDS).toEqual(
      Object.fromEntries(expected.map((item) => [item.name, item.id])),
    );
    expect(functions).toHaveLength(6);

    const actual = functions.map((fn) => {
      const typed = fn as {
        fn?: unknown;
        opts: {
          name?: string;
          retries?: number;
          triggers: Array<{ event: string }>;
        };
      };
      return {
        id: functionId(fn),
        title: typed.opts.name,
        retries: typed.opts.retries,
        triggers: typed.opts.triggers.map((trigger) => trigger.event),
        runnable: typeof typed.fn === "function",
      };
    });

    expect(actual.map((item) => item.id)).toEqual(
      expected.map((item) => item.id),
    );
    expect(actual.map((item) => item.triggers)).toEqual(
      expected.map((item) => [...item.triggers]),
    );
    expect(actual.map((item) => item.retries)).toEqual(
      expected.map((item) => item.retries),
    );
    expect(actual.every((item) => item.runnable)).toBe(true);

    const zhaopinTenantRow = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "zhaopin"))
      .all()[0]!;
    const catalogNames = getDb()
      .select({ name: eventTypes.name })
      .from(eventTypes)
      .where(eq(eventTypes.tenantId, zhaopinTenantRow.id))
      .all()
      .map((row) => row.name);
    expect(catalogNames).toContain("CANDIDATE_IDENTITY_REQUESTED");
  });

  it("registers standalone reasoning durably without adding it to the RAAS-v1 catalog", async () => {
    const codeSummary = await bootstrapCodeAgents();
    const codeFnIds = codeSummary.codeAgentFns.map(functionId);
    expect(codeFnIds).toContain("__system.code.reasoningAgent");
    expect(codeFnIds).not.toContain("__system.code.reportGenerator");

    const reasoning = agentRegistry.get("reasoningAgent");
    const report = agentRegistry.get("reportGenerator");
    expect(reasoning?.scope).toBe("system");
    expect(report?.scope).toBe("system");
    expect(reasoning?.inngestEnabled).toBe(true);
    expect(report?.inngestEnabled).toBe(false);

    const before = zhaopinCatalog();
    expect(before.map((row) => row.name).sort()).toEqual(
      expected.map((item) => item.name).sort(),
    );
    expect(before.every((row) => row.kind === "manifest")).toBe(true);

    const binding = ensureCodeAgentBinding("zhaopin", reasoning!);
    const systemTenant = getDb()
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .all()[0]!;
    const owner = getDb()
      .select({ tenantId: workflows.tenantId })
      .from(agents)
      .innerJoin(workflows, eq(workflows.id, agents.workflowId))
      .where(eq(agents.id, binding.agentId))
      .all()[0]!;
    expect(owner.tenantId).toBe(systemTenant.id);

    const after = zhaopinCatalog();
    expect(after).toEqual(before);
  });

  it("runs candidate identity as the sixth function from the normal resume chain", async () => {
    const manifest = JSON.parse(
      await readFile(path.join(modelDir, "workflow_v1.json"), "utf8"),
    ) as Array<{
      name: string;
      actions: Array<{
        name: string;
        type: string;
        invoke?: string;
        forward_last_result?: boolean;
      }>;
    }>;
    const processResume = manifest.find(
      (agent) => agent.name === "processResume",
    );
    expect(processResume?.actions).toContainEqual(
      expect.objectContaining({
        name: "invokeCandidateIdentityCheck",
        type: "invoke",
        invoke: "ruleCheckForCandidateIdentity",
        forward_last_result: true,
      }),
    );
    expect(
      processResume?.actions.some(
        (action) => action.name === "candidateDedupLookup",
      ),
    ).toBe(false);

    const createJd = manifest.find((agent) => agent.name === "createJD");
    expect(
      createJd?.actions.map((action) => [action.name, action.type]),
    ).toEqual([
      ["loadRaasRequirement", "tool"],
      ["generateJdApi", "tool"],
      ["persistJd", "tool"],
      ["persistRaasEntities", "tool"],
    ]);
  });
});
