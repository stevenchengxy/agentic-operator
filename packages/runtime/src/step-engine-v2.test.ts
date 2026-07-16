import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type {
  ChatRequest,
  ChatResponse,
  LLMGateway,
} from "@agentic/llm-gateway";
import { normalizeAgentForExecution } from "./agent-execution";
import { parseValidateAndRepairOutput } from "./agent-execution";
import { createBufferedTraceSink } from "./execution-trace";
import { getRuntimeGateway, setRuntimeGateway } from "./llm-host";
import { runAction } from "./step-engine";

const previousGateway = getRuntimeGateway();
const previousLogRoot = process.env.AGENTIC_LOGS_DIR;
let testLogRoot = "";
let requests: ChatRequest[] = [];
let responses: Array<ChatResponse | Error> = [];

const gateway = {
  async chat(request: ChatRequest): Promise<ChatResponse> {
    requests.push(structuredClone(request));
    const response = responses.shift();
    if (!response) throw new Error("test gateway response queue is empty");
    if (response instanceof Error) throw response;
    return response;
  },
} as unknown as LLMGateway;

beforeEach(() => {
  requests = [];
  responses = [];
  setRuntimeGateway(gateway);
});

before(async () => {
  testLogRoot = await mkdtemp(path.join(os.tmpdir(), "agentic-runtime-logs-"));
  process.env.AGENTIC_LOGS_DIR = testLogRoot;
});

after(async () => {
  if (previousGateway) setRuntimeGateway(previousGateway);
  if (previousLogRoot === undefined) delete process.env.AGENTIC_LOGS_DIR;
  else process.env.AGENTIC_LOGS_DIR = previousLogRoot;
  if (testLogRoot) await rm(testLogRoot, { recursive: true, force: true });
});

