/**
 * TC-10 — step-engine and runtime helper unit tests.
 *
 * Targets:
 *   - P0-RT-03 prompt assembly composition (system + user halves).
 *   - P0-RT-04 step output carries the gateway's real `model` string.
 *   - P0-RT-09 manifest engine writes step-input/output artifact sidecars.
 *   - P0-RT-11 tenant prompt's `system` field is honored.
 *
 * These tests bypass Inngest and call `runAction()` directly so the
 * assertions are about the step engine surface, not the durable executor.
 */

import path from "node:path";
import { promises as fs } from "node:fs";
import { describe, it, expect, beforeAll } from "vitest";

import { runAction, setRuntimeGateway } from "@agentic/runtime";
import { z } from "zod";

// Inline a PromptDescriptor that satisfies the runtime contract — pulling in
// @agentic/agent-sdk just for `definePrompt` would force a new workspace
// dep on apps/api, which the harness doesn't need.
interface InlinePrompt {
  readonly kind: "prompt";
  readonly name: string;
  readonly system?: string;
  template: (ctx: unknown) => string;
  readonly output?: z.ZodType<unknown>;
}
function definePrompt(p: Omit<InlinePrompt, "kind">): InlinePrompt {
  return { kind: "prompt", ...p };
}

// Build a captured-call mock gateway so the test can inspect what was sent.
let captured: Array<{
  messages: Array<{ role: string; content: string }>;
  model?: string;
}> = [];

const mockGateway = {
  chat: async (req: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    jsonMode?: boolean;
  }) => {
    captured.push({ messages: req.messages, model: req.model });
    const text = "echo: " + (req.messages.at(-1)?.content ?? "");
    return {
      // A prompt with `output` asks the gateway for JSON mode. Mirror a real
      // provider by returning a JSON string value rather than raw prose.
      text: req.jsonMode ? JSON.stringify(text) : text,
      provider: "mock" as const,
      model: "mock-model-v7",
      tokensIn: 10,
      tokensOut: 20,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  },
} as unknown as Parameters<typeof setRuntimeGateway>[0];

beforeAll(() => {
  setRuntimeGateway(mockGateway);
});

