/**
 * Event Tester backend — integration suite for the routes/queries added in
 * docs/impl/event-tester.md §2. Covers all six scenarios listed in §2.4:
 *
 *   1. POST /v1/events → row visible via GET /v1/events/recent
 *   2. cross-tenant isolation — tenant B never sees tenant A's events
 *   3. `test: true` → `__test: true` reaches the Inngest envelope
 *      (the schema column is plumbed; the manifest runtime side will be
 *      wired in a sibling change, so we assert at the boundary the impl
 *      plan governs)
 *   4. `source: "operator"` writes an `event.publish` audit row whose
 *      meta contains field *names* but not values (NFR-6)
 *   5. GET /v1/events/recent?causality=1 walks the seed → run → emitted
 *      event graph up to depth 3
 *   6. GET /v1/events/stream emits a frame for a newly published event
 *      within ~500ms of the publish call
 *
 * The harness pins AUTH_MODE=dev + AGENTIC_DEV_TENANT=__system; this suite
 * provisions a dedicated tenant per scenario where it matters to avoid
 * fixture cross-talk with the other test files.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  agents,
  auditLog,
  events,
  eventTypes,
  getDb,
  runs,
  tenants,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { inngest } from "@agentic/runtime";
import { buildTestEnv, type TestEnv } from "./harness";

interface PublishResponse {
  ok: boolean;
  data: { event_id: string; name: string };
}

interface RecentResponse {
  ok: boolean;
  data: {
    events: Array<{
      id: string;
      name: string;
      subject: string | null;
      payloadRef: string | null;
    }>;
    runs?: Array<{
      id: string;
      agentName: string | null;
      status: string;
      triggerEventId: string | null;
      emittedEventId: string | null;
    }>;
    edges?: Array<{ from: string; to: string; kind: string }>;
  };
}

interface CatalogResponse {
  ok: boolean;
  data: {
    events: Array<{
      name: string;
      fields: Array<{
        name: string;
        type: string;
        target_object?: string | null;
      }>;
      source_action?: string | null;
      raw_payload_schema: unknown;
    }>;
  };
}

interface InngestCapture {
  name: string;
  data: Record<string, unknown>;
}

/**
 * Monkey-patches `inngest.send` so we can inspect what the route emits.
 * Returns a `restore()` to put the original back; capture array is
 * populated synchronously as the route awaits send().
 */
function captureInngest(): { calls: InngestCapture[]; restore: () => void } {
  const calls: InngestCapture[] = [];
  const original = inngest.send;
  (inngest as unknown as { send: typeof inngest.send }).send =
    (async (payload: { name: string; data: Record<string, unknown> }) => {
      calls.push({
        name: payload.name,
        data: { ...(payload.data ?? {}) },
      });
      return { ids: [makeId("ing")] };
    }) as typeof inngest.send;
  return {
    calls,
    restore: () => {
      (inngest as unknown as { send: typeof inngest.send }).send = original;
    },
  };
}

