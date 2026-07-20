/**
 * TC-96 — The Agent Factory sandbox manifest is registrable + runnable.
 *
 * `mapToManifest` turns generated specs into the runtime WorkflowManifest the sandbox deploy
 * commits. The regression this guards: previously each generated agent became per-step actions
 * (tool steps named after the step → wrong tool; logic steps → boot-blocking missing prompt). Now
 * each agent maps to ONE `generated` LLM step that (a) passes the manifest Zod schema, (b) carries
 * the global tool roster (preserving only profile-authored tool config), and (c) is skipped
 * by findMissingTenantPrompts so registration never throws on a missing tenant prompt.
 */

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { AgentSchema, WorkflowManifestSchema, assertFactoryExecutionScope, findMissingTenantPrompts, runAction, setRuntimeGateway } from "@agentic/runtime";
import { buildProductionCodeAttestations, mapToManifest } from "../src/services/agent-factory/sandbox-deployer";
import { manifestLintProviderIds } from "../src/services/manifest-import";
import type { GeneratedAgentSpec } from "@agentic/agent-factory";
import { codeActContainerTestOptions } from "./codeact-container-test-transport";

const sandboxTarget = {
  target: "sandbox" as const,
  targetDomainId: "demo-domain",
  candidateFingerprint: "sandbox-evidence:v5:test-candidate",
  sandboxAttemptId: "00000000-0000-4000-8000-000000000001",
};

function spec(p: Partial<GeneratedAgentSpec> & { slug: string; actionName: string }): GeneratedAgentSpec {
  return {
    key: p.actionName,
    actionName: p.actionName,
    slug: p.slug,
    short: `${p.actionName}Agent`,
    domainId: "demo-domain",
    nameZh: p.actionName,
    kind: "llm",
    trigger: p.trigger ?? [],
    emit: p.emit ?? [],
    tools: p.tools ?? [],
    unresolvedTools: p.unresolvedTools ?? [],
    objects: p.objects ?? [],
    systemPrompt: p.systemPrompt ?? "You are an agent. Follow the rules.",
    userPrompt: "",
    steps: p.steps ?? [],
    ruleRefs: [],
    retries: p.retries ?? 1,
    hitl: p.hitl ?? false,
    confidence: 1,
    designReasoning: p.designReasoning ?? "designed for the chain",
    ...p,
  } as unknown as GeneratedAgentSpec;
}

