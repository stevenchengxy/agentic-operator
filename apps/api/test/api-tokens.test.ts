/**
 * Focused coverage for the tenant API-token lifecycle.
 *
 * Verifies one-time plaintext disclosure, hash-only persistence, bearer
 * compatibility, rotation invalidation, tenant isolation, audit redaction,
 * and immediate revocation.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { apiTokens, auditLog, getDb, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = Date.now().toString(36).slice(-8);
const TENANT_A = { id: makeId("ten"), slug: `token-a-${SUFFIX}` };
const TENANT_B = { id: makeId("ten"), slug: `token-b-${SUFFIX}` };

function tenantHeaders(slug: string, json = false): Record<string, string> {
  return {
    "x-agentic-tenant": slug,
    ...(json ? { "content-type": "application/json" } : {}),
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("tenant API tokens", () => {
  let env: TestEnv;
  const originalAuthMode = process.env.AUTH_MODE;

  beforeAll(async () => {
    const db = getDb();
    db.insert(tenants)
      .values([
        { id: TENANT_A.id, slug: TENANT_A.slug, name: "Token tenant A" },
        { id: TENANT_B.id, slug: TENANT_B.slug, name: "Token tenant B" },
      ])
      .run();
    env = await buildTestEnv();
  });

  afterAll(() => {
    process.env.AUTH_MODE = originalAuthMode;
    const db = getDb();
    db.delete(apiTokens)
      .where(inArray(apiTokens.tenantId, [TENANT_A.id, TENANT_B.id]))
      .run();
    db.delete(auditLog)
      .where(inArray(auditLog.tenantId, [TENANT_A.id, TENANT_B.id]))
      .run();
    db.delete(tenants)
      .where(inArray(tenants.id, [TENANT_A.id, TENANT_B.id]))
      .run();
  });

  it("validates token names and starts with an empty tenant list", async () => {
    const empty = await env.fetch("/v1/api-tokens", {
      headers: tenantHeaders(TENANT_A.slug),
    });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      ok: true,
      data: { items: [], count: 0 },
    });

    const blank = await env.fetch("/v1/api-tokens", {
      method: "POST",
      headers: tenantHeaders(TENANT_A.slug, true),
      body: JSON.stringify({ name: "   " }),
    });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });

    const extra = await env.fetch("/v1/api-tokens", {
      method: "POST",
      headers: tenantHeaders(TENANT_A.slug, true),
      body: JSON.stringify({ name: "CI", scopes: ["admin"] }),
    });
    expect(extra.status).toBe(400);
  });

  it("creates, lists, rotates, audits, and revokes without leaking secrets", async () => {
    const createdResponse = await env.fetch("/v1/api-tokens", {
      method: "POST",
      headers: tenantHeaders(TENANT_A.slug, true),
      body: JSON.stringify({ name: "  Production CI  " }),
    });
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("cache-control")).toContain("no-store");
    expect(createdResponse.headers.get("pragma")).toBe("no-cache");
    const createdBody = await createdResponse.json();
    expect(createdBody.ok).toBe(true);
    const created = createdBody.data as {
      id: string;
      name: string;
      prefix: string;
      scopes: string[];
      plaintext: string;
      lastUsedAt: number | null;
    };
    expect(created.name).toBe("Production CI");
    expect(created.prefix).toBe("ao_live_");
    expect(created.scopes).toEqual(["workspace:all"]);
    expect(created.plaintext).toMatch(/^ao_live_[A-Za-z0-9_-]{43}$/);
    expect(created.lastUsedAt).toBeNull();

    const db = getDb();
    const stored = db
      .select()
      .from(apiTokens)
      .where(
        and(eq(apiTokens.id, created.id), eq(apiTokens.tenantId, TENANT_A.id)),
      )
      .all()[0]!;
    const oldHash = sha256(created.plaintext);
    expect(stored.hash).toBe(oldHash);
    expect(stored.hash).not.toContain(created.plaintext);
    expect(stored.scopes).toEqual(["workspace:all"]);

    const listedResponse = await env.fetch("/v1/api-tokens", {
      headers: tenantHeaders(TENANT_A.slug),
    });
    const listedBody = await listedResponse.json();
    expect(listedBody.data.count).toBe(1);
    expect(listedBody.data.items[0]).toMatchObject({
      id: created.id,
      name: "Production CI",
      prefix: "ao_live_",
      scopes: ["workspace:all"],
    });
    expect(listedBody.data.items[0]).not.toHaveProperty("plaintext");
    expect(listedBody.data.items[0]).not.toHaveProperty("hash");
    expect(JSON.stringify(listedBody)).not.toContain(created.plaintext);

    const otherTenantList = await env.fetch("/v1/api-tokens", {
      headers: tenantHeaders(TENANT_B.slug),
    });
    expect(await otherTenantList.json()).toMatchObject({
      ok: true,
      data: { items: [], count: 0 },
    });

    const crossTenantRotate = await env.fetch(
      `/v1/api-tokens/${encodeURIComponent(created.id)}/rotate`,
      {
        method: "POST",
        headers: tenantHeaders(TENANT_B.slug),
      },
    );
    expect(crossTenantRotate.status).toBe(404);
    const crossTenantRevoke = await env.fetch(
      `/v1/api-tokens/${encodeURIComponent(created.id)}`,
      {
        method: "DELETE",
        headers: tenantHeaders(TENANT_B.slug),
      },
    );
    expect(crossTenantRevoke.status).toBe(404);

    process.env.AUTH_MODE = "production";
    try {
      const bearer = await env.fetch("/v1/counts", {
        headers: { authorization: `Bearer ${created.plaintext}` },
      });
      expect(bearer.status).toBe(200);
      const credentialAdmin = await env.fetch("/v1/api-tokens", {
        headers: { authorization: `Bearer ${created.plaintext}` },
      });
      expect(credentialAdmin.status).toBe(403);
    } finally {
      process.env.AUTH_MODE = "dev";
    }

    const rotatedResponse = await env.fetch(
      `/v1/api-tokens/${encodeURIComponent(created.id)}/rotate`,
      {
        method: "POST",
        headers: tenantHeaders(TENANT_A.slug),
      },
    );
    expect(rotatedResponse.status).toBe(200);
    expect(rotatedResponse.headers.get("cache-control")).toContain("no-store");
    expect(rotatedResponse.headers.get("pragma")).toBe("no-cache");
    const rotatedBody = await rotatedResponse.json();
    const rotated = rotatedBody.data as typeof created;
    expect(rotated.id).toBe(created.id);
    expect(rotated.name).toBe(created.name);
    expect(rotated.plaintext).toMatch(/^ao_live_[A-Za-z0-9_-]{43}$/);
    expect(rotated.plaintext).not.toBe(created.plaintext);
    expect(rotated.scopes).toEqual(["workspace:all"]);
    expect(rotated.lastUsedAt).toBeNull();

    const afterRotate = db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.id, created.id))
      .all()[0]!;
    const newHash = sha256(rotated.plaintext);
    expect(afterRotate.hash).toBe(newHash);
    expect(afterRotate.hash).not.toBe(oldHash);
    expect(afterRotate.createdAt.getTime()).toBe(stored.createdAt.getTime());
    expect(afterRotate.lastUsedAt).toBeNull();

    process.env.AUTH_MODE = "production";
    try {
      const oldBearer = await env.fetch("/v1/counts", {
        headers: { authorization: `Bearer ${created.plaintext}` },
      });
      expect(oldBearer.status).toBe(401);
      const newBearer = await env.fetch("/v1/counts", {
        headers: { authorization: `Bearer ${rotated.plaintext}` },
      });
      expect(newBearer.status).toBe(200);
    } finally {
      process.env.AUTH_MODE = "dev";
    }

    const beforeRevokeAudits = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, TENANT_A.id))
      .all();
    // "settings.write" is the deny-audit row written when the bearer-token
    // call above tried a tenant-admin operation (API tokens never administer
    // credentials — the denial itself is audited by design).
    expect(beforeRevokeAudits.map((entry) => entry.action).sort()).toEqual([
      "settings.write",
      "token.create",
      "token.rotate",
    ]);
    const auditJson = JSON.stringify(beforeRevokeAudits);
    expect(auditJson).not.toContain(created.plaintext);
    expect(auditJson).not.toContain(rotated.plaintext);
    expect(auditJson).not.toContain(oldHash);
    expect(auditJson).not.toContain(newHash);

    const revokedResponse = await env.fetch(
      `/v1/api-tokens/${encodeURIComponent(created.id)}`,
      {
        method: "DELETE",
        headers: tenantHeaders(TENANT_A.slug),
      },
    );
    expect(revokedResponse.status).toBe(200);
    expect(await revokedResponse.json()).toMatchObject({
      ok: true,
      data: { id: created.id, revoked: true },
    });
    expect(
      db.select().from(apiTokens).where(eq(apiTokens.id, created.id)).all(),
    ).toHaveLength(0);

    const actions = db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(eq(auditLog.tenantId, TENANT_A.id))
      .all()
      .map((entry) => entry.action)
      .sort();
    // "settings.write" = the audited denial of the earlier bearer-token
    // admin attempt (see comment on the pre-revoke assertion above).
    expect(actions).toEqual([
      "settings.write",
      "token.create",
      "token.revoke",
      "token.rotate",
    ]);

    process.env.AUTH_MODE = "production";
    try {
      const revokedBearer = await env.fetch("/v1/counts", {
        headers: { authorization: `Bearer ${rotated.plaintext}` },
      });
      expect(revokedBearer.status).toBe(401);
    } finally {
      process.env.AUTH_MODE = "dev";
    }
  });
});
