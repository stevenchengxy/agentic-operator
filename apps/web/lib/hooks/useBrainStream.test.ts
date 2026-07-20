import { describe, expect, it } from "vitest";
import {
  brainStreamRequestKey,
  brainStreamViewKey,
  shouldAppendBrainReplay,
  type BrainStreamRequest,
} from "./useBrainStream";

const request = (patch: Partial<BrainStreamRequest> = {}): BrainStreamRequest => ({
  tenant: "tenant-a",
  reconnectRunId: "conversation-1",
  conversation: "conversation-1",
  replayMode: "append",
  nonce: 1,
  ...patch,
});

describe("brain stream request identity", () => {
  it("never shares a visible transcript across runtime tenants", () => {
    expect(brainStreamViewKey(request()))
      .not.toBe(brainStreamViewKey(request({ tenant: "tenant-b" })));
  });

  it("keeps consecutive turns in one tenant conversation visually continuous", () => {
    expect(brainStreamViewKey(request({ nonce: 1 })))
      .toBe(brainStreamViewKey(request({ nonce: 2 })));
    expect(brainStreamRequestKey(request({ nonce: 1 })))
      .not.toBe(brainStreamRequestKey(request({ nonce: 2 })));
  });

  it("distinguishes exact run ids in the effect identity", () => {
    expect(brainStreamRequestKey(request({ reconnectRunId: "run&v=1" })))
      .not.toBe(brainStreamRequestKey(request({ reconnectRunId: "run" })));
  });

  it("uses a fresh visible identity for full replay replacement", () => {
    expect(brainStreamViewKey(request({ replayMode: "replace", nonce: 1 })))
      .not.toBe(brainStreamViewKey(request({ replayMode: "replace", nonce: 2 })));
  });

  it("appends only a current turn for the exact prior conversation", () => {
    expect(shouldAppendBrainReplay("conversation-1", request())).toBe(true);
    expect(shouldAppendBrainReplay("conversation-1", request({ replayMode: "replace" }))).toBe(false);
    expect(shouldAppendBrainReplay("other", request())).toBe(false);
  });
});