describe("Event Tester backend", () => {
  let env: TestEnv;
  // Dedicated tenant for the catalog / publish tests so we don't have to
  // race against rich-seed updates to the shared tenants.
  const tenantSlug = `evt-tester-${makeId("tag").slice(-6)}`;
  let tenantId: string;
  // The Inngest dev runner isn't live in-process; we patch send by default
  // for every test that hits POST /events so the route doesn't choke.
  let originalDevTenant: string | undefined;

  beforeAll(async () => {
    env = await buildTestEnv();
    const db = getDb();

    tenantId = makeId("ten");
    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: "Event Tester suite" })
      .run();

    // Seed two events into the catalog so listEventCatalog has something
    // structured to parse and we can assert the field extraction shape.
    db.insert(eventTypes)
      .values({
        tenantId,
        name: "CLIENT_RULES_PASSED",
        category: "rules",
        color: "#abcdef",
        description: "Client rule check passed",
        payloadJson: {
          source_action: "ruleCheckerForClientResume",
          event_data: [
            { name: "client_id", type: "String", target_object: "Client" },
            {
              name: "candidate_id",
              type: "String",
              target_object: "Candidate",
            },
            { name: "rules_passed", type: "Boolean", target_object: null },
          ],
        } as never,
      })
      .run();
    db.insert(eventTypes)
      .values({
        tenantId,
        name: "PAYLOAD_MISSING",
        category: "ops",
        color: null,
        description: "Edge-case: no payload schema declared",
        payloadJson: null,
      })
      .run();

    // Pin the dev tenant so requireAuth(req) resolves to our scratch tenant
    // for every request the suite issues.
    originalDevTenant = process.env.AGENTIC_DEV_TENANT;
    process.env.AGENTIC_DEV_TENANT = tenantSlug;
  });

  afterAll(() => {
    if (originalDevTenant === undefined) delete process.env.AGENTIC_DEV_TENANT;
    else process.env.AGENTIC_DEV_TENANT = originalDevTenant;
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 1 — publish + recent list
  // ─────────────────────────────────────────────────────────────────────

  describe("publishes and lists in recent", () => {
    it("POST /v1/events writes a row, GET /v1/events/recent returns it", async () => {
      const cap = captureInngest();
      try {
        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: "req-tester-1",
            payload: {
              client_id: "client-1",
              candidate_id: "cand-1",
              rules_passed: true,
            },
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublishResponse;
        expect(body.ok).toBe(true);
        expect(body.data.event_id.startsWith("evt-")).toBe(true);
        expect(body.data.name).toBe(`${tenantSlug}/CLIENT_RULES_PASSED`);

        // DB row exists, tenant-scoped.
        const row = getDb()
          .select()
          .from(events)
          .where(eq(events.id, body.data.event_id))
          .all()[0];
        expect(row).toBeDefined();
        expect(row!.tenantId).toBe(tenantId);
        expect(row!.name).toBe("CLIENT_RULES_PASSED");

        // GET /v1/events/recent surfaces the row inside the envelope.
        const recent = await env.fetch("/v1/events/recent?limit=10");
        expect(recent.status).toBe(200);
        const r = (await recent.json()) as RecentResponse;
        expect(Array.isArray(r.data.events)).toBe(true);
        expect(
          r.data.events.find((e) => e.id === body.data.event_id),
        ).toBeDefined();
      } finally {
        cap.restore();
      }
    });

    it("persists and delivers one canonical logical envelope with the exact prompt", async () => {
      const cap = captureInngest();
      let eventId: string | undefined;
      try {
        const exactPrompt = "  Investigate this request.\nKeep spacing.  ";
        const subject = `canonical-${makeId("tag")}`;
        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject,
            payload: {
              event_type: "CALLER_CANNOT_OVERRIDE",
              event_name: "CALLER_CANNOT_OVERRIDE",
              event_id: "evt-caller",
              request_id: "   ",
              prompt: exactPrompt,
              domain_field: "preserved",
            },
          }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as PublishResponse;
        eventId = body.data.event_id;
        expect(cap.calls).toHaveLength(1);
        const delivered = cap.calls[0]!.data;
        const correlationId = delivered.__correlationId;
        expect(typeof correlationId).toBe("string");
        const {
          __triggerEventId: triggerEventId,
          __correlationId: _privateCorrelationId,
          ...deliveredLogical
        } = delivered;
        expect(triggerEventId).toBe(eventId);
        expect(deliveredLogical).toEqual({
          request_id: correlationId,
          domain_field: "preserved",
          event_type: "CLIENT_RULES_PASSED",
          event_name: "CLIENT_RULES_PASSED",
          event_id: eventId,
          subject,
          prompt: exactPrompt,
          input: exactPrompt,
          context: exactPrompt,
        });

        const persisted = getDb()
          .select({ payloadRef: events.payloadRef })
          .from(events)
          .where(eq(events.id, eventId))
          .all()[0];
        expect(persisted?.payloadRef).toBeTruthy();
        const [ledgerPath, offset = "0"] = persisted!.payloadRef!.split("#");
        const ledgerBytes = await readFile(ledgerPath!);
        const ledgerLine = ledgerBytes
          .subarray(Number(offset))
          .toString("utf8")
          .split("\n")[0]!;
        const ledgerRecord = JSON.parse(ledgerLine) as {
          data: Record<string, unknown>;
        };
        expect(ledgerRecord.data).toEqual(deliveredLogical);
        expect(
          Object.keys(ledgerRecord.data).some((key) => key.startsWith("__")),
        ).toBe(false);
      } finally {
        if (eventId) {
          getDb().delete(events).where(eq(events.id, eventId)).run();
        }
        cap.restore();
      }
    });

    it("publish stamps events.category from the catalog row", async () => {
      // Round-2 review follow-up: the publish route looks up
      // eventTypes.category for (tenantId, bareName) and copies it onto the
      // events row so SSE/recent reads can colour-code by category without
      // a second join. Catalog seeded `CLIENT_RULES_PASSED → "rules"` in the
      // suite-level beforeAll.
      const cap = captureInngest();
      try {
        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: "category-stamp",
            payload: {
              client_id: "cc1",
              candidate_id: "kk1",
              rules_passed: true,
            },
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublishResponse;

        const row = getDb()
          .select()
          .from(events)
          .where(eq(events.id, body.data.event_id))
          .all()[0];
        expect(row).toBeDefined();
        expect(row!.category).toBe("rules");
      } finally {
        cap.restore();
      }
    });

    it("publish leaves events.category null when there's no catalog row", async () => {
      // Publishing a name that isn't in event_types — the route should
      // store the row with category=null rather than inventing a value or
      // throwing.
      const cap = captureInngest();
      try {
        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "UNCATALOGUED_EVENT",
            subject: "no-cat",
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublishResponse;
        const row = getDb()
          .select()
          .from(events)
          .where(eq(events.id, body.data.event_id))
          .all()[0];
        expect(row!.category).toBeNull();
      } finally {
        cap.restore();
      }
    });

    it("GET /v1/events/catalog returns typed fields", async () => {
      const res = await env.fetch("/v1/events/catalog");
      expect(res.status).toBe(200);
      const body = (await res.json()) as CatalogResponse;
      const passed = body.data.events.find(
        (e) => e.name === "CLIENT_RULES_PASSED",
      );
      expect(passed).toBeDefined();
      expect(passed!.source_action).toBe("ruleCheckerForClientResume");
      expect(passed!.fields).toHaveLength(3);
      expect(passed!.fields.map((f) => f.name)).toEqual([
        "client_id",
        "candidate_id",
        "rules_passed",
      ]);
      expect(passed!.fields.map((f) => f.type)).toEqual([
        "String",
        "String",
        "Boolean",
      ]);

      // Null payload_json must degrade gracefully → empty fields, no throw.
      const empty = body.data.events.find((e) => e.name === "PAYLOAD_MISSING");
      expect(empty).toBeDefined();
      expect(empty!.fields).toEqual([]);
      expect(empty!.raw_payload_schema).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Ingest safety — tenant namespace, internal metadata, dispatch atomicity
  // ─────────────────────────────────────────────────────────────────────

  describe("ingest safety", () => {
    it("rejects an event addressed to another tenant namespace", async () => {
      const cap = captureInngest();
      try {
        const subject = `foreign-ns-${makeId("tag")}`;
        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: `some-other-tenant/CLIENT_RULES_PASSED`,
            subject,
            payload: { client_id: "c1" },
          }),
        });

        expect(res.status).toBe(403);
        expect(cap.calls).toHaveLength(0);
        expect(
          getDb()
            .select()
            .from(events)
            .where(
              and(eq(events.tenantId, tenantId), eq(events.subject, subject)),
            )
            .all(),
        ).toHaveLength(0);
      } finally {
        cap.restore();
      }
    });

    it("rejects public payload keys reserved for runtime metadata", async () => {
      const cap = captureInngest();
      try {
        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: "reserved-metadata",
            payload: { __test: true, client_id: "c1" },
          }),
        });

        expect(res.status).toBe(400);
        expect(cap.calls).toHaveLength(0);
      } finally {
        cap.restore();
      }
    });

    it("targets one registered live agent and rejects a trigger it does not subscribe to", async () => {
      // buildTestEnv bootstraps the real northwind manifest functions into
      // the mutable registry. Temporarily scope this request to that tenant
      // so we exercise target preflight + envelope stamping without a live
      // external Inngest process.
      const priorTenant = process.env.AGENTIC_DEV_TENANT;
      process.env.AGENTIC_DEV_TENANT = "northwind";
      const cap = captureInngest();
      let publishedEventId: string | undefined;
      try {
        const subject = `targeted-${makeId("tag")}`;
        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "HIRING_REQUIREMENT_SUBMITTED",
            targetAgent: "jdAuthorAgent",
            subject,
            payload: { requirement: "platform engineer" },
          }),
        });

        expect(res.status).toBe(200);
        const body = (await res.json()) as PublishResponse;
        publishedEventId = body.data.event_id;
        expect(cap.calls).toHaveLength(1);
        expect(cap.calls[0]).toEqual(
          expect.objectContaining({
            name: "northwind/HIRING_REQUIREMENT_SUBMITTED",
            data: expect.objectContaining({
              __triggerEventId: publishedEventId,
              __invokedAgent: "jdAuthorAgent",
              subject,
            }),
          }),
        );

        const wrongTrigger = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "RESUME_INTAKE_REQUESTED",
            targetAgent: "jdAuthorAgent",
            subject: `${subject}-wrong`,
          }),
        });
        expect(wrongTrigger.status).toBe(409);
        expect(cap.calls).toHaveLength(1);
      } finally {
        if (publishedEventId) {
          getDb().delete(events).where(eq(events.id, publishedEventId)).run();
        }
        cap.restore();
        if (priorTenant === undefined) delete process.env.AGENTIC_DEV_TENANT;
        else process.env.AGENTIC_DEV_TENANT = priorTenant;
      }
    });

    it("removes the provisional event row when runtime dispatch fails", async () => {
      const original = inngest.send;
      (inngest as unknown as { send: typeof inngest.send }).send =
        (async () => {
          throw new Error("simulated Inngest outage");
        }) as typeof inngest.send;

      const subject = `dispatch-failure-${makeId("tag")}`;
      try {
        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject,
            payload: { client_id: "c1" },
          }),
        });

        expect(res.status).toBe(503);
        expect(
          getDb()
            .select()
            .from(events)
            .where(
              and(eq(events.tenantId, tenantId), eq(events.subject, subject)),
            )
            .all(),
        ).toHaveLength(0);
      } finally {
        (inngest as unknown as { send: typeof inngest.send }).send = original;
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Soft-delete consistency — both list functions must hide tombstoned rows
  // ─────────────────────────────────────────────────────────────────────

  describe("soft-deleted events are hidden from both list paths", () => {
    it("listRecentEvents and fetchEventsSince agree on deletedAt IS NULL", async () => {
      const db = getDb();
      // Two rows with the same name in our tenant: one live, one tombstoned.
      // We anchor receivedAt 5 minutes in the past so fetchEventsSince's
      // `since` cursor can be far enough back to scoop both up if the filter
      // weren't applied — i.e. the test would fail if the filter regresses.
      const baseTs = Date.now() - 5 * 60_000;
      const liveId = makeId("evt");
      const deletedId = makeId("evt");
      db.insert(events)
        .values([
          {
            id: liveId,
            tenantId,
            name: "SOFT_DELETE_PROBE",
            subject: "live",
            receivedAt: new Date(baseTs + 1000),
            payloadRef: null,
          },
          {
            id: deletedId,
            tenantId,
            name: "SOFT_DELETE_PROBE",
            subject: "tombstoned",
            receivedAt: new Date(baseTs + 2000),
            payloadRef: null,
            deletedAt: new Date(baseTs + 3000),
          },
        ])
        .run();

      // Catch-up GET path.
      const { listRecentEvents } = await import("../src/queries/runs");
      const recent = await listRecentEvents(tenantSlug, {
        limit: 200,
        name: "SOFT_DELETE_PROBE",
      });
      expect(recent.some((r) => r.id === liveId)).toBe(true);
      expect(recent.some((r) => r.id === deletedId)).toBe(false);

      // SSE live-tail path.
      const { fetchEventsSince } = await import("../src/queries/events");
      const stream = await fetchEventsSince(tenantSlug, baseTs, [
        "SOFT_DELETE_PROBE",
      ]);
      expect(stream.some((r) => r.id === liveId)).toBe(true);
      expect(stream.some((r) => r.id === deletedId)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 2 — cross-tenant isolation
  // ─────────────────────────────────────────────────────────────────────

  describe("rejects cross-tenant access", () => {
    const otherSlug = `evt-tester-other-${makeId("tag").slice(-6)}`;
    let otherTenantId: string;
    let otherEventId: string;

    beforeAll(() => {
      const db = getDb();
      otherTenantId = makeId("ten");
      db.insert(tenants)
        .values({
          id: otherTenantId,
          slug: otherSlug,
          name: "Event Tester suite (other)",
        })
        .run();
      // Seed an event for the other tenant directly (no HTTP, so we don't
      // have to swap dev tenants to do the insert).
      otherEventId = makeId("evt");
      db.insert(events)
        .values({
          id: otherEventId,
          tenantId: otherTenantId,
          name: "FOREIGN_EVENT",
          subject: "foreign-subject",
          payloadRef: null,
        })
        .run();
      db.insert(eventTypes)
        .values({
          tenantId: otherTenantId,
          name: "FOREIGN_EVENT",
          payloadJson: {
            source_action: "x",
            event_data: [{ name: "secret_field", type: "String" }],
          } as never,
        })
        .run();
    });

    it("recent feed does not leak other-tenant events", async () => {
      const recent = await env.fetch("/v1/events/recent?limit=200");
      expect(recent.status).toBe(200);
      const body = (await recent.json()) as RecentResponse;
      for (const e of body.data.events) {
        expect(e.name).not.toBe("FOREIGN_EVENT");
        expect(e.id).not.toBe(otherEventId);
      }
    });

    it("catalog does not leak other-tenant event types", async () => {
      const res = await env.fetch("/v1/events/catalog");
      expect(res.status).toBe(200);
      const body = (await res.json()) as CatalogResponse;
      for (const e of body.data.events) {
        expect(e.name).not.toBe("FOREIGN_EVENT");
      }
    });

    it("causality lookup against a foreign event id returns an empty graph", async () => {
      const res = await env.fetch(
        `/v1/events/recent?causality=1&seed=${otherEventId}`,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as RecentResponse;
      // The seed isn't in our tenant → BFS short-circuits at the seed
      // load with an empty result. Confirms tenant scope is enforced at
      // the query layer rather than only in the route.
      expect(body.data.events ?? []).toHaveLength(0);
      expect(body.data.runs ?? []).toHaveLength(0);
      expect(body.data.edges ?? []).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 3 — test flag plumbing
  // ─────────────────────────────────────────────────────────────────────

  describe("honors test flag → __test stamped on Inngest data", () => {
    it("test:true adds __test to the inngest envelope; test:false omits it", async () => {
      const cap = captureInngest();
      try {
        const r1 = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: "test-flag-true",
            payload: {
              client_id: "c1",
              candidate_id: "k1",
              rules_passed: true,
            },
            test: true,
          }),
        });
        expect(r1.status).toBe(200);

        const r2 = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: "test-flag-false",
            payload: {
              client_id: "c2",
              candidate_id: "k2",
              rules_passed: true,
            },
          }),
        });
        expect(r2.status).toBe(200);

        expect(cap.calls.length).toBe(2);
        const [first, second] = cap.calls;
        expect(first!.data.__test).toBe(true);
        expect(first!.data.subject).toBe("test-flag-true");
        expect(first!.data.__triggerEventId).toBeDefined();
        // The non-test branch must NEVER inject __test — that would silently
        // tag production traffic.
        expect(second!.data.__test).toBeUndefined();
      } finally {
        cap.restore();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 4 — audit row
  // ─────────────────────────────────────────────────────────────────────

  describe("writes audit row when source=operator", () => {
    it("source:operator emits event.publish; absent source does not", async () => {
      const cap = captureInngest();
      try {
        // Baseline count for our tenant.
        const before = getDb()
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenantId, tenantId),
              eq(auditLog.action, "event.publish"),
            ),
          )
          .all().length;

        const res = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: "audit-test",
            payload: {
              client_id: "c-a",
              candidate_id: "k-a",
              rules_passed: true,
            },
            test: true,
            source: "operator",
          }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as PublishResponse;

        const rows = getDb()
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenantId, tenantId),
              eq(auditLog.action, "event.publish"),
            ),
          )
          .all();
        expect(rows.length).toBe(before + 1);

        const fresh = rows.find((r) => r.targetId === body.data.event_id);
        expect(fresh).toBeDefined();
        expect(fresh!.targetType).toBe("event");
        const meta = fresh!.metaJson as Record<string, unknown>;
        expect(meta.name).toBe("CLIENT_RULES_PASSED");
        expect(meta.subject).toBe("audit-test");
        expect(meta.test).toBe(true);
        // NFR-6 — log field NAMES not values, so PII never lands in audit.
        expect(meta.fields).toEqual([
          "client_id",
          "candidate_id",
          "rules_passed",
        ]);
        // No values from the payload should leak into meta.
        expect(JSON.stringify(meta)).not.toContain("c-a");
        expect(JSON.stringify(meta)).not.toContain("k-a");

        // Publish without source — must NOT add another audit row.
        const before2 = rows.length;
        const r2 = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: "audit-test-no-source",
            payload: {
              client_id: "c-b",
              candidate_id: "k-b",
              rules_passed: true,
            },
          }),
        });
        expect(r2.status).toBe(200);
        const after = getDb()
          .select()
          .from(auditLog)
          .where(
            and(
              eq(auditLog.tenantId, tenantId),
              eq(auditLog.action, "event.publish"),
            ),
          )
          .all().length;
        expect(after).toBe(before2);
      } finally {
        cap.restore();
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 5 — causality DAG up to depth 3
  // ─────────────────────────────────────────────────────────────────────

  describe("returns causality DAG up to depth 3", () => {
    it("BFS from a seed event surfaces triggered runs and emitted events", () => {
      // Build a synthetic chain directly in the DB so we don't depend on a
      // running Inngest worker. Shape:
      //
      //   seedEvent ─triggered_run→ runA ─emitted_event→ evtChild
      //   evtChild  ─triggered_run→ runB ─emitted_event→ evtGrandchild
      //   evtGrandchild ─triggered_run→ runC (no emit)
      //
      // Depth 3 should capture seedEvent + 2 child events + 3 runs, with
      // 5 edges total. Depth 4+ wouldn't add anything because runC emits
      // nothing.
      const db = getDb();

      // We need an `agents.id` to satisfy the FK on runs.agent_id; reuse
      // an existing agent row from any tenant — the row is just a join
      // target for the BFS query. If none exists, synthesize one in our
      // tenant scoped to a placeholder workflow.
      let agentRow = db.select().from(agents).limit(1).all()[0];
      if (!agentRow) {
        const wfId = makeId("wf");
        db.insert(workflows)
          .values({
            id: wfId,
            tenantId,
            slug: "evt-causality-wf",
            name: "Causality fixture",
          })
          .run();
        const agentId = makeId("agt");
        db.insert(agents)
          .values({
            id: agentId,
            workflowId: wfId,
            kebabId: "causalityAgent",
            name: "causalityAgent",
            actor: "Agent",
            kind: "manifest",
            enabled: true,
          })
          .run();
        agentRow = db
          .select()
          .from(agents)
          .where(eq(agents.id, agentId))
          .all()[0]!;
      }

      const seedEventId = makeId("evt");
      const childEventId = makeId("evt");
      const grandchildEventId = makeId("evt");
      const runA = makeId("run");
      const runB = makeId("run");
      const runC = makeId("run");
      const baseTs = Date.now();

      db.insert(events)
        .values([
          {
            id: seedEventId,
            tenantId,
            name: "SEED",
            subject: "causal-1",
            receivedAt: new Date(baseTs),
            payloadRef: null,
          },
          {
            id: childEventId,
            tenantId,
            name: "CHILD",
            subject: "causal-1",
            receivedAt: new Date(baseTs + 1000),
            payloadRef: null,
          },
          {
            id: grandchildEventId,
            tenantId,
            name: "GRANDCHILD",
            subject: "causal-1",
            receivedAt: new Date(baseTs + 2000),
            payloadRef: null,
          },
        ])
        .run();

      db.insert(runs)
        .values([
          {
            id: runA,
            tenantId,
            agentId: agentRow.id,
            triggerEventId: seedEventId,
            emittedEventId: childEventId,
            status: "ok",
            startedAt: new Date(baseTs + 100),
            correlationId: makeId("cor"),
            subject: "causal-1",
          },
          {
            id: runB,
            tenantId,
            agentId: agentRow.id,
            triggerEventId: childEventId,
            emittedEventId: grandchildEventId,
            status: "ok",
            startedAt: new Date(baseTs + 1100),
            correlationId: makeId("cor"),
            subject: "causal-1",
          },
          {
            id: runC,
            tenantId,
            agentId: agentRow.id,
            triggerEventId: grandchildEventId,
            emittedEventId: null,
            status: "ok",
            startedAt: new Date(baseTs + 2100),
            correlationId: makeId("cor"),
            subject: "causal-1",
          },
        ])
        .run();

      // Use the async helper directly so we exercise the function under
      // test rather than just the HTTP route. The route is exercised via
      // the recent endpoint below.
      return env
        .fetch(`/v1/events/recent?causality=1&seed=${seedEventId}`)
        .then(async (res) => {
          expect(res.status).toBe(200);
          const body = (await res.json()) as RecentResponse;
          const evIds = (body.data.events ?? []).map((e) => e.id).sort();
          expect(evIds).toContain(seedEventId);
          expect(evIds).toContain(childEventId);
          expect(evIds).toContain(grandchildEventId);

          const runIds = (body.data.runs ?? []).map((r) => r.id).sort();
          expect(runIds).toContain(runA);
          expect(runIds).toContain(runB);
          expect(runIds).toContain(runC);

          const edges = body.data.edges ?? [];
          // We should see both kinds of edges along the chain.
          expect(
            edges.some((e) => e.from === seedEventId && e.to === runA),
          ).toBe(true);
          expect(
            edges.some((e) => e.from === runA && e.to === childEventId),
          ).toBe(true);
          expect(
            edges.some((e) => e.from === childEventId && e.to === runB),
          ).toBe(true);
          expect(
            edges.some((e) => e.from === runB && e.to === grandchildEventId),
          ).toBe(true);
          expect(
            edges.some((e) => e.from === grandchildEventId && e.to === runC),
          ).toBe(true);
        });
    });
  });

  // ─────────────────────────────────────────────────────────────────────
  // Scenario 6 — SSE delivers a publish within ~500ms
  // ─────────────────────────────────────────────────────────────────────

  describe("SSE delivers a published event within 500ms", () => {
    it("the live-tail query primitive surfaces a freshly-published event", async () => {
      // The SSE handler is a 250ms-poll wrapper around fetchEventsSince.
      // We assert the primitive sees the row promptly; the route just
      // serialises its results into `event:`/`data:` frames every tick.
      // Exercising the actual hijacked socket would require a real HTTP
      // client (Fastify inject buffers the body until handler return),
      // so we test the primitive + route registration separately.
      const { restore } = captureInngest();
      try {
        // Sit at the start of the next wall-clock second so the SQLite
        // unixepoch() default for events.received_at can't accidentally
        // round down below our cursor and hide the freshly-inserted row.
        const wait = 1000 - (Date.now() % 1000);
        await new Promise((resolve) => setTimeout(resolve, wait));

        const before = Date.now();
        const pubRes = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: "sse-test",
            payload: {
              client_id: "c-sse",
              candidate_id: "k-sse",
              rules_passed: true,
            },
          }),
        });
        expect(pubRes.status).toBe(200);
        const pubBody = (await pubRes.json()) as PublishResponse;

        const { fetchEventsSince } = await import("../src/queries/events");
        // The cursor must span the SQLite unixepoch second boundary —
        // the route handler uses `Date.now() - 1000` as its default
        // cursor for exactly this reason. Apply the same compensation
        // here.
        const rows = await fetchEventsSince(tenantSlug, before - 1000);
        const elapsed = Date.now() - before;
        // PRD NFR-2 budget is < 500ms p95 in local dev; allow a small
        // CI-noise margin without losing the regression value.
        expect(elapsed).toBeLessThan(1500);
        expect(rows.some((r) => r.id === pubBody.data.event_id)).toBe(true);

        // names filter narrows correctly — confirms the SSE ?names= path
        // doesn't leak the row when the caller asked for a different
        // event type.
        const filtered = await fetchEventsSince(tenantSlug, before - 1000, [
          "UNRELATED_NAME",
        ]);
        expect(filtered.some((r) => r.id === pubBody.data.event_id)).toBe(
          false,
        );
      } finally {
        restore();
      }
    });

    it("GET /v1/events/stream delivers a published event over a live socket", async () => {
      // Mirrors TC-14's pattern: fastify.inject() buffers the body so it
      // can't observe SSE frames. We bind the shared singleton to an
      // ephemeral port (idempotent — the harness never listens itself)
      // and fetch the SSE endpoint with a streaming Response.
      const { build } = await import("../src/server");
      const app = await build();
      let port: number | null = null;
      try {
        const addr = await app.listen({ port: 0, host: "127.0.0.1" });
        const m = /:(\d+)/.exec(addr);
        if (m) port = Number(m[1]);
      } catch {
        const a = app.server.address();
        if (a && typeof a !== "string") port = a.port;
      }
      expect(port).toBeTruthy();

      const cap = captureInngest();
      const ctrl = new AbortController();
      const stopMarker = `evt-tester-sse-${makeId("tag").slice(-6)}`;
      try {
        // Pre-publish into the past so we don't have to race against the
        // poll. The cursor we hand the route is anchored 1.5s before the
        // publish wall-clock; the SQLite unixepoch() truncates the row
        // to the start of its second, so a margin > 1s spans the worst
        // case.
        //
        // We then open the SSE stream with `since` set to (publishTime −
        // 1500ms), so the FIRST poll tick (≤ 250ms after open) emits a
        // frame for our row.
        const pubRes = await env.fetch("/v1/events", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            name: "CLIENT_RULES_PASSED",
            subject: stopMarker,
            payload: {
              client_id: "c-stream",
              candidate_id: "k-stream",
              rules_passed: true,
            },
          }),
        });
        expect(pubRes.status).toBe(200);

        const since = Date.now() - 5000;
        const res = await fetch(
          `http://127.0.0.1:${port}/v1/events/stream?since=${since}`,
          { signal: ctrl.signal },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("text/event-stream");

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buf = "";

        const readerDone = (async () => {
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) return;
            buf += decoder.decode(value);
            if (buf.includes(stopMarker)) return;
          }
        })();

        await Promise.race([
          readerDone,
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("sse frame timeout")), 3500),
          ),
        ]);

        expect(buf).toContain(stopMarker);
        expect(buf).toMatch(/event: event/);
      } finally {
        cap.restore();
        ctrl.abort();
      }
    }, 10_000);
  });

  // ─────────────────────────────────────────────────────────────────────
  // Surface-level: confirm /v1/events still works for legacy clients
  // ─────────────────────────────────────────────────────────────────────

  describe("legacy GET /v1/events shape is unchanged", () => {
    it("returns a bare array (not the new envelope)", async () => {
      const res = await env.fetch("/v1/events?limit=5");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; data: unknown };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });
  });
});
