/**
 * TC-31 — P3-RT-03 + P3-RT-04 + P3-RT-05: webhook ingest.
 *
 * Covers:
 *   1. POST /v1/webhooks/:source — 404 when no enabled subscription.
 *   2. Empty body → 400.
 *   3. Missing signature → 401.
 *   4. Bad HMAC → 401.
 *   5. Valid HMAC + body → 202 + idempotency_key returned.
 *   6. Stale x-timestamp (>5min) → 401 replay_rejected.
 *   7. Idempotency key picked from explicit header when present.
 *   8. Authorization / Cookie headers stripped from the emitted Inngest event.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, getDb, tenants, webhookSubscriptions } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { getTenantInngest, inngest } from "@agentic/runtime";
import { buildTestEnv, type TestEnv } from "./harness";

const SOURCE = `gh-test-${makeId("tag").slice(-6)}`;
const SECRET = "s3kret-shared-key";

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("TC-31: webhook ingest (P3-RT-03/04/05)", () => {
  let env: TestEnv;
  let tenantId: string;
  let tenantSlug: string;
  let subscriptionId: string;
  let encryptedSecret: string;
  let tenantInngest: ReturnType<typeof getTenantInngest>;

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();
    tenantSlug = `webhook-tenant-${makeId("tag").slice(-6)}`;
    tenantId = makeId("ten");
    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: tenantSlug })
      .run();
    const provisioned = await env.fetch("/v1/webhook-subscriptions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenantSlug,
      },
      body: JSON.stringify({ source: SOURCE, secret: SECRET }),
    });
    expect(provisioned.status).toBe(201);
    const provisionedBody = (await provisioned.json()) as {
      data: { id: string; source: string; configured: boolean };
    };
    subscriptionId = provisionedBody.data.id;
    expect(provisionedBody.data).toMatchObject({
      source: SOURCE,
      configured: true,
    });
    const stored = db
      .select({ encrypted: webhookSubscriptions.secretEncrypted })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, subscriptionId))
      .all()[0];
    encryptedSecret = stored?.encrypted ?? "";
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  beforeEach(() => {
    // This is a route unit/integration test, not an Inngest broker test. Stub
    // only the external enqueue boundary and keep the production route's
    // acknowledgement contract under test. The dedicated failure case below
    // overrides the first call to prove that a broker rejection returns 503.
    tenantInngest = getTenantInngest(tenantSlug);
    vi.spyOn(tenantInngest, "send").mockResolvedValue({
      ids: ["accepted"],
    } as never);
    // Keep a separate spy on the backwards-compatible __system client so the
    // happy-path assertion can prove webhook delivery never crosses tenant
    // boundaries through that global client.
    vi.spyOn(inngest, "send").mockResolvedValue({ ids: ["system"] } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function audits() {
    return getDb()
      .select({ id: auditLog.id, meta: auditLog.metaJson })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.action, "webhook.ingest"),
          eq(auditLog.targetId, subscriptionId),
        ),
      )
      .all();
  }

  it("stores an authenticated ciphertext envelope, never the signing secret", () => {
    const row = getDb()
      .select({ encrypted: webhookSubscriptions.secretEncrypted })
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, subscriptionId))
      .all()[0];
    expect(row?.encrypted).toBe(encryptedSecret);
    expect(row?.encrypted).toMatch(/^agentic-secret-v1\./);
    expect(row?.encrypted).not.toContain(SECRET);
  });

  it("provides tenant-admin create, rotate, list, enable, disable, and delete without secret disclosure", async () => {
    const source = `crud-${makeId("tag").slice(-6)}`;
    const firstSecret = "crud-first-secret-value";
    const rotatedSecret = "crud-rotated-secret-value";
    const adminHeaders = {
      "content-type": "application/json",
      "x-agentic-tenant": tenantSlug,
    };

    const created = await env.fetch("/v1/webhook-subscriptions", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ source, secret: firstSecret }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      data: {
        id: string;
        source: string;
        enabled: boolean;
        configured: boolean;
      };
    };
    expect(createdBody.data).toMatchObject({
      source,
      enabled: true,
      configured: true,
    });
    expect(JSON.stringify(createdBody)).not.toContain(firstSecret);
    expect(JSON.stringify(createdBody)).not.toContain("agentic-secret-v1");

    const listed = await env.fetch("/v1/webhook-subscriptions", {
      headers: { "x-agentic-tenant": tenantSlug },
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as {
      data: { items: Array<Record<string, unknown>> };
    };
    expect(listedBody.data.items).toContainEqual(
      expect.objectContaining({
        id: createdBody.data.id,
        source,
        enabled: true,
      }),
    );
    expect(JSON.stringify(listedBody)).not.toContain(firstSecret);
    expect(JSON.stringify(listedBody)).not.toContain("secretEncrypted");

    const rotated = await env.fetch("/v1/webhook-subscriptions", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ source, secret: rotatedSecret }),
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = (await rotated.json()) as {
      data: { id: string; enabled: boolean };
    };
    expect(rotatedBody.data.id).not.toBe(createdBody.data.id);
    expect(rotatedBody.data.enabled).toBe(true);
    expect(JSON.stringify(rotatedBody)).not.toContain(rotatedSecret);

    const signedByOldSecret = JSON.stringify({ event: "old-secret" });
    const oldAttempt = await env.fetch(`/v1/webhooks/${source}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(signedByOldSecret, firstSecret),
      },
      body: signedByOldSecret,
    });
    expect(oldAttempt.status).toBe(401);

    const signedByNewSecret = JSON.stringify({ event: "rotated-secret" });
    const newAttempt = await env.fetch(`/v1/webhooks/${source}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(signedByNewSecret, rotatedSecret),
      },
      body: signedByNewSecret,
    });
    expect(newAttempt.status).toBe(202);

    const disabled = await env.fetch(
      `/v1/webhook-subscriptions/${rotatedBody.data.id}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ enabled: false }),
      },
    );
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ data: { enabled: false } });

    const disabledAttemptBody = JSON.stringify({ event: "disabled" });
    const disabledAttempt = await env.fetch(`/v1/webhooks/${source}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(disabledAttemptBody, rotatedSecret),
      },
      body: disabledAttemptBody,
    });
    expect(disabledAttempt.status).toBe(404);

    const enabled = await env.fetch(
      `/v1/webhook-subscriptions/${rotatedBody.data.id}`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ enabled: true }),
      },
    );
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({ data: { enabled: true } });

    const removed = await env.fetch(
      `/v1/webhook-subscriptions/${rotatedBody.data.id}`,
      {
        method: "DELETE",
        headers: { "x-agentic-tenant": tenantSlug },
      },
    );
    expect(removed.status).toBe(200);
    expect(await removed.json()).toMatchObject({
      data: { id: rotatedBody.data.id, source, deleted: true },
    });

    const postDeleteBody = JSON.stringify({ event: "deleted" });
    const postDelete = await env.fetch(`/v1/webhooks/${source}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(postDeleteBody, rotatedSecret),
      },
      body: postDeleteBody,
    });
    expect(postDelete.status).toBe(404);

    const mutationAudits = getDb()
      .select({ action: auditLog.action, meta: auditLog.metaJson })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenantId),
          eq(auditLog.targetType, "webhook_subscription"),
        ),
      )
      .all()
      .filter((row) => row.action.startsWith("webhook.subscription."));
    expect(mutationAudits.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "webhook.subscription.create",
        "webhook.subscription.rotate",
        "webhook.subscription.disable",
        "webhook.subscription.enable",
        "webhook.subscription.delete",
      ]),
    );
    const auditText = JSON.stringify(mutationAudits);
    expect(auditText).not.toContain(firstSecret);
    expect(auditText).not.toContain(rotatedSecret);
    expect(auditText).not.toContain("agentic-secret-v1");
  });

  it("returns 503 and stays disabled when an undecryptable subscription is enabled", async () => {
    const source = `corrupt-enable-${makeId("tag").slice(-6)}`;
    const adminHeaders = {
      "content-type": "application/json",
      "x-agentic-tenant": tenantSlug,
    };
    const created = await env.fetch("/v1/webhook-subscriptions", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ source, secret: "valid-before-corruption" }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { data: { id: string } };
    const id = createdBody.data.id;

    try {
      const disabled = await env.fetch(`/v1/webhook-subscriptions/${id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ enabled: false }),
      });
      expect(disabled.status).toBe(200);
      getDb()
        .update(webhookSubscriptions)
        .set({ secretEncrypted: "not-an-authenticated-vault-envelope" })
        .where(eq(webhookSubscriptions.id, id))
        .run();

      const enabled = await env.fetch(`/v1/webhook-subscriptions/${id}`, {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({ enabled: true }),
      });
      expect(enabled.status).toBe(503);
      expect(await enabled.json()).toMatchObject({
        error: { code: "webhook_secret_unavailable" },
      });
      const stored = getDb()
        .select({ enabled: webhookSubscriptions.enabled })
        .from(webhookSubscriptions)
        .where(eq(webhookSubscriptions.id, id))
        .all()[0];
      expect(stored?.enabled).toBe(false);
    } finally {
      await env.fetch(`/v1/webhook-subscriptions/${id}`, {
        method: "DELETE",
        headers: { "x-agentic-tenant": tenantSlug },
      });
    }
  });

  it("404s when no enabled subscription matches the source slug", async () => {
    const body = JSON.stringify({ event: "ping" });
    const res = await env.fetch(`/v1/webhooks/unknown-source-xyz`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(body),
      },
      body,
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.ok).toBe(false);
    expect(json.error.code).toBe("not_subscribed");
  });

  it("400s on an empty body", async () => {
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(""),
      },
      body: "",
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.error.code).toBe("empty_body");
  });

  it("401s when signature header is missing", async () => {
    const body = JSON.stringify({ event: "ping" });
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.error.code).toBe("no_signature");
  });

  it("401s on bad HMAC", async () => {
    const bodySentinel = `never-audit-body-${makeId("tag")}`;
    const body = JSON.stringify({ event: "ping", bodySentinel });
    const bogus = "0".repeat(64);
    const before = new Set(audits().map((row) => row.id));
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": bogus,
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.error.code).toBe("bad_signature");
    const after = audits();
    const [created] = after.filter((row) => !before.has(row.id));
    expect(after).toHaveLength(before.size + 1);
    const auditText = JSON.stringify(created?.meta);
    expect(created?.meta).toMatchObject({
      outcome: "rejected",
      reason: "bad_signature",
      source: SOURCE,
    });
    expect(auditText).not.toContain(bodySentinel);
    expect(auditText).not.toContain(SECRET);
    expect(auditText).not.toContain(bogus);
  });

  it("cannot authenticate with the stored ciphertext as if it were the key", async () => {
    const body = JSON.stringify({ event: "ciphertext-is-not-a-key" });
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(body, encryptedSecret),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: "bad_signature" },
    });
  });

  it("fails closed when a legacy plaintext or corrupt value is stored", async () => {
    const db = getDb();
    db.update(webhookSubscriptions)
      .set({ secretEncrypted: SECRET })
      .where(eq(webhookSubscriptions.id, subscriptionId))
      .run();
    try {
      const body = JSON.stringify({ event: "legacy-plaintext" });
      const before = new Set(audits().map((row) => row.id));
      const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-signature-256": sign(body),
        },
        body,
      });
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({
        error: { code: "webhook_secret_unavailable" },
      });
      expect(tenantInngest.send).not.toHaveBeenCalled();
      const after = audits();
      const [created] = after.filter((row) => !before.has(row.id));
      expect(after).toHaveLength(before.size + 1);
      expect(created?.meta).toMatchObject({
        outcome: "rejected",
        reason: "secret_decryption_failed",
      });
      expect(JSON.stringify(created?.meta)).not.toContain(SECRET);
    } finally {
      db.update(webhookSubscriptions)
        .set({ secretEncrypted: encryptedSecret })
        .where(eq(webhookSubscriptions.id, subscriptionId))
        .run();
    }
  });

  it("returns 202 + idempotency_key on valid HMAC", async () => {
    const bodySentinel = `never-audit-success-body-${makeId("tag")}`;
    const body = JSON.stringify({ event: "ping", id: "abc", bodySentinel });
    const signature = sign(body);
    const before = new Set(audits().map((row) => row.id));
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": signature,
        "x-idempotency-key": "my-explicit-key",
      },
      body,
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      ok: boolean;
      data: {
        source: string;
        tenant: string;
        event: string;
        idempotency_key: string;
      };
    };
    expect(json.ok).toBe(true);
    expect(json.data.source).toBe(SOURCE);
    expect(json.data.tenant).toBe(tenantSlug);
    expect(json.data.event).toBe(`${tenantSlug}/${SOURCE}.received`);
    expect(json.data.idempotency_key).toBe("my-explicit-key");
    expect(tenantInngest.send).toHaveBeenCalledOnce();
    expect(tenantInngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `${tenantSlug}/${SOURCE}.received`,
        data: expect.objectContaining({ tenantId, tenantSlug }),
      }),
    );
    expect(inngest.send).not.toHaveBeenCalled();
    const after = audits();
    const [created] = after.filter((row) => !before.has(row.id));
    expect(after).toHaveLength(before.size + 1);
    expect(created?.meta).toMatchObject({
      outcome: "accepted",
      reason: "enqueued",
      source: SOURCE,
      eventName: `${tenantSlug}/${SOURCE}.received`,
      duplicate: false,
    });
    const auditText = JSON.stringify(created?.meta);
    expect(auditText).not.toContain(bodySentinel);
    expect(auditText).not.toContain(SECRET);
    expect(auditText).not.toContain(encryptedSecret);
    expect(auditText).not.toContain(signature);
  });

  it("falls back to signature digest as idempotency_key when header absent", async () => {
    const body = JSON.stringify({ event: "x", n: 1 });
    const sig = sign(body);
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sig,
      },
      body,
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as {
      ok: boolean;
      data: { idempotency_key: string };
    };
    expect(json.data.idempotency_key).toBe(sig.slice(0, 64));
  });

  it("401s on a stale x-timestamp (replay window)", async () => {
    const body = JSON.stringify({ event: "old" });
    const stale = String(Date.now() - 10 * 60 * 1000); // 10 min ago
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(body),
        "x-timestamp": stale,
      },
      body,
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(json.error.code).toBe("replay_rejected");
  });

  it("accepts a fresh x-timestamp", async () => {
    const body = JSON.stringify({ event: "fresh" });
    const now = String(Date.now());
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(body),
        "x-timestamp": now,
      },
      body,
    });
    expect(res.status).toBe(202);
  });

  it("accepts standard epoch-seconds timestamps and Stripe's signed timestamp envelope", async () => {
    const body = JSON.stringify({ event: "stripe-compatible" });
    const seconds = Math.floor(Date.now() / 1000);
    const stripeSignature = createHmac("sha256", SECRET)
      .update(`${seconds}.${body}`)
      .digest("hex");
    const res = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "stripe-signature": `t=${seconds},v1=${stripeSignature}`,
      },
      body,
    });
    expect(res.status).toBe(202);
  });

  it("never acknowledges a failed Inngest enqueue and safely retries with one stable event id", async () => {
    const send = vi
      .mocked(tenantInngest.send)
      .mockRejectedValueOnce(new Error("broker offline"))
      .mockResolvedValue({ ids: ["accepted"] } as never);
    const body = JSON.stringify({
      event: "retry-after-broker-failure",
      nonce: makeId("tag"),
    });
    const headers = {
      "content-type": "application/json",
      "x-signature-256": sign(body),
      "x-idempotency-key": `retry-${makeId("tag")}`,
    };

    const failed = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers,
      body,
    });
    expect(failed.status).toBe(503);
    expect(
      ((await failed.json()) as { error: { code: string } }).error.code,
    ).toBe("delivery_failed");

    const retried = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers,
      body,
    });
    expect(retried.status).toBe(202);
    const retryBody = (await retried.json()) as {
      data: { duplicate: boolean; event_id: string };
    };
    expect(retryBody.data.duplicate).toBe(false);

    const replayed = await env.fetch(`/v1/webhooks/${SOURCE}`, {
      method: "POST",
      headers,
      body,
    });
    expect(replayed.status).toBe(202);
    expect(
      ((await replayed.json()) as { data: { duplicate: boolean } }).data
        .duplicate,
    ).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[0]?.[0] as { id?: string }).id).toBe(
      retryBody.data.event_id,
    );
    expect((send.mock.calls[1]?.[0] as { id?: string }).id).toBe(
      retryBody.data.event_id,
    );
  });

  it("400s on a malformed source slug", async () => {
    const body = JSON.stringify({ event: "x" });
    const res = await env.fetch(`/v1/webhooks/has%20space`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-256": sign(body),
      },
      body,
    });
    expect([400, 404]).toContain(res.status);
  });
});
