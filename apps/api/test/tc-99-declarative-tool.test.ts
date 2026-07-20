/**
 * TC-99 — declarative tool persistence is scoped by immutable tenant id.
 * Ontology/domain labels are metadata only and never decide ownership.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { auditLog, factoryTools, getDb, tenants, users } from "@agentic/db";
import {
  saveDeclarativeTool,
  listDeclarativeTools,
  deleteDeclarativeTool,
  DeclarativeToolQueryError,
} from "../src/services/agent-factory/declarative-tool";
import { registerEnvelope } from "../src/plugins/error";
import { toolsRoutes } from "../src/routes/v1/tools";
import type { TestEnv } from "./harness";

const suffix = Date.now().toString(36);
const tenantAId = `ten-tc99-a-${suffix}`;
const tenantBId = `ten-tc99-b-${suffix}`;
const userId = `usr-tc99-${suffix}`;
const names = new Set<string>();
let env: TestEnv;

function tool(name: string, domain: string | null = "Hiring-v2") {
  names.add(name);
  return {
    name,
    description: "d",
    method: "GET",
    urlTemplate: "https://api.example.com/p",
    sideEffect: "read",
    operation: "read" as const,
    effectScope: "external" as const,
    sandboxPolicy: "live_external" as const,
    domain,
  };
}

describe("TC-99: declarative tool tenant scope", () => {
  beforeAll(async () => {
    const now = new Date();
    getDb().insert(tenants).values([
      { id: tenantAId, slug: `tc99-a-${suffix}`, name: "TC99 A", createdAt: now, updatedAt: now },
      { id: tenantBId, slug: `tc99-b-${suffix}`, name: "TC99 B", createdAt: now, updatedAt: now },
    ]).run();
    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get()!;
    getDb().insert(users).values({ id: userId, email: `${userId}@example.test`, name: "TC99", platformRole: "superadmin", status: "active", createdAt: now, updatedAt: now }).run();
    const app = Fastify({ logger: false });
    await registerEnvelope(app);
    app.addHook("onRequest", async (req) => {
      req.auth = {
        userId,
        email: "tc99@example.com",
        name: "TC99",
        platformRole: "superadmin",
        tenantId: systemTenant.id,
        tenantSlug: systemTenant.slug,
        role: "admin",
        via: "dev",
      };
    });
    await app.register(toolsRoutes, { prefix: "/v1" });
    await app.ready();
    env = {
      fetch: async (url, init) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
        const response = await app.inject({
          method: (init?.method ?? "GET") as never,
          url,
          headers,
          payload: typeof init?.body === "string" ? init.body : undefined,
        });
        return new Response(response.body, { status: response.statusCode, headers: response.headers as HeadersInit });
      },
      cleanup: () => app.close(),
    };
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    const db = getDb();
    for (const name of names) db.delete(factoryTools).where(eq(factoryTools.name, name)).run();
    db.delete(auditLog).where(eq(auditLog.actorUserId, userId)).run();
    db.delete(tenants).where(eq(tenants.id, tenantAId)).run();
    db.delete(tenants).where(eq(tenants.id, tenantBId)).run();
    db.delete(users).where(eq(users.id, userId)).run();
    await env.cleanup();
  });

  it("shares a tool only when shared scope is explicitly requested", () => {
    const name = `tc99.shared_${suffix}`;
    expect(saveDeclarativeTool(tool(name, null), { shared: true }).ok).toBe(true);
    expect(listDeclarativeTools(tenantAId).some((t) => t.name === name)).toBe(true);
    expect(listDeclarativeTools(tenantBId).some((t) => t.name === name)).toBe(true);
    expect(deleteDeclarativeTool(name, tenantAId)).toBe(false);
    expect(deleteDeclarativeTool(name, tenantAId, true)).toBe(true);
  });

  it("allows the same tool name in two tenants without cross-tenant overwrite", () => {
    const name = `tc99.same_name_${suffix}`;
    expect(saveDeclarativeTool({ ...tool(name), description: "owned by A" }, { tenantId: tenantAId }).ok).toBe(true);
    expect(saveDeclarativeTool({ ...tool(name), description: "owned by B" }, { tenantId: tenantBId }).ok).toBe(true);

    expect(listDeclarativeTools(tenantAId).find((t) => t.name === name)?.description).toBe("owned by A");
    expect(listDeclarativeTools(tenantBId).find((t) => t.name === name)?.description).toBe("owned by B");

    expect(deleteDeclarativeTool(name, tenantBId)).toBe(true);
    expect(listDeclarativeTools(tenantAId).some((t) => t.name === name)).toBe(true);
  });

  it("does not infer ownership from a matching ontology domain label", () => {
    const name = `tc99.owned_by_a_${suffix}`;
    expect(saveDeclarativeTool(tool(name, "Same-Ontology"), { tenantId: tenantAId }).ok).toBe(true);
    expect(listDeclarativeTools(tenantBId).some((t) => t.name === name)).toBe(false);
    expect(deleteDeclarativeTool(name, tenantBId)).toBe(false);
    expect(deleteDeclarativeTool(name, tenantAId)).toBe(true);
  });

  it("does not overwrite or ambiguously delete a same-name tool after ontology rebind", () => {
    const name = `tc99.rebind_same_name_${suffix}`;
    expect(saveDeclarativeTool({ ...tool(name, "Ontology-A"), description: "A implementation" }, { tenantId: tenantAId }).ok).toBe(true);
    expect(saveDeclarativeTool({ ...tool(name, "Ontology-B"), description: "B implementation" }, { tenantId: tenantAId }).ok).toBe(true);

    expect(listDeclarativeTools(tenantAId, "Ontology-A").find((t) => t.name === name)?.description).toBe("A implementation");
    expect(listDeclarativeTools(tenantAId, "Ontology-B").find((t) => t.name === name)?.description).toBe("B implementation");
    expect(listDeclarativeTools(tenantAId).filter((t) => t.name === name)).toHaveLength(2);

    expect(deleteDeclarativeTool(name, tenantAId)).toBe(false);
    expect(deleteDeclarativeTool(name, tenantAId, false, "Ontology-A")).toBe(true);
    expect(listDeclarativeTools(tenantAId, "Ontology-B").some((t) => t.name === name)).toBe(true);
  });

  it("an unscoped listing returns shared tools only", () => {
    const shared = `tc99.unscoped_shared_${suffix}`;
    const privateName = `tc99.unscoped_private_${suffix}`;
    saveDeclarativeTool(tool(shared, null), { shared: true });
    saveDeclarativeTool(tool(privateName), { tenantId: tenantAId });
    const listed = listDeclarativeTools().map((t) => t.name);
    expect(listed).toContain(shared);
    expect(listed).not.toContain(privateName);
  });

  it("refuses a name that collides with a built-in global tool", () => {
    expect(saveDeclarativeTool(tool("fs.readFromInbox", null), { tenantId: tenantAId }).ok).toBe(false);
  });

  it("propagates a catalog query outage instead of returning an empty tool list", () => {
    const db = getDb();
    const select = vi.spyOn(db, "select").mockImplementationOnce(() => {
      throw new Error("SQLITE_IOERR injected");
    });
    try {
      expect(() => listDeclarativeTools(tenantAId)).toThrow(DeclarativeToolQueryError);
      expect(() => listDeclarativeTools(tenantAId)).not.toThrow();
    } finally {
      select.mockRestore();
    }
  });

  it("quarantines a historical row until its execution policy is explicitly migrated", () => {
    const name = `tc99.legacy_policy_${suffix}`;
    names.add(name);
    const now = new Date();
    getDb().insert(factoryTools).values({
      id: `tol-legacy-${suffix}`,
      scopeKey: tenantAId,
      domainKey: "",
      name,
      tenantId: tenantAId,
      description: "historical row without 0048 metadata",
      method: "GET",
      urlTemplate: "https://api.example.com/legacy",
      sideEffect: "read",
      operation: null,
      effectScope: null,
      sandboxPolicy: null,
      createdAt: now,
      updatedAt: now,
    }).run();
    try {
      let failure: unknown;
      try {
        listDeclarativeTools(tenantAId);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(DeclarativeToolQueryError);
      expect(String((failure as Error & { cause?: unknown }).cause)).toMatch(/explicit operation\/effect_scope\/sandbox_policy migration/);
    } finally {
      getDb().delete(factoryTools).where(eq(factoryTools.name, name)).run();
    }
  });

  it("persists capabilities and initializes route-created tools as probe-required", async () => {
    const name = `tc99.capabilities_${suffix}`;
    names.add(name);
    const capabilities = [{
      systems: ["RoboHire"],
      kinds: ["api"],
      roles: ["calls"],
      operations: ["parse-resume"],
      objectTypes: ["Resume"],
      probeRequired: true,
    }];
    const res = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "capability persistence",
        method: "POST",
        url_template: "https://api.example.com/resumes/parse",
        side_effect: "write",
        operation: "write",
        effect_scope: "external",
        sandbox_policy: "requires_attempt_grant",
        capabilities,
      }),
    });
    expect(res.status).toBe(200);

    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get();
    expect(systemTenant).toBeTruthy();
    const persisted = listDeclarativeTools(systemTenant!.id).find((candidate) => candidate.name === name);
    expect(persisted).toMatchObject({ capabilities, probeStatus: "required" });
    expect(persisted?.definitionHash).toBeUndefined();
    expect(persisted?.probeEvidence).toBeUndefined();
    expect(persisted?.verifiedAt).toBeUndefined();
  });

  it("persists successful probe evidence without config or response secrets", async () => {
    const name = `tc99.probe_success_${suffix}`;
    names.add(name);
    const created = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        description: "successful probe",
        method: "GET",
        url_template: "https://api.example.com/lookup/{id}",
        headers: { authorization: "Bearer {api_key}" },
        side_effect: "read",
        operation: "read",
        effect_scope: "external",
        sandbox_policy: "live_external",
        params_schema: { id: { type: "string", required: true } },
        returns_schema: { result: { type: "object", required: true } },
      }),
    });
    expect(created.status).toBe(200);

    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer config-secret");
      return new Response(JSON.stringify({ result: { ok: true, token: "vendor-secret" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env.TC99_PROBE_API_KEY = "config-secret";
    const probed = await env.fetch(`/v1/tools/${encodeURIComponent(name)}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        args: { id: "resume-1" },
        config: { api_key_env: "TC99_PROBE_API_KEY" },
        persist_cassette: false,
      }),
    });
    expect(probed.status).toBe(200);
    const responseText = await probed.text();
    expect(responseText).not.toContain("config-secret");
    expect(responseText).not.toContain("vendor-secret");
    expect(fetchMock).toHaveBeenCalledOnce();

    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get()!;
    const persisted = listDeclarativeTools(systemTenant.id).find((candidate) => candidate.name === name);
    expect(persisted?.probeStatus).toBe("verified");
    expect(persisted?.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted?.verifiedAt).toBeTruthy();
    expect(persisted?.probeEvidence).toMatchObject({ classification: "verified", status: 200 });
    expect(JSON.stringify(persisted?.probeEvidence)).not.toContain("config-secret");
    expect(JSON.stringify(persisted?.probeEvidence)).not.toContain("vendor-secret");
    delete process.env.TC99_PROBE_API_KEY;
  });

  it("persists a failed probe classification while redacting vendor errors", async () => {
    const name = `tc99.probe_failure_${suffix}`;
    names.add(name);
    const created = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        method: "GET",
        url_template: "https://api.example.com/failure",
        side_effect: "read",
        operation: "read",
        effect_scope: "external",
        sandbox_policy: "live_external",
      }),
    });
    expect(created.status).toBe(200);
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"token":"failure-secret"}', { status: 503 })));

    const probed = await env.fetch(`/v1/tools/${encodeURIComponent(name)}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ persist_cassette: false }),
    });
    expect(probed.status).toBe(422);
    const responseText = await probed.text();
    expect(responseText).toContain('"classification":"http_5xx"');
    expect(responseText).not.toContain("failure-secret");

    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get()!;
    const persisted = listDeclarativeTools(systemTenant.id).find((candidate) => candidate.name === name);
    expect(persisted?.probeStatus).toBe("failed");
    expect(persisted?.definitionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(persisted?.verifiedAt).toBeUndefined();
    expect(persisted?.probeEvidence).toMatchObject({ classification: "http_5xx", status: 503 });
    expect(JSON.stringify(persisted?.probeEvidence)).not.toContain("failure-secret");
  });

  it("returns needs_config before a declarative write probe lacking canary cleanup metadata", async () => {
    const name = `tc99.probe_write_${suffix}`;
    names.add(name);
    const created = await env.fetch("/v1/tools", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name,
        method: "POST",
        url_template: "https://api.example.com/create",
        side_effect: "write",
        operation: "write",
        effect_scope: "external",
        sandbox_policy: "requires_attempt_grant",
      }),
    });
    expect(created.status).toBe(200);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const probed = await env.fetch(`/v1/tools/${encodeURIComponent(name)}/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ args: {}, allow_side_effects: true }),
    });
    expect(probed.status).toBe(428);
    const body = await probed.json() as { status: string; next: string; missing: string[]; error: { code: string } };
    expect(body).toMatchObject({
      status: "needs_config",
      next: "ask_user",
      error: { code: "PROBE_CANARY_CONFIG_REQUIRED" },
      missing: expect.arrayContaining(["test_data_contract", "cleanup", "absence_readback"]),
    });
    expect(fetchMock).not.toHaveBeenCalled();

    const systemTenant = getDb().select().from(tenants).where(eq(tenants.slug, "__system")).get()!;
    const persisted = listDeclarativeTools(systemTenant.id).find((candidate) => candidate.name === name);
    expect(persisted?.probeStatus).toBe("required");
    expect(persisted?.definitionHash).toBeUndefined();
  });

  it("requires an explicit environment and keeps same-key sandbox/production profiles separate", async () => {
    const toolName = "meta.ping";
    const profileKey = `tc99-${suffix}`;
    const endpoint = `/v1/tools/${encodeURIComponent(toolName)}/profiles/${encodeURIComponent(profileKey)}`;
    const missingEnvironment = await env.fetch(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ config: {} }),
    });
    expect(missingEnvironment.status).toBe(400);
    expect(await missingEnvironment.text()).toContain("INVALID_PROFILE_ENVIRONMENT");

    for (const environment of ["production", "sandbox"] as const) {
      const saved = await env.fetch(endpoint, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ environment, config: {} }),
      });
      expect(saved.status).toBe(200);
      expect(await saved.json()).toMatchObject({
        ok: true,
        data: { profile: { profileKey, environment } },
      });
    }

    const sandboxOnly = await env.fetch(`/v1/tools/${encodeURIComponent(toolName)}/profiles?environment=sandbox`);
    expect(sandboxOnly.status).toBe(200);
    expect(await sandboxOnly.json()).toMatchObject({
      data: { count: 1, profiles: [{ profileKey, environment: "sandbox" }] },
    });

    const ambiguousDelete = await env.fetch(endpoint, { method: "DELETE" });
    expect(ambiguousDelete.status).toBe(400);
    for (const environment of ["production", "sandbox"] as const) {
      const deleted = await env.fetch(`${endpoint}?environment=${environment}`, { method: "DELETE" });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ data: { deleted: true, environment } });
    }
  });
});
