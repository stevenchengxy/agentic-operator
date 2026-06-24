import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { appendToLedger, inngest } from "@agentic/runtime";
import { events, eventTypes, getDb } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { IngestEventBody, ListEventsQuery } from "@agentic/contracts";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { listRecentEvents } from "../../queries/runs";
import {
  fetchCausality,
  fetchEventsSince,
  getEventDetail,
  listEventCatalog,
} from "../../queries/events";
import {
  lookupIdempotency,
  readIdempotencyKey,
  storeIdempotency,
} from "../../services/idempotency";

/**
 * SSE limits for `GET /v1/events/stream` per docs/design/event-tester.md §4.2:
 *   - Poll the events table every 250ms (SQLite has no LISTEN/NOTIFY; this
 *     is the cheapest live-tail primitive that doesn't couple the wire
 *     format to Inngest internals).
 *   - 15s heartbeat keeps proxies / load balancers from idling the conn.
 *   - 30-min hard timeout — the client is expected to reconnect; this caps
 *     the per-connection cost in the unlikely "user left tab open" case.
 */
const SSE_POLL_MS = 250;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_TIMEOUT_MS = 30 * 60_000;

function sseFrame(event: string, data: string): string {
  const lines = [`event: ${event}`];
  for (const ln of data.split("\n")) lines.push(`data: ${ln}`);
  lines.push("", "");
  return lines.join("\n");
}

