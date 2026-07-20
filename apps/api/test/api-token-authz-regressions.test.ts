import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { eq, inArray } from "drizzle-orm";
import { apiTokens, getDb, memberships, tenants, users } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

const suffix = Date.now().toString(36).slice(-8);
const tenant = {
  id: makeId("ten"),
  slug: `tok-auth-${suffix}`,
};
const admin = {
  id: makeId("usr"),
  email: `token-admin-${suffix}@example.test`,
};
const viewer = {
  id: makeId("usr"),
  email: `token-viewer-${suffix}@example.test`,
};
const sessionSecret = `token-authz-${suffix}-session-secret-32-chars`;

async function cookieFor(emailSubject: string): Promise<string> {
  const jwt = await new SignJWT({
    name: emailSubject,
    initials: "QA",
    tenant: tenant.slug,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(emailSubject)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(sessionSecret));
  return `agentic_session=${jwt}`;
}

describe("API-token administrator authorization regressions", () => {
  let env: TestEnv;
  let adminCookie: string;
  let viewerCookie: string;
  let tokenId: string;
  const previousAuthMode = process.env.AUTH_MODE;
  const previousSessionSecret = process.env.AUTH_SESSION_SECRET;

  beforeAll(async () => {
    const db = getDb();
    db.insert(tenants)
      .values({ id: tenant.id, slug: tenant.slug, name: "Token authz tenant" })
      .run();
    db.insert(users)
      .values([
        { id: admin.id, email: admin.email, name: "Token admin" },
        { id: viewer.id, email: viewer.email, name: "Token viewer" },
      ])
      .run();
    db.insert(memberships)
      .values([
        { tenantId: tenant.id, userId: admin.id, role: "admin" },
        { tenantId: tenant.id, userId: viewer.id, role: "viewer" },
      ])
      .run();
    process.env.AUTH_SESSION_SECRET = sessionSecret;
    env = await buildTestEnv();
    adminCookie = await cookieFor(admin.email);
    viewerCookie = await cookieFor(viewer.email);
  });

  afterAll(() => {
    process.env.AUTH_MODE = previousAuthMode;
    if (previousSessionSecret === undefined) {
      delete process.env.AUTH_SESSION_SECRET;
    } else {
      process.env.AUTH_SESSION_SECRET = previousSessionSecret;
    }
    const db = getDb();
    db.delete(tenants).where(eq(tenants.id, tenant.id)).run();
    db.delete(users)
      .where(inArray(users.id, [admin.id, viewer.id]))
      .run();
  });

  it("resolves an email JWT subject to the DB admin and never caches disclosed secrets", async () => {
    process.env.AUTH_MODE = "production";
    const response = await env.fetch("/v1/api-tokens", {
      method: "POST",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Production automation" }),
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");

    const body = (await response.json()) as {
      data: { id: string; plaintext: string };
    };
    tokenId = body.data.id;
    expect(body.data.plaintext).toMatch(/^ao_live_/);

    const rotate = await env.fetch(
      `/v1/api-tokens/${encodeURIComponent(body.data.id)}/rotate`,
      { method: "POST", headers: { cookie: adminCookie } },
    );
    expect(rotate.status).toBe(200);
    expect(rotate.headers.get("cache-control")).toContain("no-store");
    expect(rotate.headers.get("pragma")).toBe("no-cache");
  });

  it("rejects a production viewer from every credential-management operation", async () => {
    process.env.AUTH_MODE = "production";
    const list = await env.fetch("/v1/api-tokens", {
      headers: { cookie: viewerCookie },
    });
    expect(list.status).toBe(403);

    const create = await env.fetch("/v1/api-tokens", {
      method: "POST",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Must not mint" }),
    });
    expect(create.status).toBe(403);

    const rotate = await env.fetch(
      `/v1/api-tokens/${encodeURIComponent(tokenId)}/rotate`,
      { method: "POST", headers: { cookie: viewerCookie } },
    );
    expect(rotate.status).toBe(403);
    const revoke = await env.fetch(
      `/v1/api-tokens/${encodeURIComponent(tokenId)}`,
      { method: "DELETE", headers: { cookie: viewerCookie } },
    );
    expect(revoke.status).toBe(403);
  });

  it("lets a bearer token call tenant APIs but forbids token self-administration", async () => {
    process.env.AUTH_MODE = "production";
    const stored = getDb()
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tenantId, tenant.id))
      .all()[0];
    expect(stored).toBeDefined();

    // Rotate once more so this test owns the current one-time plaintext.
    const rotated = await env.fetch(
      `/v1/api-tokens/${encodeURIComponent(stored!.id)}/rotate`,
      { method: "POST", headers: { cookie: adminCookie } },
    );
    const rotatedBody = (await rotated.json()) as {
      data: { plaintext: string };
    };
    const authorization = `Bearer ${rotatedBody.data.plaintext}`;

    const normalEndpoint = await env.fetch("/v1/counts", {
      headers: { authorization },
    });
    expect(normalEndpoint.status).toBe(200);

    const credentialEndpoint = await env.fetch("/v1/api-tokens", {
      headers: { authorization },
    });
    expect(credentialEndpoint.status).toBe(403);
  });
});
