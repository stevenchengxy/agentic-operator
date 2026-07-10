import { describe, it, expect } from "vitest";
import { isWriteTool, toolDispatchDecision, gatedWriteMarker } from "@agentic/runtime";

// #REDESIGN P1b — the sandbox "gated" tool mode: READS run live (real integration), external WRITES
// are gated (real payload recorded, not fired) unless FACTORY_SANDBOX_ALLOW_WRITES=1.

describe("isWriteTool — side-effect heuristic", () => {
  it("flags write/append/send/post/create/notify/email tools as writes", () => {
    for (const n of ["fs.writeJdToDisk", "fs.appendToLog", "sendInviteEmail", "acme.postJob", "createRequisition", "notifyCandidate", "http.post", "match.updateStatus", "saveDraft", "audit.record"]) {
      expect(isWriteTool(n)).toBe(true);
    }
  });
  it("treats read/fetch/get/parse/match tools as reads", () => {
    for (const n of ["fs.readFromInbox", "parseResumeApi", "getRequirement", "matchResumeApi", "http.fetch", "ontology.fetchActionRules"]) {
      expect(isWriteTool(n)).toBe(false);
    }
  });
});

describe("toolDispatchDecision — gated mode (read live, write gated)", () => {
  it("read tool → live", () => {
    expect(toolDispatchDecision("parseResumeApi", "gated", {} as NodeJS.ProcessEnv)).toBe("live");
  });
  it("write tool → gate (not fired) without the confirm opt-in", () => {
    expect(toolDispatchDecision("sendInviteEmail", "gated", {} as NodeJS.ProcessEnv)).toBe("gate");
  });
  it("write tool → live WITH FACTORY_SANDBOX_ALLOW_WRITES=1 (real data + confirm)", () => {
    expect(toolDispatchDecision("sendInviteEmail", "gated", { FACTORY_SANDBOX_ALLOW_WRITES: "1" } as unknown as NodeJS.ProcessEnv)).toBe("live");
  });
  it("legacy modes: mock→stub, live→live, replay→replay", () => {
    expect(toolDispatchDecision("anything", "mock", {} as NodeJS.ProcessEnv)).toBe("stub");
    expect(toolDispatchDecision("sendInviteEmail", "live", {} as NodeJS.ProcessEnv)).toBe("live");
    expect(toolDispatchDecision("getX", "replay", {} as NodeJS.ProcessEnv)).toBe("replay");
  });
  it("gatedWriteMarker records the real payload but does not fire", () => {
    const m = gatedWriteMarker("sendInviteEmail", { to: "real@co.com" });
    expect(m.__gated).toBe(true);
    expect((m.wouldWrite as { to: string }).to).toBe("real@co.com");
  });
});
