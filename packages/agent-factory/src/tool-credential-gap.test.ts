import { describe, it, expect } from "vitest";
import { detectMissingToolCredentials, type RealTool } from "./tool-catalog";

// #KEY-GAP — the detector that lets the brain ask_user when a BOUND tool's REQUIRED credential env
// isn't configured. It must be fully GENERIC: driven only by each tool's self-declared `credentialEnv`
// + the environment, never by a hardcoded tool name. These tests pin that contract.

const TOOLS: RealTool[] = [
  { name: "parseResumeApi", summary: "parse", credentialEnv: ["ROBOHIRE_API_KEY"], aliases: ["fs.readFromInbox"] },
  { name: "matchResumeApi", summary: "match", credentialEnv: ["ROBOHIRE_API_KEY"] },
  { name: "vendorX.push", summary: "push", credentialEnv: ["VENDOR_X_TOKEN", "VENDOR_X_KEY"] }, // any-of
  { name: "fs.writeJdToDisk", summary: "write" }, // no credential at all
];

describe("detectMissingToolCredentials — generic, not hardcoded", () => {
  it("reports a bound tool whose declared env is unset", () => {
    const miss = detectMissingToolCredentials(["parseResumeApi"], TOOLS, {});
    expect(miss).toEqual([{ tool: "parseResumeApi", missingEnv: ["ROBOHIRE_API_KEY"] }]);
  });

  it("stays silent when the declared env IS set", () => {
    const miss = detectMissingToolCredentials(["parseResumeApi"], TOOLS, { ROBOHIRE_API_KEY: "sk-live-xyz" });
    expect(miss).toEqual([]);
  });

  it("never reports a tool that declares NO credential (no hardcoding — pure data-driven)", () => {
    const miss = detectMissingToolCredentials(["fs.writeJdToDisk"], TOOLS, {});
    expect(miss).toEqual([]);
  });

  it("treats an empty / whitespace env value as unset", () => {
    expect(detectMissingToolCredentials(["matchResumeApi"], TOOLS, { ROBOHIRE_API_KEY: "" })).toHaveLength(1);
    expect(detectMissingToolCredentials(["matchResumeApi"], TOOLS, { ROBOHIRE_API_KEY: "   " })).toHaveLength(1);
  });

  it("is satisfied if ANY of several declared env names is set (any-of semantics)", () => {
    expect(detectMissingToolCredentials(["vendorX.push"], TOOLS, { VENDOR_X_KEY: "k" })).toEqual([]);
    expect(detectMissingToolCredentials(["vendorX.push"], TOOLS, {})).toEqual([
      { tool: "vendorX.push", missingEnv: ["VENDOR_X_TOKEN", "VENDOR_X_KEY"] },
    ]);
  });

  it("resolves aliases to the canonical tool's credential", () => {
    const miss = detectMissingToolCredentials(["fs.readFromInbox"], TOOLS, {});
    expect(miss).toEqual([{ tool: "parseResumeApi", missingEnv: ["ROBOHIRE_API_KEY"] }]);
  });

  it("dedupes: the same canonical tool bound twice (by name + alias) is reported once", () => {
    const miss = detectMissingToolCredentials(["parseResumeApi", "fs.readFromInbox"], TOOLS, {});
    expect(miss).toEqual([{ tool: "parseResumeApi", missingEnv: ["ROBOHIRE_API_KEY"] }]);
  });

  it("reports each DISTINCT credentialed tool once, skipping unknown + credential-free names", () => {
    const miss = detectMissingToolCredentials(
      ["parseResumeApi", "matchResumeApi", "fs.writeJdToDisk", "totallyUnknownTool"],
      TOOLS,
      {},
    );
    expect(miss.map((m) => m.tool)).toEqual(["parseResumeApi", "matchResumeApi"]);
  });
});
