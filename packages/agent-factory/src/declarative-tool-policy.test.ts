import { describe, expect, it } from "vitest";

import { parseCapabilityDescriptors, validateDeclarativeToolPolicy } from "./declarative-tool-policy";

describe("declarative tool side-effect truth", () => {
  it("never defaults a missing or unknown label to read", () => {
    expect(validateDeclarativeToolPolicy({ method: "GET", declaredSideEffect: undefined }).ok).toBe(false);
    expect(validateDeclarativeToolPolicy({ method: "TRACE", declaredSideEffect: "read" }).ok).toBe(false);
  });

  it("derives POST with an ambiguous calls role as write, not read", () => {
    const capabilities = [{ systems: ["Vendor"], kinds: ["external_api"], roles: ["calls"], operations: ["invite-candidate"] }];
    const downgraded = validateDeclarativeToolPolicy({ method: "POST", declaredSideEffect: "read", capabilities });
    expect(downgraded).toMatchObject({ ok: false });
    expect(validateDeclarativeToolPolicy({ method: "POST", declaredSideEffect: "write", capabilities }))
      .toEqual({ ok: true, sideEffect: "write" });
  });

  it("requires dual only when capabilities explicitly contain read and write signals", () => {
    const capabilities = [{ systems: ["Vendor"], kinds: ["api"], roles: ["reads", "writes"], operations: ["lookup", "update"] }];
    expect(validateDeclarativeToolPolicy({ method: "POST", declaredSideEffect: "write", capabilities }).ok).toBe(false);
    expect(validateDeclarativeToolPolicy({ method: "POST", declaredSideEffect: "dual", capabilities }))
      .toEqual({ ok: true, sideEffect: "dual" });
  });

  it("rejects safe-method body/write contradictions", () => {
    expect(validateDeclarativeToolPolicy({ method: "GET", declaredSideEffect: "read", bodyTemplate: "{}" }).ok).toBe(false);
    expect(validateDeclarativeToolPolicy({
      method: "GET",
      declaredSideEffect: "read",
      capabilities: [{ systems: ["Vendor"], kinds: ["api"], roles: ["writes"] }],
    }).ok).toBe(false);
  });

  it("strictly parses capability JSON instead of trusting request types", () => {
    expect(parseCapabilityDescriptors([{ systems: ["Vendor"], kinds: ["api"], roles: ["writes"], extra: true }]).ok).toBe(false);
    expect(parseCapabilityDescriptors([{ systems: ["Vendor"], kinds: ["api"], roles: ["writes"], operations: ["invite"] }]))
      .toMatchObject({ ok: true, capabilities: [{ roles: ["writes"] }] });
  });
});
