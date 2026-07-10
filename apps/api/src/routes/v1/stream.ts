/**
 * GET /v1/stream — Server-Sent Events feed of RunStreamEvent for the caller's
 * tenant.
 *
 * Wire format: standard text/event-stream. Each event is one `data:` line
 * carrying a JSON-serialized RunStreamEvent. We send keepalive comment lines
 * every 15s to defeat idle proxies (cloudflare, nginx) that drop slow
 * connections.
 *
 *   curl -N -H "Authorization: Bearer <token>" http://localhost:3540/v1/stream
 *
 * Tenant scoping (P1-API-01): the broadcast channel is keyed by tenantId,
 * which the route derives from `requireAuth`. There is NO `?tenant=` query
 * override — operators wanting cross-tenant access need a platform-admin
 * surface (out of scope for v1).
 *
 * Backpressure: we attach a single listener that performs a synchronous
 * `res.write`. If the socket buffer fills, the write call returns false; we
 * log + ignore for v1 (event volume is low). Phase 4 swaps the in-process
 * EventEmitter for a real queue with high-water-mark drops.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { subscribeStreamEvents } from "@agentic/runtime";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";

const KEEPALIVE_MS = 15_000;

export async function streamRoutes(app: FastifyInstance): Promise<void> {
  app.get("/stream", async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = requirePermission(req, "events.read");

    // The Fastify reply object is hijacked to write raw SSE frames; we must
    // tell Fastify not to apply its JSON serialization or attempt to set
    // content-length.
    reply.hijack();
    const raw = reply.raw;

    raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // CORS already added globally; SSE doesn't need extra headers.
      "X-Accel-Buffering": "no", // disable nginx buffering when fronted
    });

    // Initial comment so the connection is "open" from the client's POV even
    // before the first event arrives.
    raw.write(": stream open\n\n");

    // Emit a ready event so clients can confirm the auth handshake.
    raw.write(
      `event: ready\ndata: ${JSON.stringify({
        ok: true,
        tenantSlug: auth.tenantSlug,
        at: Date.now(),
      })}\n\n`,
    );

    let closed = false;

    const unsub = subscribeStreamEvents(auth.tenantId, (event) => {
      if (closed) return;
      try {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        // Socket likely dead; let the close handler clean up.
        req.log.warn({ err }, "[stream] write failed");
      }
    });

    const keepalive = setInterval(() => {
      if (closed) return;
      try {
        raw.write(`: keepalive ${Date.now()}\n\n`);
      } catch {
        /* swallow */
      }
    }, KEEPALIVE_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(keepalive);
      unsub();
      try {
        raw.end();
      } catch {
        /* swallow */
      }
    };

    raw.on("close", cleanup);
    raw.on("error", cleanup);
    req.raw.on("close", cleanup);
  });
}
