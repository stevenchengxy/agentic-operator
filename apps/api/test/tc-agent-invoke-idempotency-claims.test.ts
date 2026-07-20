import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, getDb, idempotencyKeys, runs, tenants } from "@agentic/db";
import { getTenantInngest } from "@agentic/runtime";
import { buildTestEnv, type TestEnv } from "./harness";
import {
  claimIdempotency,
  completeIdempotency,
  idempotencyFingerprint,
} from "../src/services/idempotency";

const suffix = Date.now().toString(36);
const storageKey = (scope: string, publicKey: string) =>
  `v2:${scope}:${createHash("sha256").update(publicKey).digest("hex")}`;

describe("durable idempotency claims", () => {
  const tenantId = `ten-idem-claim-${suffix}`;
  const tenantSlug = `idem-claim-${suffix}`;

  beforeAll(() => {
    getDb().insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "Idempotency claim test" }).run();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("allows one owner, exposes pending, and reclaims the original stable recipe after lease expiry", () => {
    const key = `claim-${suffix}`;
    const scope = "agent-invoke:testAgent";
    const fingerprint = idempotencyFingerprint({ input: "same" });
    const first = claimIdempotency({
      tenantId,
      key,
      scope,
      fingerprint,
      operation: { eventId: "evt-stable", runId: "run-stable" },
    });
    expect(first.state).toBe("owner");
    if (first.state !== "owner") throw new Error("expected owner");

    const concurrent = claimIdempotency({
      tenantId,
      key,
      scope,
      fingerprint,
      operation: { eventId: "evt-other", runId: "run-other" },
    });
    expect(concurrent.state).toBe("pending");
    if (concurrent.state === "pending") {
      expect(concurrent.operation).toEqual({ eventId: "evt-stable", runId: "run-stable" });
    }

    const stored = storageKey(scope, key);
    const row = getDb().select().from(idempotencyKeys).where(and(
      eq(idempotencyKeys.tenantId, tenantId),
      eq(idempotencyKeys.key, stored),
    )).all()[0]!;
    const envelope = JSON.parse(row.responseJson) as Record<string, unknown>;
    envelope.leaseUntil = Date.now() - 1;
    getDb().update(idempotencyKeys).set({ responseJson: JSON.stringify(envelope) }).where(and(
      eq(idempotencyKeys.tenantId, tenantId),
      eq(idempotencyKeys.key, stored),
    )).run();

    const recovered = claimIdempotency({
      tenantId,
      key,
      scope,
      fingerprint,
      operation: { eventId: "evt-new", runId: "run-new" },
    });
    expect(recovered.state).toBe("owner");
    if (recovered.state !== "owner") throw new Error("expected recovered owner");
    expect(recovered.recovered).toBe(true);
    expect(recovered.operation).toEqual({ eventId: "evt-stable", runId: "run-stable" });
    expect(() => completeIdempotency({
      tenantId,
      key,
      scope,
      fingerprint,
      ownerToken: first.ownerToken,
      response: { status: 200, body: { wrong: true } },
    })).toThrow(/ownership was lost/);

    completeIdempotency({
      tenantId,
      key,
      scope,
      fingerprint,
      ownerToken: recovered.ownerToken,
      response: { status: 202, body: { ok: true, eventId: "evt-stable" } },
    });
    const replay = claimIdempotency({
      tenantId,
      key,
      scope,
      fingerprint,
      operation: { eventId: "evt-never", runId: "run-never" },
    });
    expect(replay).toEqual({ state: "replay", response: { status: 202, body: { ok: true, eventId: "evt-stable" } } });
    expect(() => claimIdempotency({
      tenantId,
      key,
      scope,
      fingerprint: idempotencyFingerprint({ input: "different" }),
      operation: { eventId: "evt-never", runId: "run-never" },
    })).toThrow(/different request/);
  });
});

