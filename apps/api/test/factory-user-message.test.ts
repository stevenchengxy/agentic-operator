import { describe, expect, it } from "vitest";
import type { BrainEvent } from "@agentic/agent-factory";
import {
  emitUserMessage,
  structuralProjection,
} from "../src/services/agent-factory/run-registry";

describe("#USER-MESSAGE — the human's words are first-class transcript frames", () => {
  it("structuralProjection KEEPS user.message (only think deltas are dropped)", () => {
    const events = [
      { t: "user.message", text: "帮我只生成 createJD 的 function" },
      { t: "think", delta: "内部推理…" },
      { t: "message", text: "好的" },
    ] as unknown as BrainEvent[];
    const projected = structuralProjection(events);
    expect(projected.map((e) => e.t)).toEqual(["user.message", "message"]);
    expect((projected[0] as { text?: string }).text).toContain("createJD");
  });

  it("emitUserMessage is a safe no-op (false) when no active run matches", () => {
    expect(emitUserMessage("frn-does-not-exist", undefined, "hello")).toBe(false);
    expect(emitUserMessage("frn-does-not-exist", "ten-x", "hello")).toBe(false);
  });

  it("emitUserMessage refuses empty/whitespace text", () => {
    expect(emitUserMessage("frn-does-not-exist", undefined, "   ")).toBe(false);
  });
});
