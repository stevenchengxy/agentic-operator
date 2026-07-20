import { createHash, randomUUID } from "node:crypto";

import {
  sandboxExecutionReceiptIssues,
  type GeneratedAgentSpec,
} from "@agentic/agent-factory";
import { eq, getDb, tenants } from "@agentic/db";
import { tenantInngestIsolationIdentity } from "@agentic/runtime";

import {
  RemoteSandboxDeployer,
  loadRemoteSandboxConnectionConfig,
} from "./remote-sandbox-deployer";

const domain = "__factory-sandbox-probe";
const entryEvent = "FACTORY_SANDBOX_PROBE_REQUESTED";
const completedEvent = "FACTORY_SANDBOX_PROBE_COMPLETED";

export interface FactorySandboxProbeReport {
  schema: "agent-factory-external-sandbox-probe/v1";
  passed: boolean;
  probeId: string;
  attemptId?: string;
  appId?: string;
  functionsRegistered?: number;
  runsObserved?: number;
  exactCodeAgents?: string[];
  cleanupVerified?: boolean;
  appAbsent?: boolean;
  externalLiveCalls?: number | null;
  semanticModel?: unknown;
  candidateExecutions?: unknown[];
  executionReceipt?: unknown;
  executionPlaneIssues?: string[];
  degraded?: string[];
}

function candidateFingerprint(probeId: string): string {
  return `sandbox-evidence:v5:${createHash("sha256")
    .update(probeId, "utf8")
    .digest("hex")}`;
}

