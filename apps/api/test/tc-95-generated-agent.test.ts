/**
 * TC-95 — Generated agents (Agent Factory) are runnable WITHOUT a hand-written tenant prompt.
 *
 * The factory generates agents into an isolated sandbox tenant (and later promotes them) with no
 * `@tenants/<slug>` package. Before this, a generated agent's LLM `logic` action either blocked
 * boot (findMissingTenantPrompts threw) or failed at runtime (missing_tenant_prompt) — so the
 * sandbox "registered" agents that could never actually run. These tests pin the fix:
 *   - a `generated` agent's logic action runs the runtime default prompt (event payload in the
 *     user turn; ontology_instructions = its system prompt),
 *   - it advertises GLOBAL registry tools in the tool-use loop,
 *   - hand-authored tenants keep STRICT behaviour (RAAS unaffected),
 *   - findMissingTenantPrompts skips generated agents but still flags hand-authored ones.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { runAction, setRuntimeGateway, findMissingTenantPrompts } from "@agentic/runtime";

let captured: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ name: string }> }> = [];

const mockGateway = {
  chat: async (req: { messages: Array<{ role: string; content: string }>; tools?: Array<{ name: string }> }) => {
    captured.push({ messages: req.messages, tools: req.tools });
    return {
      text: "done",
      provider: "mock" as const,
      model: "mock-model-v7",
      tokensIn: 5,
      tokensOut: 5,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  },
} as unknown as Parameters<typeof setRuntimeGateway>[0];

beforeAll(() => {
  setRuntimeGateway(mockGateway);
});

describe("TC-95: generated agents run without a tenant prompt package", () => {
  it("a generated agent's logic action runs the default prompt (event payload in the user turn)", async () => {
    captured = [];
    const out = await runAction({
      ctx: {
        agentName: "genA",
        actionName: "processResume",
        correlationId: "c1",
        tenantSlug: "acme-sb",
        event: { name: "RESUME_UPLOADED", data: { resume_id: "r-1", subject: "REQ-9" } },
        lastResult: null,
      },
      action: { order: "1", name: "processResume", description: "process the resume", type: "logic" },
      // generated:true, NO tenantRegistry.prompts — the whole point.
      agent: { name: "genA", generated: true, ontology_instructions: "You process resumes per the rules." },
    });
    expect(out.ok).toBe(true);
    expect(out.model).toBe("mock-model-v7");
    const user = captured[0]!.messages.at(-1)!;
    expect(user.role).toBe("user");
    expect(user.content).toContain("resume_id");
    expect(user.content).toContain("processResume");
    // ontology_instructions are the system prompt.
    const system = captured[0]!.messages[0]!;
    expect(system.content).toContain("You process resumes per the rules.");
  });

  it("a generated agent advertises GLOBAL registry tools in its tool-use loop", async () => {
    captured = [];
    await runAction({
      ctx: {
        agentName: "genB",
        actionName: "checkRules",
        correlationId: "c2",
        tenantSlug: "acme-sb",
        event: { name: "X", data: {} },
        lastResult: null,
      },
      action: { order: "1", name: "checkRules", description: "", type: "logic" },
      agent: { name: "genB", generated: true, tool_use: [{ name: "ontology.fetchActionRules" }] },
    });
    const advertised = (captured[0]!.tools ?? []).map((t) => t.name);
    expect(advertised).toContain("ontology.fetchActionRules");
  });

  it("a NON-generated agent's prompt-less logic action still fails strict (RAAS behaviour preserved)", async () => {
    const out = await runAction({
      ctx: {
        agentName: "raasA",
        actionName: "rankCandidates",
        correlationId: "c3",
        tenantSlug: "raas",
        event: { name: "X", data: {} },
        lastResult: null,
      },
      action: { order: "1", name: "rankCandidates", description: "", type: "logic" },
      agent: { name: "raasA" }, // generated NOT set
    });
    expect(out.ok).toBe(false);
    expect((out.meta as { error?: string } | undefined)?.error).toBe("missing_tenant_prompt");
  });

  it("findMissingTenantPrompts skips generated agents but flags hand-authored ones", () => {
    const manifest = [
      { id: "a", name: "genA", actor: ["Agent"], trigger: ["X"], triggered_event: ["Y"], generated: true, actions: [{ order: "1", name: "step1", description: "", type: "logic" }] },
      { id: "b", name: "handA", actor: ["Agent"], trigger: ["Y"], triggered_event: ["Z"], actions: [{ order: "1", name: "step2", description: "", type: "logic" }] },
    ] as unknown as Parameters<typeof findMissingTenantPrompts>[0]["manifest"];
    const missing = findMissingTenantPrompts({ manifest, tenantRegistry: {} });
    expect(missing.map((m) => m.actionName)).toEqual(["step2"]);
  });
});