describe("agent invoke idempotency transport", () => {
  let env: TestEnv;
  const createdRuns = new Set<string>();
  const createdAuditTargets = new Set<string>();
  const keys = new Set<string>();

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    for (const runId of createdRuns) getDb().delete(runs).where(eq(runs.id, runId)).run();
    for (const runId of createdAuditTargets) {
      getDb().delete(auditLog).where(and(eq(auditLog.targetType, "run"), eq(auditLog.targetId, runId))).run();
    }
    const systemTenant = getDb().select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "__system")).all()[0];
    if (systemTenant) {
      for (const key of keys) {
        getDb().delete(idempotencyKeys).where(and(
          eq(idempotencyKeys.tenantId, systemTenant.id),
          eq(idempotencyKeys.key, storageKey("agent-invoke:testAgent", key)),
        )).run();
      }
    }
    await env.cleanup();
  });

  it("rejects an overlong key instead of silently executing without protection", async () => {
    const response = await env.fetch("/v1/agents/testAgent/invoke?testRun=1", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "x".repeat(256) },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_idempotency_key");
  });

  it("executes at most one synchronous run for concurrent first requests and rejects body reuse", async () => {
    const key = `sync-${suffix}`;
    keys.add(key);
    const request = () => env.fetch("/v1/agents/testAgent/invoke?testRun=1", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({}),
    });
    const firstPair = await Promise.all([request(), request()]);
    expect(firstPair.map((response) => response.status).every((status) => status === 200 || status === 409)).toBe(true);
    const bodies = await Promise.all(firstPair.map((response) => response.json() as Promise<{ ok: boolean; data?: { runId: string } }>));
    const successfulIds = bodies.filter((body) => body.ok).map((body) => body.data!.runId);
    expect(successfulIds.length).toBeGreaterThanOrEqual(1);
    expect(new Set(successfulIds).size).toBe(1);

    const replay = await request();
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as { data: { runId: string } };
    expect(replayBody.data.runId).toBe(successfulIds[0]);
    createdRuns.add(replayBody.data.runId);

    const conflict = await env.fetch("/v1/agents/testAgent/invoke?testRun=1", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ input: { changed: true } }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("idempotency_key_reused");
  });

  it("uses one stable Inngest event id and replays the exact async receipt", async () => {
    const key = `async-${suffix}`;
    keys.add(key);
    const send = vi.spyOn(getTenantInngest("__system"), "send").mockResolvedValue({ ids: ["accepted"] } as never);
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ async: true, input: { subject: `SUB-${suffix}` } }),
    } satisfies RequestInit;
    const first = await env.fetch("/v1/agents/testAgent/invoke", init);
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { data: { runId: string; eventId: string } };
    createdRuns.add(firstBody.data.runId);
    createdAuditTargets.add(firstBody.data.runId);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      id: firstBody.data.eventId,
      data: { runId: firstBody.data.runId },
    });

    const replay = await env.fetch("/v1/agents/testAgent/invoke", init);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(firstBody);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRestore();
  });

  it("returns 503 rather than a false success when the completed receipt cannot be committed", async () => {
    const key = `store-fail-${suffix}`;
    keys.add(key);
    const systemTenant = getDb().select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, "__system")).all()[0]!;
    let runId = "";
    const send = vi.spyOn(getTenantInngest("__system"), "send").mockImplementation(async (event: unknown) => {
      const sent = event as { id?: string; data?: { runId?: string } };
      runId = String(sent.data?.runId ?? "");
      // Simulate durable-store loss after broker acceptance but before the
      // route commits its success response.
      getDb().delete(idempotencyKeys).where(and(
        eq(idempotencyKeys.tenantId, systemTenant.id),
        eq(idempotencyKeys.key, storageKey("agent-invoke:testAgent", key)),
      )).run();
      return { ids: [String(sent.id)] } as never;
    });
    const response = await env.fetch("/v1/agents/testAgent/invoke", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify({ async: true, input: { subject: `FAIL-${suffix}` } }),
    });
    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("idempotency_store_failed");
    expect(runId).toMatch(/^run-/);
    createdRuns.add(runId);
    createdAuditTargets.add(runId);
    send.mockRestore();
  });
});