function response(
  text: string,
  toolCalls?: ChatResponse["toolCalls"],
): ChatResponse {
  return {
    text,
    provider: "mock",
    model: "mock-model-v2",
    tokensIn: 11,
    tokensOut: 7,
    finishReason: toolCalls ? "tool_calls" : "stop",
    latencyMs: 1,
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function v2Agent(overrides: Record<string, unknown> = {}) {
  return normalizeAgentForExecution({
    id: "1-studio-agent",
    name: "studioAgent",
    description: "A Studio-authored agent.",
    actor: ["Agent"],
    trigger: ["RUN"],
    inputs: [
      {
        id: "prompt",
        kind: "prompt",
        required: true,
        schema: { type: "string", minLength: 1 },
      },
      {
        id: "candidate",
        kind: "value",
        required: true,
        schema: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
          additionalProperties: false,
        },
      },
    ],
    ontology_instructions: "Never invent candidate evidence.",
    user_prompt_template: "{{json inputs.candidate}}",
    generated: true,
    tool_use: [],
    actions: [
      {
        order: "1",
        name: "execute",
        description: "Produce the declared result.",
        type: "logic",
      },
    ],
    outputs: [
      {
        id: "result",
        required: true,
        schema: {
          type: "object",
          required: ["decision"],
          properties: {
            decision: { type: "string", enum: ["advance", "reject"] },
          },
          additionalProperties: false,
        },
      },
    ],
    output_config: {
      format: "json",
      strict: true,
      repair_attempts: 1,
      unwrap_single_output: false,
      artifact: {
        filename: "output.json",
        persist_individual_outputs: false,
        persist_run_input: true,
        persist_run_record: true,
        persist_raw_response: false,
      },
    },
    triggered_event: ["DONE"],
    provider: "mock",
    model: "mock-model-v2",
    temperature: 0.25,
    max_tokens: 900,
    ...overrides,
  }).definition;
}

describe("runAction v2 integration", () => {
  it("sends the Studio prompt as a real user role and repairs strict output once", async () => {
    responses.push(
      response("not-json"),
      response(JSON.stringify({ result: { decision: "advance" } })),
    );
    const trace = createBufferedTraceSink();
    const result = await runAction({
      runId: "run-v2-1",
      stepId: "stp-v2-1",
      trace,
      ctx: {
        agentName: "studioAgent",
        actionName: "execute",
        correlationId: "cor-v2-1",
        tenantSlug: "test",
        event: {
          // Production registration namespaces Inngest event names. The
          // execution boundary must remove that prefix before resolving the
          // authored trigger_bindings key.
          name: "test/RUN",
          data: {
            prompt: "Assess candidate cand-1.",
            candidate: { id: "cand-1" },
          },
        },
      },
      action: {
        order: "1",
        name: "execute",
        description: "Produce the declared result.",
        action_prompt: "Apply the authored assessment rubric.",
        type: "logic",
      },
      agent: v2Agent({
        trigger_bindings: {
          RUN: {
            prompt: { path: "$.prompt" },
            candidate: { path: "$.candidate" },
          },
        },
      }),
      tenantRegistry: {},
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { result: { decision: "advance" } });
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.messages[0]?.role, "system");
    assert.equal(requests[0]?.messages[1]?.role, "user");
    assert.ok(
      typeof requests[0]?.messages[1]?.content === "string" &&
        requests[0].messages[1].content.startsWith("Assess candidate cand-1."),
    );
    assert.match(
      String(requests[0]?.messages[0]?.content),
      /Apply the authored assessment rubric\./,
    );
    assert.match(
      String(requests[0]?.messages[1]?.content),
      /<action-context>[\s\S]*Produce the declared result\./,
    );
    assert.equal(requests[0]?.jsonMode, true);
    assert.equal(requests[1]?.jsonMode, true);
    assert.equal(requests[0]?.temperature, 0.25);
    assert.equal(requests[0]?.maxTokens, 900);
    assert.equal(result.meta?.outputValid, true);
    assert.equal(result.meta?.repairAttempts, 1);
    assert.ok(
      trace.events.some(
        (event) =>
          event.kind === "output_validation" && event.status === "failed",
      ),
    );
    assert.ok(
      trace.events.some(
        (event) => event.name === "llm.output_repair" && event.status === "ok",
      ),
    );
  });

  it("delivers prior conversation to the gateway before the exact current user turn", async () => {
    responses.push(
      response(JSON.stringify({ result: { decision: "advance" } })),
    );
    const trace = createBufferedTraceSink();
    const conversationHistory = [
      { role: "user" as const, content: "What did you find previously?" },
      {
        role: "assistant" as const,
        content: "I found one relevant piece of evidence.",
      },
    ];
    const result = await runAction({
      runId: "run-v2-chat",
      stepId: "stp-v2-chat",
      trace,
      conversationHistory,
      ctx: {
        agentName: "studioAgent",
        actionName: "execute",
        correlationId: "cor-v2-chat",
        tenantSlug: "test",
        event: {
          name: "RUN",
          data: {
            prompt: "Now assess candidate cand-chat with that context.",
            inputs: { candidate: { id: "cand-chat" } },
          },
        },
      },
      action: {
        order: "1",
        name: "execute",
        description: "Produce the declared result.",
        type: "logic",
      },
      agent: v2Agent(),
      tenantRegistry: {},
    });

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.deepEqual(
      requests[0]?.messages.map((message) => message.role),
      ["system", "user", "assistant", "user"],
    );
    assert.deepEqual(requests[0]?.messages.slice(1, -1), conversationHistory);
    const currentUser = requests[0]?.messages.at(-1);
    assert.equal(currentUser?.role, "user");
    assert.ok(
      typeof currentUser?.content === "string" &&
        currentUser.content.startsWith(
          "Now assess candidate cand-chat with that context.",
        ),
    );
    const promptTrace = trace.events.find(
      (event) => event.name === "prompt.compiled",
    );
    assert.equal(
      promptTrace?.data?.userBytes,
      Buffer.byteLength(String(currentUser?.content)),
    );
  });

  it("rejects schema-invalid model tool input before the handler", async () => {
    let handlerCalls = 0;
    responses.push(
      response("", [
        { id: "call-1", name: "searchEvidence", input: { limit: 3 } },
      ]),
      response(JSON.stringify({ result: { decision: "reject" } })),
    );
    const agent = v2Agent({
      tool_use: [
        {
          name: "searchEvidence",
          description: "Search evidence by a required query.",
          input_schema: {
            type: "object",
            required: ["query"],
            properties: { query: { type: "string" } },
            additionalProperties: false,
          },
        },
      ],
    });
    const result = await runAction({
      runId: "run-v2-tool",
      stepId: "stp-v2-tool",
      ctx: {
        agentName: "studioAgent",
        actionName: "execute",
        correlationId: "cor-v2-tool",
        tenantSlug: "test",
        event: {
          name: "RUN",
          data: {
            prompt: "Assess candidate cand-2.",
            inputs: { candidate: { id: "cand-2" } },
          },
        },
      },
      action: {
        order: "1",
        name: "execute",
        description: "Produce the declared result.",
        type: "logic",
      },
      agent,
      tenantRegistry: {
        tools: {
          searchEvidence: {
            kind: "tool",
            name: "searchEvidence",
            description: "Search evidence.",
            handler: async () => {
              handlerCalls += 1;
              return { ok: true, data: { evidence: [] } };
            },
          } as never,
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(handlerCalls, 0);
    const toolCalls = result.meta?.toolCalls as
      | Array<{ name: string; isError: boolean }>
      | undefined;
    assert.equal(toolCalls?.length, 1);
    assert.equal(toolCalls?.[0]?.name, "searchEvidence");
    assert.equal(toolCalls?.[0]?.isError, true);
    const toolTurn = requests[1]?.messages.find(
      (message) => message.role === "tool",
    );
    assert.match(
      JSON.stringify(toolTurn?.content),
      /tool_input_schema_invalid/,
    );
  });

  it("closes both model and step traces when the gateway throws", async () => {
    const trace = createBufferedTraceSink();
    await assert.rejects(
      runAction({
        runId: "run-v2-gateway-error",
        stepId: "stp-v2-gateway-error",
        trace,
        ctx: {
          agentName: "studioAgent",
          actionName: "execute",
          correlationId: "cor-v2-gateway-error",
          tenantSlug: "test",
          event: {
            name: "RUN",
            data: {
              prompt: "Assess candidate cand-error.",
              inputs: { candidate: { id: "cand-error" } },
            },
          },
        },
        action: {
          order: "1",
          name: "execute",
          description: "Produce the declared result.",
          type: "logic",
        },
        agent: v2Agent(),
        tenantRegistry: {},
      }),
      /response queue is empty/,
    );

    assert.ok(
      trace.events.some(
        (event) =>
          event.kind === "llm" &&
          event.name === "llm.call" &&
          event.status === "failed",
      ),
    );
    assert.ok(
      trace.events.some(
        (event) =>
          event.kind === "step" &&
          event.name === "execute" &&
          event.status === "failed",
      ),
    );
  });

  it("honors logic-only retries and the per-action gateway timeout", async () => {
    responses.push(
      new Error("transient provider failure"),
      response(JSON.stringify({ result: { decision: "advance" } })),
    );
    const result = await runAction({
      ctx: {
        agentName: "studioAgent",
        actionName: "execute",
        correlationId: "cor-v2-retry",
        tenantSlug: "test",
        event: {
          name: "RUN",
          data: {
            prompt: "Assess candidate cand-retry.",
            inputs: { candidate: { id: "cand-retry" } },
          },
        },
      },
      action: {
        order: "1",
        name: "execute",
        description: "Produce the declared result.",
        type: "logic",
        retries: 1,
        timeout_s: 2,
      },
      agent: v2Agent({ timeout_s: 90 }),
      tenantRegistry: {},
    });

    assert.equal(result.ok, true);
    assert.equal(result.meta?.actionAttempts, 2);
    assert.equal(requests.length, 2);
    assert.equal(requests[0]?.timeoutMs, 2_000);
    assert.equal(requests[1]?.timeoutMs, 2_000);
  });

  it("dispatches an explicitly named direct tool with its allow-listed config", async () => {
    let receivedConfig: Record<string, unknown> | undefined;
    let receivedInput: Record<string, unknown> | undefined;
    const result = await runAction({
      ctx: {
        agentName: "studioAgent",
        actionName: "collectEvidence",
        correlationId: "cor-direct-tool",
        tenantSlug: "test",
        event: { name: "RUN", data: { candidateId: "cand-3" } },
      },
      action: {
        order: "1",
        name: "collectEvidence",
        tool: "searchEvidence",
        description: "Collect evidence.",
        type: "tool",
        input_mapping: { query: "$.event.candidateId" },
        output_mapping: { matches: "$.result.count" },
      },
      agent: v2Agent({
        tool_use: [
          {
            name: "searchEvidence",
            input_schema: {
              type: "object",
              required: ["query"],
              properties: { query: { type: "string" } },
              additionalProperties: false,
            },
            config: { index: "tenant-candidates" },
          },
        ],
      }),
      tenantRegistry: {
        tools: {
          searchEvidence: {
            kind: "tool",
            name: "searchEvidence",
            description: "Search evidence.",
            handler: async (ctx: {
              config?: Record<string, unknown>;
              event?: { data: Record<string, unknown> };
            }) => {
              receivedConfig = ctx.config;
              receivedInput = ctx.event?.data;
              return { ok: true, data: { count: 1 } };
            },
          } as never,
        },
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { matches: 1 });
    assert.deepEqual(receivedConfig, { index: "tenant-candidates" });
    assert.deepEqual(receivedInput, { query: "cand-3" });
  });

  it("uses per-action mapped inputs when compiling a v2 logic prompt", async () => {
    responses.push(
      response(JSON.stringify({ result: { decision: "advance" } })),
    );
    const result = await runAction({
      ctx: {
        agentName: "studioAgent",
        actionName: "execute",
        correlationId: "cor-mapped-logic",
        tenantSlug: "test",
        event: {
          name: "RUN",
          data: {
            prompt: "Assess the mapped candidate.",
            inputs: { candidate: { id: "cand-original" } },
          },
        },
      },
      action: {
        order: "1",
        name: "execute",
        description: "Produce the declared result.",
        type: "logic",
        input_mapping: {
          candidate: { constant: { id: "cand-mapped" } },
        },
      },
      agent: v2Agent(),
      tenantRegistry: {},
    });

    assert.equal(result.ok, true);
    const userContent = String(requests[0]?.messages[1]?.content);
    assert.match(userContent, /cand-mapped/);
    assert.doesNotMatch(userContent, /cand-original/);
  });

  it("maps a structured logic result before aggregate output validation", async () => {
    responses.push(response(JSON.stringify({ decision: "advance" })));
    const agent = v2Agent();
    const result = await runAction({
      ctx: {
        agentName: "studioAgent",
        actionName: "execute",
        correlationId: "cor-mapped-output",
        tenantSlug: "test",
        event: {
          name: "RUN",
          data: {
            prompt: "Assess candidate cand-output.",
            inputs: { candidate: { id: "cand-output" } },
          },
        },
      },
      action: {
        order: "1",
        name: "execute",
        description: "Produce the declared result.",
        type: "logic",
        output_mapping: { result: "$.result" },
      },
      agent,
      tenantRegistry: {},
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { result: { decision: "advance" } });
    const validated = await parseValidateAndRepairOutput({
      definition: agent,
      candidate: result.data,
    });
    assert.equal(validated.valid, true);
  });

  it("evaluates restricted conditions and exposes the selected branch target", async () => {
    const result = await runAction({
      ctx: {
        agentName: "studioAgent",
        actionName: "routeCandidate",
        correlationId: "cor-condition",
        tenantSlug: "test",
        event: { name: "RUN", data: { inputs: {} } },
        lastResult: { score: 82 },
      },
      action: {
        id: "route",
        order: "1",
        name: "routeCandidate",
        description: "Route by score.",
        type: "condition",
        condition: "lastResult.score >= 70",
        true_action_id: "advance",
        false_action_id: "reject",
        output_mapping: { route: "$.result.targetActionId" },
      },
      agent: v2Agent(),
      tenantRegistry: {},
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.data, {
      route: "advance",
      evaluated: true,
      condition: "lastResult.score >= 70",
      targetActionId: "advance",
    });
  });

  it("blocks an undeclared direct tool before registry dispatch", async () => {
    let handlerCalls = 0;
    const result = await runAction({
      ctx: {
        agentName: "studioAgent",
        actionName: "collectEvidence",
        correlationId: "cor-direct-tool-denied",
        tenantSlug: "test",
        event: { name: "RUN", data: { query: "cand-4" } },
      },
      action: {
        order: "1",
        name: "collectEvidence",
        tool: "searchEvidence",
        description: "Collect evidence.",
        type: "tool",
      },
      agent: v2Agent({ tool_use: [] }),
      tenantRegistry: {
        tools: {
          searchEvidence: {
            kind: "tool",
            name: "searchEvidence",
            description: "Search evidence.",
            handler: async () => {
              handlerCalls += 1;
              return { ok: true, data: { count: 1 } };
            },
          } as never,
        },
      },
    });

    assert.equal(result.ok, false);
    assert.equal(result.meta?.error, "tool_not_allowed");
    assert.equal(handlerCalls, 0);
  });

  it("fails an allow-listed but unresolved v2 direct tool without using the legacy mock", async () => {
    const result = await runAction({
      ctx: {
        agentName: "studioAgent",
        actionName: "collectEvidence",
        correlationId: "cor-direct-tool-missing",
        tenantSlug: "test",
        event: { name: "RUN", data: { query: "cand-5" } },
      },
      action: {
        order: "1",
        name: "collectEvidence",
        tool: "missingStudioTool",
        description: "Collect evidence.",
        type: "tool",
      },
      agent: v2Agent({ tool_use: [{ name: "missingStudioTool" }] }),
      tenantRegistry: {},
    });

    assert.equal(result.ok, false);
    assert.equal(result.meta?.error, "tool_not_registered");
    assert.equal(result.meta?.tool, "missingStudioTool");
  });

  it("keeps legacy v1 direct-tool dispatch compatible without a tool_use array", async () => {
    let handlerCalls = 0;
    const result = await runAction({
      ctx: {
        agentName: "legacyAgent",
        actionName: "legacyTool",
        correlationId: "cor-v1-direct-tool",
        tenantSlug: "test",
        event: { name: "RUN", data: { value: 1 } },
      },
      action: {
        order: "1",
        name: "legacyTool",
        description: "Legacy direct tool action.",
        type: "tool",
      },
      agent: { name: "legacyAgent" },
      tenantRegistry: {
        tools: {
          legacyTool: {
            kind: "tool",
            name: "legacyTool",
            description: "Legacy tool.",
            handler: async () => {
              handlerCalls += 1;
              return { ok: true, data: { legacy: true } };
            },
          } as never,
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(handlerCalls, 1);
  });

  it("never applies authored retries to a direct tool action", async () => {
    let handlerCalls = 0;
    await assert.rejects(
      runAction({
        ctx: {
          agentName: "studioAgent",
          actionName: "unstableWrite",
          correlationId: "cor-tool-no-retry",
          tenantSlug: "test",
          event: { name: "RUN", data: {} },
        },
        action: {
          order: "1",
          name: "unstableWrite",
          description: "Side-effecting write.",
          type: "tool",
          retries: 5,
        },
        agent: v2Agent({ tool_use: [{ name: "unstableWrite" }] }),
        tenantRegistry: {
          tools: {
            unstableWrite: {
              kind: "tool",
              name: "unstableWrite",
              handler: async () => {
                handlerCalls += 1;
                throw new Error("write failed");
              },
            } as never,
          },
        },
      }),
      /write failed/,
    );
    assert.equal(handlerCalls, 1);
  });
});