describe("TC-96: sandbox manifest registers + runs generated agents", () => {
  const previousGeneratedExecution = process.env.FACTORY_EXEC_GENERATED;

  beforeAll(() => {
    process.env.FACTORY_EXEC_GENERATED = "1";
  });

  afterAll(() => {
    if (previousGeneratedExecution === undefined) {
      delete process.env.FACTORY_EXEC_GENERATED;
    } else {
      process.env.FACTORY_EXEC_GENERATED = previousGeneratedExecution;
    }
  });

  const specs: GeneratedAgentSpec[] = [
    spec({
      slug: "demo-intake",
      actionName: "IntakeResume",
      trigger: ["RESUME_UPLOADED"],
      emit: ["RESUME_PARSED"],
      tools: ["fs.readFromInbox", "parseResumeApi"],
      toolSideEffects: { "fs.readFromInbox": "read", parseResumeApi: "read" },
      toolPolicies: {
        "fs.readFromInbox": { operation: "read", effectScope: "external", sandboxPolicy: "live_external" },
        parseResumeApi: { operation: "read", effectScope: "external", sandboxPolicy: "live_external" },
      },
    }),
    spec({
      slug: "demo-rules",
      actionName: "CheckRules",
      trigger: ["RESUME_PARSED"],
      emit: ["RULES_PASSED"],
      tools: ["ontology.fetchActionRules"],
      toolSideEffects: { "ontology.fetchActionRules": "read" },
      toolPolicies: {
        "ontology.fetchActionRules": { operation: "read", effectScope: "external", sandboxPolicy: "live_external" },
      },
      toolConfigs: {
        "ontology.fetchActionRules": {
          base_url_env: "RULES_BASE_URL",
          api_key_env: "RULES_API_KEY",
          domain: "demo-domain",
          action: "CheckRules",
        },
      },
      sandboxToolConfigs: {
        "ontology.fetchActionRules": {
          base_url_env: "RULES_BASE_URL",
          api_key_env: "RULES_API_KEY",
          domain: "demo-domain",
          action: "CheckRules",
        },
      },
      unresolvedTools: ["someGhostTool"],
    }),
  ];

  it("maps each agent to a single schema-valid generated logic step", () => {
    const manifest = mapToManifest(specs, sandboxTarget);
    const parsed = manifest.map((a) => AgentSchema.parse(a)); // throws if the schema rejects it
    for (const [index, a] of parsed.entries()) {
      expect(a.generated).toBe(true);
      expect(a.factory_domain_id).toBe("demo-domain");
      expect(a.factory_target_domain_id).toBe("demo-domain");
      expect(a.factory_execution_scope).toMatchObject({
        kind: "sandbox",
        target_domain_id: "demo-domain",
        candidate_fingerprint: sandboxTarget.candidateFingerprint,
        attempt_id: sandboxTarget.sandboxAttemptId,
      });
      expect(a.factory_action_name).toBe(specs[index]!.actionName);
      expect(a.actions).toHaveLength(1);
      expect(a.actions[0]!.type).toBe("logic");
    }
    // trigger/emit preserved for chain wiring.
    expect(parsed[0]!.trigger).toEqual(["RESUME_UPLOADED"]);
    expect(parsed[0]!.triggered_event).toEqual(["RESUME_PARSED"]);
    expect(parsed[1]!.trigger).toEqual(["RESUME_PARSED"]);
  });

  it("does not require production LLM credentials for an all-exact-code nonce sandbox", () => {
    const exact = spec({
      slug: "exact-code-only",
      actionName: "ExactCodeOnly",
      trigger: ["EXACT_REQUESTED"],
      emit: ["EXACT_COMPLETED"],
      codeExecuted: true,
      generatedCode: `export const agent = defineAgent({ async handler(input, ctx) { await ctx.emit("EXACT_COMPLETED", input); return input; } });`,
    });
    const manifest = WorkflowManifestSchema.parse(
      mapToManifest([exact], sandboxTarget),
    );
    expect(manifestLintProviderIds(
      manifest,
      { manifestValidationMode: "sandbox_exact_code" },
      () => {
        throw new Error("production gateway must not be constructed");
      },
      { NODE_ENV: "production" },
    )).toEqual([]);

    const mixed = WorkflowManifestSchema.parse([{
      ...manifest[0],
      codeExecuted: false,
    }]);
    expect(() => manifestLintProviderIds(
      mixed,
      { manifestValidationMode: "sandbox_exact_code" },
      () => [],
      { NODE_ENV: "production" },
    )).toThrow(/every agent.*exact generated code/i);
  });

  it("carries the spec retry budget onto the agent-level manifest field", () => {
    const retrying = spec({
      slug: "demo-retry-budget",
      actionName: "RetryBudget",
      trigger: ["INPUT_READY"],
      emit: ["OUTPUT_READY"],
      retries: 7,
    });
    const manifestAgent = AgentSchema.parse(
      mapToManifest([retrying], sandboxTarget)[0],
    );
    expect(manifestAgent.retries).toBe(7);
  });

  it("preserves the resolved tool roster and profile-authored config; drops unresolved", () => {
    const manifest = mapToManifest(specs, sandboxTarget).map((a) => AgentSchema.parse(a));
    const intakeTools = (manifest[0]!.tool_use ?? []).map((t) => (t as { name: string }).name);
    expect(intakeTools).toEqual(["fs.readFromInbox", "parseResumeApi"]);
    expect(manifest[0]!.tool_use?.[0]).toMatchObject({
      side_effect: "read",
      execution_policy: {
        operation: "read",
        effect_scope: "external",
        sandbox_policy: "live_external",
      },
    });
    const rulesUse = manifest[1]!.tool_use ?? [];
    const frEntry = rulesUse.find((t) => (t as { name: string }).name === "ontology.fetchActionRules") as { config?: Record<string, unknown> };
    expect(frEntry?.config).toEqual({
      base_url_env: "RULES_BASE_URL",
      api_key_env: "RULES_API_KEY",
      domain: "demo-domain",
      action: "CheckRules",
    });
    // the unresolved ghost tool was filtered out.
    expect(rulesUse.map((t) => (t as { name: string }).name)).not.toContain("someGhostTool");
  });

  it("carries attempt-bound cassette hashes only in the sandbox manifest", () => {
    const replayRefs = {
      "demo-intake": {
        parseResumeApi: {
          definition_hash: "a".repeat(64),
          content_hash: "b".repeat(64),
        },
      },
    };
    const sandboxAgent = AgentSchema.parse(mapToManifest(specs, {
      ...sandboxTarget,
      sandboxReplayRefs: replayRefs,
    })[0]);
    expect(sandboxAgent.factory_tool_replay_refs).toEqual(replayRefs["demo-intake"]);

    const productionAgent = AgentSchema.parse(mapToManifest(specs, {
      target: "production",
      targetDomainId: "demo-domain",
      productionProvenance: { versionId: "v-demo", suiteFingerprint: "regression-suite:v1:demo" },
    })[0]);
    expect(productionAgent.factory_tool_replay_refs).toBeUndefined();
    expect(() => AgentSchema.parse({
      ...productionAgent,
      factory_tool_replay_refs: replayRefs["demo-intake"],
    })).toThrow(/sandbox-attempt-only/);
  });

  it("refuses to infer an execution policy when reviewed metadata is missing", () => {
    const missing = spec({
      slug: "demo-no-policy",
      actionName: "NoPolicy",
      tools: ["vendor.lookup"],
      toolSideEffects: { "vendor.lookup": "read" },
    });
    expect(() => mapToManifest([missing], sandboxTarget)).toThrow(/missing reviewed execution-policy metadata/);
  });

  it("never blocks registration on a missing tenant prompt (generated agents are skipped)", () => {
    const manifest = mapToManifest(specs, sandboxTarget).map((a) => AgentSchema.parse(a));
    expect(findMissingTenantPrompts({ manifest, tenantRegistry: {} })).toEqual([]);
  });

  it("a HITL agent keeps its human-approval gate (manual action precedes the logic step)", () => {
    const hitlSpec = spec({ slug: "demo-approve", actionName: "ApproveOffer", trigger: ["OFFER_DRAFTED"], emit: ["OFFER_APPROVED"], tools: [], hitl: true });
    const a = AgentSchema.parse(mapToManifest([hitlSpec], sandboxTarget)[0]);
    expect(a.actor).toEqual(["Human"]);
    expect(a.actions.map((x) => x.type)).toEqual(["manual", "logic"]); // gate THEN the work
    expect(a.generated).toBe(true);
    // the manual gate is type:"manual" so findMissingTenantPrompts (which only flags logic) is fine.
    expect(findMissingTenantPrompts({ manifest: [a], tenantRegistry: {} })).toEqual([]);
  });

  it("carries six-kind input provenance and durable acquisition actions into the runtime manifest", () => {
    const bound = spec({
      slug: "demo-bound",
      actionName: "BoundWork",
      trigger: ["WORK_REQUESTED"],
      emit: ["WORK_DONE"],
      tools: ["records.getWork"],
      toolSideEffects: { "records.getWork": "read" },
      toolPolicies: {
        "records.getWork": { operation: "read", effectScope: "external", sandboxPolicy: "live_external" },
      },
      toolConfigs: { "records.getWork": { api_key_env: "WORK_TOKEN", region: "cn-east" } },
      sandboxToolConfigs: { "records.getWork": { api_key_env: "WORK_TOKEN", region: "cn-east" } },
      toolProfileRefs: { "records.getWork": "profile-1" },
      sandboxToolProfileRefs: { "records.getWork": "sandbox-profile-1" },
      plan: [{ stepId: "calculate", kind: "logic" }],
      inputBindings: [
        { field: "work_id", type: "String", required: true, kind: "event", eventPath: "work_id" },
        { field: "secret_ref", type: "String", required: true, kind: "secret", reference: "tool:records.getWork:api_key_env" },
        { field: "config_ref", type: "String", required: true, kind: "config", reference: "tool:records.getWork:region" },
        { field: "operator_id", type: "String", required: true, kind: "human_input", prompt: "请提供操作员编号" },
        { field: "stored", type: "String", required: true, kind: "object_lookup", sourceObject: "Work.result", tool: "records.getWork", arguments: { id: "bindings.operator_id" }, resultPath: "result", dependsOn: ["operator_id"] },
        { field: "score", type: "Number", required: true, kind: "step_output", sourceStep: "calculate", sourceOutput: "score" },
      ],
    });
    const manifest = AgentSchema.parse(mapToManifest([bound], sandboxTarget)[0]);
    expect(manifest.factory_input_bindings).toHaveLength(6);
    expect(manifest.actions.map((action) => action.type)).toEqual(["manual", "tool", "logic"]);
    expect(manifest.actions[0]!.input_binding).toMatchObject({ kind: "human_input", field: "operator_id" });
    expect(manifest.actions[1]!.input_binding).toMatchObject({ kind: "object_lookup", tool: "records.getWork" });
    expect(JSON.stringify(manifest)).not.toContain("actual-secret");
  });

  it("sandbox executes exact code, while production manifest self-attestation grants no authority", async () => {
    let declarativeCalls = 0;
    setRuntimeGateway({
      chat: async () => {
        declarativeCalls++;
        return {
          text: JSON.stringify({ path: "production-declarative" }),
          provider: "test",
          model: "truthfulness-model",
          tokensIn: 1,
          tokensOut: 1,
          finishReason: "stop",
          latencyMs: 1,
        };
      },
    } as unknown as Parameters<typeof setRuntimeGateway>[0]);

    const generatedCode = `
      import { defineAgent } from "@agentic/runtime";
      export const truthAgent = defineAgent({
        name: "truth-agent",
        async handler(input, ctx) {
          ctx.emit("DONE", { source: "sandbox-code" });
          return { path: "sandbox-code", input };
        },
      });
    `;
    const runnable = spec({
      slug: "demo-truth",
      actionName: "TruthAction",
      trigger: ["START"],
      emit: ["DONE"],
      codeSource: "ai",
      codeExecuted: true,
      generatedCode,
    });

    const sandboxAgent = AgentSchema.parse(mapToManifest([runnable], sandboxTarget)[0]);
    const productionAgent = AgentSchema.parse(mapToManifest([runnable], {
      target: "production",
      targetDomainId: "demo-domain",
      productionCodeAttestations: buildProductionCodeAttestations([runnable]),
      productionProvenance: { versionId: "v-demo", suiteFingerprint: "regression-suite:v1:demo" },
    })[0]);
    expect(sandboxAgent.codeExecuted).toBe(true);
    expect(productionAgent.codeExecuted).toBe(true);
    expect(productionAgent.code_attestation).toEqual(expect.objectContaining({ allow_production: true }));
    expect(productionAgent.typescript_code).toBe(generatedCode);
    expect(productionAgent.actions).toEqual(sandboxAgent.actions);
    expect(productionAgent.factory_execution_scope).toEqual({
      kind: "production",
      target_domain_id: "demo-domain",
    });
    expect(JSON.stringify(productionAgent)).not.toContain(sandboxTarget.sandboxAttemptId);
    expect(JSON.stringify(productionAgent)).not.toContain(sandboxTarget.candidateFingerprint);
    const ephemeralSlug = "af-sbx-1234abcd-5678efab-123456789abc-sb";
    expect(() => assertFactoryExecutionScope(sandboxAgent, ephemeralSlug)).not.toThrow();
    expect(() => assertFactoryExecutionScope(sandboxAgent, "agents-generation")).toThrow(/refuses sandbox app pointer/);
    expect(() => assertFactoryExecutionScope(productionAgent, "agents-generation")).not.toThrow();

    const sandboxExecutor = codeActContainerTestOptions();
    const sandboxOut = await runAction({
      ctx: {
        agentName: sandboxAgent.name,
        actionName: sandboxAgent.actions[0]!.name,
        correlationId: "truth-sandbox",
        tenantSlug: ephemeralSlug,
        event: { name: "START", data: { id: "1" } },
      },
      action: sandboxAgent.actions[0]!,
      agent: {
        id: sandboxAgent.id,
        name: sandboxAgent.name,
        generated: sandboxAgent.generated,
        factoryDomainId: sandboxAgent.factory_domain_id,
        factoryExecutionScope: sandboxAgent.factory_execution_scope,
        codeExecuted: sandboxAgent.codeExecuted,
        typescriptCode: sandboxAgent.typescript_code,
        ontology_instructions: sandboxAgent.ontology_instructions,
      },
      generatedCodeCandidateImage: sandboxExecutor.candidateImage,
      generatedCodeContainerTransport: sandboxExecutor.containerTransport,
    });
    expect(sandboxOut).toMatchObject({ ok: true });
    expect(sandboxOut.data).toEqual(expect.objectContaining({ path: "sandbox-code", _emit: "DONE" }));
    expect(sandboxOut.meta?.codeExecuted).toBe(true);
    expect(declarativeCalls).toBe(0);

    const productionOut = await runAction({
      ctx: {
        agentName: productionAgent.name,
        actionName: productionAgent.actions[0]!.name,
        correlationId: "truth-production",
        tenantSlug: "truth-production",
        event: { name: "START", data: { id: "1" } },
      },
      action: productionAgent.actions[0]!,
      agent: {
        name: productionAgent.name,
        generated: productionAgent.generated,
        codeExecuted: productionAgent.codeExecuted,
        typescriptCode: productionAgent.typescript_code,
        codeAttestation: productionAgent.code_attestation,
        ontology_instructions: productionAgent.ontology_instructions,
      },
    });
    // The manifest's allow/hash attestation is descriptive evidence only. A
    // production handler must also receive the opaque capability minted from
    // the durable promotion ledger; direct runAction callers cannot invent it.
    expect(productionOut.ok).toBe(false);
    expect(productionOut.meta).toMatchObject({
      error: "generated_code_requires_sandbox",
      denialReason: "durable_production_authorization_missing",
      codeExecuted: false,
      codeAttestation: "not_authorized",
    });
    expect(declarativeCalls).toBe(0);

    // A legacy on-disk production manifest may still carry the old true flag. It must fail closed:
    // silently falling back to a declarative LLM call would report success without executing the
    // generated code the persisted evidence claims was executed.
    const legacyProductionOut = await runAction({
      ctx: {
        agentName: productionAgent.name,
        actionName: productionAgent.actions[0]!.name,
        correlationId: "truth-production-legacy",
        tenantSlug: "truth-production",
        event: { name: "START", data: { id: "2" } },
      },
      action: productionAgent.actions[0]!,
      agent: {
        name: productionAgent.name,
        generated: true,
        codeExecuted: true,
        typescriptCode: generatedCode,
        ontology_instructions: productionAgent.ontology_instructions,
      },
    });
    expect(legacyProductionOut.ok).toBe(false);
    expect(legacyProductionOut.meta?.error).toBe("generated_code_requires_sandbox");
    expect(legacyProductionOut.meta?.codeExecuted).toBe(false);
    expect(declarativeCalls).toBe(0);
  });

  it("AI authorship alone never bypasses the executable-code probes", () => {
    const unprobed = spec({
      slug: "demo-unprobed",
      actionName: "UnprobedAction",
      codeSource: "ai",
      codeExecuted: false,
      generatedCode: "export const sourceOnly = defineAgent({ async handler() { return { ok: true }; } });",
    });
    const sandboxAgent = AgentSchema.parse(mapToManifest([unprobed], sandboxTarget)[0]);
    expect(sandboxAgent.codeExecuted).toBe(false);
  });
});
