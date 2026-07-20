import { afterEach, describe, expect, it } from "vitest";

import { SANDBOX_BROKER_REGISTRATION_SCHEMA } from "./ports";
import { sandboxRegistrationEvidenceIssues } from "./sandbox-registration";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

function proof(observedFunctionCount: number) {
  return {
    schema: SANDBOX_BROKER_REGISTRATION_SCHEMA,
    appId: "sandbox-app",
    expectedFunctionCount: 2,
    observedFunctionCount,
    connected: true,
    verified: true,
    evidence: "dev_graphql" as const,
    checkedAt: new Date(0).toISOString(),
  };
}

describe("sandboxRegistrationEvidenceIssues", () => {
  it("accepts exact committed IDs plus an independent exact broker readback", () => {
    expect(sandboxRegistrationEvidenceIssues({
      appId: "sandbox-app",
      committedManifestFunctionIds: ["a", "b"],
      brokerRegistration: proof(2),
    }, ["b", "a"])).toEqual([]);
  });

  it("rejects a stale broker app with surplus functions", () => {
    expect(sandboxRegistrationEvidenceIssues({
      appId: "sandbox-app",
      committedManifestFunctionIds: ["a", "b"],
      brokerRegistration: proof(3),
    }, ["a", "b"]).join(" ")).toContain("observed 3/2");
  });

  it("does not treat locally synthesized legacy registeredIds as broker proof", () => {
    expect(sandboxRegistrationEvidenceIssues({
      appId: "sandbox-app",
    }, ["a", "b"])).toEqual(expect.arrayContaining([
      "missing committed manifest function IDs",
      "missing independent Inngest broker registration proof",
    ]));
  });

  it("permits only an explicit test bypass and ignores it in production", () => {
    process.env.NODE_ENV = "test";
    expect(sandboxRegistrationEvidenceIssues({ testOnlyRegistrationBypass: true }, ["a"])).toEqual([]);
    process.env.NODE_ENV = "production";
    expect(sandboxRegistrationEvidenceIssues({ testOnlyRegistrationBypass: true }, ["a"])).not.toEqual([]);
  });
});
