/**
 * TC-14 — P1-RT-05 + P1-API-01 + P1-CON-03 stream regression.
 *
 * Boots the API, subscribes to /v1/stream as an SSE client, publishes a
 * synthetic `RunStreamEvent` via the broadcast channel, and asserts the
 * event is delivered to the SSE socket within ~1 second.
 *
 * Also exercises the broadcast unit-test surface: per-tenant isolation,
 * subscribe/unsubscribe ref-counting.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  publishStreamEvent,
  subscribeStreamEvents,
  __broadcastSubscriberCount,
  __broadcastResetForTest,
} from "@agentic/runtime";
import type { RunStreamEvent } from "@agentic/contracts";
import { RunStreamEvent as RunStreamEventSchema } from "@agentic/contracts";
import { events, getDb, tenants } from "@agentic/db";
import { eq } from "drizzle-orm";
import { makeId } from "@agentic/shared";
import { buildTestEnv, type TestEnv } from "./harness";

describe("TC-14: broadcast channel + SSE stream", () => {
  let env: TestEnv;
  let systemTenantId: string;

  beforeAll(async () => {
    env = await buildTestEnv();
    const row = getDb()
      .select()
      .from(tenants)
      .where(eq(tenants.slug, "__system"))
      .all()[0];
    if (!row) throw new Error("__system tenant not seeded");
    systemTenantId = row.id;
  });

  afterAll(() => {
    __broadcastResetForTest();
  });

  describe("broadcast channel (P1-RT-05)", () => {
    it("delivers a published event to a subscriber", async () => {
      __broadcastResetForTest();
      const received: RunStreamEvent[] = [];
      const unsub = subscribeStreamEvents("ten-a", (e) => received.push(e));
      const evt: RunStreamEvent = {
        type: "run.started",
        tenantId: "ten-a",
        at: Date.now(),
        runId: "run-xyz",
        agentName: "demo",
        triggerEvent: "DEMO_FIRED",
        subject: null,
        correlationId: "cor-1",
      };
      publishStreamEvent(evt);
      expect(received).toEqual([evt]);
      unsub();
    });

    it("isolates tenants — subscriber A does not see tenant B events", () => {
      __broadcastResetForTest();
      const a: RunStreamEvent[] = [];
      const b: RunStreamEvent[] = [];
      const unsubA = subscribeStreamEvents("ten-a", (e) => a.push(e));
      const unsubB = subscribeStreamEvents("ten-b", (e) => b.push(e));
      publishStreamEvent({
        type: "run.started",
        tenantId: "ten-b",
        at: 1,
        runId: "rid",
        agentName: "demo",
        triggerEvent: null,
        subject: null,
        correlationId: "cor",
      });
      expect(a).toHaveLength(0);
      expect(b).toHaveLength(1);
      unsubA();
      unsubB();
    });

    it("subscriber count drops to 0 after unsubscribe", () => {
      __broadcastResetForTest();
      const unsub = subscribeStreamEvents("ten-x", () => undefined);
      expect(__broadcastSubscriberCount("ten-x")).toBe(1);
      unsub();
      expect(__broadcastSubscriberCount("ten-x")).toBe(0);
    });

    it("RunStreamEvent zod schema parses every variant", () => {
      const variants: RunStreamEvent[] = [
        {
          type: "run.started",
          tenantId: "t",
          at: 1,
          runId: "r",
          agentName: "a",
          triggerEvent: "E",
          subject: null,
          correlationId: "c",
        },
        {
          type: "run.step.started",
          tenantId: "t",
          at: 1,
          runId: "r",
          stepId: "s",
          ord: 1,
          name: "step1",
          stepType: "tool",
        },
        {
          type: "run.step.completed",
          tenantId: "t",
          at: 1,
          runId: "r",
          stepId: "s",
          ord: 1,
          name: "step1",
          stepType: "logic",
          status: "ok",
          durationMs: 50,
          provider: "mock",
          model: "mock-model-v1",
          tokensIn: 10,
          tokensOut: 5,
          error: null,
        },
        {
          type: "run.completed",
          tenantId: "t",
          at: 1,
          runId: "r",
          durationMs: 100,
          tokensIn: 20,
          tokensOut: 10,
          emittedEventId: "evt-1",
        },
        {
          type: "run.failed",
          tenantId: "t",
          at: 1,
          runId: "r",
          errorMessage: "boom",
        },
        {
          type: "run.cancelled",
          tenantId: "t",
          at: 1,
          runId: "r",
          reason: "operator",
        },
        {
          type: "event.emitted",
          tenantId: "t",
          at: 1,
          eventId: "e",
          name: "X",
          subject: null,
          sourceRunId: "r",
        },
        {
          type: "task.created",
          tenantId: "t",
          at: 1,
          taskId: "tsk",
          runId: "r",
          taskType: "approve",
          title: "Title",
        },
        {
          type: "task.resolved",
          tenantId: "t",
          at: 1,
          taskId: "tsk",
          decision: "approve",
        },
        {
          type: "deployment.created",
          tenantId: "t",
          at: 1,
          deploymentId: "d",
          kind: "manifest",
          version: "1",
          workflowSlug: "wf",
        },
        {
          type: "log.line",
          tenantId: "t",
          at: 1,
          runId: "r",
          correlationId: "c",
          level: "INFO",
          event: "run.start",
          message: "started",
          fields: {},
        },
        {
          type: "audit.recorded",
          tenantId: "t",
          at: 1,
          auditId: "a",
          action: "run.cancel",
          actorUserId: null,
          targetType: "run",
          targetId: "r",
          decision: "allow",
        },
        {
          type: "llm.call.completed",
          tenantId: "t",
          at: 1,
          callId: "l",
          purpose: "agent:a",
          provider: "mock",
          requestedModel: "mock-model-v1",
          servedModel: "mock-model-v1",
          tokensIn: 1,
          tokensOut: 1,
          latencyMs: 1,
          fallback: false,
          ok: true,
          failureReason: null,
        },
        {
          type: "tool.call.completed",
          tenantId: "t",
          at: 1,
          runId: "r",
          correlationId: "c",
          agentName: "a",
          stepName: "s",
          toolName: "tool",
          durationMs: 1,
          ok: true,
          error: null,
        },
      ];
      for (const v of variants) {
        const parsed = RunStreamEventSchema.parse(v);
        expect(parsed.type).toBe(v.type);
      }
    });
  });

  describe("SSE endpoint (P1-API-01)", () => {
    async function listeningPort(): Promise<number> {
      const { build } = await import("../src/server");
      const app = await build();
      try {
        const addr = await app.listen({ port: 0, host: "127.0.0.1" });
        const match = /:(\d+)/.exec(addr);
        if (match) return Number(match[1]);
      } catch (error) {
        const address = app.server.address();
        if (address && typeof address !== "string") return address.port;
        throw error;
      }
      const address = app.server.address();
      if (address && typeof address !== "string") return address.port;
      throw new Error("API server has no listening port");
    }

    // Live-wire SSE smoke. The test harness uses `fastify.inject()` which
    // buffers the response and is therefore unsuitable for SSE. We bind a
    // real port, fetch with streaming Response.body, and assert frames
    // arrive within 1 second.
    //
    // The Fastify singleton in `harness.ts` is reused — calling
    // `app.listen()` on it once is safe because the harness never opens its
    // own port (it only uses inject). Closing the app at the end is
    // intentionally skipped: the singleton stays open for sibling tests.
    it("delivers a published event to a real SSE client within 1s", async () => {
      const port = await listeningPort();

      const ctrl = new AbortController();
      const res = await fetch(`http://127.0.0.1:${port}/v1/stream`, {
        signal: ctrl.signal,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      // Read until we see the run-stream-smoke runId or timeout.
      const readerDone = (async () => {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += decoder.decode(value);
          if (buf.includes("run-stream-smoke")) return;
        }
      })();

      // Wait briefly for the ready frame, then publish.
      await new Promise((r) => setTimeout(r, 50));
      publishStreamEvent({
        type: "run.started",
        tenantId: systemTenantId,
        at: Date.now(),
        runId: "run-stream-smoke",
        agentName: "tc-14",
        triggerEvent: "smoke",
        subject: null,
        correlationId: "cor-smoke",
      });

      await Promise.race([
        readerDone,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("sse timeout")), 1500),
        ),
      ]);

      expect(buf).toContain("event: ready");
      expect(buf).toContain("run-stream-smoke");
      expect(buf).toContain('"type":"run.started"');

      ctrl.abort();
      await reader.cancel().catch(() => undefined);
    }, 5_000);

    it("replays durable rows after Last-Event-ID without requiring an in-memory publish", async () => {
      const firstId = makeId("evt");
      const secondId = makeId("evt");
      const now = Date.now();
      getDb()
        .insert(events)
        .values([
          {
            id: firstId,
            tenantId: systemTenantId,
            name: "STREAM_DURABLE_FIRST",
            subject: "cursor",
            receivedAt: new Date(now - 10),
          },
          {
            id: secondId,
            tenantId: systemTenantId,
            name: "STREAM_DURABLE_SECOND",
            subject: "cursor",
            receivedAt: new Date(now),
          },
        ])
        .run();

      const port = await listeningPort();
      const ctrl = new AbortController();
      try {
        const res = await fetch(
          `http://127.0.0.1:${port}/v1/stream?backfill=2000`,
          {
            signal: ctrl.signal,
            headers: { "Last-Event-ID": `event:${firstId}` },
          },
        );
        expect(res.status).toBe(200);
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let body = "";
        await Promise.race([
          (async () => {
            while (!body.includes("event: ready")) {
              const { value, done } = await reader.read();
              if (done) break;
              body += decoder.decode(value, { stream: true });
            }
          })(),
          new Promise<void>((_, reject) =>
            setTimeout(() => reject(new Error("durable SSE timeout")), 2_000),
          ),
        ]);
        expect(body).toContain(secondId);
        expect(body).not.toContain(firstId);
        expect(body).toContain("STREAM_DURABLE_SECOND");
        await reader.cancel().catch(() => undefined);
      } finally {
        ctrl.abort();
        getDb().delete(events).where(eq(events.id, firstId)).run();
        getDb().delete(events).where(eq(events.id, secondId)).run();
      }
    }, 5_000);
  });
});
