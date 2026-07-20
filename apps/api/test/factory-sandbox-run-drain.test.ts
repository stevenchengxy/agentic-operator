import { beforeEach, describe, expect, it, vi } from "vitest";

const ledger = vi.hoisted(() => ({
  started: vi.fn(),
  verified: vi.fn(),
  failed: vi.fn(),
}));

vi.mock("../src/services/agent-factory/sandbox-lifecycle-store", () => ({
  markSandboxRunDrainStarted: ledger.started,
  markSandboxRunDrainVerified: ledger.verified,
  markSandboxRunDrainFailed: ledger.failed,
}));

import { drainSandboxRuns } from "../src/services/agent-factory/sandbox-run-drain";

const context = {
  tenantId: "ten-sandbox",
  tenantSlug: "af-sbx-11111111-22222222-333333333333-sb",
  appId: "factory-test-af-sbx-11111111-22222222-333333333333-sb",
  attemptId: "11111111-1111-4111-8111-111111111111",
  lease: {
    attemptId: "11111111-1111-4111-8111-111111111111",
    leaseOwner: "test-owner",
    leaseToken: "test-token",
    fenceGeneration: 1,
  },
};

function clock(start = 0) {
  let value = start;
  return {
    now: () => new Date(value),
    sleep: async (ms: number) => { value += ms; },
    value: () => value,
  };
}

describe("sandbox run drain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("signals an exact subject and waits for delayed independent terminal persistence", async () => {
    const time = clock();
    let polls = 0;
    const rows = [
      { id: "run-done", status: "ok", subject: "subject-done" },
      { id: "run-live", status: "running", subject: "subject-live" },
    ];
    const sent: Array<{ id: string; name: string; data: Record<string, unknown> }> = [];

    const receipt = await drainSandboxRuns(context, {
      listRuns: () => rows.map((row) => ({ ...row })),
      sendCancel: async (event) => { sent.push(event); },
      now: time.now,
      sleep: async (ms) => {
        await time.sleep(ms);
        polls += 1;
        if (polls === 2) rows[1]!.status = "cancelled";
      },
      timeoutMs: 30,
      pollMs: 5,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: `${context.tenantSlug}/run.cancel`,
      data: { runId: "run-live", subject: "subject-live", sandboxAttemptId: context.attemptId },
    });
    expect(receipt.observedRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: "run-done", finalStatus: "ok" }),
      expect.objectContaining({ runId: "run-live", finalStatus: "cancelled", cancelEventId: sent[0]!.id }),
    ]));
    expect(receipt.observedRuns.map((run) => JSON.stringify(run)).join(" ")).not.toContain("subject-live");
    expect(ledger.verified).toHaveBeenCalledWith(context.lease, receipt);
    expect(ledger.failed).not.toHaveBeenCalled();
  });

  it("fails closed on timeout without fabricating a terminal DB status", async () => {
    const time = clock();
    const row = { id: "run-stuck", status: "running", subject: "subject-stuck" };

    await expect(drainSandboxRuns(context, {
      listRuns: () => [{ ...row }],
      sendCancel: async () => undefined,
      now: time.now,
      sleep: time.sleep,
      timeoutMs: 10,
      pollMs: 5,
    })).rejects.toThrow(/did not reach terminal status/);

    expect(row.status).toBe("running");
    expect(ledger.verified).not.toHaveBeenCalled();
    expect(ledger.failed).toHaveBeenCalledWith(context.lease, expect.any(Error));
  });

  it("reuses the same cancel event id after a restart and verifies only after terminal readback", async () => {
    const time = clock();
    const row = { id: "run-restart", status: "running", subject: "subject-restart" };
    const eventIds: string[] = [];

    await expect(drainSandboxRuns(context, {
      listRuns: () => [{ ...row }],
      sendCancel: async (event) => { eventIds.push(event.id); },
      now: time.now,
      sleep: time.sleep,
      timeoutMs: 5,
      pollMs: 5,
    })).rejects.toThrow(/did not reach terminal status/);

    const receipt = await drainSandboxRuns(context, {
      listRuns: () => [{ ...row }],
      sendCancel: async (event) => { eventIds.push(event.id); },
      now: time.now,
      sleep: async (ms) => {
        await time.sleep(ms);
        row.status = "failed";
      },
      timeoutMs: 10,
      pollMs: 5,
    });

    expect(eventIds).toHaveLength(2);
    expect(eventIds[0]).toBe(eventIds[1]);
    expect(receipt.observedRuns[0]).toMatchObject({ runId: row.id, finalStatus: "failed" });
    expect(ledger.started).toHaveBeenCalledTimes(2);
    expect(ledger.failed).toHaveBeenCalledTimes(1);
    expect(ledger.verified).toHaveBeenCalledTimes(1);
  });
});
