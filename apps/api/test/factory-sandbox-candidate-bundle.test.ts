import type { GeneratedAgentSpec } from "@agentic/agent-factory";
import type { CanonicalCassetteDocument } from "@agentic/shared/cassette";
import { describe, expect, it } from "vitest";

import {
  buildSandboxCandidateBundle,
  sandboxCandidateBundleHash,
  sandboxToolBindingId,
} from "../src/services/agent-factory/sandbox-bundle-builder";
import { canonicalSandboxSha256 } from "../src/services/agent-factory/sandbox-remote-protocol";
import { makeTargetInngestIsolationIdentity } from "./factory-sandbox-execution-fixture";
import { validateSandboxCandidateBundle } from "../src/services/agent-factory/sandbox-runner-executor";

const definitionHash = "a".repeat(64);
const specSlug = "agents-generation-check-candidate";
const sandboxConfig = { api_key_env: "SANDBOX_CANDIDATE_KEY" };
const configHash = canonicalSandboxSha256(sandboxConfig);
const bindingId = sandboxToolBindingId({
  specSlugs: [specSlug],
  toolName: "candidate.lookup",
  configHash,
  definitionHash,
});

function spec(overrides: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "CheckCandidate",
    actionName: "CheckCandidate",
    slug: specSlug,
    short: "CheckCandidateAgent",
    domainId: "Agents-generation",
    nameZh: "检查候选人",
    kind: "llm",
    trigger: ["CANDIDATE_RECEIVED"],
    emit: ["CANDIDATE_CHECKED"],
    tools: ["candidate.lookup"],
    toolSideEffects: { "candidate.lookup": "read" },
    toolPolicies: {
      "candidate.lookup": {
        operation: "read",
        effectScope: "external",
        sandboxPolicy: "live_external",
      },
    },
    sandboxToolConfigs: {
      "candidate.lookup": sandboxConfig,
    },
    unresolvedTools: [],
    objects: ["Candidate"],
    systemPrompt: "按已审查规则处理候选人。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    plan: [{
      stepId: "lookup-candidate",
      kind: "tool",
      tool: "candidate.lookup",
    }],
    generatedCode: "export const generatedFunction = { id: 'check-candidate' };",
    // A tool-bearing workflow is owned by the durable declarative runtime.
    // generatedCode remains a review artifact, not a competing executor.
    codeExecuted: false,
    ...overrides,
  } as GeneratedAgentSpec;
}

function cassette(): CanonicalCassetteDocument {
  return {
    version: 1,
    tool: { name: "candidate.lookup", definitionHash },
    evidence: {
      recordedAt: "2026-07-15T08:00:00.000Z",
      mode: "signed-fixture",
    },
    entries: [
      {
        key: "cassette-entry-1",
        request: {
          kind: "tool",
          toolName: "candidate.lookup",
          argsHash: "args-hash",
        },
        response: { status: 200, body: { found: true } },
      },
    ],
  };
}

function build() {
  return buildSandboxCandidateBundle({
    attemptId: "00000000-0000-4000-8000-000000000011",
    candidateFingerprint: "sandbox-evidence:v5:candidate-bundle-test",
    targetDomainId: "Agents-generation",
    targetTenant: {
      tenantId: "tenant-agents-generation",
      tenantSlug: "agents-generation",
      registryVersion: "agents-generation@1.2.3",
    },
    tenantRegistry: {
      schema: "agent-factory-sandbox-tenant-registry/v1",
      tenantSlug: "agents-generation",
      selectedVersion: "agents-generation@1.2.3",
      registrySource: null,
      promptNames: [],
      eventAdapter: null,
    },
    targetInngestIsolation: makeTargetInngestIsolationIdentity("agents-generation"),
    controlPlaneBuildId: "api-build-test",
    specs: [spec()],
    toolDefinitions: [
      {
        bindingId,
        specSlugs: [specSlug],
        toolName: "candidate.lookup",
        configHash,
        source: "declarative",
        definition: {
          schema: "agent-factory-declarative-http-tool/v1",
          name: "candidate.lookup",
          method: "POST",
          urlTemplate: "https://sandbox.invalid/candidates/lookup",
          headers: { Authorization: "Bearer ${SANDBOX_CANDIDATE_KEY}" },
        },
        definitionHash,
      },
    ],
    toolEvidence: [
      {
        bindingId,
        specSlugs: [specSlug],
        toolName: "candidate.lookup",
        configHash,
        definitionHash,
        cassette: cassette(),
      },
    ],
    now: new Date("2026-07-15T08:00:00.000Z"),
  });
}

