import { describe, expect, it } from "vitest";
import { z } from "zod";
import { selectEmittedEvent, selectEmittedEvents } from "./emit-select";
import { mergeStepResults } from "./message-envelope";
import { runAction } from "./step-engine";
import { setRuntimeGateway } from "./llm-host";
import { parseStructuredJson } from "./structured-output";

describe("structured LLM output", () => {
  it("parses direct, fenced, and lightly wrapped JSON", () => {
    expect(parseStructuredJson('{"ok":true}')).toEqual({ ok: true });
    expect(
      parseStructuredJson('```json\n{"ok":true,"items":[1,2]}\n```'),
    ).toEqual({
      ok: true,
      items: [1, 2],
    });
    expect(
      parseStructuredJson(
        '结果如下：\n{"body":"brace } in string","ok":true}\n谢谢',
      ),
    ).toEqual({
      body: "brace } in string",
      ok: true,
    });
    expect(() => parseStructuredJson("not json")).toThrow(
      /Invalid structured LLM output/,
    );
  });

  it("enables gateway JSON mode and validates a fenced response against the prompt schema", async () => {
    let jsonMode: boolean | undefined;
    setRuntimeGateway({
      async chat(req) {
        jsonMode = req.jsonMode;
        return {
          text: '```json\n{"decision":"keep","score":95}\n```',
          provider: "mock",
          model: "mock-structured",
          tokensIn: 1,
          tokensOut: 1,
          finishReason: "stop",
          latencyMs: 1,
        };
      },
    } as never);

    const out = await runAction({
      ctx: {
        agentName: "structured",
        actionName: "decide",
        correlationId: "cor-structured",
        tenantSlug: "test",
        event: { name: "INPUT", data: {} },
      },
      action: { order: "1", name: "decide", type: "logic" },
      tenantRegistry: {
        prompts: {
          decide: {
            kind: "prompt",
            name: "decide",
            template: () => "Return JSON",
            output: z.object({ decision: z.string(), score: z.number() }),
          },
        },
      },
    });

    expect(jsonMode).toBe(true);
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ decision: "keep", score: 95 });
  });
});

describe("cross-step structured result accumulation", () => {
  it("merges plain objects with current-step precedence", () => {
    expect(
      mergeStepResults(
        { jd_content: "full jd", title: "old" },
        { title: "new", mapping: [] },
      ),
    ).toEqual({ jd_content: "full jd", title: "new", mapping: [] });
  });

  it("removes stale routing selectors and keeps only the current step selector", () => {
    const withoutCurrentSelector = mergeStepResults(
      { _emit: "MATCH_FAILED", matchScore: 95 },
      { decision_reason: "excellent" },
    );
    expect(withoutCurrentSelector).toEqual({
      matchScore: 95,
      decision_reason: "excellent",
    });
    expect(
      selectEmittedEvent(
        ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"],
        withoutCurrentSelector,
      ),
    ).toBe("MATCH_PASSED_NEED_INTERVIEW");

    const withCurrentSelector = mergeStepResults(withoutCurrentSelector, {
      _emit: "MATCH_FAILED",
    });
    expect(
      selectEmittedEvent(
        ["MATCH_PASSED_NEED_INTERVIEW", "MATCH_FAILED"],
        withCurrentSelector,
      ),
    ).toBe("MATCH_FAILED");
  });

  it("keeps legacy replacement semantics for arrays and strings", () => {
    expect(mergeStepResults({ a: 1 }, [1, 2])).toEqual([1, 2]);
    expect(mergeStepResults({ a: 1 }, "done")).toBe("done");
    expect(mergeStepResults([1], { b: 2 })).toEqual({ b: 2 });
  });

  it("selects an allow-listed event from fenced JSON", () => {
    expect(
      selectEmittedEvent(
        [
          "MATCH_PASSED_NEED_INTERVIEW",
          "MATCH_PASSED_NO_INTERVIEW",
          "MATCH_FAILED",
        ],
        '```json\n{"_emit":"MATCH_PASSED_NO_INTERVIEW","match_score":95}\n```',
      ),
    ).toBe("MATCH_PASSED_NO_INTERVIEW");
  });

  it("preserves every explicit emit intent, including repeated event names", () => {
    expect(
      selectEmittedEvents(
        ["ITEM_DONE", "BATCH_FAILED"],
        { ignored: true },
        [
          { event: "ITEM_DONE", payload: { id: "1" } },
          { event: "ITEM_DONE", payload: { id: "2" } },
          { event: "INVENTED", payload: { id: "3" } },
        ],
      ),
    ).toEqual([
      { event: "ITEM_DONE", payload: { id: "1" } },
      { event: "ITEM_DONE", payload: { id: "2" } },
    ]);
  });

  it("keeps the historical single-event fallback when no explicit intents exist", () => {
    expect(selectEmittedEvents(["PASS", "FAIL"], { _emit: "FAIL" })).toEqual([{ event: "FAIL" }]);
  });

  it("fails closed instead of turning an invented explicit event into default success", () => {
    expect(selectEmittedEvents(["SUCCESS"], {}, [{ event: "INVENTED" }])).toEqual([]);
  });
});
