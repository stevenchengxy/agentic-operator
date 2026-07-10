// #P0-3 — persist LLM telemetry. Wires the factory brain's LLM-call sink (stream-gateway) to a DB
// insert into `llm_calls`, so per-call model / routing / latency / size / failure are auditable
// (they were ephemeral in-memory streaming only). Best-effort: telemetry never breaks a brain call.

import { setLlmCallSink, type LlmCallRecord } from "@agentic/agent-factory";
import { getDb, llmCalls } from "@agentic/db";
import { makeId } from "@agentic/shared";

/** Persist one LLM-call record to the llm_calls table. Best-effort — never throws. */
export function writeLlmCall(rec: LlmCallRecord): void {
  try {
    getDb()
      .insert(llmCalls)
      .values({
        id: makeId("llm"),
        tenantId: rec.tenantId ?? null,
        domain: rec.domain ?? null,
        conversationId: rec.conversationId ?? null,
        purpose: rec.purpose ?? null,
        requestedModel: rec.requestedModel ?? null,
        servedModel: rec.servedModel ?? null,
        provider: rec.provider ?? null,
        fallback: rec.fallback ?? null,
        promptChars: rec.promptChars,
        completionChars: rec.completionChars,
        approxTokensIn: rec.approxTokensIn,
        approxTokensOut: rec.approxTokensOut,
        latencyMs: rec.latencyMs,
        ok: rec.ok,
        failureReason: rec.failureReason ?? null,
      })
      .run();
  } catch {
    /* telemetry best-effort — never surface to the caller */
  }
}

let wired = false;
export function wireLlmTelemetry(): void {
  if (wired) return;
  wired = true;
  setLlmCallSink(writeLlmCall);
}
