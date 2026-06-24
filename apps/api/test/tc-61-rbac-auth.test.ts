/**
 * TC-61 — auth + RBAC enforcement through the real HTTP surface.
 *
 * Dev mode resolves every request to the seeded superadmin, so this suite
 * disables AUTH_MODE for its lifetime and authenticates via the real
 * /v1/auth/login → session-cookie path, then asserts that role determines
 * what each caller may do.
 *
 * Relies on the seeded users (pnpm db:seed): ops@ (superadmin), admin@ (admin
 * in raas), operator@ (operator in raas), viewer@ (viewer in raas), all with
 * password "agentic".
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestEnv, type TestEnv } from "./harness";

const PASS = "agentic";

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

  beforeAll(async () => {
    prevAuthMode = process.env.AUTH_MODE;
    process.env.AUTH_MODE = ""; // exercise real cookie auth, not the dev bypass
    env = await buildTestEnv();
  });

  afterAll(() => {
    process.env.AUTH_MODE = prevAuthMode ?? "dev";
  });

  it("rejects bad credentials uniformly", async () => {
    const res = await env.fetch("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "viewer@agentic.local", password: "wrong" }),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("invalid_credentials");
  });

  it("GET /v1/me returns role + capabilities for the active tenant", async () => {
    const cookie = await loginCookie(env, "viewer@agentic.local");
    const res = await env.fetch("/v1/me", authed(cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        user: { email: string; platformRole: string };
        activeTenant: { slug: string; role: string | null } | null;
        capabilities: string[];
      };
    };
    expect(body.data.user.email).toBe("viewer@agentic.local");
    expect(body.data.user.platformRole).toBe("none");
    expect(body.data.activeTenant?.role).toBe("viewer");
    expect(body.data.capabilities).toContain("runs.read");
    expect(body.data.capabilities).not.toContain("members.write");
    expect(body.data.capabilities).not.toContain("members.read");
  });

  it("viewer cannot read or manage members (403)", async () => {
    const cookie = await loginCookie(env, "viewer@agentic.local");
    const list = await env.fetch("/v1/members", authed(cookie));
    expect(list.status).toBe(403);
    const add = await env.fetch(
      "/v1/members",
      authed(cookie, {
        method: "POST",
        body: JSON.stringify({ email: "operator@agentic.local", role: "viewer" }),
      }),
    );
    expect(add.status).toBe(403);
  });

  it("operator can act but cannot manage members (403)", async () => {
    const cookie = await loginCookie(env, "operator@agentic.local");
    const list = await env.fetch("/v1/members", authed(cookie));
    expect(list.status).toBe(403);
  });

  it("admin can list members of its tenant", async () => {
    const cookie = await loginCookie(env, "admin@agentic.local");
    const res = await env.fetch("/v1/members", authed(cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ email: string }> } };
    const emails = body.data.items.map((m) => m.email);
    expect(emails).toContain("admin@agentic.local");
    expect(emails).toContain("viewer@agentic.local");
  });

  it("admin adding an unregistered email gets a clear 404", async () => {
    const cookie = await loginCookie(env, "admin@agentic.local");
    const res = await env.fetch(
      "/v1/members",
      authed(cookie, {
        method: "POST",
        body: JSON.stringify({ email: "nobody-xyz@nowhere.local", role: "viewer" }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("user_not_found");
  });

  it("non-superadmin cannot reach the platform user admin (403)", async () => {
    const cookie = await loginCookie(env, "admin@agentic.local");
    const res = await env.fetch("/v1/admin/users", authed(cookie));
    expect(res.status).toBe(403);
  });

  it("superadmin can list all platform users", async () => {
    const cookie = await loginCookie(env, "ops@agentic.local");
    const res = await env.fetch("/v1/admin/users", authed(cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items: Array<{ email: string; platformRole: string }> } };
    const ops = body.data.items.find((u) => u.email === "ops@agentic.local");
    expect(ops?.platformRole).toBe("superadmin");
  });

  it("self-registration creates a user with no memberships", async () => {
    const email = `selfreg-${Date.now()}@example.com`;
    const res = await env.fetch("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "supersecret", name: "Self Reg" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { memberships: unknown[] } };
    expect(body.data.memberships).toEqual([]);
  });

  it("viewer cannot publish events or invoke agents (403)", async () => {
    const cookie = await loginCookie(env, "viewer@agentic.local");
    const pub = await env.fetch(
      "/v1/events",
      authed(cookie, { method: "POST", body: JSON.stringify({ name: "X", subject: "s" }) }),
    );
    expect(pub.status).toBe(403);
    const inv = await env.fetch(
      "/v1/agents/testAgent/invoke",
      authed(cookie, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(inv.status).toBe(403);
  });

  it("operator holds the invoke permission (gate passes, not 403)", async () => {
    const cookie = await loginCookie(env, "operator@agentic.local");
    // operator has agents.invoke → the RBAC gate must pass (any non-403 status
    // proves authorization succeeded; downstream may 200/404 on agent lookup).
    const inv = await env.fetch(
      "/v1/agents/testAgent/invoke",
      authed(cookie, { method: "POST", body: JSON.stringify({}) }),
    );
    expect(inv.status).not.toBe(403);
  });

  it("non-superadmin cannot delete accounts (403)", async () => {
    const cookie = await loginCookie(env, "admin@agentic.local");
    const res = await env.fetch("/v1/admin/users/usr-does-not-exist", authed(cookie, { method: "DELETE" }));
    expect(res.status).toBe(403);
  });

  it("superadmin can hard-delete an account but not itself", async () => {
    const cookie = await loginCookie(env, "ops@agentic.local");
    // create a throwaway account
    const email = `deltest-${Date.now()}@example.com`;
    const reg = await env.fetch("/v1/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "supersecret", name: "Del Test" }),
    });
    const id = ((await reg.json()) as { data: { user: { id: string } } }).data.user.id;

    const del = await env.fetch(`/v1/admin/users/${id}`, authed(cookie, { method: "DELETE" }));
    expect(del.status).toBe(200);
    const items = ((await del.json()) as { data: { items: Array<{ id: string }> } }).data.items;
    expect(items.find((u) => u.id === id)).toBeUndefined();

    // self-delete is blocked
    const me = await env.fetch("/v1/me", authed(cookie));
    const opsId = ((await me.json()) as { data: { user: { id: string } } }).data.user.id;
    const self = await env.fetch(`/v1/admin/users/${opsId}`, authed(cookie, { method: "DELETE" }));
    expect(self.status).toBe(400);
  });
});
