import { afterEach, describe, it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeToolCassetteEntry } from "@agentic/shared/cassette";
import {
  sandboxToolMode,
  isFactorySandboxTenant,
  isSandboxTenant,
  sandboxToolStub,
  cassetteKey,
  cassetteLookup,
  gatedToolMarker,
  requiresAttemptGrant,
  toolDispatchDecision,
  factorySandboxDispatchDecision,
  initializeFactorySandboxReplayAttempt,
  stageFactorySandboxReplayCassette,
  replayFactorySandboxTool,
  recordFactorySandboxLocalDispatch,
  readFactorySandboxDispatchEvidence,
  removeFactorySandboxReplayAttempt,
} from "./sandbox-mode";

describe("sandboxToolMode", () => {
  it("defaults production to gated and keeps synthetic modes test-only", () => {
    expect(sandboxToolMode({})).toBe("gated");
    expect(sandboxToolMode({ NODE_ENV: "test" })).toBe("mock");
    expect(sandboxToolMode({ NODE_ENV: "test", FACTORY_SANDBOX_TOOL_MODE: "replay" })).toBe("replay");
    expect(sandboxToolMode({ FACTORY_SANDBOX_TOOL_MODE: "live" })).toBe("live");
    expect(sandboxToolMode({ FACTORY_SANDBOX_TOOL_MODE: "nonsense" })).toBe("gated");
    expect(() => sandboxToolMode({ FACTORY_SANDBOX_TOOL_MODE: "mock" })).toThrow(/test-only/);
    expect(() => sandboxToolMode({ FACTORY_SANDBOX_TOOL_MODE: "replay" })).toThrow(/test-only/);
  });
});

