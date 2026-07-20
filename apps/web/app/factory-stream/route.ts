/**
 * GET /factory-stream — a STREAMING SSE proxy to the api's /v1/agent-factory/stream.
 *
 * Same rationale as app/livefeed/route.ts: the `/v1/:path*` rewrite in
 * next.config.mjs BUFFERS SSE bodies (EventSource would only get the handshake),
 * and EventSource can't set request headers. A separate JSON POST has already
 * accepted the goal and returned a run id; this route forwards only that opaque id
 * and translates `?tenant=` into the `x-agentic-tenant` header.
 */

import type { NextRequest } from "next/server";
import { serverApiUrl } from "@/lib/server-api-url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API_URL = serverApiUrl();

export async function GET(req: NextRequest): Promise<Response> {
  const sp = req.nextUrl.searchParams;
  const tenant = sp.get("tenant");
  const run = sp.get("run")?.trim() ?? "";
  if (!run) return new Response("run is required", { status: 400 });

  const headers: Record<string, string> = {
    accept: "text/event-stream",
    cookie: req.headers.get("cookie") ?? "",
  };
  if (tenant) headers["x-agentic-tenant"] = tenant;

  const upstreamUrl = new URL(`${API_URL}/v1/agent-factory/stream`);
  upstreamUrl.searchParams.set("run", run);

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
