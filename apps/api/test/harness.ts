/**
 * Test harness — boots one Fastify instance per isolated Vitest file context.
 *
 * Usage:
 *   const env = await buildTestEnv();
 *   afterAll(() => env.cleanup());
 *   const res = await env.fetch("/v1/llm/providers");
 *
 * Bootstrap is idempotent so it's safe to call from each test file.
 */

import type { FastifyInstance } from "fastify";

let _app: FastifyInstance | null = null;

async function getApp(): Promise<FastifyInstance> {
  if (_app) return _app;
  // Dynamic import so process.env.* (set in setup.ts) is fully applied before
  // any package code that reads env at module top-level.
  const { build } = await import("../src/server");
  _app = await build();
  await _app.ready();
  return _app;
}

export interface TestEnv {
  /** Issue a request directly to the Fastify instance (no network roundtrip). */
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  /** Tear down the Fastify instance. Call in afterAll(). */
  cleanup: () => Promise<void>;
}

export async function buildTestEnv(): Promise<TestEnv> {
  const app = await getApp();

  return {
    fetch: async (path: string, init?: RequestInit): Promise<Response> => {
      const method = (init?.method ?? "GET").toUpperCase();
      const headers: Record<string, string> = {};
      if (init?.headers) {
        const h = new Headers(init.headers);
        h.forEach((v, k) => {
          headers[k] = v;
        });
      }
      const payload =
        typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : undefined;
      const res = await app.inject({
        method: method as never,
        url: path,
        headers,
        payload,
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: Object.fromEntries(
          Object.entries(res.headers).map(([k, v]) => [k, String(v ?? "")]),
        ),
      });
    },
    cleanup: async () => {
      // Tests within this file share the instance. Defer close to process exit;
      // a later isolated test file constructs and bootstraps its own instance.
    },
  };
}
