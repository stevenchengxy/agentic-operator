/**
 * TC-6 — Phase 0 auth + tenant isolation regression suite.
 *
 * Covers:
 *   - P0-AUTH-01: AUTH_MODE must be explicitly `dev`; NODE_ENV alone never
 *                 unlocks the isolated test administrator tenant.
 *   - P0-AUTH-02: GET /v1/runs/:id and /v1/runs/:id/logs no longer fall
 *                 back to `__system` for code-agent runs.
 *   - P0-AUTH-03: GET /v1/agents drops the `?tenant=` query param.
 *   - P0-AUTH-04: POST /v1/agents/:name/invoke runs system-scoped agents
 *                 under `__system` and tenant-scoped agents under the
 *                 caller's tenant.
 *   - P0-RT-12  : the dead verifyHmac helper is gone from auth.ts.
 *   - P0-API-01 : POST /v1/events/:id/replay yields unique ids on
 *                 same-millisecond replays.
 *
 * These tests rely on the shared dev tenant (`__system`) seeded by the
 * default migrations + bootstrapCodeAgents. The harness pins
 * AUTH_MODE=dev + AGENTIC_DEV_TENANT=__system so requireAuth resolves
 * to the __system tenant.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { eq } from "drizzle-orm";
import { events, getDb, runs, tenants } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";
import { authenticate } from "../src/plugins/auth";

interface InvokeBody {
  ok: boolean;
  data: { runId: string };
}

interface EnvelopeBody<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message?: string };
}

describe("TC-6: Phase 0 auth + tenant isolation", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  // ─────────────────────────────────────────────────────────────────────
  // P0-AUTH-01
  // ─────────────────────────────────────────────────────────────────────

  describe("P0-AUTH-01: AUTH_MODE=dev opt-in", () => {
    it("rejects requests when AUTH_MODE is unset (no bearer)", async () => {
      const saved = process.env.AUTH_MODE;
      process.env.AUTH_MODE = "production";
      try {
        // No Authorization header → bearer path → returns null → /v1/runs
        // rejects with 401.
        const res = await env.fetch("/v1/runs");
        expect(res.status).toBe(401);
      } finally {
        process.env.AUTH_MODE = saved;
      }
    });

    it("rejects requests when only NODE_ENV=test is set (no AUTH_MODE)", async () => {
      const savedMode = process.env.AUTH_MODE;
      const savedNode = process.env.NODE_ENV;
      delete process.env.AUTH_MODE;
      process.env.NODE_ENV = "test";
      try {
        const res = await env.fetch("/v1/runs");
        expect(res.status).toBe(401);
      } finally {
        process.env.AUTH_MODE = savedMode;
        process.env.NODE_ENV = savedNode;
      }
    });

    it("allows requests when AUTH_MODE=dev is explicit", async () => {
      // The harness already runs in this mode; just confirm it works.
      const res = await env.fetch("/v1/runs");
      expect(res.status).toBe(200);
    });

    it("authenticate() returns null without AUTH_MODE=dev and no bearer", async () => {
      const saved = process.env.AUTH_MODE;
      process.env.AUTH_MODE = "production";
      try {
        const fakeReq = { headers: {} } as never;
        const ctx = await authenticate(fakeReq);
        expect(ctx).toBeNull();
      } finally {
        process.env.AUTH_MODE = saved;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P0-AUTH-02
  // ─────────────────────────────────────────────────────────────────────

  describe("P0-AUTH-02: no implicit __system fallback on /v1/runs/:id", () => {
    let systemRunId: string;
    let originalDevTenant: string | undefined;

    beforeAll(async () => {
      // Create a code-agent run under __system (testAgent is system-scoped).
      const res = await env.fetch("/v1/agents/testAgent/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as InvokeBody;
      systemRunId = body.data.runId;
      originalDevTenant = process.env.AGENTIC_DEV_TENANT;
    });

    it("a non-__system tenant cannot read a __system run by id (no implicit fallback)", async () => {
      // Switch the dev tenant to 'raas' so requireAuth resolves to raas.
      process.env.AGENTIC_DEV_TENANT = "raas";
      try {
        const res = await env.fetch(`/v1/runs/${systemRunId}`);
        // raas tenant has no row with this id; fallback to __system used to
        // mask that. Now: 404.
        expect(res.status).toBe(404);
      } finally {
        process.env.AGENTIC_DEV_TENANT = originalDevTenant;
      }
    });

    it("?include_system=1 still 404s for callers without platform-admin (v1)", async () => {
      process.env.AGENTIC_DEV_TENANT = "raas";
      try {
        const res = await env.fetch(
          `/v1/runs/${systemRunId}?include_system=1`,
        );
        expect(res.status).toBe(404);
      } finally {
        process.env.AGENTIC_DEV_TENANT = originalDevTenant;
      }
    });

    it("__system tenant itself still sees its own run (no regression)", async () => {
      // Default harness env: AGENTIC_DEV_TENANT=__system.
      const res = await env.fetch(`/v1/runs/${systemRunId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as EnvelopeBody<{
        run: { id: string };
      }>;
      expect(body.data?.run.id).toBe(systemRunId);
    });

    it("/v1/runs/:id/logs follows the same isolation rule", async () => {
      process.env.AGENTIC_DEV_TENANT = "raas";
      try {
        const res = await env.fetch(`/v1/runs/${systemRunId}/logs`);
        expect(res.status).toBe(404);
      } finally {
        process.env.AGENTIC_DEV_TENANT = originalDevTenant;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P0-AUTH-03
  // ─────────────────────────────────────────────────────────────────────

  describe("P0-AUTH-03: ?tenant= query param dropped", () => {
    it("passing ?tenant=other does not switch the listed tenant", async () => {
      // Auth tenant is __system. Asking for ?tenant=raas must NOT return
      // raas's agents — the param is now a no-op.
      const baseline = await env.fetch("/v1/agents?kind=all");
      const baselineBody = (await baseline.json()) as EnvelopeBody<
        Array<{ kebabId: string }>
      >;

      const withParam = await env.fetch("/v1/agents?kind=all&tenant=raas");
      const withParamBody = (await withParam.json()) as EnvelopeBody<
        Array<{ kebabId: string }>
      >;

      const baselineNames = (baselineBody.data ?? [])
        .map((a) => a.kebabId)
        .sort();
      const overrideNames = (withParamBody.data ?? [])
        .map((a) => a.kebabId)
        .sort();
      expect(overrideNames).toEqual(baselineNames);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P0-AUTH-04
  // ─────────────────────────────────────────────────────────────────────

  describe("P0-AUTH-04: agent-invoke tenant routing", () => {
    it("system-scoped testAgent runs under __system regardless of caller", async () => {
      // Caller is __system per harness setup. testAgent is in the
      // allowlist (system-scoped), so the run lives under __system.
      const res = await env.fetch("/v1/agents/testAgent/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = (await res.json()) as InvokeBody;
      const runId = body.data.runId;

      const db = getDb();
      const runRow = db.select().from(runs).where(eq(runs.id, runId)).all()[0];
      expect(runRow).toBeDefined();
      const tenantRow = db
        .select()
        .from(tenants)
        .where(eq(tenants.id, runRow!.tenantId))
        .all()[0];
      expect(tenantRow?.slug).toBe("__system");
    });

    it("system-scoped testAgent runs under __system even when raas invokes it", async () => {
      const savedTenant = process.env.AGENTIC_DEV_TENANT;
      process.env.AGENTIC_DEV_TENANT = "raas";
      try {
        const res = await env.fetch("/v1/agents/testAgent/invoke", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as InvokeBody;
        const runId = body.data.runId;

        const db = getDb();
        const runRow = db
          .select()
          .from(runs)
          .where(eq(runs.id, runId))
          .all()[0];
        expect(runRow).toBeDefined();
        const tenantRow = db
          .select()
          .from(tenants)
          .where(eq(tenants.id, runRow!.tenantId))
          .all()[0];
        // testAgent is on the allowlist → __system wins over raas.
        expect(tenantRow?.slug).toBe("__system");
      } finally {
        process.env.AGENTIC_DEV_TENANT = savedTenant;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P0-RT-12
  // ─────────────────────────────────────────────────────────────────────

  describe("P0-RT-12: verifyHmac is gone", () => {
    it("the auth plugin no longer exports verifyHmac", async () => {
      const mod = await import("../src/plugins/auth");
      expect((mod as Record<string, unknown>).verifyHmac).toBeUndefined();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // P0-API-01
  // ─────────────────────────────────────────────────────────────────────

  describe("P0-API-01: events.replay id collision", () => {
    it("the replay route no longer assigns the legacy `${id}-replay-${Date.now()}` to newId", async () => {
      // Read the route source directly. The legacy pattern collided on
      // same-millisecond replays; the fix is to use makeId("evt"). We
      // assert the bad assignment is gone (comments referencing the old
      // pattern are fine).
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const src = await fs.readFile(
        path.resolve(__dirname, "../src/routes/v1/events.ts"),
        "utf8",
      );
      // Strip /* ... */ block comments and // line comments so we only
      // assert against live code.
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(stripped).not.toMatch(/newId\s*=\s*`\$\{id\}-replay-/);
      expect(stripped).toMatch(/newId\s*=\s*makeId\("evt"\)/);
    });

    it("makeId('evt') produces distinct ids on the same millisecond", () => {
      // The route uses this factory in a tight loop. Confirm collision
      // probability is effectively zero across rapid successive calls.
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) ids.add(makeId("evt"));
      expect(ids.size).toBe(1000);
      for (const id of ids) expect(id.startsWith("evt-")).toBe(true);
    });

    it("two replays of the same event store distinct new ids in the inngest payload (smoke)", async () => {
      // Best-effort integration: seed an event and hit /replay twice.
      // Inngest send may fail in this no-worker env; the route still
      // returns 200 + new_event_id BEFORE the send if we can plumb a
      // success, but realistically the dev SDK retries → 500. We accept
      // either outcome and just assert IDs (if any returned) differ.
      const db = getDb();
      const sys = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, "__system"))
        .all()[0];
      expect(sys).toBeDefined();

      const eventId = makeId("evt");
      db.insert(events)
        .values({
          id: eventId,
          tenantId: sys!.id,
          name: "p0-api-01-test",
          subject: null,
          payloadRef: null,
        })
        .run();

      const res1 = await env.fetch(`/v1/events/${eventId}/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const res2 = await env.fetch(`/v1/events/${eventId}/replay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      // Either both succeed (Inngest reachable) or both fail at the
      // send step (no worker). We assert that if both succeeded, the
      // returned ids differ.
      if (res1.status === 200 && res2.status === 200) {
        const body1 = (await res1.json()) as EnvelopeBody<{
          new_event_id: string;
        }>;
        const body2 = (await res2.json()) as EnvelopeBody<{
          new_event_id: string;
        }>;
        expect(body1.data?.new_event_id).toBeTruthy();
        expect(body2.data?.new_event_id).toBeTruthy();
        expect(body1.data?.new_event_id).not.toBe(body2.data?.new_event_id);
      } else {
        // Inngest unreachable — covered by the static-source + makeId
        // unit assertions above.
        expect([200, 502]).toContain(res1.status);
      }
    });
  });
});