export async function eventsRoutes(app: FastifyInstance) {
  // POST /v1/events — public ingest. Additive `test` + `source` fields per
  // PRD FR-4 / FR-8 / NFR-6 — kept fully backwards-compatible with existing
  // payload shapes by routing them through the same Zod schema.
  app.post("/events", async (req, reply) => {
    const auth = requirePermission(req, "events.publish");
    const parsed = IngestEventBody.parse(req.body);

    // UC-V11-32 / PF-GAP-10 — idempotency replay. If the caller supplied
    // an Idempotency-Key header AND we previously serviced the same
    // (tenant, key) pair, return the cached body byte-for-byte without
    // re-emitting the Inngest event or inserting a new `events` row.
    const idemKey = readIdempotencyKey(req);
    if (idemKey) {
      const cached = lookupIdempotency(auth.tenantId, idemKey);
      if (cached) {
        return reply.code(cached.status).send(cached.body);
      }
    }

    const eventId = makeId("evt");
    const tenantNamespacedName = parsed.name.includes("/")
      ? parsed.name
      : `${auth.tenantSlug}/${parsed.name}`;
    const bareName = tenantNamespacedName.includes("/")
      ? tenantNamespacedName.split("/").slice(1).join("/")
      : tenantNamespacedName;

    const payloadRef = await appendToLedger(auth.tenantSlug, {
      id: eventId,
      name: bareName,
      subject: parsed.subject,
      data: parsed.payload ?? {},
      ts: Date.now(),
    });

    // Stamp `events.category` from the catalog. The legacy `SELECT
    // events.category` reads in listRecentEvents / fetchEventsSince already
    // expect the column to be populated; without this lookup, SSE rows
    // arrived with `category: null` even when the catalog declared one,
    // breaking the colour-coded category filter in the Events view.
    const db = getDb();
    const catalogRow = db
      .select({ category: eventTypes.category })
      .from(eventTypes)
      .where(
        and(
          eq(eventTypes.tenantId, auth.tenantId),
          eq(eventTypes.name, bareName),
        ),
      )
      .all()[0];

    db.insert(events)
      .values({
        id: eventId,
        tenantId: auth.tenantId,
        name: bareName,
        category: catalogRow?.category ?? null,
        subject: parsed.subject ?? null,
        payloadRef,
      })
      .run();

    // Only stamp __test when the caller explicitly opted in. We never inject
    // it on payloads that didn't ask — that would silently flag production
    // traffic as test, breaking dashboards in the opposite direction.
    const inngestData: Record<string, unknown> = {
      ...(parsed.payload ?? {}),
      subject: parsed.subject,
      __triggerEventId: eventId,
    };
    if (parsed.test === true) {
      inngestData.__test = true;
    }

    await inngest.send({
      name: tenantNamespacedName as `${string}/${string}`,
      data: inngestData,
    });

    // Audit every non-`external` publish (NFR-6). Reviewer guidance: the
    // `source` body field is a hint, not a trust boundary — the auth context
    // is. We always log `auth_via` so a post-hoc forensics pass can tell a
    // real-operator publish (via: "token") from a dev-bypass publish
    // (via: "dev"). External webhook ingest stays unaudited here because
    // those callers already have dedicated audit on their own routes.
    // Field *names* only — never values — so PII in payloads stays out of
    // the audit log.
    const auditedSource = parsed.source ?? "external";
    if (auditedSource !== "external") {
      try {
        const audit = await import("../../plugins/audit");
        audit.writeAudit({
          tenantId: auth.tenantId,
          action: "event.publish",
          targetType: "event",
          targetId: eventId,
          meta: {
            name: bareName,
            subject: parsed.subject ?? null,
            test: parsed.test === true,
            source: auditedSource,
            auth_via: auth.via ?? null,
            fields: Object.keys(parsed.payload ?? {}),
          },
        });
      } catch (err) {
        req.log.warn({ err }, "event.publish: audit write failed");
      }
    }

    const okBody = { event_id: eventId, name: tenantNamespacedName };
    if (idemKey) {
      // Cache the envelope-wrapped body so a retry replays the same shape
      // the client originally received (the error plugin wraps `reply.ok`
      // responses as `{ ok: true, data: ... }`).
      try {
        storeIdempotency(auth.tenantId, idemKey, {
          status: 200,
          body: { ok: true, data: okBody },
        });
      } catch (err) {
        req.log.warn({ err }, "idempotency: cache write failed (event)");
      }
    }
    return reply.ok(okBody);
  });

  // POST /v1/events/:id/replay
  app.post<{ Params: { id: string } }>(
    "/events/:id/replay",
    async (req, reply) => {
      const auth = requirePermission(req, "events.publish");
      const { id } = req.params;
      const db = getDb();
      const row = db.select().from(events).where(eq(events.id, id)).all()[0];
      if (!row) return reply.fail("not_found", "event not found", 404);
      if (row.tenantId !== auth.tenantId)
        return reply.fail("forbidden", "forbidden", 403);

      let payload: unknown = null;
      if (row.payloadRef) {
        const [filePath, offsetStr] = row.payloadRef.split("#");
        if (filePath && offsetStr != null) {
          try {
            const buf = await readFile(filePath);
            const offset = parseInt(offsetStr, 10);
            const nl = buf.indexOf(0x0a, offset);
            const line = buf.toString(
              "utf8",
              offset,
              nl === -1 ? undefined : nl,
            );
            payload = JSON.parse(line).data;
          } catch {}
        }
      }

      // P0-API-01 — use makeId("evt") so same-millisecond replays cannot
      // collide on the legacy `${id}-replay-${Date.now()}` pattern.
      const newId = makeId("evt");
      try {
        await inngest.send({
          name: `${auth.tenantSlug}/${row.name}` as `${string}/${string}`,
          data: {
            ...((payload as Record<string, unknown>) ?? {}),
            __triggerEventId: newId,
            __replayOf: id,
          },
        });
      } catch (err) {
        req.log.warn({ err }, "event.replay: inngest.send failed");
      }
      try {
        const audit = await import("../../plugins/audit");
        audit.writeAudit({
          tenantId: auth.tenantId,
          action: "event.replay",
          targetType: "event",
          targetId: id,
          meta: { new_event_id: newId },
        });
      } catch {
        /* audit best-effort */
      }
      return reply.ok({ replayed: id, new_event_id: newId });
    },
  );

  // GET /v1/events — list recent (legacy shape, used by the existing
  // events.jsx view; kept unchanged so we don't break that surface).
  app.get("/events", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    const q = ListEventsQuery.parse(req.query);
    const rows = await listRecentEvents(auth.tenantSlug, q);
    return reply.ok(rows);
  });

  // GET /v1/events/catalog — tenant's event catalog (FR-1).
  app.get("/events/catalog", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    const list = await listEventCatalog(auth.tenantSlug);
    return reply.ok({ events: list });
  });

  // GET /v1/events/:id — single event with its REAL resolved payload +
  // actual consumers (the runs it triggered). Powers the Events detail panel.
  // Declared AFTER the static /events/catalog + /events/recent routes so
  // Fastify's static-before-param ordering doesn't shadow them.
  app.get<{ Params: { id: string } }>("/events/:id", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    const detail = await getEventDetail(auth.tenantSlug, req.params.id);
    if (!detail) return reply.fail("not_found", "event not found", 404);
    return reply.ok(detail);
  });

  // GET /v1/events/recent — same payload as /events but with optional
  // causality envelope when ?causality=1&seed=<id>. We keep /events
  // untouched so the legacy SPA view doesn't have to migrate.
  app.get<{
    Querystring: {
      causality?: string;
      seed?: string;
      limit?: string;
      name?: string;
    };
  }>("/events/recent", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    if (req.query.causality === "1" && req.query.seed) {
      const out = await fetchCausality(auth.tenantSlug, req.query.seed);
      return reply.ok(out);
    }
    const limit = req.query.limit
      ? parseInt(req.query.limit, 10)
      : undefined;
    const rows = await listRecentEvents(auth.tenantSlug, {
      limit,
      name: req.query.name,
    });
    return reply.ok({ events: rows });
  });

  // GET /v1/events/stream — SSE live tail (FR-5). Mirrors the framing logic
  // in runs-logs.ts so SPA clients can use the same EventSource patterns.
  app.get<{
    Querystring: { since?: string; names?: string };
  }>("/events/stream", async (req, reply) => {
    const auth = requirePermission(req, "events.read");

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    reply.hijack();

    // `cursor` is exclusive — we ask the query layer for rows strictly
    // newer than this timestamp. Default to "now − 1s" so a fresh
    // subscriber doesn't drown in history, while still spanning the
    // SQLite `unixepoch()` second-boundary: `receivedAt` is stamped at
    // floor(now() in seconds) * 1000, so a cursor of exactly `Date.now()`
    // would miss any row inserted in the current wall-clock second.
    const sinceParam = req.query.since
      ? parseInt(req.query.since, 10)
      : NaN;
    let cursor = Number.isFinite(sinceParam)
      ? sinceParam
      : Date.now() - 1000;
    const names =
      req.query.names && req.query.names.length > 0
        ? req.query.names.split(",").map((s) => s.trim()).filter(Boolean)
        : null;

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(hbTimer);
      clearTimeout(timeoutTimer);
      try {
        reply.raw.end();
      } catch {
        /* socket already closed */
      }
    };

    const pollTimer = setInterval(async () => {
      if (closed) return;
      try {
        const rows = await fetchEventsSince(auth.tenantSlug, cursor, names);
        for (const r of rows) {
          if (closed) return;
          const ts = r.receivedAt instanceof Date ? r.receivedAt.getTime() : 0;
          if (ts > cursor) cursor = ts;
          reply.raw.write(sseFrame("event", JSON.stringify(r)));
        }
      } catch (err) {
        req.log.warn({ err }, "events/stream: poll failed");
      }
    }, SSE_POLL_MS);

    const hbTimer = setInterval(() => {
      if (closed) return;
      try {
        reply.raw.write(sseFrame("heartbeat", "{}"));
      } catch {
        close();
      }
    }, SSE_HEARTBEAT_MS);

    const timeoutTimer = setTimeout(close, SSE_TIMEOUT_MS);

    req.raw.on("close", close);
    req.raw.on("error", close);
  });
}
