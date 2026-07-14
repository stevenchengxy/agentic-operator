import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createBufferedTraceSink,
  createFilteredTraceSink,
  shouldPersistRuntimeTrace,
} from "./execution-trace";

describe("runtime trace policy", () => {
  it("persists only events at or below the authored detail level", async () => {
    assert.equal(shouldPersistRuntimeTrace("minimal", "minimal"), true);
    assert.equal(shouldPersistRuntimeTrace("standard", "minimal"), false);
    assert.equal(shouldPersistRuntimeTrace("debug", "standard"), false);
    assert.equal(shouldPersistRuntimeTrace("debug", "debug"), true);

    const buffer = createBufferedTraceSink();
    const trace = createFilteredTraceSink(buffer, { traceLevel: "minimal" });
    await trace.append({
      runId: "run-1",
      kind: "run",
      level: "minimal",
      name: "run.start",
      status: "running",
      visibility: "user",
    });
    await trace.append({
      runId: "run-1",
      kind: "step",
      level: "standard",
      name: "step.start",
      status: "running",
      visibility: "user",
    });
    assert.deepEqual(
      buffer.events.map((event) => event.name),
      ["run.start"],
    );
  });

  it("suppresses only user-facing LLM reasoning summaries", async () => {
    const buffer = createBufferedTraceSink();
    const trace = createFilteredTraceSink(buffer, {
      traceLevel: "debug",
      reasoningSummary: false,
    });
    await trace.append({
      runId: "run-2",
      kind: "llm",
      level: "standard",
      name: "llm.summary",
      status: "ok",
      summary: "Generated reasoning summary",
      data: { reasoningSummary: "Because...", tokensOut: 20 },
      visibility: "user",
    });
    await trace.append({
      runId: "run-2",
      kind: "llm",
      level: "standard",
      name: "llm.call",
      status: "ok",
      summary: "Operator-safe call metadata",
      visibility: "operator",
    });

    assert.equal(buffer.events[0]?.summary, undefined);
    assert.deepEqual(buffer.events[0]?.data, { tokensOut: 20 });
    assert.equal(buffer.events[1]?.summary, "Operator-safe call metadata");
  });
});
