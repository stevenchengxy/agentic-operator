import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { eq, inArray } from "drizzle-orm";
import { getDb, memberships, tenants, users } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

const suffix = Date.now().toString(36).slice(-8);
const tenantA = {
  id: makeId("ten"),
  slug: `settings-a-${suffix}`,
};
const tenantB = {
  id: makeId("ten"),
  slug: `settings-b-${suffix}`,
};
const people = {
  admin: {
    id: makeId("usr"),
    email: `settings-admin-${suffix}@example.test`,
  },
  viewer: {
    id: makeId("usr"),
    email: `settings-viewer-${suffix}@example.test`,
  },
};
const sessionSecret = `tenant-settings-${suffix}-session-secret-32-chars`;

async function cookieFor(userId: string): Promise<string> {
  const token = await new SignJWT({
    name: userId,
    initials: "QA",
    tenant: tenantA.slug,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(sessionSecret));
  return `agentic_session=${token}`;
}

describe("tenant Settings authorization", () => {
  let env: TestEnv;
  let adminCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    const db = getDb();
    db.insert(tenants)
      .values([
        { id: tenantA.id, slug: tenantA.slug, name: "Settings tenant A" },
        { id: tenantB.id, slug: tenantB.slug, name: "Settings tenant B" },
      ])
      .run();
    db.insert(users)
      .values([
        { id: people.admin.id, email: people.admin.email, name: "Admin" },
        { id: people.viewer.id, email: people.viewer.email, name: "Viewer" },
      ])
      .run();
    db.insert(memberships)
      .values([
        { tenantId: tenantA.id, userId: people.admin.id, role: "admin" },
        { tenantId: tenantA.id, userId: people.viewer.id, role: "viewer" },
      ])
      .run();

    vi.stubEnv("AUTH_MODE", "production");
    vi.stubEnv("AUTH_SESSION_SECRET", sessionSecret);
    env = await buildTestEnv();
    adminCookie = await cookieFor(people.admin.id);
    viewerCookie = await cookieFor(people.viewer.id);
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    const db = getDb();
    db.delete(tenants)
      .where(inArray(tenants.id, [tenantA.id, tenantB.id]))
      .run();
    db.delete(users)
      .where(inArray(users.id, [people.admin.id, people.viewer.id]))
      .run();
  });

  it("allows an administrator to update its authenticated tenant", async () => {
    const response = await env.fetch(`/v1/tenants/${tenantA.slug}`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Settings tenant A updated" }),
    });

    expect(response.status).toBe(200);
    expect(
      getDb()
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantA.id))
        .all()[0]?.name,
    ).toBe("Settings tenant A updated");
  });

  it("denies a non-admin before updating its own tenant", async () => {
    const response = await env.fetch(`/v1/tenants/${tenantA.slug}`, {
      method: "PUT",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Viewer mutation" }),
    });

    expect(response.status).toBe(403);
    expect(
      getDb()
        .select({ name: tenants.name })
        .from(tenants)
        .where(eq(tenants.id, tenantA.id))
        .all()[0]?.name,
    ).toBe("Settings tenant A updated");
  });

  it("denies an administrator attempting a cross-tenant mutation", async () => {
    const update = await env.fetch(`/v1/tenants/${tenantB.slug}`, {
      method: "PUT",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Cross-tenant mutation" }),
    });
    const archive = await env.fetch(`/v1/tenants/${tenantB.slug}`, {
      method: "DELETE",
      headers: {
        cookie: adminCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ confirm: tenantB.slug }),
    });

    expect(update.status).toBe(403);
    expect(archive.status).toBe(403);
    expect(
      getDb()
        .select({ name: tenants.name, archivedAt: tenants.archivedAt })
        .from(tenants)
        .where(eq(tenants.id, tenantB.id))
        .all()[0],
    ).toMatchObject({ name: "Settings tenant B", archivedAt: null });
  });
});
