import { SandboxLifecycleBlockedError } from "@agentic/agent-factory";

import {
  reapFactorySandboxOrphans,
  type SandboxReaperReport,
} from "./sandbox-deployer";
import {
  listOutstandingSandboxAttempts,
  sandboxAttemptError,
  type SandboxAttemptRecord,
} from "./sandbox-lifecycle-store";

export interface SandboxReaperLogger {
  info(message: string): void;
  warn(message: string): void;
}

export interface SandboxReconcileReport extends SandboxReaperReport {
  outstanding: number;
}

/**
 * Process-local evidence for the durable lifecycle-ledger reaper.
 *
 * `lastReaperAt` advances only after both the cleanup pass and the following
 * ledger read complete.  A timer tick that merely starts (or subsequently
 * throws) must not make health look fresh.
 */
export interface FactorySandboxReaperTelemetry {
  lastReaperAt: string | null;
  reaperFailure: string | null;
}

/** Health facts derived from durable rows, not from control-plane job state. */
export interface FactorySandboxOrphanStats {
  outstandingAttempts: number;
  cleanupFailures: number;
  oldestOrphanAgeMs: number | null;
}

let reaperTelemetry: FactorySandboxReaperTelemetry = {
  lastReaperAt: null,
  reaperFailure: null,
};

export function getFactorySandboxReaperTelemetry(): FactorySandboxReaperTelemetry {
  return { ...reaperTelemetry };
}

/**
 * Summarise rows already classified as outstanding by the lifecycle store.
 * A cleanup failure is intentionally narrower than a generic execution/job
 * failure: only the durable `cleanup_failed` state increments it.  Creation
 * time is used for orphan age so a retry/heartbeat cannot make an old orphan
 * appear young by updating the row.
 */
export function summarizeFactorySandboxOrphans(
  rows: ReadonlyArray<Pick<SandboxAttemptRecord, "status" | "createdAt">>,
  now: Date = new Date(),
): FactorySandboxOrphanStats {
  let oldestOrphanAgeMs: number | null = null;
  let cleanupFailures = 0;
  for (const row of rows) {
    if (row.status === "cleanup_failed") cleanupFailures += 1;
    const createdAt = row.createdAt instanceof Date
      ? row.createdAt.getTime()
      : Number.NaN;
    const age = Number.isFinite(createdAt)
      ? Math.max(0, now.getTime() - createdAt)
      : 0;
    oldestOrphanAgeMs = Math.max(oldestOrphanAgeMs ?? 0, age);
  }
  return {
    outstandingAttempts: rows.length,
    cleanupFailures,
    oldestOrphanAgeMs,
  };
}

let timer: ReturnType<typeof setInterval> | null = null;
let running: Promise<SandboxReconcileReport> | null = null;

function reaperIntervalMs(): number {
  const raw = process.env.FACTORY_SANDBOX_REAPER_MS?.trim();
  if (!raw) return 60_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("FACTORY_SANDBOX_REAPER_MS must be a positive integer");
  }
  return value;
}

function describeOutstanding(rows: ReturnType<typeof listOutstandingSandboxAttempts>): string[] {
  return rows
    .slice(0, 8)
    .map((row) => `${row.id} (${row.status}, app=${row.appId})`);
}

/**
 * Reconcile durable Agent Factory sandbox attempts.
 *
 * Startup is deliberately stricter than the periodic pass: after expired
 * attempts have been reaped, *any* non-terminal row keeps runtime bootstrap
 * closed. It may represent a still-live process or an ambiguous crash window;
 * either way, loading model directories or registering apps is unsafe until an
 * operator retries after the lease expires or verifies cleanup.
 */
export async function reconcileFactorySandboxOrphans(args: {
  startup?: boolean;
  now?: Date;
  logger?: SandboxReaperLogger;
} = {}): Promise<SandboxReconcileReport> {
  let reaped: SandboxReaperReport;
  let outstandingRows: ReturnType<typeof listOutstandingSandboxAttempts>;
  try {
    reaped = await reapFactorySandboxOrphans({ now: args.now });
    outstandingRows = listOutstandingSandboxAttempts();
  } catch (error) {
    reaperTelemetry = {
      ...reaperTelemetry,
      reaperFailure: sandboxAttemptError(error),
    };
    if (!args.startup) throw error;
    throw new SandboxLifecycleBlockedError({
      code: "sandbox_cleanup_failed",
      next: "ask_user",
      question:
        "服务无法读取 Agent Factory 的持久沙箱清理账本，因此没有继续加载或注册 App。请先应用数据库迁移 0047，并检查本地数据库可写性后重试。",
      missing: [`sandbox lifecycle ledger: ${sandboxAttemptError(error)}`],
    });
  }
  // This timestamp means a complete pass: reaping returned and the durable
  // ledger was readable afterward. Per-attempt cleanup failures are reported
  // separately and do not masquerade as a crashed/stale reaper.
  reaperTelemetry = {
    lastReaperAt: (args.now ?? new Date()).toISOString(),
    reaperFailure: null,
  };
  const report: SandboxReconcileReport = {
    ...reaped,
    outstanding: outstandingRows.length,
  };

  if (reaped.cleaned > 0) {
    args.logger?.info(
      `[factory-sandbox-reaper] cleaned ${reaped.cleaned}/${reaped.scanned} expired sandbox attempt(s)`,
    );
  }
  if (reaped.failed > 0) {
    args.logger?.warn(
      `[factory-sandbox-reaper] ${reaped.failed} sandbox cleanup attempt(s) remain unverified`,
    );
  }

  if (args.startup && (reaped.failed > 0 || outstandingRows.length > 0)) {
    const details = [
      ...reaped.failures.map(
        (failure) => `${failure.attemptId} (${failure.appId}): ${failure.error}`,
      ),
      ...describeOutstanding(outstandingRows),
    ].slice(0, 8);
    throw new SandboxLifecycleBlockedError({
      code: "sandbox_cleanup_failed",
      next: "ask_user",
      question:
        "启动时发现尚未确认清除的 Agent Factory 临时 Inngest App，所以服务没有继续加载或注册任何 App。请先确认专用测试 Inngest 的删除控制面和缺席回读可用；若另一进程仍在测试，请等它结束或等 lease 过期后再启动。",
      missing: details.length
        ? details
        : ["durable sandbox attempt is not cleanup_verified"],
    });
  }

  return report;
}

/** Start a singleton non-overlapping periodic orphan reaper. */
export function startFactorySandboxReaper(logger?: SandboxReaperLogger): void {
  if (timer) return;
  const intervalMs = reaperIntervalMs();
  timer = setInterval(() => {
    if (running) return;
    running = reconcileFactorySandboxOrphans({ logger })
      .catch((error) => {
        logger?.warn(
          `[factory-sandbox-reaper] periodic reconciliation failed: ${sandboxAttemptError(error)}`,
        );
        return {
          scanned: 0,
          cleaned: 0,
          failed: 1,
          failures: [],
          // The ledger query itself may be the failure; do not query it again
          // from the timer rejection handler and create an unhandled rejection.
          outstanding: -1,
        };
      })
      .finally(() => {
        running = null;
      });
  }, intervalMs);
  timer.unref?.();
}

export function stopFactorySandboxReaper(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
