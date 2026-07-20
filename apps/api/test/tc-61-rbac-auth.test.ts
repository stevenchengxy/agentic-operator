/**
 * TC-61 — auth + RBAC enforcement through the real HTTP surface.
 *
 * Dev mode resolves every request to the seeded superadmin, so this suite
 * disables AUTH_MODE for its lifetime and authenticates via the real
 * /v1/auth/login → session-cookie path, then asserts that role determines
 * what each caller may do.
 *
 * Creates its own role fixtures in Vitest's isolated database snapshot. It
 * never relies on production seed identities or credentials.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, hashPassword, memberships, tenants, users } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

const PASS = "tc-61-isolated-password";
const PLATFORM_ADMIN_EMAIL =
  process.env.AGENTIC_DEV_USER_EMAIL ?? "test-platform-admin@agentic.invalid";
const TENANT_ADMIN_EMAIL = `rbac-admin-${process.pid}@agentic.invalid`;
const OPERATOR_EMAIL = `rbac-operator-${process.pid}@agentic.invalid`;
const VIEWER_EMAIL = `rbac-viewer-${process.pid}@agentic.invalid`;
const ROLE_FIXTURES = [
  { email: TENANT_ADMIN_EMAIL, name: "RBAC Admin", role: "admin" as const },
  { email: OPERATOR_EMAIL, name: "RBAC Operator", role: "operator" as const },
  { email: VIEWER_EMAIL, name: "RBAC Viewer", role: "viewer" as const },
];
const FIXTURE_EMAILS = [
  PLATFORM_ADMIN_EMAIL,
  ...ROLE_FIXTURES.map((fixture) => fixture.email),
];

function cookieFrom(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  const first = raw.split(";")[0] ?? "";
  return first; // "agentic_session=<jwt>"
}

async function loginCookie(env: TestEnv, email: string): Promise<string> {
  const res = await env.fetch("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASS }),
  });
  expect(res.status, `login ${email}`).toBe(200);
  return cookieFrom(res);
}

function authed(cookie: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: {
      // Only set JSON content-type with a body (Fastify 400s on empty JSON body).
      ...(init.body != null ? { "content-type": "application/json" } : {}),
      cookie,
      "x-agentic-tenant": "raas",
      ...(init.headers as Record<string, string> | undefined),
    },
  };
}

describe("TC-61: auth + RBAC enforcement", () => {
  let env: TestEnv;
  let prevAuthMode: string | undefined;
  const priorPasswordHashes = new Map<string, string | null>();

  beforeAll(async () => {
    prevAuthMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = ""; // exercise real cookie auth, not the dev bypass

    // setup.ts has already redirected @agentic/db to an isolated DB. Create
    // the per-role principals here rather than shipping them in production.
    const db = getDb();
    const tenant = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "raas"))
      .all()[0];
    if (!tenant) throw new Error("TC-61 fixture tenant is missing: raas");
    for (const fixture of ROLE_FIXTURES) {
      const id = makeId("usr");
      const now = new Date();
      db.insert(users)
        .values({
          id,
          email: fixture.email,
          name: fixture.name,
          platformRole: "none",
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(memberships)
        .values({
          userId: id,
          tenantId: tenant.id,
          role: fixture.role,
          createdAt: now,
        })
        .run();
    }

    const passwordHash = hashPassword(PASS);
    for (const email of FIXTURE_EMAILS) {
      const user = db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .all()[0];
      if (!user) throw new Error(`TC-61 fixture user is missing: ${email}`);
      priorPasswordHashes.set(email, user.passwordHash);
      db.update(users).set({ passwordHash }).where(eq(users.id, user.id)).run();
    }
    env = await buildTestEnv();
  });

  afterAll(async () => {
    const db = getDb();
    for (const [email, passwordHash] of priorPasswordHashes) {
      db.update(users)
        .set({ passwordHash })
        .where(eq(users.email, email))
        .run();
    }
    if (prevAuthMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = prevAuthMode;
    await env?.cleanup();
  });

  it("rejects bad credentials uniformly", async () => {
    const res = await env.fetch("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: VIEWER_EMAIL, password: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_credentials");
  });

  it("GET /v1/me returns role + capabilities for the active tenant", async () => {
    const cookie = await loginCookie(env, VIEWER_EMAIL);
    const res = await env.fetch("/v1/me", authed(cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        user: { email: string; platformRole: string };
        activeTenant: { slug: string; role: string | null } | null;
        capabilities: string[];
      };
    };
    expect(body.data.user.email).toBe(VIEWER_EMAIL);
    expect(body.data.user.platformRole).toBe("none");
    expect(body.data.activeTenant?.role).toBe("viewer");
    expect(body.data.capabilities).toContain("runs.read");
    expect(body.data.capabilities).not.toContain("members.write");
    expect(body.data.capabilities).not.toContain("members.read");
  });

  it("viewer cannot read or manage members (403)", async () => {
    const cookie = await loginCookie(env, VIEWER_EMAIL);
    const list = await env.fetch("/v1/members", authed(cookie));
    expect(list.status).toBe(403);
    const add = await env.fetch(
      "/v1/members",
      authed(cookie, {
        method: "POST",
        body: JSON.stringify({ email: OPERATOR_EMAIL, role: "viewer" }),
      }),
    );
    expect(add.status).toBe(403);
  });

  it("operator can act but cannot manage members (403)", async () => {
    const cookie = await loginCookie(env, OPERATOR_EMAIL);
    const list = await env.fetch("/v1/members", authed(cookie));
    expect(list.status).toBe(403);
  });

  it("admin can list members of its tenant", async () => {
    const cookie = await loginCookie(env, TENANT_ADMIN_EMAIL);
    const res = await env.fetch("/v1/members", authed(cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<{ email: string }> };
    };
    const emails = body.data.items.map((m) => m.email);
    expect(emails).toContain(TENANT_ADMIN_EMAIL);
    expect(emails).toContain(VIEWER_EMAIL);
  });

  it("admin adding an unregistered email gets a clear 404", async () => {
    const cookie = await loginCookie(env, TENANT_ADMIN_EMAIL);
    const res = await env.fetch(
      "/v1/members",
      authed(cookie, {
        method: "POST",
        body: JSON.stringify({
          email: "nobody-xyz@nowhere.local",
          role: "viewer",
        }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("user_not_found");
  });

  it("non-superadmin cannot reach the platform user admin (403)", async () => {
    const cookie = await loginCookie(env, TENANT_ADMIN_EMAIL);
    const res = await env.fetch("/v1/admin/users", authed(cookie));
    expect(res.status).toBe(403);
  });

  it("superadmin can list all platform users", async () => {
    const cookie = await loginCookie(env, PLATFORM_ADMIN_EMAIL);
    const res = await env.fetch("/v1/admin/users", authed(cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<{ email: string; platformRole: string }> };
    };
    const ops = body.data.items.find((u) => u.email === PLATFORM_ADMIN_EMAIL);
    expect(ops?.platformRole).toBe("superadmin");
  });

  it("self-registration creates a user with no memberships", async () => {
    const email = `selfreg-${Date.now()}@example.com`;
    const res = await env.fetch("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "supersecret",
        name: "Self Reg",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { memberships: unknown[] } };
    expect(body.data.memberships).toEqual([]);
  });

  it("viewer cannot publish events or invoke agents (403)", async () => {
    const cookie = await loginCookie(env, VIEWER_EMAIL);
    const pub = await env.fetch(
      "/v1/events",
      authed(cookie, {
        method: "POST",
        body: JSON.stringify({ name: "X", subject: "s" }),
      }),
    );
    expect(pub.status).toBe(403);
    const inv = await env.fetch(
      "/v1/agents/testAgent/invoke",
      authed(cookie, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(inv.status).toBe(403);
  });

  it("operator holds the invoke permission (gate passes, not 403)", async () => {
    const cookie = await loginCookie(env, OPERATOR_EMAIL);
    // operator has agents.invoke → the RBAC gate must pass (any non-403 status
    // proves authorization succeeded; downstream may 200/404 on agent lookup).
    const inv = await env.fetch(
      "/v1/agents/testAgent/invoke",
      authed(cookie, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(inv.status).not.toBe(403);
  });

  it("requires deployment authority for the final Agent Factory promotion", async () => {
    const operatorCookie = await loginCookie(env, OPERATOR_EMAIL);
    const denied = await env.fetch(
      "/v1/agent-factory/drafts/promote",
      authed(operatorCookie, {
        method: "POST",
        body: JSON.stringify({
          domain: "rbac-probe",
          versionId: "version-probe",
          receiptId: "receipt-probe",
        }),
      }),
    );
    expect(denied.status).toBe(403);

    const adminCookie = await loginCookie(env, TENANT_ADMIN_EMAIL);
    const admitted = await env.fetch(
      "/v1/agent-factory/drafts/promote",
      authed(adminCookie, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    // A malformed request reaches the route's validation only after the
    // deployments.write guard, proving the admin is allowed to authorize a
    // deployment while an operator with agents.invoke is not.
    expect(admitted.status).toBe(400);
    expect(
      ((await admitted.json()) as { error: { code: string } }).error.code,
    ).toBe("bad_request");
  });

  it("non-superadmin cannot delete accounts (403)", async () => {
    const cookie = await loginCookie(env, TENANT_ADMIN_EMAIL);
    const res = await env.fetch(
      "/v1/admin/users/usr-does-not-exist",
      authed(cookie, { method: "DELETE" }),
    );
    expect(res.status).toBe(403);
  });

  it("membership removal rejects a nonexistent relationship instead of reporting success", async () => {
    const cookie = await loginCookie(env, PLATFORM_ADMIN_EMAIL);
    const email = `no-membership-${Date.now()}@example.com`;
    const reg = await env.fetch("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "supersecret",
        name: "No Membership",
      }),
    });
    expect(reg.status).toBe(201);
    const id = ((await reg.json()) as { data: { user: { id: string } } }).data
      .user.id;

    const revoke = await env.fetch(
      `/v1/admin/users/${id}/memberships/raas`,
      authed(cookie, { method: "DELETE" }),
    );
    expect(revoke.status).toBe(404);
    const body = (await revoke.json()) as { error: { code: string } };
    expect(body.error.code).toBe("membership_not_found");

    const cleanup = await env.fetch(
      `/v1/admin/users/${id}`,
      authed(cookie, { method: "DELETE" }),
    );
    expect(cleanup.status).toBe(200);
  });

  it("superadmin can hard-delete an account but not itself", async () => {
    const cookie = await loginCookie(env, PLATFORM_ADMIN_EMAIL);
    // create a throwaway account
    const email = `deltest-${Date.now()}@example.com`;
    const reg = await env.fetch("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "supersecret",
        name: "Del Test",
      }),
    });
    const id = ((await reg.json()) as { data: { user: { id: string } } }).data
      .user.id;

    const del = await env.fetch(
      `/v1/admin/users/${id}`,
      authed(cookie, { method: "DELETE" }),
    );
    expect(del.status).toBe(200);
    const items = (
      (await del.json()) as { data: { items: Array<{ id: string }> } }
    ).data.items;
    expect(items.find((u) => u.id === id)).toBeUndefined();

    // self-delete is blocked
    const me = await env.fetch("/v1/me", authed(cookie));
    const opsId = ((await me.json()) as { data: { user: { id: string } } }).data
      .user.id;
    const self = await env.fetch(
      `/v1/admin/users/${opsId}`,
      authed(cookie, { method: "DELETE" }),
    );
    expect(self.status).toBe(400);
  });
});
