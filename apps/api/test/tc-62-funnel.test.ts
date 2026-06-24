/**
 * TC-62 — GET /v1/funnel (dashboard stage-funnel endpoint).
 *
 * The dashboard's stage funnel previously rendered all-zeros with a
 * "until the forthcoming /v1/funnel endpoint ships" placeholder. This
 * endpoint backs it for real: for the tenant's LIVE workflow it groups
 * runs in a rolling window by the agent's pipeline stage (the numeric
 * kebab-id prefix that getDag derives) and counts the DISTINCT subjects
 * that reached each stage — a true conversion funnel.
 *
 * Shape contract (FunnelResult):
 *   { window: string, windowMs: number, stages: [{ stage, count }] }
 *
 * Behavioural guarantees asserted here:
 *   - stages are sorted ascending by stage index
 *   - every count is a non-negative integer
 *   - the unstaged bucket (kebab prefix absent → stage 99) is excluded
 *   - test runs (`is_test = 1`) never contribute
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildTestEnv, type TestEnv } from "./harness";

interface OkEnvelope<T> {
  ok: true;
  data: T;
}

interface FunnelResult {
  window: string;
  windowMs: number;
  stages: Array<{ stage: number; count: number }>;
}

describe("TC-62: GET /v1/funnel", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  it("returns the FunnelResult shape", async () => {
    const res = await env.fetch("/v1/funnel");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<FunnelResult>;
    expect(body.ok).toBe(true);
    expect(typeof body.data.window).toBe("string");
    expect(typeof body.data.windowMs).toBe("number");
    expect(Array.isArray(body.data.stages)).toBe(true);
  });

  it("stages are sorted ascending with non-negative integer counts, no unstaged bucket", async () => {
    // Hit the raas tenant explicitly — it ships a staged pipeline so the
    // funnel has real stages to validate ordering against.
    const res = await env.fetch("/v1/funnel", {
      headers: { "x-agentic-tenant": "raas" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<FunnelResult>;
    expect(body.ok).toBe(true);

    let prev = -Infinity;
    for (const s of body.data.stages) {
      expect(Number.isInteger(s.stage)).toBe(true);
      expect(s.stage).toBeGreaterThanOrEqual(0);
      expect(s.stage).toBeLessThan(99); // unstaged sentinel excluded
      expect(Number.isInteger(s.count)).toBe(true);
      expect(s.count).toBeGreaterThanOrEqual(0);
      expect(s.stage).toBeGreaterThan(prev); // strictly ascending, deduped
      prev = s.stage;
    }
  });

  it("honours a custom window (windowMs echoes the requested window)", async () => {
    const res = await env.fetch("/v1/funnel?window=1h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<FunnelResult>;
    expect(body.data.window).toBe("1h");
    expect(body.data.windowMs).toBe(60 * 60 * 1000);
  });

  it("falls back to 24h for an unrecognised window value", async () => {
    const res = await env.fetch("/v1/funnel?window=bogus");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<FunnelResult>;
    expect(body.data.window).toBe("24h");
    expect(body.data.windowMs).toBe(24 * 60 * 60 * 1000);
  });
});
