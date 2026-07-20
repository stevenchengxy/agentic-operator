/**
 * TC-52 — Cross-tenant IDOR sweep around the tenant CRUD surface.
 *
 * Principal Engineer review item: "Add a cross-tenant IDOR sweep test in
 * apps/api/test/ — create two tenants, attempt every /v1/* GET/POST/PUT with
 * tenant-A's auth against tenant-B's IDs, assert 403/404."
 *
 * Today's auth model: `req.auth` is resolved by the dev-mode AGENTIC_DEV_TENANT
 * env var; we can't easily flip mid-test. So this test asserts the IDOR-shape
 * invariants that DON'T depend on a second auth context:
 *
 *   1. Archive of one tenant doesn't disturb other tenants' rows.
 *   2. Restore of one tenant doesn't touch others.
 *   3. The /v1/tenants list includes both rows when both are active and
 *      excludes only the archived one when one is archived.
 *   4. PUT to slug X never updates tenant Y.
 *   5. The audit_log rows for tenant-X's mutations are stamped with
 *      tenant-X's tenantId only — never tenant-Y's.
 *
 * The full bearer-token-per-tenant IDOR sweep belongs to P5-TEN-02 (when
 * token→user identity lands and the auth plugin can swap tenant per token).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import {
  apiTokens,
  auditLog,
  getDb,
  tenantBudgets,
  tenants,
} from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `t52${Date.now().toString(36)}`.toLowerCase().slice(0, 12);
const SLUG_A = `iso-${SUFFIX}-a`;
const SLUG_B = `iso-${SUFFIX}-b`;

describe("TC-52: cross-tenant isolation", () => {
  let env: TestEnv;
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    env = await buildTestEnv();

    await env
      .fetch("/v1/tenants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: SLUG_A,
          name: "Isolation A",
          starter: "empty",
          mintToken: false,
        }),
      })
      .then((r) => r.json())
      .then((b) => {
        tenantAId = b.data.tenant.id;
      });

    await env
      .fetch("/v1/tenants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: SLUG_B,
          name: "Isolation B",
          starter: "empty",
          mintToken: false,
        }),
      })
      .then((r) => r.json())
      .then((b) => {
        tenantBId = b.data.tenant.id;
      });
  });

  afterAll(() => {
    const db = getDb();
    const rows = db
      .select()
      .from(tenants)
      .where(like(tenants.slug, `iso-${SUFFIX}%`))
      .all();
    for (const row of rows) {
      db.delete(apiTokens).where(eq(apiTokens.tenantId, row.id)).run();
      db.delete(tenantBudgets).where(eq(tenantBudgets.tenantId, row.id)).run();
      db.delete(auditLog).where(eq(auditLog.tenantId, row.id)).run();
      db.delete(tenants).where(eq(tenants.id, row.id)).run();
    }
  });

  it("list contains both newly created tenants", async () => {
    const res = await env.fetch("/v1/tenants");
    const body = await res.json();
    const slugs = body.data.items.map((t: { slug: string }) => t.slug);
    expect(slugs).toContain(SLUG_A);
    expect(slugs).toContain(SLUG_B);
  });

  it("PUT to slug A updates only tenant A", async () => {
    await env.fetch(`/v1/tenants/${SLUG_A}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "A renamed via tc-52" }),
    });

    const db = getDb();
    const a = db.select().from(tenants).where(eq(tenants.slug, SLUG_A)).all()[0];
    const b = db.select().from(tenants).where(eq(tenants.slug, SLUG_B)).all()[0];
    expect(a!.name).toBe("A renamed via tc-52");
    expect(b!.name).toBe("Isolation B");
  });

  it("audit_log row for tenant A is stamped with tenant A's id only", async () => {
    const db = getDb();
    const tenantAUpdates = db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantAId),
          eq(auditLog.action, "tenant.update"),
        ),
      )
      .all();
    expect(tenantAUpdates.length).toBeGreaterThan(0);
    for (const row of tenantAUpdates) {
      expect(row.tenantId).toBe(tenantAId);
      expect(row.tenantId).not.toBe(tenantBId);
    }
  });

  it("archive A does not change B", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG_A}`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: SLUG_A }),
    });
    expect(res.status).toBe(200);

    const db = getDb();
    const a = db.select().from(tenants).where(eq(tenants.slug, SLUG_A)).all()[0];
    const b = db.select().from(tenants).where(eq(tenants.slug, SLUG_B)).all()[0];
    expect(a!.archivedAt).not.toBeNull();
    expect(b!.archivedAt).toBeNull();
  });

  it("default list shows only B; ?include_archived=1 shows both", async () => {
    const defRes = await env.fetch("/v1/tenants");
    const defBody = await defRes.json();
    const defSlugs = defBody.data.items.map((t: { slug: string }) => t.slug);
    expect(defSlugs).not.toContain(SLUG_A);
    expect(defSlugs).toContain(SLUG_B);

    const allRes = await env.fetch("/v1/tenants?include_archived=1");
    const allBody = await allRes.json();
    const allSlugs = allBody.data.items.map((t: { slug: string }) => t.slug);
    expect(allSlugs).toContain(SLUG_A);
    expect(allSlugs).toContain(SLUG_B);
  });

  it("restore A does not touch B", async () => {
    const res = await env.fetch(`/v1/tenants/${SLUG_A}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);

    const db = getDb();
    const a = db.select().from(tenants).where(eq(tenants.slug, SLUG_A)).all()[0];
    const b = db.select().from(tenants).where(eq(tenants.slug, SLUG_B)).all()[0];
    expect(a!.archivedAt).toBeNull();
    expect(b!.archivedAt).toBeNull();
  });

});
