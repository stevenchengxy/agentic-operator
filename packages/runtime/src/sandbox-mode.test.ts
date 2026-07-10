import { describe, it, expect } from "vitest";
import { sandboxToolMode, isSandboxTenant, sandboxToolStub, cassetteKey, cassetteLookup } from "./sandbox-mode";

describe("sandboxToolMode", () => {
  it("defaults to mock; honors replay/live; junk → mock", () => {
    expect(sandboxToolMode({})).toBe("mock");
    expect(sandboxToolMode({ FACTORY_SANDBOX_TOOL_MODE: "replay" })).toBe("replay");
    expect(sandboxToolMode({ FACTORY_SANDBOX_TOOL_MODE: "live" })).toBe("live");
    expect(sandboxToolMode({ FACTORY_SANDBOX_TOOL_MODE: "nonsense" })).toBe("mock");
  });
});

describe("isSandboxTenant", () => {
  it("matches the -sb convention", () => {
    expect(isSandboxTenant("recruitment-sb")).toBe(true);
    expect(isSandboxTenant("raas")).toBe(false);
    expect(isSandboxTenant(undefined)).toBe(false);
  });
});

describe("sandboxToolStub", () => {
  it("returns a flagged non-empty stub (no real side effect)", () => {
    const s = sandboxToolStub("parseResumeApi");
    expect(s).toMatchObject({ __sandbox: true, mock: true, tool: "parseResumeApi" });
  });
});

describe("cassetteKey", () => {
  it("is stable for the same (name,args) and differs otherwise", () => {
    expect(cassetteKey("t", { a: 1 })).toBe(cassetteKey("t", { a: 1 }));
    expect(cassetteKey("t", { a: 1 })).not.toBe(cassetteKey("t", { a: 2 }));
  });
});

describe("cassetteLookup", () => {
  it("returns undefined (no throw) when no cassette file exists", async () => {
    await expect(cassetteLookup("nope-sb", "ghostTool", { x: 1 })).resolves.toBeUndefined();
  });
});
