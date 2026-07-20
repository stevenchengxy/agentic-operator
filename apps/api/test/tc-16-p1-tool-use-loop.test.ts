/**
 * TC-16 — Phase 1 tool-use loop end-to-end via the run engine.
 *
 * Targets:
 *   - P1-RT-01: multi-turn `maxSteps` loop dispatches tool calls and re-prompts.
 *   - P1-RT-02: `BaseAgent.getTools(ctx)` hook is consulted.
 *   - P1-RT-06: `req.providers` chain is honoured (passed through to gateway).
 *   - P1-RT-07: structured-output validate + repair retry loop.
 *
 * The test installs a captured-call mock gateway via `setGateway()` and a
 * trivial `Echo` code agent that declares one tool. The mock dictates the
 * agent's behaviour turn-by-turn so we can assert on:
 *   - the number of LLM calls made,
 *   - tokens aggregated across turns,
 *   - one `steps` row per LLM call + per tool dispatch.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { z } from "zod";

import {
  BaseAgent,
  agentRegistry,
  setGateway,
  bootstrapCodeAgents,
} from "@agentic/agent-runtime";
import type { AgentContext, ToolHandlerMap } from "@agentic/agent-runtime";
import { getDb, runs, runMigrations, steps } from "@agentic/db";
import type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ToolDef,
} from "@agentic/llm-gateway";

// ─── Test fixtures ────────────────────────────────────────────────────────

interface CapturedCall {
  messages: ChatMessage[];
  tools?: ToolDef[];
  providers?: string[];
  provider?: string;
  jsonMode?: boolean;
  routing?: ChatRequest["routing"];
}

/** Programmable mock gateway: per-call queue of responses. */
class ProgrammableGateway {
  private queue: ChatResponse[] = [];
  public captured: CapturedCall[] = [];
  public defaultProvider = "mock";
  public defaultModel = "mock-model-v1";

  queueResponse(r: ChatResponse): void {
    this.queue.push(r);
  }

  hasProvider(_id: string): boolean {
    return true;
  }
  listProviders(): never[] {
    return [];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Snapshot the request — the engine mutates the same `messages` array
    // across turns, so a live reference would show every turn's state.
    this.captured.push({
      messages: JSON.parse(JSON.stringify(req.messages)) as ChatMessage[],
      tools: req.tools
        ? (JSON.parse(JSON.stringify(req.tools)) as ToolDef[])
        : undefined,
      providers: req.providers as string[] | undefined,
      provider: req.provider,
      jsonMode: req.jsonMode,
      routing: req.routing
        ? (JSON.parse(JSON.stringify(req.routing)) as ChatRequest["routing"])
        : undefined,
    });
    const next = this.queue.shift();
    if (!next) {
      throw new Error(
        "[programmable-gateway] queue empty — test forgot to enqueue a response",
      );
    }
    return next;
  }
}

class WeatherAgent extends BaseAgent<{ city: string }, string> {
  readonly name = "weatherAgent";
  readonly description = "Look up the weather using a tool.";
  override readonly maxSteps = 3;
  override readonly defaultProvider = "mock" as const;

  protected buildMessages({ city }: { city: string }): ChatMessage[] {
    return [
      { role: "system", content: "Use tools to answer." },
      { role: "user", content: `Weather in ${city}?` },
    ];
  }

  override getTools(): ToolDef[] {
    return [
      {
        name: "lookupWeather",
        description: "Fetch current weather for a city.",
        input_schema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];
  }

  override getToolHandlers(): ToolHandlerMap {
    return {
      lookupWeather: async (input) => ({
        ok: true,
        data: { city: input.city, tempC: 18, sky: "clear" },
      }),
    };
  }
}

const scoreSchema = z.object({ score: z.number(), label: z.string() });
type Score = z.infer<typeof scoreSchema>;

class ScorerAgent extends BaseAgent<{ text: string }, Score> {
  readonly name = "scorerAgent";
  readonly description = "Score a string against a rubric.";
  override readonly outputSchema = scoreSchema;
  override readonly defaultProvider = "mock" as const;

