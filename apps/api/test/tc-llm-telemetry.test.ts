import { describe, it, expect } from "vitest";
import type { LlmCallRecord } from "@agentic/agent-factory";
import {
  getLlmTelemetryStatus,
  writeLlmCall,
} from "../src/services/agent-factory/llm-telemetry";
import { getDb, llmCalls, eq } from "@agentic/db";

// #P0-3 — raw LLM telemetry is persisted to the llm_calls table (was ephemeral in-memory streaming).
// Feed the production writer a record and read it back — proving the table + writer + routing fields.

describe("#P0-3 llm_calls telemetry persistence", () => {
  it("persists an LLM call with routing (requested vs served + fallback) + sizes", () => {
    const conv = `conv-tel-${Math.floor(Date.now() % 1e9)}`;
    const rec: LlmCallRecord = {
      conversationId: conv, domain: "raas", tenantId: "raas", purpose: "review",
      requestedModel: "kimi", servedModel: "sonnet", provider: "https://gw", fallback: true,
      promptChars: 400, completionChars: 120, approxTokensIn: 100, approxTokensOut: 30, latencyMs: 812, ok: true,
    };
    writeLlmCall(rec);
    const rows = getDb().select().from(llmCalls).where(eq(llmCalls.conversationId, conv)).all();
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.requestedModel).toBe("kimi");
    expect(row.servedModel).toBe("sonnet");
    expect(row.fallback).toBe(true);
    expect(row.promptChars).toBe(400);
    expect(row.approxTokensOut).toBe(30);
    expect(row.latencyMs).toBe(812);
    expect(row.ok).toBe(true);
    expect(row.purpose).toBe("review");
    expect(getLlmTelemetryStatus()).toMatchObject({
      ok: true,
      consecutiveFailures: 0,
    });
  });

  it("records a failed call (ok=false + failureReason) too", () => {
    const conv = `conv-fail-${Math.floor(Date.now() % 1e9)}`;
    writeLlmCall({
      conversationId: conv, domain: "raas", purpose: "design",
      requestedModel: "kimi", servedModel: "kimi", fallback: false,
      promptChars: 10, completionChars: 0, approxTokensIn: 3, approxTokensOut: 0, latencyMs: 50, ok: false, failureReason: "rate_limit",
    });
    const row = getDb().select().from(llmCalls).where(eq(llmCalls.conversationId, conv)).all()[0]!;
    expect(row.ok).toBe(false);
    expect(row.failureReason).toBe("rate_limit");
  });
});
