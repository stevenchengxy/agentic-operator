/**
 * GET /livefeed — a STREAMING SSE proxy to the api's /v1/stream.
 *
 * Why this exists: the `/v1/:path*` rewrite in next.config.mjs BUFFERS SSE
 * response bodies, so a browser EventSource pointed at `/v1/stream` only ever
 * receives the handshake frame — never the live run/step/event activity. A
 * Next.js **route handler** (unlike a rewrite) can return a streaming
 * `ReadableStream` body, so events flow to the client in real time.
 *
 * It also bridges a second limitation: the browser `EventSource` API can't set
 * request headers, so it can't forward the `x-agentic-tenant` dev override that
 * scopes the stream to the *viewed* tenant. This handler reads that tenant from
 * a `?tenant=` query param and forwards it as the header upstream — so the live
 * terminal shows the tenant you're actually looking at, not the session default.
 *
 * Auth + tenant ride through: the session cookie is forwarded verbatim; the
 * `?tenant` query (if present) becomes the `x-agentic-tenant` header (consulted
 * by the api only under AUTH_MODE=dev). Client disconnect aborts the upstream
 * fetch via the request's AbortSignal.
 */

import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const API_URL = process.env.AGENTIC_API_URL ?? "http://localhost:3540";

export async function GET(req: NextRequest): Promise<Response> {
  const tenant = req.nextUrl.searchParams.get("tenant");
  const headers: Record<string, string> = {
    accept: "text/event-stream",
    cookie: req.headers.get("cookie") ?? "",
  };
  if (tenant) headers["x-agentic-tenant"] = tenant;

  let upstream: Response;
  try {
    upstream = await fetch(`${API_URL}/v1/stream`, {
      headers,
      signal: req.signal,
      // Node's undici returns the Response as soon as headers arrive; `.body`
      // is a ReadableStream that yields frames as the api writes them.
      cache: "no-store",
    });
  } catch {
    return new Response("upstream unavailable", { status: 502 });
  }

  if (!upstream.ok || !upstream.body) {
    return new Response("upstream error", { status: upstream.status || 502 });
  }

  // Pipe the upstream SSE body straight through, unbuffered.
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