  protected buildMessages({ text }: { text: string }): ChatMessage[] {
    return [
      { role: "system", content: "Return strict JSON: { score, label }." },
      { role: "user", content: text },
    ];
  }
}

// ─── Test harness ─────────────────────────────────────────────────────────
// We need the DB up so steps/runs rows can be inserted. The `harness` helper
// boots the full server (which seeds tenants + bootstraps agents). For this
// test we want a clean handle, so we manually invoke bootstrapCodeAgents
// after registering the test agents.

const gw = new ProgrammableGateway();

beforeAll(async () => {
  // Apply migrations directly — avoid `buildTestEnv()` because it boots the
  // whole Fastify server, which currently breaks under the runtime
  // engineer's in-progress route additions. The DB seed below is all we
  // need: bootstrapCodeAgents creates the __system tenant + workflow on
  // first run, so the agent registry + DB are aligned without a server.
  const path = await import("node:path");
  const repoRoot = path.resolve(__dirname, "../../..");
  runMigrations(path.join(repoRoot, "packages/db/drizzle"));

  // Replace the gateway with our programmable mock so we can dictate
  // turn-by-turn behaviour.
  setGateway(gw as never);

  agentRegistry.register(new WeatherAgent());
  agentRegistry.register(new ScorerAgent());
  await bootstrapCodeAgents();
});

function ctxFor(): AgentContext {
  return { tenantSlug: "__system", correlationId: "cor-tc16" };
}

describe("TC-16: Phase 1 tool-use loop (P1-RT-01..02 + RT-06..07)", () => {
  it("runs a 2-turn loop: tool_use → tool_result → text (P1-RT-01)", async () => {
    gw.captured = [];
    gw.queueResponse({
      text: "",
      provider: "mock",
      model: "mock-model-v1",
      tokensIn: 10,
      tokensOut: 5,
      finishReason: "tool_calls",
      latencyMs: 1,
      toolCalls: [
        {
          id: "call-1",
          name: "lookupWeather",
          input: { city: "Tokyo" },
        },
      ],
    });
    gw.queueResponse({
      text: "Tokyo is 18 °C and clear.",
      provider: "mock",
      model: "mock-model-v1",
      tokensIn: 30,
      tokensOut: 8,
      finishReason: "stop",
      latencyMs: 1,
    });

    const agent = agentRegistry.get("weatherAgent") as WeatherAgent;
    const result = await agent.run({ city: "Tokyo" }, ctxFor());

    expect(result.status).toBe("ok");
    expect(result.output).toContain("Tokyo");
    // Tokens aggregated across both LLM turns
    expect(result.tokensIn).toBe(40);
    expect(result.tokensOut).toBe(13);

    // The gateway should have been called exactly twice
    expect(gw.captured.length).toBe(2);

    // Turn 1: just the agent's seed messages (system + user)
    expect(gw.captured[0]!.messages.length).toBe(2);
    expect(gw.captured[0]!.tools).toBeDefined();
    expect(gw.captured[0]!.tools!.length).toBe(1);
    expect(gw.captured[0]!.tools![0]!.name).toBe("lookupWeather");
    expect(gw.captured[0]!.routing?.taskType).toBe("tool.loop");

    // Turn 2: seed + assistant(tool_use) + tool(tool_result) = 4 messages
    const t2messages = gw.captured[1]!.messages;
    expect(t2messages.length).toBe(4);
    expect(t2messages[2]!.role).toBe("assistant");
    const t2content = t2messages[2]!.content;
    expect(Array.isArray(t2content)).toBe(true);
    if (Array.isArray(t2content)) {
      const useBlock = t2content.find((b) => b.type === "tool_use");
      expect(useBlock).toBeDefined();
      expect((useBlock as { id: string }).id).toBe("call-1");
    }
    expect(t2messages[3]!.role).toBe("tool");

    // DB: one logic step per LLM call + one tool step per tool dispatch = 3
    const db = getDb();
    const stepRows = db
      .select()
      .from(steps)
      .where(eq(steps.runId, result.runId))
      .all();
    expect(stepRows.length).toBe(3);
    const types = stepRows.map((s) => s.type).sort();
    expect(types).toEqual(["logic", "logic", "tool"]);

    // Run row reflects steps count.
    const runRow = db
      .select()
      .from(runs)
      .where(eq(runs.id, result.runId))
      .all()[0]!;
    expect(runRow.status).toBe("ok");
    expect(runRow.tokensIn).toBe(40);
    expect(runRow.tokensOut).toBe(13);
  });

  it("respects maxSteps by terminating without a final tool dispatch", async () => {
    gw.captured = [];
    // Agent has maxSteps=3 — queue 3 tool_use responses; loop should stop
    // after the LLM call on turn 3 (no dispatch on the final turn).
    for (let i = 0; i < 3; i++) {
      gw.queueResponse({
        text: "",
        provider: "mock",
        model: "mock-model-v1",
        tokensIn: 10,
        tokensOut: 5,
        finishReason: "tool_calls",
        latencyMs: 1,
        toolCalls: [
          {
            id: `call-${i + 1}`,
            name: "lookupWeather",
            input: { city: "X" },
          },
        ],
      });
    }
    const agent = agentRegistry.get("weatherAgent") as WeatherAgent;
    const result = await agent.run({ city: "X" }, ctxFor());
    // Three LLM calls; no exception.
    expect(gw.captured.length).toBe(3);
    expect(result.status).toBe("ok");
  });

  it("forwards req.providers chain from ctx (P1-RT-06)", async () => {
    gw.captured = [];
    gw.queueResponse({
      text: "ok",
      provider: "mock",
      model: "mock-model-v1",
      tokensIn: 1,
      tokensOut: 1,
      finishReason: "stop",
      latencyMs: 1,
    });
    const agent = agentRegistry.get("weatherAgent") as WeatherAgent;
    await agent.run(
      { city: "X" },
      { ...ctxFor(), providers: ["anthropic", "mock"] as never },
    );
    expect(gw.captured[0]!.providers).toEqual(["anthropic", "mock"]);
  });

  it("structured output: validates + repair-retries on bad JSON (P1-RT-07)", async () => {
    gw.captured = [];
    // First response: malformed JSON
    gw.queueResponse({
      text: "{score: not a number, label: 'bad'}",
      provider: "mock",
      model: "mock-model-v1",
      tokensIn: 5,
      tokensOut: 5,
      finishReason: "stop",
      latencyMs: 1,
    });
    // Repair attempt: returns valid JSON
    gw.queueResponse({
      text: JSON.stringify({ score: 0.92, label: "high" }),
      provider: "mock",
      model: "mock-model-v1",
      tokensIn: 5,
      tokensOut: 5,
      finishReason: "stop",
      latencyMs: 1,
    });
    const agent = agentRegistry.get("scorerAgent") as ScorerAgent;
    const result = await agent.run({ text: "hello" }, ctxFor());
    expect(result.status).toBe("ok");
    expect(result.output).toEqual({ score: 0.92, label: "high" });
    expect(gw.captured.length).toBe(2);
    // jsonMode is on for both calls
    expect(gw.captured[0]!.jsonMode).toBe(true);
    expect(gw.captured[1]!.jsonMode).toBe(true);
    expect(gw.captured[0]!.routing?.taskType).toBe("tool.loop");
    expect(gw.captured[1]!.routing?.taskType).toBe("output.repair");
    // Tokens summed across both turns
    expect(result.tokensIn).toBe(10);
    expect(result.tokensOut).toBe(10);
  });

  it("routes by task class while preserving explicit provider/model overrides", async () => {
    const agent = agentRegistry.get("scorerAgent") as ScorerAgent;
    const validResponse = (): ChatResponse => ({
      text: JSON.stringify({ score: 0.8, label: "good" }),
      provider: "mock",
      model: "mock-model-v1",
      tokensIn: 1,
      tokensOut: 1,
      finishReason: "stop",
      latencyMs: 1,
    });

    gw.captured = [];
    gw.queueResponse(validResponse());
    await agent.run(
      { text: "normal" },
      {
        ...ctxFor(),
        taskClass: "evaluation",
        provider: "openai",
        model: "gpt-test",
      },
    );
    expect(gw.captured[0]!.routing?.taskType).toBe("evaluation");
    expect(gw.captured[0]!.routing).toMatchObject({
      taskType: "evaluation",
      requestedRoute: "openai/gpt-test",
      bypassTaskPolicy: true,
    });

    gw.captured = [];
    gw.queueResponse(validResponse());
    await agent.run(
      { text: "test" },
      {
        ...ctxFor(),
        taskClass: "evaluation",
        provider: "openai",
        model: "gpt-test",
        testRun: true,
      },
    );
    expect(gw.captured[0]!.routing).toMatchObject({
      taskType: "evaluation",
      requestedRoute: "openai/gpt-test",
      bypassTaskPolicy: true,
    });
  });

  it("structured output: two consecutive failures throws output_parse_error", async () => {
    gw.captured = [];
    gw.queueResponse({
      text: "not even json",
      provider: "mock",
      model: "mock-model-v1",
      tokensIn: 1,
      tokensOut: 1,
      finishReason: "stop",
      latencyMs: 1,
    });
    gw.queueResponse({
      text: "still not json",
      provider: "mock",
      model: "mock-model-v1",
      tokensIn: 1,
      tokensOut: 1,
      finishReason: "stop",
      latencyMs: 1,
    });
    const agent = agentRegistry.get("scorerAgent") as ScorerAgent;
    await expect(agent.run({ text: "x" }, ctxFor())).rejects.toMatchObject({
      code: "bad_request",
      message: expect.stringMatching(/output_parse_error/),
    });
  });
});
