import path from "node:path";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { chatJson, type LlmCallRecord } from "@agentic/agent-factory";
import {
  LLMGateway,
  setGatewayCallSink,
  type ChatRequest,
  type ProviderAdapter,
} from "@agentic/llm-gateway";
import { getDb, llmCalls } from "@agentic/db";
import {
  _resetLlmTelemetryStatusForTests,
  _setLlmTelemetryTestHooks,
  getLlmTelemetryStatus,
  LlmTelemetryDurabilityError,
  replayLlmTelemetrySpool,
  writeLlmCall,
} from "../src/services/agent-factory/llm-telemetry";
import { buildTestEnv } from "./harness";

class CountingProvider implements ProviderAdapter {
  readonly id = "custom" as const;
  readonly name = "telemetry-test";
  readonly hasKey = true;
  readonly defaultModel = "telemetry-model-v1";
  calls = 0;

  async chat(_request: ChatRequest) {
    this.calls += 1;
    return {
      text: "durable response",
      provider: this.id,
      model: this.defaultModel,
      tokensIn: 3,
      tokensOut: 2,
      finishReason: "stop" as const,
      latencyMs: 1,
    };
  }
}

describe("durable LLM telemetry outbox", () => {
  const originalSpoolPath = process.env.AGENTIC_LLM_TELEMETRY_SPOOL_PATH;
  const tempDir = mkdtempSync(path.join(tmpdir(), "agentic-llm-telemetry-"));
  const spoolPath = path.join(tempDir, "outbox.ndjson");

  beforeAll(async () => {
    await buildTestEnv();
    process.env.AGENTIC_LLM_TELEMETRY_SPOOL_PATH = spoolPath;
  });

  afterEach(() => {
    _setLlmTelemetryTestHooks(null);
    _resetLlmTelemetryStatusForTests();
    setGatewayCallSink(null);
    rmSync(spoolPath, { force: true });
    rmSync(`${spoolPath}.lock`, { force: true });
  });

  afterAll(() => {
    if (originalSpoolPath === undefined) {
      delete process.env.AGENTIC_LLM_TELEMETRY_SPOOL_PATH;
    } else {
      process.env.AGENTIC_LLM_TELEMETRY_SPOOL_PATH = originalSpoolPath;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function record(conversationId: string): LlmCallRecord {
    return {
      conversationId,
      domain: "telemetry-test",
      purpose: "fault-injection",
      requestedModel: "telemetry-model-v1",
      servedModel: "telemetry-model-v1",
      provider: "custom",
      fallback: false,
      promptChars: 12,
      completionChars: 8,
      approxTokensIn: 3,
      approxTokensOut: 2,
      latencyMs: 1,
      ok: true,
    };
  }

  it("fsyncs a stable envelope when SQLite fails, then replays it idempotently", () => {
    const conversationId = `telemetry-spool-${Date.now()}`;
    _setLlmTelemetryTestHooks({
      persistEnvelope: () => {
        throw new Error("SQLITE_BUSY injected");
      },
    });

    expect(() => writeLlmCall(record(conversationId))).not.toThrow();
    expect(existsSync(spoolPath)).toBe(true);
    const line = readFileSync(spoolPath, "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({
      version: 1,
      id: expect.stringMatching(/^llm-/),
      record: { conversationId },
    });
    expect(getLlmTelemetryStatus()).toMatchObject({
      ok: true,
      degraded: true,
      storage: "spool",
      pendingSpoolRecords: 1,
    });

    _setLlmTelemetryTestHooks(null);
    expect(replayLlmTelemetrySpool()).toEqual({ replayed: 1, pending: 0 });
    expect(replayLlmTelemetrySpool()).toEqual({ replayed: 0, pending: 0 });
    expect(existsSync(spoolPath)).toBe(false);
    const rows = getDb().select().from(llmCalls)
      .where(eq(llmCalls.conversationId, conversationId)).all();
    expect(rows).toHaveLength(1);
    expect(getLlmTelemetryStatus()).toMatchObject({
      ok: true,
      degraded: false,
      storage: "database",
      replayedRecords: 1,
      pendingSpoolRecords: 0,
      consecutiveFailures: 0,
    });
  });

  it("throws when both SQLite and the fsync outbox fail", () => {
    _setLlmTelemetryTestHooks({
      persistEnvelope: () => {
        throw new Error("database unavailable");
      },
      appendEnvelope: () => {
        throw new Error("disk full");
      },
    });

    expect(() => writeLlmCall(record(`telemetry-lost-${Date.now()}`)))
      .toThrow(LlmTelemetryDurabilityError);
    expect(getLlmTelemetryStatus()).toMatchObject({
      ok: false,
      degraded: true,
      storage: "unavailable",
      durabilityFailures: 1,
    });
  });

  it("does not return a provider success when its durability sink rejects", async () => {
    const provider = new CountingProvider();
    const gateway = new LLMGateway({
      defaultProvider: "custom",
      defaultModel: provider.defaultModel,
      timeoutMs: 5_000,
    });
    gateway.registerProvider(provider);
    setGatewayCallSink(() => {
      throw new LlmTelemetryDurabilityError(
        new Error("database unavailable"),
        new Error("disk full"),
      );
    });

    await expect(gateway.chat({
      messages: [{ role: "user", content: "run" }],
    })).rejects.toMatchObject({ code: "llm_telemetry_unavailable" });
    expect(provider.calls).toBe(1);
  });

  it("does not turn telemetry loss into chatJson's deterministic fallback", async () => {
    let calls = 0;
    await expect(chatJson("system", "user", {
      callFn: async () => {
        calls += 1;
        throw new LlmTelemetryDurabilityError(
          new Error("database unavailable"),
          new Error("disk full"),
        );
      },
    })).rejects.toMatchObject({ code: "llm_telemetry_unavailable" });
    expect(calls).toBe(1);
  });
});