describe("external sandbox candidate bundle", () => {
  it("is self-contained, immutable and replay-only", () => {
    const bundle = build();
    expect(sandboxCandidateBundleHash(bundle)).toBe(bundle.bundleHash);
    expect(bundle.targetTenant).toMatchObject({
      slug: "agents-generation",
      registryVersion: "agents-generation@1.2.3",
    });
    expect(bundle.tenantRegistry).toMatchObject({
      selectedVersion: "agents-generation@1.2.3",
      promptNames: [],
      eventAdapter: null,
    });
    expect(bundle.policy).toMatchObject({
      networkPolicy: "deny_public_egress",
      externalLiveCalls: 0,
      functionModuleFallbackAllowed: false,
    });
    expect(bundle.toolDefinitions).toHaveLength(1);
    expect(bundle.toolEvidence).toHaveLength(1);
    expect(bundle.manifest).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          factory_tool_replay_refs: {
            "candidate.lookup": {
              definition_hash: definitionHash,
              content_hash: bundle.toolEvidence[0]!.contentHash,
            },
          },
        }),
      ]),
    );
  });

  it("fails closed on the legacy v1 bundle schema even with a recomputed hash", () => {
    const valid = build();
    const legacy = {
      ...valid,
      schema: "agent-factory-sandbox-candidate-bundle/v1",
    } as unknown as typeof valid;
    legacy.bundleHash = sandboxCandidateBundleHash(legacy);
    expect(() => validateSandboxCandidateBundle(
      legacy,
      new Date(valid.createdAt),
    )).toThrow(/identity is invalid/i);
  });

  it("requires evidence for every selected tool", () => {
    const valid = build();
    expect(() =>
      buildSandboxCandidateBundle({
        attemptId: valid.attemptId,
        candidateFingerprint: valid.candidateFingerprint,
        targetDomainId: valid.targetDomainId,
        targetTenant: {
          tenantId: valid.targetTenant.id,
          tenantSlug: valid.targetTenant.slug,
        },
        targetInngestIsolation: valid.targetInngestIsolation,
        controlPlaneBuildId: valid.controlPlaneBuildId,
        specs: valid.specs,
        toolDefinitions: valid.toolDefinitions,
        toolEvidence: [],
      }),
    ).toThrow(/no definition-bound replay evidence/i);
  });

  it("rejects a tool binding attached to the wrong generated function", () => {
    const valid = build();
    expect(() => buildSandboxCandidateBundle({
      attemptId: valid.attemptId,
      candidateFingerprint: valid.candidateFingerprint,
      targetDomainId: valid.targetDomainId,
      targetTenant: {
        tenantId: valid.targetTenant.id,
        tenantSlug: valid.targetTenant.slug,
      },
      targetInngestIsolation: valid.targetInngestIsolation,
      controlPlaneBuildId: valid.controlPlaneBuildId,
      specs: valid.specs,
      toolDefinitions: valid.toolDefinitions.map((entry) => ({
        ...entry,
        specSlugs: ["agents-generation-wrong-spec"],
      })),
      toolEvidence: valid.toolEvidence,
    })).toThrow(/wrong generated function|binding identity/i);
  });

  it("rejects duplicate bindings even when their tool name and bytes match", () => {
    const valid = build();
    expect(() => buildSandboxCandidateBundle({
      attemptId: valid.attemptId,
      candidateFingerprint: valid.candidateFingerprint,
      targetDomainId: valid.targetDomainId,
      targetTenant: {
        tenantId: valid.targetTenant.id,
        tenantSlug: valid.targetTenant.slug,
      },
      targetInngestIsolation: valid.targetInngestIsolation,
      controlPlaneBuildId: valid.controlPlaneBuildId,
      specs: valid.specs,
      toolDefinitions: [valid.toolDefinitions[0]!, valid.toolDefinitions[0]!],
      toolEvidence: valid.toolEvidence,
    })).toThrow(/duplicate executable definitions|duplicate/i);
  });

  it("rejects config-hash tampering instead of replaying a same-name cassette", () => {
    const valid = build();
    expect(() => buildSandboxCandidateBundle({
      attemptId: valid.attemptId,
      candidateFingerprint: valid.candidateFingerprint,
      targetDomainId: valid.targetDomainId,
      targetTenant: {
        tenantId: valid.targetTenant.id,
        tenantSlug: valid.targetTenant.slug,
      },
      targetInngestIsolation: valid.targetInngestIsolation,
      controlPlaneBuildId: valid.controlPlaneBuildId,
      specs: valid.specs,
      toolDefinitions: valid.toolDefinitions,
      toolEvidence: valid.toolEvidence.map((entry) => ({
        ...entry,
        configHash: "b".repeat(64),
      })),
    })).toThrow(/no exact executable binding|config/i);
  });

  it("accepts a generated declarative plan without pretending it is CodeAct", () => {
    const valid = build();
    const bundle = buildSandboxCandidateBundle({
      attemptId: valid.attemptId,
      candidateFingerprint: valid.candidateFingerprint,
      targetDomainId: valid.targetDomainId,
      targetTenant: {
        tenantId: valid.targetTenant.id,
        tenantSlug: valid.targetTenant.slug,
      },
      targetInngestIsolation: valid.targetInngestIsolation,
      controlPlaneBuildId: valid.controlPlaneBuildId,
      specs: [spec({
        codeExecuted: false,
        plan: [{
          stepId: "lookup-candidate",
          kind: "tool",
          tool: "candidate.lookup",
        }],
      })],
      toolDefinitions: valid.toolDefinitions,
      toolEvidence: valid.toolEvidence,
    });

    expect(bundle.specs[0]).toMatchObject({
      codeExecuted: false,
      plan: [{ kind: "tool", tool: "candidate.lookup" }],
    });
  });

  it("rejects a declarative owner with no executable plan", () => {
    const valid = build();
    expect(() => buildSandboxCandidateBundle({
      attemptId: valid.attemptId,
      candidateFingerprint: valid.candidateFingerprint,
      targetDomainId: valid.targetDomainId,
      targetTenant: {
        tenantId: valid.targetTenant.id,
        tenantSlug: valid.targetTenant.slug,
      },
      targetInngestIsolation: valid.targetInngestIsolation,
      controlPlaneBuildId: valid.controlPlaneBuildId,
      specs: [spec({ codeExecuted: false, plan: [] })],
      toolDefinitions: valid.toolDefinitions,
      toolEvidence: valid.toolEvidence,
    })).toThrow(/declarative action plan/i);
  });

  it("rejects literal credentials before transport", () => {
    const literalConfig = { api_key: "literal-secret-value" };
    const literalConfigHash = canonicalSandboxSha256(literalConfig);
    const literalBindingId = sandboxToolBindingId({
      specSlugs: [specSlug],
      toolName: "candidate.lookup",
      configHash: literalConfigHash,
      definitionHash,
    });
    expect(() =>
      buildSandboxCandidateBundle({
        attemptId: "00000000-0000-4000-8000-000000000012",
        candidateFingerprint: "sandbox-evidence:v5:literal-secret-test",
        targetDomainId: "Agents-generation",
        targetTenant: {
          tenantId: "tenant-agents-generation",
          tenantSlug: "agents-generation",
        },
        targetInngestIsolation: makeTargetInngestIsolationIdentity("agents-generation"),
        controlPlaneBuildId: "api-build-test",
        specs: [
          spec({
            sandboxToolConfigs: {
              "candidate.lookup": literalConfig,
            },
          }),
        ],
        toolDefinitions: [
          {
            bindingId: literalBindingId,
            specSlugs: [specSlug],
            toolName: "candidate.lookup",
            configHash: literalConfigHash,
            source: "declarative",
            definition: { name: "candidate.lookup" },
            definitionHash,
          },
        ],
        toolEvidence: [
          {
            bindingId: literalBindingId,
            specSlugs: [specSlug],
            toolName: "candidate.lookup",
            configHash: literalConfigHash,
            definitionHash,
            cassette: cassette(),
          },
        ],
      }),
    ).toThrow(/literal credential/i);
  });
});
