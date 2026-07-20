import { describe, it, expect } from "vitest";
import { requiresAttemptGrant, toolDispatchDecision, gatedWriteMarker } from "@agentic/runtime";

// #REDESIGN P1b — the sandbox "gated" tool mode: READS run live (real integration), external WRITES
// are gated (real payload recorded, not fired) unless a server-owned run grant exists.

const readPolicy = { operation: "read", effectScope: "external", sandboxPolicy: "live_external" } as const;
const writePolicy = { operation: "write", effectScope: "external", sandboxPolicy: "requires_attempt_grant" } as const;

describe("toolDispatchDecision — gated mode (read live, write gated)", () => {
  it("external read → live only with a verified sandbox profile", () => {
    expect(toolDispatchDecision(readPolicy, "gated")).toBe("gate_profile");
    expect(toolDispatchDecision(readPolicy, "gated", { sandboxProfileVerified: true })).toBe("live");
  });
  it("write tool → gate (not fired) without the confirm opt-in", () => {
    expect(requiresAttemptGrant(writePolicy)).toBe(true);
    expect(toolDispatchDecision(writePolicy, "gated")).toBe("gate_grant");
  });
  it("write tool → live only with an explicit scoped grant", () => {
    expect(toolDispatchDecision(writePolicy, "gated", { attemptGrantVerified: true })).toBe("live");
  });
  it("unknown rejects; reviewed mock/replay stay deterministic; live cannot bypass grants", () => {
    expect(toolDispatchDecision(undefined, "mock")).toBe("reject");
    expect(toolDispatchDecision(writePolicy, "mock")).toBe("stub");
    expect(toolDispatchDecision(writePolicy, "live")).toBe("gate_grant");
    expect(toolDispatchDecision(readPolicy, "replay")).toBe("replay");
  });
  it("gatedWriteMarker records the real payload but does not fire", () => {
    const m = gatedWriteMarker("sendInviteEmail", { to: "real@co.com" });
    expect(m.__gated).toBe(true);
    expect((m.wouldWrite as { to: string }).to).toBe("real@co.com");
  });
});
