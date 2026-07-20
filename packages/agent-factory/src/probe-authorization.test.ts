import { describe, expect, it } from "vitest";
import type { RealTool } from "./tool-catalog";
import { createProbeAuthorizationBinding, findSensitiveProbeInputPath } from "./probe-authorization";

const tool: RealTool = {
  name: "ontology.writeInstance",
  sideEffect: "write",
  capabilities: [{
    systems: ["Allmeta"],
    kinds: ["ontology"],
    roles: ["writes"],
    operations: ["write-instance"],
    objectTypes: ["*"],
    probeRequired: true,
  }],
  catalogDefinition: {
    name: "ontology.writeInstance",
    sideEffect: "write",
    configSchema: {
      api_key_env: { type: "string", required: true },
      action: { type: "string", required: true },
    },
  },
};

describe("canonical one-shot probe authorization subject", () => {
  it("is stable across object key order but changes with args, config, definition or side effects", () => {
    const env = { ALLMETA_API_KEY: "secret" };
    const first = createProbeAuthorizationBinding(
      tool,
      { properties: { name: "A", id: "1" }, object_type: "Candidate" },
      { api_key_env: "ALLMETA_API_KEY", action: "processResume" },
      env,
    )!;
    const reordered = createProbeAuthorizationBinding(
      tool,
      { object_type: "Candidate", properties: { id: "1", name: "A" } },
      { action: "processResume", api_key_env: "ALLMETA_API_KEY" },
      env,
    )!;
    expect(reordered).toEqual(first);
    expect(first.token).toMatch(/^authorize_probe:v2:[a-f0-9]{64}$/);
    expect(first.token).not.toContain("Candidate");
    expect(first.token).not.toContain("secret");

    expect(createProbeAuthorizationBinding(tool, { object_type: "Resume" }, { api_key_env: "ALLMETA_API_KEY", action: "processResume" }, env)?.token).not.toBe(first.token);
    expect(createProbeAuthorizationBinding(tool, { object_type: "Candidate", properties: { id: "1", name: "A" } }, { api_key_env: "ALLMETA_API_KEY", action: "createJD" }, env)?.token).not.toBe(first.token);
    expect(createProbeAuthorizationBinding({ ...tool, sideEffect: "dual" }, { object_type: "Candidate", properties: { id: "1", name: "A" } }, { api_key_env: "ALLMETA_API_KEY", action: "processResume" }, env)?.token).not.toBe(first.token);
    expect(createProbeAuthorizationBinding({ ...tool, catalogDefinition: { ...tool.catalogDefinition!, sourcePath: "changed.ts" } }, { object_type: "Candidate", properties: { id: "1", name: "A" } }, { api_key_env: "ALLMETA_API_KEY", action: "processResume" }, env)?.token).not.toBe(first.token);
    expect(createProbeAuthorizationBinding(
      tool,
      { object_type: "Candidate", properties: { id: "1", name: "A" } },
      { api_key_env: "ALLMETA_API_KEY", action: "processResume" },
      env,
      { tenantId: "tenant-a", actor: "usr-a", domainId: "domain-a", runId: "run-a", conversationId: "conv-a" },
    )?.token).not.toBe(createProbeAuthorizationBinding(
      tool,
      { object_type: "Candidate", properties: { id: "1", name: "A" } },
      { api_key_env: "ALLMETA_API_KEY", action: "processResume" },
      env,
      { tenantId: "tenant-a", actor: "usr-b", domainId: "domain-a", runId: "run-a", conversationId: "conv-a" },
    )?.token);
  });

  it("finds secret-shaped input recursively", () => {
    expect(findSensitiveProbeInputPath({ payload: [{ nested: { access_token: "secret" } }] })).toBe("args.payload[0].nested.access_token");
    expect(findSensitiveProbeInputPath({ payload: { candidate_id: "cand-1" } })).toBeUndefined();
  });
});
