import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  report: {
    scanned: 0,
    cleaned: 0,
    failed: 0,
    failures: [] as Array<{ attemptId: string; appId: string; error: string }>,
  },
  outstanding: [] as any[],
  reapCalls: 0,
  reapError: null as Error | null,
}));

vi.mock("../src/services/agent-factory/sandbox-deployer", () => ({
  reapFactorySandboxOrphans: vi.fn(async () => {
    state.reapCalls += 1;
    if (state.reapError) throw state.reapError;
    return { ...state.report, failures: [...state.report.failures] };
  }),
}));

vi.mock("../src/services/agent-factory/sandbox-lifecycle-store", () => ({
  listOutstandingSandboxAttempts: vi.fn(() => [...state.outstanding]),
  sandboxAttemptError: (error: unknown) => String((error as Error)?.message ?? error),
}));

import {
  reconcileFactorySandboxOrphans,
  startFactorySandboxReaper,
  stopFactorySandboxReaper,
} from "../src/services/agent-factory/sandbox-reaper";

function outstandingAttempt() {
  return {
    id: "sba-live",
    status: "active",
    appId: "factory-test-af-sbx-live",
  };
}

describe("Agent Factory startup and periodic sandbox reaper", () => {
  beforeEach(() => {
    stopFactorySandboxReaper();
    state.report = { scanned: 0, cleaned: 0, failed: 0, failures: [] };
    state.outstanding = [];
    state.reapCalls = 0;
    state.reapError = null;
    process.env.FACTORY_SANDBOX_REAPER_MS = "25";
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("external network is forbidden in this test");
    }));
  });

  afterEach(() => {
    stopFactorySandboxReaper();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("completes startup only when every durable attempt is terminal", async () => {
    state.report = { scanned: 1, cleaned: 1, failed: 0, failures: [] };
    await expect(reconcileFactorySandboxOrphans({ startup: true }))
      .resolves.toMatchObject({ cleaned: 1, outstanding: 0 });
    expect(state.reapCalls).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails startup closed with a natural ask_user block for an unexpired attempt", async () => {
    state.outstanding = [outstandingAttempt()];
    await expect(reconcileFactorySandboxOrphans({ startup: true })).rejects.toMatchObject({
      block: {
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        missing: [expect.stringContaining("sba-live")],
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails startup closed when strict deletion or absence readback failed", async () => {
    state.report = {
      scanned: 1,
      cleaned: 0,
      failed: 1,
      failures: [{ attemptId: "sba-failed", appId: "factory-test-failed", error: "absence unknown" }],
    };
    await expect(reconcileFactorySandboxOrphans({ startup: true })).rejects.toMatchObject({
      block: {
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        missing: [expect.stringContaining("absence unknown")],
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("turns an unreadable/missing ledger into a natural startup ask_user block", async () => {
    state.reapError = new Error("no such table: factory_sandbox_attempts");
    await expect(reconcileFactorySandboxOrphans({ startup: true })).rejects.toMatchObject({
      block: {
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        question: expect.stringContaining("0047"),
        missing: [expect.stringContaining("factory_sandbox_attempts")],
      },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs a singleton periodic reconciliation and can be stopped", async () => {
    vi.useFakeTimers();
    startFactorySandboxReaper();
    startFactorySandboxReaper();
    await vi.advanceTimersByTimeAsync(25);
    expect(state.reapCalls).toBe(1);
    stopFactorySandboxReaper();
    await vi.advanceTimersByTimeAsync(100);
    expect(state.reapCalls).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
