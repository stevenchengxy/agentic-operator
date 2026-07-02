import { describe, it, expect } from "vitest";
import { injectedFault, faultResult, runAction } from "@agentic/runtime";
import { caseVerdict } from "@agentic/agent-factory";

// #W3-FAULT — fault-injection cases fire for REAL in the sandbox: a kind:"fault" test case carries a
// `__fault` payload marker; tool dispatch (sandbox tenants only) returns an injected failure, and the
// per-kind verdict passes only when the chain handled it gracefully (no false success terminal).

describe("#W3-FAULT injected tool faults", () => {
  it("matches the marked tool (or any tool when unspecified); ignores absent markers", () => {
    expect(injectedFault({ __fault: { tool: "robohire.match", kind: "timeout" } }, "robohire.match")?.kind).toBe("timeout");
    expect(injectedFault({ __fault: { tool: "robohire.match" } }, "fs.readFromInbox")).toBeNull();
    expect(injectedFault({ __fault: { kind: "http_500" } }, "anyTool")?.kind).toBe("http_500");
    expect(injectedFault({ x: 1 }, "anyTool")).toBeNull();
    expect(faultResult("t", "timeout").__error).toContain("timeout");
  });

  it("type:'tool' dispatch in a sandbox tenant returns a FAILING result so onError is exercised", async () => {
    const res = await runAction({
      ctx: {
        agentName: "FaultProbe", actionName: "callVendor", correlationId: "c1", tenantSlug: "probe-sb",
        event: { name: "ENTRY", data: { __fault: { tool: "callVendor", kind: "timeout" }, subject: "s1" } },
      },
      action: { name: "callVendor", type: "tool", description: "vendor call" } as never,
    });
    expect(res.ok).toBe(false);
    expect((res.meta as { injectedFault?: string }).injectedFault).toBe("timeout");
    expect((res.data as { __error?: string }).__error).toContain("injected timeout");
  });

  it("fault-kind verdict: graceful (no success terminal) passes; false success fails", () => {
    expect(caseVerdict({ kind: "fault", reachedSuccessTerminal: false, reachedFailTerminal: true, crashed: false }).pass).toBe(true);
    expect(caseVerdict({ kind: "fault", reachedSuccessTerminal: true, reachedFailTerminal: false, crashed: false }).pass).toBe(false);
    expect(caseVerdict({ kind: "fault", reachedSuccessTerminal: false, reachedFailTerminal: false, crashed: true }).pass).toBe(false);
  });
});
