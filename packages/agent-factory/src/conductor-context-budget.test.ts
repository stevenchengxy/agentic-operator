import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMsg, TurnEvent } from "./stream-gateway";
import type { FactoryPorts } from "./ports";

const seenTurns: ChatMsg[][] = [];
const scriptedTurns: TurnEvent[][] = [];

vi.mock("./stream-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./stream-gateway")>();
  return {
    ...actual,
    isGatewayConfigured: () => false,
    setLlmCallContext: () => undefined,
    streamTurn: async function* (messages: ChatMsg[]) {
      seenTurns.push(structuredClone(messages));
      const events = scriptedTurns.shift() ?? [
        { t: "done" as const, content: "done" },
      ];
      for (const event of events) yield event;
    },
  };
});

import { runBrain } from "./conductor";

function savedCtx(tokens: number): Record<string, unknown> {
  return {
    domain: "dom",
    goal: "prior goal",
    specs: [],
    ontology: null,
    budget: { maxTokens: null, maxTurns: 200 },
    spent: { tokens, turns: 0, sandboxRuns: 0 },
    currentPlan: null,
    toolCatalog: [],
    attemptHistory: {},
    createdSkills: [],
    research: [],
    lastSandbox: null,
    lastValidation: null,
    humanDirectives: [],
    priorReflections: [],
  };
}

function portsFor(
  loadValue: { messages: ChatMsg[]; ctx: Record<string, unknown> },
  onSave: (value: { messages: unknown[]; ctx: Record<string, unknown> }) => void,
): FactoryPorts {
  return {
    ontology: {
      listDomains: async () => [],
      fetchOntology: async () => ({
        domainId: "dom",
        actions: [],
        events: [],
        objects: [],
        rules: [],
        workflow: [],
        source: "snapshot",
      }),
      fetchActionRules: async () => [],
    },
    sandbox: {
      deployAndObserve: async () => {
        throw new Error("not used");
      },
      teardown: async () => undefined,
    },
    conversation: {
      has: async () => true,
      load: async () => structuredClone(loadValue),
      save: async (_id, value) => onSave(structuredClone(value)),
      drainHumanMessages: async () => [],
    },
    reflection: { list: async () => [], record: async () => undefined },
  };
}

describe("conductor context and resumed-run accounting", () => {
  beforeEach(() => {
    vi.stubEnv("FACTORY_AI_MODEL", "test/context-budget-model");
    vi.stubEnv("FACTORY_COMPACT_ABSTRACTIVE", "0");
    seenTurns.splice(0);
    scriptedTurns.splice(0);
  });

  afterEach(() => vi.unstubAllEnvs());

  it("compacts a large saved payload even while the transcript has fewer than 40 messages", async () => {
    vi.stubEnv("FACTORY_COMPACT_AT_MSGS", "40");
    vi.stubEnv("FACTORY_COMPACT_AT_CHARS", "2000");
    vi.stubEnv("FACTORY_COMPACT_AT_ESTIMATED_TOKENS", "500");
    vi.stubEnv("FACTORY_COMPACT_KEEP_CHARS", "500");
    vi.stubEnv("FACTORY_COMPACT_KEEP_ESTIMATED_TOKENS", "125");
    const huge = `legacy-large-payload-${"x".repeat(12_000)}`;
    const loadValue = {
      messages: [
        { role: "system" as const, content: "old system" },
        { role: "assistant" as const, content: huge },
        { role: "user" as const, content: "old follow-up" },
        { role: "assistant" as const, content: "old answer" },
        { role: "user" as const, content: "recent question" },
        { role: "assistant" as const, content: "recent answer" },
      ],
      ctx: savedCtx(0),
    };
    let snapshot: { messages: unknown[]; ctx: Record<string, unknown> } | undefined;
    scriptedTurns.push([{ t: "done", content: "continued" }]);

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "continue",
      ports: portsFor(loadValue, (value) => {
        snapshot = value;
      }),
      tools: [],
      conversationId: "compact-large-under-40",
    })) {
      events.push(event);
    }

    expect(loadValue.messages.length).toBeLessThan(40);
    expect(events).toContainEqual(expect.objectContaining({ t: "compaction" }));
    expect(JSON.stringify(snapshot?.messages)).not.toContain(huge);
    expect(seenTurns[0]?.length).toBeLessThan(loadValue.messages.length + 3);
  });

  it("reports resumed run delta separately from conversation lifetime spend", async () => {
    const loadValue = {
      messages: [
        { role: "system" as const, content: "old system" },
        { role: "user" as const, content: "prior request" },
      ],
      ctx: savedCtx(1_000),
    };
    let snapshot: { messages: unknown[]; ctx: Record<string, unknown> } | undefined;
    scriptedTurns.push([
      { t: "usage", promptTokens: 30, completionTokens: 20 },
      { t: "done", content: "resume complete" },
    ]);

    const events = [];
    for await (const event of runBrain({
      domain: "dom",
      goal: "resume",
      ports: portsFor(loadValue, (value) => {
        snapshot = value;
      }),
      tools: [],
      conversationId: "resume-token-delta",
    })) {
      events.push(event);
    }

    expect(events).toContainEqual(
      expect.objectContaining({
        t: "budget",
        tokens: 50,
        conversationTokens: 1_050,
      }),
    );
    expect(events.at(-1)).toMatchObject({
      t: "done",
      tokensUsed: 50,
      conversationTokensUsed: 1_050,
    });
    expect(
      (snapshot?.ctx.spent as { tokens?: number } | undefined)?.tokens,
    ).toBe(1_050);
  });
});