describe("isSandboxTenant", () => {
  it("uses nonce-bearing identities outside test and keeps suffix fixtures test-only", () => {
    const ephemeral = "af-sbx-1234abcd-5678efab-123456789abc-sb";
    expect(isFactorySandboxTenant(ephemeral)).toBe(true);
    expect(isSandboxTenant(ephemeral)).toBe(true);
    expect(isSandboxTenant("recruitment-sb")).toBe(true);
    expect(isSandboxTenant("raas")).toBe(false);
    expect(isSandboxTenant(undefined)).toBe(false);

    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(isSandboxTenant("recruitment-sb")).toBe(false);
      expect(isSandboxTenant(ephemeral)).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe("sandboxToolStub", () => {
  it("returns a flagged non-empty stub (no real side effect)", () => {
    const s = sandboxToolStub("parseResumeApi");
    expect(s).toMatchObject({ __sandbox: true, mock: true, tool: "parseResumeApi" });
  });
});

describe("reviewed sandbox execution policy", () => {
  const pure = { operation: "compute", effectScope: "none", sandboxPolicy: "pure" } as const;
  const local = { operation: "write", effectScope: "sandbox_local", sandboxPolicy: "sandbox_local" } as const;
  const externalRead = { operation: "read", effectScope: "external", sandboxPolicy: "live_external" } as const;
  const externalWrite = { operation: "write", effectScope: "external", sandboxPolicy: "requires_attempt_grant" } as const;

  it("rejects missing, legacy, and inconsistent metadata even in mock mode", () => {
    expect(toolDispatchDecision(undefined, "mock")).toBe("reject");
    expect(toolDispatchDecision("read", "mock")).toBe("reject");
    expect(toolDispatchDecision({ ...pure, effectScope: "external" }, "mock")).toBe("reject");
  });

  it("runs pure and sandbox-local handlers without external authority", () => {
    expect(toolDispatchDecision(pure, "gated")).toBe("live");
    expect(toolDispatchDecision(local, "gated")).toBe("live");
  });

  it("requires an independently verified sandbox profile for live external reads", () => {
    expect(toolDispatchDecision(externalRead, "live")).toBe("gate_profile");
    expect(toolDispatchDecision(externalRead, "gated", { sandboxProfileVerified: true })).toBe("live");
  });

  it("requires an attempt-scoped grant for external writes", () => {
    expect(requiresAttemptGrant(externalWrite)).toBe(true);
    expect(requiresAttemptGrant(externalRead)).toBe(false);
    expect(toolDispatchDecision(externalWrite, "live", { sandboxProfileVerified: true })).toBe("gate_grant");
    expect(toolDispatchDecision(externalWrite, "gated", { attemptGrantVerified: true })).toBe("live");
  });

  it("applies deterministic test modes only after policy validation", () => {
    expect(toolDispatchDecision(pure, "mock")).toBe("stub");
    expect(toolDispatchDecision(externalWrite, "replay")).toBe("replay");
  });

  it("marks the exact missing authority at a gated boundary", () => {
    expect(gatedToolMarker("parseResumeApi", { id: "x" }, "sandbox_profile"))
      .toMatchObject({ __gated: true, gateReason: "sandbox_profile", wouldCall: { id: "x" } });
    expect(gatedToolMarker("inviteCandidateApi", { id: "x" }, "requires_attempt_grant"))
      .toMatchObject({ __gated: true, gateReason: "requires_attempt_grant", wouldWrite: { id: "x" } });
  });
});

describe("cassetteKey", () => {
  it("is stable for the same (name,args) and differs otherwise", () => {
    expect(cassetteKey("t", { a: 1 })).toBe(cassetteKey("t", { a: 1 }));
    expect(cassetteKey("t", { a: 1 })).not.toBe(cassetteKey("t", { a: 2 }));
  });
});

describe("cassetteLookup", () => {
  it("returns undefined (no throw) when no cassette file exists", async () => {
    await expect(cassetteLookup("nope-sb", "ghostTool", { x: 1 })).resolves.toBeUndefined();
  });
});

describe("attempt-bound Factory sandbox replay", () => {
  const roots: string[] = [];
  const tenantSlug = "af-sbx-1234abcd-5678efab-123456789abc-sb";
  const scope = {
    kind: "sandbox" as const,
    target_domain_id: "Agents-generation",
    candidate_fingerprint: "candidate-v1",
    attempt_id: "123e4567-e89b-42d3-a456-426614174000",
  };
  const external = {
    operation: "read" as const,
    effectScope: "external" as const,
    sandboxPolicy: "live_external" as const,
  };
  const local = {
    operation: "write" as const,
    effectScope: "sandbox_local" as const,
    sandboxPolicy: "sandbox_local" as const,
  };

  afterEach(async () => {
    delete process.env.AGENTIC_DATA_ROOT;
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function freshRoot(): Promise<void> {
    const root = await mkdtemp(path.join(os.tmpdir(), "factory-replay-"));
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    await initializeFactorySandboxReplayAttempt(scope, tenantSlug);
  }

  it("forces external tools to replay and lets reviewed local tools run locally", () => {
    expect(factorySandboxDispatchDecision(external, tenantSlug, scope)).toBe("replay");
    expect(factorySandboxDispatchDecision(local, tenantSlug, scope)).toBe("live");
    expect(factorySandboxDispatchDecision(external, "production", { kind: "production" })).toBeNull();
  });

  it("replays only the exact staged argsHash and reports zero external live calls", async () => {
    await freshRoot();
    const definitionHash = "a".repeat(64);
    const args = { resume_id: "r-1", jd_id: "j-1" };
    const document = {
      version: 1 as const,
      tool: { name: "matchResumeApi", definitionHash },
      evidence: {
        recordedAt: new Date(0).toISOString(),
        mode: "signed-fixture" as const,
      },
      entries: [makeToolCassetteEntry({
        toolName: "matchResumeApi",
        args,
        status: 200,
        body: { score: 88 },
      })],
    };
    const replayRef = await stageFactorySandboxReplayCassette({
      scope,
      tenantSlug,
      toolName: "matchResumeApi",
      definitionHash,
      document,
    });
    await expect(replayFactorySandboxTool({
      scope,
      tenantSlug,
      toolName: "matchResumeApi",
      toolArgs: args,
      policy: external,
      replayRef,
    })).resolves.toMatchObject({ body: { score: 88 }, receipt: { kind: "replay" } });
    await recordFactorySandboxLocalDispatch({
      scope,
      tenantSlug,
      toolName: "local.audit",
      toolArgs: { id: "x" },
      policy: local,
    });
    const evidence = await readFactorySandboxDispatchEvidence(scope, tenantSlug);
    expect(evidence).toMatchObject({
      complete: true,
      externalLiveCalls: 0,
      replayMisses: 0,
      sandboxLocalCalls: 1,
    });
    expect(evidence.replayReceipts).toHaveLength(1);
    await removeFactorySandboxReplayAttempt(scope, tenantSlug);
  });

  it("fails closed and records a replay miss when arguments drift", async () => {
    await freshRoot();
    const definitionHash = "b".repeat(64);
    const document = {
      version: 1 as const,
      tool: { name: "inviteCandidateApi", definitionHash },
      evidence: {
        recordedAt: new Date(0).toISOString(),
        mode: "signed-fixture" as const,
      },
      entries: [makeToolCassetteEntry({
        toolName: "inviteCandidateApi",
        args: { resume_id: "r-1" },
        status: 200,
        body: { sent: true },
      })],
    };
    const replayRef = await stageFactorySandboxReplayCassette({
      scope,
      tenantSlug,
      toolName: "inviteCandidateApi",
      definitionHash,
      document,
    });
    await expect(replayFactorySandboxTool({
      scope,
      tenantSlug,
      toolName: "inviteCandidateApi",
      toolArgs: { resume_id: "different" },
      policy: external,
      replayRef,
    })).rejects.toThrow(/matches arguments/);
    await expect(readFactorySandboxDispatchEvidence(scope, tenantSlug)).resolves.toMatchObject({
      complete: false,
      externalLiveCalls: 0,
      replayMisses: 1,
    });
  });
});
