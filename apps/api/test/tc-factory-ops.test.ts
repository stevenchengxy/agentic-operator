/**
 * TC — factory ops-sidebar backend primitives:
 *   1. HITL mailbox contract: push → peek (non-consuming) → drain (consuming), and the
 *      queue cap drops OLDEST first (the user's latest intervention is authoritative).
 *   2. Report-job registry: tenant-scoped listing + lookup isolation.
 */

import { describe, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  ackHumanMessages,
  disposeMailbox,
  drainHumanMessages,
  enqueueHumanMessage,
  nackHumanMessages,
  peekHumanMessages,
  pushHumanMessage,
} from "../src/services/agent-factory/mailbox";
import { listReportJobs, getReportJob } from "../src/services/agent-factory/report-jobs";

describe("TC factory-ops: mailbox", () => {
  it("push → peek does not consume; drain leases in order and explicit ack empties", () => {
    const conv = `t-mb-${Math.random().toString(36).slice(2)}`;
    pushHumanMessage(conv, "第一条补充");
    pushHumanMessage(conv, "  第二条补充  "); // exact payload whitespace is data
    const peek = peekHumanMessages(conv);
    expect(peek.pending).toBe(2);
    expect(peek.oldestTs).toBeTypeOf("number");
    expect(peekHumanMessages(conv).pending).toBe(2); // peek is non-consuming
    const drained = drainHumanMessages(conv);
    expect(drained.map((message) => message.text)).toEqual([
      "第一条补充",
      "  第二条补充  ",
    ]);
    expect(drained.every((message) => Number.isFinite(message.receivedAt))).toBe(true);
    expect(new Set(drained.map((message) => message.deliveryId)).size).toBe(1);
    expect(peekHumanMessages(conv).pending).toBe(2); // leased is still pending until durable checkpoint ack
    expect(ackHumanMessages(conv, drained[0]!.deliveryId)).toBe(true);
    expect(peekHumanMessages(conv)).toEqual({ pending: 0, oldestTs: null });
    disposeMailbox(conv);
  });

  it("persists one exact interaction identity and refuses a duplicate before consumption", () => {
    const conv = `t-mb-hitl-${Math.random().toString(36).slice(2)}`;
    const interactionId = "hitl_33333333-3333-4333-8333-333333333333";
    expect(enqueueHumanMessage(conv, "[澄清回答] A", undefined, "usr", {
      interactionId,
      gateKind: "clarify",
    })).toBe("queued");
    expect(enqueueHumanMessage(conv, "[澄清回答] B", undefined, "usr", {
      interactionId,
      gateKind: "clarify",
    })).toBe("duplicate_interaction");
    expect(drainHumanMessages(conv)).toEqual([
      expect.objectContaining({
        text: "[澄清回答] A",
        actor: "usr",
        interactionId,
        gateKind: "clarify",
      }),
    ]);
    disposeMailbox(conv);
  });

  it("persists queued intervention before acknowledgement and keeps an at-least-once drain lease", async () => {
    const conv = `t-mb-durable-${Math.random().toString(36).slice(2)}`;
    pushHumanMessage(conv, "必须持久化的人工决定");
    const rootRaw = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
    const root = path.isAbsolute(rootRaw) ? rootRaw : path.resolve(process.cwd(), rootRaw);
    const file = path.join(root, "factory-mailboxes", "unscoped", `${createHash("sha256").update(conv).digest("hex")}.json`);
    const queued = JSON.parse(await fs.readFile(file, "utf8")) as { msgs: Array<{ text: string }>; inflight?: unknown };
    expect(queued.msgs.map((message) => message.text)).toEqual(["必须持久化的人工决定"]);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    expect(drainHumanMessages(conv).map((message) => message.text)).toEqual([
      "必须持久化的人工决定",
    ]);
    const leased = JSON.parse(await fs.readFile(file, "utf8")) as { msgs: unknown[]; inflight?: { msgs: Array<{ text: string }> } };
    expect(leased.msgs).toEqual([]);
    expect(leased.inflight?.msgs.map((message) => message.text)).toEqual(["必须持久化的人工决定"]);
    expect(peekHumanMessages(conv).pending).toBe(1);
    const deliveryId = leased.inflight && (leased.inflight as { deliveryId?: string }).deliveryId;
    expect(deliveryId).toBeTypeOf("string");
    expect(ackHumanMessages(conv, deliveryId!)).toBe(true);
    expect(peekHumanMessages(conv).pending).toBe(0);
    disposeMailbox(conv);
    await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores empty conversation ids and blank messages", () => {
    pushHumanMessage("", "text");
    const conv = `t-mb-${Math.random().toString(36).slice(2)}`;
    pushHumanMessage(conv, "   ");
    expect(peekHumanMessages(conv).pending).toBe(0);
  });

  it("caps the queue at 200, dropping the OLDEST messages", () => {
    const conv = `t-mb-${Math.random().toString(36).slice(2)}`;
    for (let i = 0; i < 205; i++) pushHumanMessage(conv, `msg-${i}`);
    const drained = drainHumanMessages(conv);
    expect(drained).toHaveLength(200);
    expect(drained[0]?.text).toBe("msg-5"); // 0..4 dropped
    expect(drained[199]?.text).toBe("msg-204"); // newest kept
    disposeMailbox(conv);
  });

  it("redelivers an unacked lease after a same-process consumer crash and rejects stale ack ids", () => {
    const conv = `t-mb-crash-${Math.random().toString(36).slice(2)}`;
    pushHumanMessage(conv, "取出后、检查点前崩溃也不能丢");
    const first = drainHumanMessages(conv);
    expect(first).toHaveLength(1);

    // Simulate a conductor dying immediately after drain: no ack/nack is issued.
    const retry = drainHumanMessages(conv);
    expect(retry).toEqual(first);
    expect(peekHumanMessages(conv).pending).toBe(1);
    expect(ackHumanMessages(conv, "stale-delivery-id")).toBe(false);
    expect(drainHumanMessages(conv)).toEqual(first);

    expect(ackHumanMessages(conv, first[0]!.deliveryId)).toBe(true);
    expect(ackHumanMessages(conv, first[0]!.deliveryId)).toBe(true); // idempotent retry
    expect(drainHumanMessages(conv)).toEqual([]);
    disposeMailbox(conv);
  });

  it("nack returns the exact batch ahead of messages that arrived while it was inflight", () => {
    const conv = `t-mb-nack-${Math.random().toString(36).slice(2)}`;
    pushHumanMessage(conv, "leased-first");
    const leased = drainHumanMessages(conv);
    pushHumanMessage(conv, "arrived-later");

    expect(nackHumanMessages(conv, leased[0]!.deliveryId)).toBe(true);
    const retried = drainHumanMessages(conv);
    expect(retried.map((message) => message.text)).toEqual(["leased-first", "arrived-later"]);
    expect(retried[0]!.deliveryId).not.toBe(leased[0]!.deliveryId);
    expect(ackHumanMessages(conv, retried[0]!.deliveryId)).toBe(true);
    disposeMailbox(conv);
  });

  it("preserves the delivery id when a new API process recovers an inflight lease", async () => {
    const conv = `t-mb-restart-${Math.random().toString(36).slice(2)}`;
    pushHumanMessage(conv, "跨进程恢复也不能重复分配身份");
    const first = drainHumanMessages(conv);

    vi.resetModules();
    const restartedMailbox = await import("../src/services/agent-factory/mailbox");
    const recovered = restartedMailbox.drainHumanMessages(conv);
    expect(recovered).toEqual(first);
    expect(restartedMailbox.ackHumanMessages(conv, first[0]!.deliveryId)).toBe(true);
    restartedMailbox.disposeMailbox(conv);
  });
});

describe("TC factory-ops: report-job registry", () => {
  it("listing is tenant-scoped and lookup refuses cross-tenant reads", () => {
    // No jobs were started in this test process — listing any tenant is empty, and a
    // lookup with a mismatched tenant must be null even for a bogus id.
    expect(listReportJobs("ten-nope")).toEqual([]);
    expect(getReportJob("rpt-nope")).toBeNull();
    expect(getReportJob("rpt-nope", "ten-nope")).toBeNull();
  });
});
