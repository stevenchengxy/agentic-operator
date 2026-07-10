/**
 * TC-62 — GET /v1/throughput (dashboard per-agent throughput endpoint).
 *
 * Replaces the earlier stage-"funnel" endpoint: instead of pretending every
 * tenant is a linear conversion funnel, this reports, per agent in the LIVE
 * workflow, the DISTINCT subjects it processed and its run count over a
 * rolling window. Honest for any tenant shape.
 *
 * Shape contract (ThroughputResult):
 *   { window, windowMs, agents: [{ kebabId, name, title, subjects, runs }] }
 *
 * Behavioural guarantees:
 *   - agents sorted by subjects desc (then runs desc)
 *   - counts are non-negative integers; subjects ≤ runs (distinct ⊆ total)
 *   - window token echoes back; unknown window falls back to 24h
 *   - test runs (`is_test = 1`) never contribute
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildTestEnv, type TestEnv } from "./harness";

interface OkEnvelope<T> {
  ok: true;
  data: T;
}

interface ThroughputResult {
  window: string;
  windowMs: number;
  agents: Array<{
    kebabId: string;
    name: string;
    title: string;
    subjects: number;
    runs: number;
  }>;
}

describe("TC-62: GET /v1/throughput", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  it("returns the ThroughputResult shape", async () => {
    const res = await env.fetch("/v1/throughput");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<ThroughputResult>;
    expect(body.ok).toBe(true);
    expect(typeof body.data.window).toBe("string");
    expect(typeof body.data.windowMs).toBe("number");
    expect(Array.isArray(body.data.agents)).toBe(true);
  });

  it("agents sorted by subjects desc with sane non-negative counts", async () => {
    // raas ships a multi-agent workflow, so there are real agents to check.
    const res = await env.fetch("/v1/throughput", {
      headers: { "x-agentic-tenant": "raas" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<ThroughputResult>;
    expect(body.ok).toBe(true);

    let prevSubjects = Infinity;
    for (const a of body.data.agents) {
      expect(typeof a.kebabId).toBe("string");
      expect(typeof a.title).toBe("string");
      expect(Number.isInteger(a.subjects)).toBe(true);
      expect(Number.isInteger(a.runs)).toBe(true);
      expect(a.subjects).toBeGreaterThanOrEqual(0);
      expect(a.runs).toBeGreaterThanOrEqual(0);
      // distinct subjects can never exceed total runs.
      expect(a.subjects).toBeLessThanOrEqual(a.runs);
      // sorted by subjects descending.
      expect(a.subjects).toBeLessThanOrEqual(prevSubjects);
      prevSubjects = a.subjects;
    }
  });

  it("honours a custom window (windowMs echoes the requested window)", async () => {
    const res = await env.fetch("/v1/throughput?window=1h");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<ThroughputResult>;
    expect(body.data.window).toBe("1h");
    expect(body.data.windowMs).toBe(60 * 60 * 1000);
  });

  it("falls back to 24h for an unrecognised window value", async () => {
    const res = await env.fetch("/v1/throughput?window=bogus");
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<ThroughputResult>;
    expect(body.data.window).toBe("24h");
    expect(body.data.windowMs).toBe(24 * 60 * 60 * 1000);
  });
});