function enabledTenantSlugs(env: NodeJS.ProcessEnv): string[] {
  return (env.AGENTIC_ENABLED_TENANTS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function targetTenant(
  requestedTenantSlug: string | undefined,
  env: NodeJS.ProcessEnv,
): { tenantId: string; tenantSlug: string } {
  const enabled = enabledTenantSlugs(env);
  const tenantSlug = requestedTenantSlug?.trim()
    || (enabled.length === 1 ? enabled[0]! : "");
  if (!tenantSlug) {
    throw new Error(
      "FACTORY_SANDBOX_PROBE_TENANT_SLUG is required when more than one tenant is enabled",
    );
  }
  if (enabled.length && !enabled.includes(tenantSlug)) {
    throw new Error(`sandbox probe target tenant '${tenantSlug}' is not enabled in this deployment`);
  }
  const tenant = getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!tenant) throw new Error(`sandbox probe target tenant '${tenantSlug}' does not exist`);
  return { tenantId: tenant.id, tenantSlug };
}

function probeSpec(): GeneratedAgentSpec {
  return {
    key: "FactorySandboxProbe",
    actionName: "FactorySandboxProbe",
    slug: "factory-sandbox-probe-agent",
    short: "FactorySandboxProbeAgent",
    domainId: domain,
    nameZh: "外部沙箱自检",
    kind: "llm",
    trigger: [entryEvent],
    emit: [completedEvent],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "只执行已审查的自包含探针，不访问外部工具。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 0,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    codeSource: "ai",
    codeExecuted: true,
    generatedCode: `
      import { defineAgent } from "@agentic/runtime";
      export const factorySandboxProbeAgent = defineAgent({
        name: "factory-sandbox-probe-agent",
        async handler(input, ctx) {
          const decision = await ctx.reason(
            "Return one JSON object only. This is an isolated connectivity probe; do not call tools.",
            { probe_id: input.probe_id, expected: { ok: true } },
          );
          if (!decision || typeof decision !== "object" || decision._reasonFailed === true) {
            throw new Error("semantic model proxy did not return structured JSON");
          }
          const output = { probe_id: input.probe_id, ok: true };
          await ctx.emit("${completedEvent}", output);
          return output;
        },
      });
    `,
  } as GeneratedAgentSpec;
}

/** Run from the already-supervised API process. This function intentionally
 * owns DB-backed model grants and tenant lookup; the host CLI is HTTP-only and
 * can never create a second SQLite writer. */
export async function runFactorySandboxProbe(input: {
  tenantSlug?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<FactorySandboxProbeReport> {
  const env = input.env ?? process.env;
  const probeId = randomUUID();
  const fingerprint = candidateFingerprint(probeId);
  const { tenantId, tenantSlug } = targetTenant(input.tenantSlug, env);
  const deployer = new RemoteSandboxDeployer({
    tenantScope: { tenantId, tenantSlug },
    connection: loadRemoteSandboxConnectionConfig(env),
    targetInngestIsolation: tenantInngestIsolationIdentity(tenantSlug),
    controlPlaneBuildId:
      env.FACTORY_CONTROL_PLANE_BUILD_ID?.trim() || "local-sandbox-probe",
    pollIntervalMs: 250,
    timeoutMs: 180_000,
  });

  try {
    const result = await deployer.deployAndObserve(domain, [probeSpec()], {
      candidateFingerprint: fingerprint,
      testCases: [{
        id: "external-sandbox-smoke",
        kind: "pass",
        entryEvent,
        payload: { probe_id: probeId },
        expectedEvent: completedEvent,
      }],
    });
    const candidateExecutions =
      result.executionReceipt?.infrastructureCleanup.candidateExecutions ?? [];
    const executionPlaneIssues = sandboxExecutionReceiptIssues(result.executionReceipt);
    const passed =
      result.functionsRegistered === 1
      && result.deployed === 1
      && result.ran >= 1
      && result.fullChainRan === true
      && result.reachedSuccessTerminal === true
      && result.caseVerdicts?.allPass === true
      && result.caseVerdicts.results.length === 1
      && result.cleanupVerified === true
      && result.externalLiveCalls === 0
      && result.sandboxReplayEvidenceComplete === true
      && Boolean(result.executionReceipt)
      && executionPlaneIssues.length === 0
      && (result.modelUsage?.successfulCalls ?? 0) >= 1
      && result.modelUsage?.failedCalls === 0
      && result.modelUsage?.rejectedCalls === 0
      && result.modelUsage?.agentCalls.some((agent) =>
        agent.agentRef === "factory-sandbox-probe-agent" && agent.successfulCalls >= 1) === true
      && Number.isSafeInteger(result.modelUsage?.totalTokens)
      && (result.modelUsage?.totalTokens ?? 0) > 0
      && result.modelUsage?.budget.enforced === true
      && result.modelUsage.budget.reservedTotalTokens > 0
      && result.modelUsage.budget.reservedTotalTokens <= result.modelUsage.budget.maxTotalTokens
      && candidateExecutions.length === 1
      && candidateExecutions.every((execution) =>
        execution.removed === true && execution.absenceVerified === true)
      && result.functionTester?.length === 1
      && result.functionTester.every(
        (entry) => entry.pass && entry.ran && entry.qualification === "promotable",
      );
    return {
      schema: "agent-factory-external-sandbox-probe/v1",
      passed,
      probeId,
      attemptId: result.sandboxAttemptId,
      appId: result.appId,
      functionsRegistered: result.functionsRegistered,
      runsObserved: result.ran,
      exactCodeAgents: result.codeRanAgents ?? [],
      cleanupVerified: result.cleanupVerified === true,
      appAbsent: result.cleanupReceipt?.absence.registryState === "not_registered",
      externalLiveCalls: result.externalLiveCalls,
      semanticModel: result.modelUsage ? {
        successfulCalls: result.modelUsage.successfulCalls,
        failedCalls: result.modelUsage.failedCalls,
        rejectedCalls: result.modelUsage.rejectedCalls,
        totalTokens: result.modelUsage.totalTokens,
        providerModels: result.modelUsage.providerModels,
        agentCalls: result.modelUsage.agentCalls,
        budget: result.modelUsage.budget,
        evidenceHash: result.modelUsage.evidenceHash,
      } : null,
      candidateExecutions: candidateExecutions.map((execution) => ({
        containerIdHash: execution.containerIdHash,
        candidateImageDigest: execution.candidateImageDigest,
        imageId: execution.imageId,
        removed: execution.removed,
        absenceVerified: execution.absenceVerified,
      })),
      executionReceipt: result.executionReceipt ? {
        runnerId: result.executionReceipt.runnerId,
        runnerBuildId: result.executionReceipt.runnerBuildId,
        runtimeImageDigest: result.executionReceipt.runtimeImageDigest,
        isolationTier: result.executionReceipt.isolationTier,
      } : null,
      executionPlaneIssues,
      degraded: result.degradedAgents,
    };
  } finally {
    await deployer.teardown(domain);
  }
}
