import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  reapError: null as Error | null,
  outstanding: [] as Array<{
    id: string;
    status: string;
    appId: string;
    createdAt: Date;
  }>,
}));

vi.mock("../src/services/agent-factory/sandbox-deployer", () => ({
  reapFactorySandboxOrphans: vi.fn(async () => {
    if (state.reapError) throw state.reapError;
    return { scanned: 0, cleaned: 0, failed: 0, failures: [] };
  }),
}));

vi.mock("../src/services/agent-factory/sandbox-lifecycle-store", () => ({
  listOutstandingSandboxAttempts: vi.fn(() => [...state.outstanding]),
  sandboxAttemptError: (error: unknown) => String((error as Error)?.message ?? error),
}));

import {
  getFactorySandboxReaperTelemetry,
  reconcileFactorySandboxOrphans,
  summarizeFactorySandboxOrphans,
} from "../src/services/agent-factory/sandbox-reaper";

describe("sandbox durable reaper health evidence", () => {
  beforeEach(() => {
    state.reapError = null;
    state.outstanding = [];
  });

  it("counts only durable cleanup failures and preserves the true orphan age", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const stats = summarizeFactorySandboxOrphans([
      {
        status: "cleanup_pending",
        createdAt: new Date("2026-07-16T11:55:00.000Z"),
      },
      {
        status: "cleanup_failed",
        createdAt: new Date("2026-07-16T11:50:00.000Z"),
      },
      {
        // Outstanding/prepared is not the same thing as cleanup_failed.
        status: "prepared",
        createdAt: new Date("2026-07-16T11:40:00.000Z"),
      },
    ], now);

    expect(stats).toEqual({
      outstandingAttempts: 3,
      cleanupFailures: 1,
      oldestOrphanAgeMs: 20 * 60_000,
    });
  });

  it("advances lastReaperAt only after a complete durable pass", async () => {
    const completedAt = new Date("2026-07-16T12:05:00.000Z");
    await reconcileFactorySandboxOrphans({ now: completedAt });
    expect(getFactorySandboxReaperTelemetry()).toEqual({
      lastReaperAt: completedAt.toISOString(),
      reaperFailure: null,
    });

    state.reapError = new Error("durable ledger unavailable");
    await expect(reconcileFactorySandboxOrphans({
      now: new Date("2026-07-16T12:10:00.000Z"),
    })).rejects.toThrow("durable ledger unavailable");
    expect(getFactorySandboxReaperTelemetry()).toEqual({
      lastReaperAt: completedAt.toISOString(),
      reaperFailure: "durable ledger unavailable",
    });
  });
});
