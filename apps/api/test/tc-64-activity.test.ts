/**
 * TC-64 — GET /v1/activity (live-terminal backfill).
 *
 * Reconstructs the recent lifecycle (runs / steps / events / tasks) as a
 * chronological RunStreamEvent[] so the Logs → terminal can seed from history
 * instead of starting empty. Asserts shape, ordering, the limit clamp, and
 * that every record is a valid discriminated-union member.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildTestEnv, type TestEnv } from "./harness";

interface OkEnvelope<T> {
  ok: true;
  data: T;
}

interface StreamEvent {
  type: string;
  at: number;
  tenantId: string;
}

const KNOWN_TYPES = new Set([
  "run.started",
  "run.step.started",
  "run.step.completed",
  "run.completed",
  "run.failed",
  "event.emitted",
  "task.created",
  "task.resolved",
  "deployment.created",
]);

describe("TC-64: GET /v1/activity", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await buildTestEnv();
  });

  it("returns a chronological RunStreamEvent[] (ascending by at)", async () => {
    const res = await env.fetch("/v1/activity", {
      headers: { "x-agentic-tenant": "raas" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);

    let prev = -Infinity;
    for (const ev of body.data) {
      expect(KNOWN_TYPES.has(ev.type)).toBe(true);
      expect(typeof ev.at).toBe("number");
      expect(typeof ev.tenantId).toBe("string");
      expect(ev.at).toBeGreaterThanOrEqual(prev); // ascending
      prev = ev.at;
    }
  });

  it("honours the limit clamp", async () => {
    const res = await env.fetch("/v1/activity?limit=5", {
      headers: { "x-agentic-tenant": "raas" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
    expect(body.data.length).toBeLessThanOrEqual(5);
  });

  it("defaults gracefully on a bogus limit", async () => {
    const res = await env.fetch("/v1/activity?limit=notanumber", {
      headers: { "x-agentic-tenant": "raas" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as OkEnvelope<StreamEvent[]>;
    expect(Array.isArray(body.data)).toBe(true);
  });
});
