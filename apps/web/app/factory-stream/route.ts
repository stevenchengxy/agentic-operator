/**
 * GET /factory-stream — a STREAMING SSE proxy to the api's /v1/agent-factory/stream.
 *
 * Same rationale as app/livefeed/route.ts: the `/v1/:path*` rewrite in
 * next.config.mjs BUFFERS SSE bodies (EventSource would only get the handshake),
 * and EventSource can't set request headers. This route handler returns the upstream
 * ReadableStream verbatim (unbuffered) and translates `?tenant=` into the
 * `x-agentic-tenant` dev header. The factory params (domain/goal/conversation) ride
 * through as query string to the upstream brain stream.
 */

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API_URL = process.env.AGENTIC_API_URL ?? "http://localhost:3540";

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const tenant = sp.get("tenant");
  const domain = sp.get("domain") ?? "";
  const goal = sp.get("goal") ?? "";
  const conversation = sp.get("conversation") ?? "";
  const run = sp.get("run") ?? ""; // reconnect to a live/finished background run

  const headers: Record<string, string> = {
    accept: "text/event-stream",
    cookie: req.headers.get("cookie") ?? "",
  };
  if (tenant) headers["x-agentic-tenant"] = tenant;

  const upstreamUrl = new URL(`${API_URL}/v1/agent-factory/stream`);
  if (run) {
    upstreamUrl.searchParams.set("run", run);
  } else {
    upstreamUrl.searchParams.set("domain", domain);
    upstreamUrl.searchParams.set("goal", goal);
    if (conversation) upstreamUrl.searchParams.set("conversation", conversation);
  }

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl.toString(), { headers, signal: req.signal, cache: "no-store" });
  } catch {
    return new Response("upstream unavailable", { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response("upstream error", { status: upstream.status || 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