describe("TC-10: step engine prompt assembly (P0-RT-03 + RT-11)", () => {
  it("tenant prompt with auto-prelude includes runtime prelude + ontology + lastResult JSON", async () => {
    // UC-V11-25: every `logic` action must now ship a tenant definePrompt.
    // The runtime no longer auto-builds a fallback prompt from
    // `${action.name}: ${action.description}`. The original P0-RT-03 spec
    // still holds for tenant prompts that route through the runtime prelude
    // (system content concatenated with ontology_instructions, user content
    // carrying lastResult JSON).
    captured = [];
    const rankPrompt = definePrompt({
      name: "rankCandidates",
      system: "Senior matcher\n\nOnly score against the rubric. Do not invent fields.",
      template: (ctx) => {
        const c = ctx as {
          event?: { name?: string; data?: unknown };
          lastResult?: unknown;
        };
        return [
          "rankCandidates: Score the candidate against the job rubric.",
          `event: ${c.event?.name}`,
          `payload: ${JSON.stringify(c.event?.data ?? {})}`,
          `lastResult: ${JSON.stringify(c.lastResult, null, 2)}`,
        ].join("\n");
      },
    });
    const out = await runAction({
      ctx: {
        agentName: "agentA",
        actionName: "rankCandidates",
        subject: "candidate-7",
        correlationId: "cor-1",
        tenantSlug: "raas",
        event: { name: "MATCH_REQUESTED", data: { jobId: "j-1" } },
        lastResult: { score: 0.62 },
      },
      action: {
        order: "1",
        name: "rankCandidates",
        description: "Score the candidate against the job rubric.",
        type: "logic",
      },
      agent: {
        name: "agentA",
        description: "Senior matcher",
        ontology_instructions:
          "Only score against the rubric. Do not invent fields.",
      },
      tenantRegistry: { prompts: { rankCandidates: rankPrompt } },
    });

    expect(out.ok).toBe(true);
    expect(captured.length).toBe(1);
    const [system, user] = captured[0]!.messages;
    expect(system?.role).toBe("system");
    expect(user?.role).toBe("user");

    // System carries the tenant override.
    expect(system!.content).toContain("Senior matcher");
    expect(system!.content).toContain("Only score against the rubric");

    // User payload carries the action description, the trigger event
    // payload, and the lastResult JSON snapshot.
    expect(user!.content).toContain("rankCandidates");
    expect(user!.content).toContain("MATCH_REQUESTED");
    expect(user!.content).toContain("jobId");
    expect(user!.content).toContain('"score": 0.62');
  });

  it("tenant prompt's `system` field is the first system message (P0-RT-11)", async () => {
    captured = [];
    const prompt = definePrompt({
      name: "tenantPrompt",
      system: "TENANT-OVERRIDE-FIRST",
      template: () => "user body",
      output: z.string(),
    });

    const out = await runAction({
      ctx: {
        agentName: "agentB",
        actionName: "tenantPrompt",
        correlationId: "cor-2",
        tenantSlug: "raas",
        event: { name: "X", data: {} },
        lastResult: null,
      },
      action: {
        order: "1",
        name: "tenantPrompt",
        description: "",
        type: "logic",
      },
      agent: {
        name: "agentB",
        ontology_instructions: "ONTOLOGY-BEHIND",
      },
      tenantRegistry: { prompts: { tenantPrompt: prompt } },
    });

    expect(out.ok).toBe(true);
    const [system, user] = captured[0]!.messages;
    expect(system!.role).toBe("system");
    expect(user!.content).toBe("user body");
    // Tenant override must appear before the runtime prelude.
    const idxOverride = system!.content.indexOf("TENANT-OVERRIDE-FIRST");
    const idxOntology = system!.content.indexOf("ONTOLOGY-BEHIND");
    expect(idxOverride).toBeGreaterThanOrEqual(0);
    expect(idxOntology).toBeGreaterThan(idxOverride);
  });

  it("step output carries the gateway's real `model` string (P0-RT-04)", async () => {
    const computePrompt = definePrompt({
      name: "compute",
      template: () => "compute body",
    });
    const out = await runAction({
      ctx: {
        agentName: "agentC",
        actionName: "compute",
        correlationId: "cor-3",
        tenantSlug: "raas",
        event: { name: "X", data: {} },
        lastResult: null,
      },
      action: { order: "1", name: "compute", description: "", type: "logic" },
      agent: { name: "agentC" },
      tenantRegistry: { prompts: { compute: computePrompt } },
    });
    expect(out.model).toBe("mock-model-v7");
    expect(out.provider).toBe("mock");
  });

  it("writes input + output artifact sidecars when runId+stepOrd are supplied (P0-RT-09)", async () => {
    const runId = `run-test-${Date.now()}`;
    const computePrompt = definePrompt({
      name: "compute",
      template: () => "compute body",
    });
    const out = await runAction({
      ctx: {
        agentName: "agentD",
        actionName: "compute",
        correlationId: "cor-4",
        tenantSlug: "raas",
        event: { name: "X", data: { hello: "world" } },
        lastResult: { prior: 1 },
      },
      action: { order: "1", name: "compute", description: "", type: "logic" },
      agent: { name: "agentD" },
      tenantRegistry: { prompts: { compute: computePrompt } },
      runId,
      stepOrd: 1,
    });
    expect(out.outputArtifact).toBeTruthy();
    const artifactRoot = process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts";
    const inputPath = path.join(artifactRoot, runId, "step-1-input.json");
    const outputPath = path.join(artifactRoot, runId, "step-1-output.json");
    const inputJson = JSON.parse(await fs.readFile(inputPath, "utf8"));
    const outputJson = JSON.parse(await fs.readFile(outputPath, "utf8"));
    expect(inputJson.action).toBe("compute");
    expect(inputJson.ctx.event.name).toBe("X");
    expect(outputJson.ok).toBe(true);
    expect(outputJson.model).toBe("mock-model-v7");
  });
});
