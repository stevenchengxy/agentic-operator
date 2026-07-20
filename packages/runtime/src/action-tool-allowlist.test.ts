import { afterEach, describe, expect, it } from "vitest";

import { ActionSchema } from "./manifest";
import { setRuntimeGateway } from "./llm-host";
import { runAction } from "./step-engine";

afterEach(() => {
  setRuntimeGateway(null);
});

describe("action-local tool capability boundaries", () => {
  it("keeps omission compatible while validating explicit logic and tool scopes", () => {
    const legacy = ActionSchema.parse({
      order: "1",
      name: "legacy-reason",
      type: "logic",
    });
    expect(legacy.allowed_tools).toBeUndefined();

    expect(ActionSchema.parse({
      order: "1",
      name: "reason",
      type: "logic",
      allowed_tools: [],
    }).allowed_tools).toEqual([]);
    expect(ActionSchema.safeParse({
      order: "1",
      name: "records.write",
      type: "tool",
      allowed_tools: ["records.write"],
    }).success).toBe(true);
    expect(ActionSchema.safeParse({
      order: "1",
      name: "records.write",
      type: "tool",
      allowed_tools: ["records.read", "records.write"],
    }).success).toBe(false);
  });

  it("rejects a logic step's secondary write outside the action intersection before its handler runs", async () => {
    let writeHandlerCalls = 0;
    let advertisedTools: string[] = [];
    setRuntimeGateway({
      async chat(request) {
        advertisedTools = (request.tools ?? []).map((tool) => tool.name);
        // A compromised or non-conforming provider can still return a tool
        // call that was not advertised. The engine must enforce the boundary.
        return {
          text: "",
          provider: "mock",
          model: "action-tool-boundary",
          tokensIn: 1,
          tokensOut: 1,
          finishReason: "tool_calls",
          latencyMs: 1,
          toolCalls: [{ id: "write-1", name: "records.write", input: { id: "r-1" } }],
        };
      },
    } as never);

    const output = await runAction({
      ctx: {
        agentName: "generated-record-agent",
        actionName: "summarize",
        correlationId: "action-boundary-write-deny",
        tenantSlug: "boundary-test",
        event: { name: "RECORD_LOADED", data: { id: "r-1" } },
      },
      action: ActionSchema.parse({
        order: "2",
        name: "summarize",
        type: "logic",
        allowed_tools: [],
      }),
      agent: {
        name: "generated-record-agent",
        generated: true,
        tool_use: [{ name: "records.write" }],
      },
      tenantRegistry: {
        prompts: {
          summarize: {
            kind: "prompt",
            name: "summarize",
            template: () => "Summarize the already persisted record without another write.",
          },
        },
        tools: {
          "records.write": {
            kind: "tool",
            name: "records.write",
            description: "write a record",
            async handler() {
              writeHandlerCalls += 1;
              return { data: { written: true } };
            },
          },
        },
      } as never,
    });

    expect(advertisedTools).toEqual([]);
    expect(output).toMatchObject({
      ok: false,
      meta: {
        error: "llm_incomplete",
        message: expect.stringContaining("action_tool_not_allowed"),
        toolCalls: [],
      },
    });
    expect(writeHandlerCalls).toBe(0);
  });
});
