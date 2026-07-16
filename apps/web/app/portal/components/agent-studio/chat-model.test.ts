import type { GetRunSessionResponse } from "@agentic/contracts";
import { describe, expect, it } from "vitest";
import {
  buildChatTranscript,
  isStructuredChatValue,
  normalizeAssistantContent,
  prettyChatValue,
} from "./chat-model";

const now = new Date("2026-07-15T04:00:00.000Z");

function session(
  overrides: Partial<GetRunSessionResponse> = {},
): GetRunSessionResponse {
  return {
    session: {
      id: "ars-1",
      tenantId: "ten-1",
      agentId: "agt-1",
      createdBy: null,
      title: "Test chat",
      createdAt: now,
      updatedAt: now,
      lastRunAt: now,
    },
    messages: [],
    runs: [],
    ...overrides,
  };
}

function run(
  status: "queued" | "running" | "ok" | "failed" | "waiting" | "cancelled",
) {
  return {
    id: "run-1",
    sessionId: "ars-1",
    status,
    source: "studio" as const,
    target: { kind: "live" as const, agentVersionId: "av-1" },
    definitionHash: "hash",
    subject: null,
    promptPreview: "hello",
    testRun: true,
    sideEffectMode: "safe" as const,
    outputValid: status === "ok" ? true : null,
    queuedAt: now,
    startedAt: now,
    endedAt: status === "running" || status === "queued" ? null : now,
    durationMs: status === "running" || status === "queued" ? null : 20,
    provider: "mock" as const,
    model: "mock-model-v1",
    tokensIn: null,
    tokensOut: null,
    error: status === "failed" ? "Model gateway unavailable" : null,
  };
}

describe("Test Lab chat transcript", () => {
  it("orders user and assistant messages while hiding system/tool records", () => {
    const transcript = buildChatTranscript(
      session({
        messages: [
          {
            id: "msg-assistant",
            sessionId: "ars-1",
            runId: "run-1",
            ord: 3,
            role: "assistant",
            content: { answer: 42 },
            createdAt: now,
          },
          {
            id: "msg-system",
            sessionId: "ars-1",
            runId: "run-1",
            ord: 1,
            role: "system",
            content: "hidden",
            createdAt: now,
          },
          {
            id: "msg-user",
            sessionId: "ars-1",
            runId: "run-1",
            ord: 2,
            role: "user",
            content: { prompt: "Preserve this exact prompt", inputs: {} },
            createdAt: now,
          },
        ],
        runs: [run("ok")],
      }),
    );

    expect(transcript.map(({ role }) => role)).toEqual(["user", "assistant"]);
    expect(transcript[0]?.content).toBe("Preserve this exact prompt");
    expect(transcript[1]?.content).toEqual({ answer: 42 });
  });

  it.each([
    ["running", "working", "working on this request"],
    ["failed", "failed", "Model gateway unavailable"],
    ["cancelled", "cancelled", "cancelled"],
    ["ok", "empty", "without returning a result"],
  ] as const)(
    "adds a useful assistant fallback for a %s run",
    (status, state, copy) => {
      const transcript = buildChatTranscript(
        session({
          messages: [
            {
              id: "msg-user",
              sessionId: "ars-1",
              runId: "run-1",
              ord: 1,
              role: "user",
              content: { prompt: "hello", inputs: {} },
              createdAt: now,
            },
          ],
          runs: [run(status)],
        }),
      );

      expect(transcript[1]?.state).toBe(state);
      expect(String(transcript[1]?.content)).toContain(copy);
    },
  );

  it("formats structured results as readable JSON and null safely", () => {
    expect(isStructuredChatValue({ answer: 42 })).toBe(true);
    expect(prettyChatValue({ answer: 42 })).toBe('{\n  "answer": 42\n}');
    expect(prettyChatValue(null)).toContain("without returning a result");
  });

  it("normalizes legacy assistant JSON strings without changing plain prose", () => {
    const json = '{"answer":42,"items":["a","b"]}';
    const fenced = '```json\n{"answer":42}\n```';

    expect(normalizeAssistantContent(json)).toEqual({
      answer: 42,
      items: ["a", "b"],
    });
    expect(normalizeAssistantContent(fenced)).toEqual({ answer: 42 });
    expect(normalizeAssistantContent("A normal assistant response.")).toBe(
      "A normal assistant response.",
    );
    expect(normalizeAssistantContent("{not valid JSON}")).toBe(
      "{not valid JSON}",
    );
  });

  it("renders a persisted assistant JSON string as structured chat content", () => {
    const transcript = buildChatTranscript(
      session({
        messages: [
          {
            id: "msg-assistant-json",
            sessionId: "ars-1",
            runId: "run-1",
            ord: 1,
            role: "assistant",
            content: '{"event_type":"TEST3_END","payload":{"status":"ok"}}',
            createdAt: now,
          },
        ],
        runs: [run("ok")],
      }),
    );

    expect(transcript[0]).toMatchObject({
      role: "assistant",
      state: "complete",
      content: {
        event_type: "TEST3_END",
        payload: { status: "ok" },
      },
    });
  });

  it("recognizes a legacy stringified assistant error envelope", () => {
    const transcript = buildChatTranscript(
      session({
        messages: [
          {
            id: "msg-string-error",
            sessionId: "ars-1",
            runId: "run-1",
            ord: 1,
            role: "assistant",
            content:
              '{"error":{"code":"gateway_failed","message":"Try again later"}}',
            createdAt: now,
          },
        ],
        runs: [run("failed")],
      }),
    );

    expect(transcript[0]).toMatchObject({
      state: "failed",
      content: "Try again later",
    });
  });

  it("uses a fetched output during the brief terminal-message persistence race", () => {
    const response = session({
      messages: [
        {
          id: "msg-user",
          sessionId: "ars-1",
          runId: "run-1",
          ord: 1,
          role: "user",
          content: { prompt: "hello", inputs: {} },
          createdAt: now,
        },
      ],
      runs: [run("ok")],
    });
    const transcript = buildChatTranscript(
      response,
      new Map([["run-1", { answer: 42 }]]),
    );

    expect(transcript[1]).toMatchObject({
      role: "assistant",
      state: "complete",
      content: { answer: 42 },
    });
  });

  it("shows an assistant error message without exposing its envelope", () => {
    const transcript = buildChatTranscript(
      session({
        messages: [
          {
            id: "msg-error",
            sessionId: "ars-1",
            runId: "run-1",
            ord: 1,
            role: "assistant",
            content: {
              error: { code: "gateway_failed", message: "Try again later" },
            },
            createdAt: now,
          },
        ],
        runs: [run("failed")],
      }),
    );

    expect(transcript[0]).toMatchObject({
      state: "failed",
      content: "Try again later",
    });
  });
});
