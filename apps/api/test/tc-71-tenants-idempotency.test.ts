/**
 * TC-51 — POST /v1/tenants Idempotency-Key behavior (P5-TEN-01).
 *
 * A SQLite pending claim stores the stable tenant/token/audit ids before the
 * first side effect, then stores the exact response. This test verifies:
 *
 *   1. Two POSTs with the same Idempotency-Key produce IDENTICAL responses
 *      (same token plaintext — critical so the operator's retry never loses
 *      the bootstrap token to a "second time you get null" footgun).
 *   2. The SAME key with a DIFFERENT body is rejected instead of replaying a
 *      response created for different input.
 *   3. Without an Idempotency-Key, the second POST gets a fresh 409 because
 *      the slug now exists.
 */

import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import {
  apiTokens,
  auditLog,
  eventTypes,
  getDb,
  idempotencyKeys,
  tenantBudgets,
  tenants,
} from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";

const SUFFIX = `t51${Date.now().toString(36)}`.toLowerCase().slice(0, 12);
const USED_KEYS = new Set<string>();

function storedKey(key: string): string {
  return `v2:tenants.create:${createHash("sha256").update(key).digest("hex")}`;
}

describe("TC-51: Idempotency-Key on POST /v1/tenants", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  afterAll(() => {
    const db = getDb();
    for (const key of USED_KEYS) {
      db.delete(idempotencyKeys)
        .where(eq(idempotencyKeys.key, storedKey(key)))
        .run();
    }
    const rows = db
      .select()
      .from(tenants)
      .where(like(tenants.slug, `idem-${SUFFIX}%`))
      .all();
    for (const row of rows) {
      db.delete(apiTokens).where(eq(apiTokens.tenantId, row.id)).run();
      db.delete(tenantBudgets).where(eq(tenantBudgets.tenantId, row.id)).run();
      db.delete(eventTypes).where(eq(eventTypes.tenantId, row.id)).run();
      db.delete(auditLog).where(eq(auditLog.tenantId, row.id)).run();
      db.delete(tenants).where(eq(tenants.id, row.id)).run();
    }
  });

  it("identical key → identical response body (token preserved)", async () => {
    const slug = `idem-${SUFFIX}-a`;
    const key = `idem-key-${SUFFIX}-a`;

    const body1 = await postTenant(env, key, {
      slug,
      name: "Idempotency A",
      starter: "empty",
      mintToken: true,
    });
    expect(body1.ok).toBe(true);
    expect(body1.data.token.plaintext).toMatch(/^agentic_/);

    const body2 = await postTenant(env, key, {
      slug,
      name: "Idempotency A",
      starter: "empty",
      mintToken: true,
    });
    expect(body2.ok).toBe(true);
    expect(body2.data.tenant.id).toBe(body1.data.tenant.id);
    expect(body2.data.token.plaintext).toBe(body1.data.token.plaintext);

    const durable = getDb()
      .select({ responseJson: idempotencyKeys.responseJson })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.key, storedKey(key)))
      .all()[0];
    expect(durable).toBeDefined();
    expect(JSON.parse(durable!.responseJson)).toMatchObject({
      __agentic_idempotency: 2,
      state: "complete",
      response: { status: 201 },
    });

    // DB invariant: exactly one row, exactly one token, exactly one audit
    // entry — proves the second call returned the cache, not a second insert.
    const db = getDb();
    const tenantRow = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .all();
    expect(tenantRow).toHaveLength(1);
    const tokenRows = db
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tenantId, tenantRow[0]!.id))
      .all();
    expect(tokenRows).toHaveLength(1);
    const audits = db
      .select()
      .from(auditLog)
      .where(eq(auditLog.tenantId, tenantRow[0]!.id))
      .all();
    expect(audits).toHaveLength(1);
  });

  it("same key with different input is a 409 conflict", async () => {
    const key = `idem-key-${SUFFIX}-conflict`;
    const firstSlug = `idem-${SUFFIX}-e`;
    const secondSlug = `idem-${SUFFIX}-f`;
    const first = await postTenant(env, key, {
      slug: firstSlug,
      name: "Original request",
      starter: "empty",
      mintToken: false,
    });
    expect(first.ok).toBe(true);

    const response = await env.fetch("/v1/tenants", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": key,
      },
      body: JSON.stringify({
        slug: secondSlug,
        name: "Different request",
        starter: "empty",
        mintToken: false,
      }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "idempotency_key_reused" },
    });
    expect(
      getDb()
        .select()
        .from(tenants)
        .where(eq(tenants.slug, secondSlug))
        .all(),
    ).toHaveLength(0);
  });

  it("no key → second POST gets fresh 409 slug_taken", async () => {
    const slug = `idem-${SUFFIX}-b`;

    const body1 = await postTenant(env, null, {
      slug,
      name: "No Idempotency B",
      starter: "empty",
      mintToken: false,
    });
    expect(body1.ok).toBe(true);

    const res2 = await env.fetch("/v1/tenants", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug,
        name: "No Idempotency B again",
        starter: "empty",
        mintToken: false,
      }),
    });
    expect(res2.status).toBe(409);
    const body2 = await res2.json();
    expect(body2.error.code).toBe("slug_taken");
  });

  it("different keys produce distinct tenants when slugs differ", async () => {
    const slugA = `idem-${SUFFIX}-c`;
    const slugB = `idem-${SUFFIX}-d`;
    const keyA = `idem-key-${SUFFIX}-c`;
    const keyB = `idem-key-${SUFFIX}-d`;

    const ra = await postTenant(env, keyA, {
      slug: slugA,
      name: "C",
      starter: "empty",
      mintToken: false,
    });
    const rb = await postTenant(env, keyB, {
      slug: slugB,
      name: "D",
      starter: "empty",
      mintToken: false,
    });

    expect(ra.data.tenant.slug).toBe(slugA);
    expect(rb.data.tenant.slug).toBe(slugB);
    expect(ra.data.tenant.id).not.toBe(rb.data.tenant.id);
  });
});

async function postTenant(
  env: TestEnv,
  idempotencyKey: string | null,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data: never; error?: never }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  if (idempotencyKey) USED_KEYS.add(idempotencyKey);
  const res = await env.fetch("/v1/tenants", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return res.json() as never;
}
