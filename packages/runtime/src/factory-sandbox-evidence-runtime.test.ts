import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { makeToolCassetteEntry } from "@agentic/shared/cassette";
import { runAction } from "./step-engine";
import { materializeForeach } from "./action-plan";
import { setRuntimeGateway } from "./llm-host";
import {
  initializeFactorySandboxReplayAttempt,
  readFactorySandboxDispatchEvidence,
  stageFactorySandboxReplayCassette,
  type FactorySandboxExecutionScope,
} from "./sandbox-mode";

const EXTERNAL_POLICY = {
  operation: "read" as const,
  effectScope: "external" as const,
  sandboxPolicy: "live_external" as const,
};

describe("full runtime Factory sandbox evidence replay", () => {
  const roots: string[] = [];
  let sequence = 1;

  afterEach(async () => {
    delete process.env.AGENTIC_DATA_ROOT;
    setRuntimeGateway(null);
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function attempt(toolName: string, entries: Array<{ args: unknown; body: unknown }>) {
    const root = await mkdtemp(path.join(os.tmpdir(), "factory-full-runtime-"));
    roots.push(root);
    process.env.AGENTIC_DATA_ROOT = root;
    const suffix = String(sequence++).padStart(12, "0");
    const tenantSlug = `af-sbx-1234abcd-5678efab-${suffix}-sb`;
    const scope: FactorySandboxExecutionScope = {
      kind: "sandbox",
      target_domain_id: "Agents-generation",
      candidate_fingerprint: `candidate-${suffix}`,
      attempt_id: `123e4567-e89b-42d3-a456-${suffix}`,
    };
    await initializeFactorySandboxReplayAttempt(scope, tenantSlug);
    const definitionHash = sequence.toString(16).padStart(64, "0");
    const replayRef = await stageFactorySandboxReplayCassette({
      scope,
      tenantSlug,
      toolName,
      definitionHash,
      document: {
        version: 1,
        tool: { name: toolName, definitionHash },
        evidence: {
          recordedAt: new Date(0).toISOString(),
          mode: "signed-fixture",
        },
        entries: entries.map((entry) => makeToolCassetteEntry({
          toolName,
          args: entry.args,
          status: 200,
          body: entry.body,
        })),
      },
    });
    return { scope, tenantSlug, replayRef };
  }

  function registry(toolName: string, onLive: () => void) {
    return {
      prompts: {
        reason: {
          kind: "prompt",
          name: "reason",
          template: () => "use the reviewed tool",
        },
      },
      tools: {
        [toolName]: {
          kind: "tool",
          name: toolName,
          description: "must not execute live in a Factory sandbox",
          async handler() {
            onLive();
            return { data: { live: true } };
          },
        },
      },
    } as never;
  }

  function agent(
    toolName: string,
    scope: FactorySandboxExecutionScope,
    replayRef: { definition_hash: string; content_hash: string },
    extra: Record<string, unknown> = {},
  ) {
    return {
      name: "factory-test-agent",
      generated: true,
      factoryExecutionScope: scope,
      factoryToolReplayRefs: { [toolName]: replayRef },
      tool_use: [{
        name: toolName,
        execution_policy: {
          operation: EXTERNAL_POLICY.operation,
          effect_scope: EXTERNAL_POLICY.effectScope,
          sandbox_policy: EXTERNAL_POLICY.sandboxPolicy,
        },
      }],
      ...extra,
    } as never;
  }

  it("replays an ordinary declarative tool step without invoking its handler", async () => {
    const args = { resume_id: "r-1" };
    const prepared = await attempt("parseResumeApi", [{ args, body: { parsed: true } }]);
    let liveCalls = 0;
    const output = await runAction({
      ctx: {
        agentName: "factory-test-agent",
        actionName: "parseResumeApi",
        correlationId: "c-plan",
        tenantSlug: prepared.tenantSlug,
        event: { name: "RESUME_DOWNLOADED", data: args },
      },
      action: { name: "parseResumeApi", type: "tool" },
      agent: agent("parseResumeApi", prepared.scope, prepared.replayRef),
      tenantRegistry: registry("parseResumeApi", () => { liveCalls += 1; }),
    });
    expect(output).toMatchObject({ ok: true, data: { parsed: true } });
    expect(liveCalls).toBe(0);
    await expect(readFactorySandboxDispatchEvidence(prepared.scope, prepared.tenantSlug))
      .resolves.toMatchObject({ externalLiveCalls: 0, replayMisses: 0, complete: true });
  });

  it("replays every foreach body dispatch by its exact materialized arguments", async () => {
    const eventData = { items: [{ id: "a" }, { id: "b" }] };
    const materialized = materializeForeach({
      items: eventData.items,
      itemAs: "candidate",
      itemKeyFrom: "candidate.id",
    });
    if (!materialized.ok) throw new Error(materialized.error);
    const expectedArgs = materialized.frames.map((frame) => ({
      ...eventData,
      ...frame.locals,
      _foreach: {
        parentStepId: "foreach-candidates",
        index: frame.index,
        key: frame.businessKey,
        stableKey: frame.stableKey,
      },
    }));
    const prepared = await attempt(
      "matchResumeApi",
      expectedArgs.map((args, index) => ({ args, body: { score: 80 + index } })),
    );
    let liveCalls = 0;
    const output = await runAction({
      ctx: {
        agentName: "factory-test-agent",
        actionName: "foreach-candidates",
        correlationId: "c-foreach",
        tenantSlug: prepared.tenantSlug,
        event: { name: "RULE_CHECK_PASSED", data: eventData },
      },
      action: {
        name: "foreach-candidates",
        type: "foreach",
        items_from: "input.items",
        item_as: "candidate",
        item_key_from: "candidate.id",
        foreach_actions: [{ name: "matchResumeApi", type: "tool" }],
      },
      agent: agent("matchResumeApi", prepared.scope, prepared.replayRef),
      tenantRegistry: registry("matchResumeApi", () => { liveCalls += 1; }),
    });
    expect(output.ok).toBe(true);
    expect(liveCalls).toBe(0);
    const evidence = await readFactorySandboxDispatchEvidence(prepared.scope, prepared.tenantSlug);
    expect(evidence.replayReceipts).toHaveLength(2);
    expect(evidence).toMatchObject({ externalLiveCalls: 0, replayMisses: 0, complete: true });
  });

  it("replays the actual LLM tool-loop entry and preserves the cassette body", async () => {
    const args = { candidate_id: "c-1" };
    const prepared = await attempt("identity.lookup", [{ args, body: { duplicate: false } }]);
    const replies = [
      {
        text: "",
        provider: "mock",
        model: "factory-test",
        tokensIn: 1,
        tokensOut: 1,
        finishReason: "tool_calls",
        latencyMs: 1,
        toolCalls: [{ id: "call-1", name: "identity.lookup", input: args }],
      },
      {
        text: "checked",
        provider: "mock",
        model: "factory-test",
        tokensIn: 1,
        tokensOut: 1,
        finishReason: "stop",
        latencyMs: 1,
      },
    ];
    setRuntimeGateway({ async chat() { return replies.shift()!; } } as never);
    let liveCalls = 0;
    const output = await runAction({
      ctx: {
        agentName: "factory-test-agent",
        actionName: "reason",
        correlationId: "c-llm",
        tenantSlug: prepared.tenantSlug,
        event: { name: "IDENTITY_REQUESTED", data: {} },
      },
      action: { name: "reason", type: "logic" },
      agent: agent("identity.lookup", prepared.scope, prepared.replayRef),
      tenantRegistry: registry("identity.lookup", () => { liveCalls += 1; }),
    });
    expect(output).toMatchObject({ ok: true, data: "checked" });
    expect(liveCalls).toBe(0);
    expect(output.meta?.sandboxDispatches).toHaveLength(1);
    await expect(readFactorySandboxDispatchEvidence(prepared.scope, prepared.tenantSlug))
      .resolves.toMatchObject({ externalLiveCalls: 0, replayMisses: 0, complete: true });
  });

  it("does not let a toolful spec bypass durable replay by claiming CodeAct", async () => {
    const args = { resume_id: "r-code" };
    const prepared = await attempt("factory.externalEcho", [{ args, body: { name: "Ada" } }]);
    let liveCalls = 0;
    const code = `export const agent = defineAgent({
      async handler(input, ctx) {
        const parsed = await ctx.tool("factory.externalEcho", input);
        return { parsed };
      }
    });`;
    const output = await runAction({
      ctx: {
        agentName: "factory-test-agent",
        actionName: "execute-code",
        correlationId: "c-code",
        tenantSlug: prepared.tenantSlug,
        event: { name: "RESUME_DOWNLOADED", data: args },
      },
      action: { name: "execute-code", type: "logic" },
      agent: agent("factory.externalEcho", prepared.scope, prepared.replayRef, {
        codeExecuted: true,
        typescriptCode: code,
      }),
      tenantRegistry: registry("factory.externalEcho", () => { liveCalls += 1; }),
    });
    expect(output).toMatchObject({
      ok: false,
      data: null,
      meta: {
        error: "generated_code_execution_failed",
        codeExecuted: false,
        codeExecutionFailure: "execution_disabled",
      },
    });
    expect(liveCalls).toBe(0);
    expect(output.meta?.sandboxDispatches).toHaveLength(0);
    await expect(readFactorySandboxDispatchEvidence(prepared.scope, prepared.tenantSlug))
      .resolves.toMatchObject({ externalLiveCalls: 0, replayMisses: 0, complete: true });
  });
});
