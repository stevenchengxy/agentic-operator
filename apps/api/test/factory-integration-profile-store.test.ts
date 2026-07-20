import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { factoryAuthorizationChallenges, factoryIntegrationProfiles, getDb, tenants } from "@agentic/db";
import {
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  createIntegrationProfileAuthorizationBinding,
  integrationProfileConfigDigest,
  integrationProfileToolDefinitionDigest,
  type RealTool,
} from "@agentic/agent-factory";
import {
  deleteIntegrationProfile,
  listIntegrationProfiles,
  saveIntegrationProfile,
} from "../src/services/agent-factory/integration-profile-store";
import { makeFactoryPorts } from "../src/services/agent-factory/index";

const suffix = randomUUID();
const tenantId = `ten-integration-profile-${suffix}`;
const tenantSlug = `integration-profile-${suffix}`;
const domain = "RAAS-v1";
const tool: RealTool = {
  name: "ontology.writeInstance",
  catalogDefinition: {
    name: "ontology.writeInstance",
    configSchema: {
      base_url_env: { type: "string", required: true },
      api_key_env: { type: "string", required: true },
      domain: { type: "string", required: true },
      action: { type: "string", required: true },
      allowed_objects: { type: "string[]", required: true },
    },
  },
};

describe("factory integration profile store", () => {
  beforeAll(() => {
    getDb().insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "Integration profile test" }).run();
  });

  afterAll(() => {
    getDb().delete(factoryAuthorizationChallenges).where(eq(factoryAuthorizationChallenges.tenantId, tenantId)).run();
    getDb().delete(factoryIntegrationProfiles).where(eq(factoryIntegrationProfiles.tenantId, tenantId)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("persists only validated env references and non-secret config", () => {
    const first = saveIntegrationProfile({
      tenantId,
      domainId: domain,
      profileKey: "process-resume",
      environment: "production",
      tool,
      config: {
        api_key_env: "ALLMETA_API_KEY",
        base_url_env: "ALLMETA_BASE_URL",
        domain,
        action: "processResume",
        allowed_objects: ["Candidate", "Resume"],
      },
      confirmedBy: "usr-test",
      env: {},
    });
    expect(first).toMatchObject({
      ok: true,
      validation: { valid: true, ready: false, missingEnvRefs: ["ALLMETA_API_KEY", "ALLMETA_BASE_URL"] },
    });
    expect(JSON.stringify(first)).not.toContain("Bearer");
    expect(listIntegrationProfiles(tenantId, domain, tool.name)).toHaveLength(1);

    const updated = saveIntegrationProfile({
      tenantId,
      domainId: domain,
      profileKey: "process-resume",
      environment: "production",
      tool,
      config: {
        api_key_env: "ALLMETA_API_KEY",
        base_url_env: "ALLMETA_BASE_URL",
        domain,
        action: "processResumeV2",
        allowed_objects: ["Candidate"],
      },
      confirmedBy: "usr-test-2",
      env: { ALLMETA_API_KEY: "secret", ALLMETA_BASE_URL: "https://allmeta.example.test" },
    });
    expect(updated).toMatchObject({ ok: true, validation: { ready: true } });
    const profiles = listIntegrationProfiles(tenantId, domain, tool.name);
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({
      profileKey: "process-resume",
      confirmedBy: "usr-test-2",
      toolDefinitionDigest: integrationProfileToolDefinitionDigest(tool),
      configDigest: integrationProfileConfigDigest(profiles[0]!.config),
      environment: "production",
      authorizationProtocolVersion: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
      config: { action: "processResumeV2", allowed_objects: ["Candidate"] },
    });
    expect(JSON.stringify(profiles)).not.toContain("secret");
  });

  it("rejects a literal credential before any row is written", () => {
    const result = saveIntegrationProfile({
      tenantId,
      domainId: domain,
      profileKey: "unsafe",
      environment: "production",
      tool,
      config: {
        base_url_env: "ALLMETA_BASE_URL",
        api_key_env: "ALLMETA_API_KEY",
        api_key: "literal-secret",
        domain,
        action: "processResume",
        allowed_objects: ["Candidate"],
      },
      confirmedBy: "usr-test",
    });
    expect(result).toMatchObject({ ok: false });
    expect(listIntegrationProfiles(tenantId, domain, tool.name).some((profile) => profile.profileKey === "unsafe")).toBe(false);
  });

  it("stores the same profile key independently per environment and deletes only the selected one", () => {
    const baseConfig = {
      api_key_env: "ALLMETA_API_KEY",
      base_url_env: "ALLMETA_BASE_URL",
      domain,
      allowed_objects: ["Candidate"],
    };
    for (const environment of ["production", "sandbox"] as const) {
      expect(saveIntegrationProfile({
        tenantId,
        domainId: domain,
        profileKey: "same-key",
        environment,
        tool,
        config: { ...baseConfig, action: environment === "production" ? "processResume" : "processResumeCanary" },
        confirmedBy: "usr-test",
      })).toMatchObject({ ok: true, profile: { environment, profileKey: "same-key" } });
    }
    expect(listIntegrationProfiles(tenantId, domain, tool.name, "production").filter((profile) => profile.profileKey === "same-key")).toHaveLength(1);
    expect(listIntegrationProfiles(tenantId, domain, tool.name, "sandbox").filter((profile) => profile.profileKey === "same-key")).toHaveLength(1);
    expect(deleteIntegrationProfile(tenantId, domain, tool.name, "same-key", "production")).toBe(true);
    expect(listIntegrationProfiles(tenantId, domain, tool.name, "production").some((profile) => profile.profileKey === "same-key")).toBe(false);
    expect(listIntegrationProfiles(tenantId, domain, tool.name, "sandbox").some((profile) => profile.profileKey === "same-key")).toBe(true);
  });

  it("rejects a legacy v2 confirmation instead of upgrading it implicitly", () => {
    const result = saveIntegrationProfile({
      tenantId,
      domainId: domain,
      profileKey: "legacy-v2",
      environment: "production",
      tool,
      config: {
        api_key_env: "ALLMETA_API_KEY",
        base_url_env: "ALLMETA_BASE_URL",
        domain,
        action: "processResume",
        allowed_objects: ["Candidate"],
      },
      confirmedBy: "usr-test",
      authorizationProtocolVersion: 2,
    });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("已失效") });
    expect(listIntegrationProfiles(tenantId, domain, tool.name).some((profile) => profile.profileKey === "legacy-v2")).toBe(false);
  });

  it("attributes BrainTool profile persistence to the authenticated challenge responder, not the run starter", async () => {
    const ports = makeFactoryPorts(tenantSlug, tenantId, domain, "usr-run-starter");
    const config = {
      api_key_env: "ALLMETA_API_KEY",
      base_url_env: "ALLMETA_BASE_URL",
      domain,
      action: "processResume",
      allowed_objects: ["Candidate"],
    };
    const subject = createIntegrationProfileAuthorizationBinding({
      tool,
      domainId: domain,
      profileKey: "composition-confirmed",
      environment: "production",
      config,
      // Agent Factory currently uses one durable execution id for both fields.
      scope: { runId: "factory-run-1", conversationId: "factory-run-1" },
    });
    const challenge = await ports.authorizationChallenges!.issue(domain, {
      kind: "integration_profile",
      subjectDigest: subject.digest,
      runId: "factory-run-1",
      conversationId: "factory-run-1",
      question: "确认保存这套集成配置吗？",
      declineLabel: "暂不保存",
      confirmLabel: "确认保存",
    });
    const authorization = await ports.authorizationChallenges!.consume(domain, {
      challenge,
      answer: challenge.token,
      actor: "usr-responder",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    });
    const profile = await ports.integrationProfiles!.save(domain, {
      profileKey: "composition-confirmed",
      environment: "production",
      tool,
      config,
      authorization,
      execution: { runId: "factory-run-1", conversationId: "factory-run-1" },
    });
    expect(profile).toMatchObject({
      profileKey: "composition-confirmed",
      confirmedBy: "usr-responder",
      domainId: domain,
      environment: "production",
    });

    await expect(ports.integrationProfiles!.save(domain, {
      profileKey: "composition-confirmed",
      environment: "sandbox",
      tool,
      config,
      authorization,
      execution: { runId: "factory-run-1", conversationId: "factory-run-1" },
    })).rejects.toThrow(/receipt is missing, stale, or belongs to another actor\/scope/);

    await expect(ports.integrationProfiles!.save(domain, {
      profileKey: "wrong-execution",
      environment: "production",
      tool,
      config,
      authorization,
      execution: { runId: "another-execution", conversationId: "another-execution" },
    })).rejects.toThrow(/does not belong to the current execution/);

    await expect(ports.integrationProfiles!.save(domain, {
      profileKey: "must-not-save",
      environment: "production",
      tool,
      config,
      authorization: { ...authorization, subjectDigest: "f".repeat(64) },
      execution: { runId: "factory-run-1", conversationId: "factory-run-1" },
    })).rejects.toThrow(/receipt is missing, stale, or belongs to another actor\/scope/);
    expect(listIntegrationProfiles(tenantId, domain, tool.name).some((item) => item.profileKey === "must-not-save")).toBe(false);
  });
});
