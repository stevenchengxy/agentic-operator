import { createHash } from "node:crypto";

import type { SandboxRunDrainReceipt } from "@agentic/agent-factory";
import {
  SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
  sandboxRunDrainReceiptHash,
} from "@agentic/agent-factory";
import { eq, getDb, runs } from "@agentic/db";
import { getTenantInngest, tenantEventName } from "@agentic/runtime";

import {
  markSandboxRunDrainFailed,
  markSandboxRunDrainStarted,
  markSandboxRunDrainVerified,
} from "./sandbox-lifecycle-store";
import type { SandboxLeaseFence } from "./sandbox-lifecycle-store";

export interface SandboxRunDrainContext {
  tenantId: string;
  tenantSlug: string;
  appId: string;
  attemptId: string;
  lease: SandboxLeaseFence;
}

export interface SandboxRunRow {
  id: string;
  status: string;
  subject: string | null;
}

export interface SandboxRunDrainDependencies {
  listRuns?: () => SandboxRunRow[];
  sendCancel?: (event: {
    id: string;
    name: string;
    data: Record<string, unknown>;
  }) => Promise<void>;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollMs?: number;
}

const TERMINAL = new Set(["ok", "failed", "cancelled"]);

function positiveMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function subjectHash(subject: string | null): string {
  return `sha256:${createHash("sha256")
    .update(subject === null ? "<null-subject>" : subject, "utf8")
    .digest("hex")}`;
}

function cancelEventId(attemptId: string, runId: string): string {
  const digest = createHash("sha256")
    .update(attemptId)
    .update("\0")
    .update(runId)
    .digest("hex")
    .slice(0, 32);
  return `af-sbx-cancel-${digest}`;
}

/**
 * Close the dispatch gate first, signal every active run by its exact persisted
 * subject, then wait for an independent runtime/executor update to a terminal
 * DB status. This function never writes `runs.status` itself: broker acceptance
 * is not proof that the function has stopped.
 */
export async function drainSandboxRuns(
  ctx: SandboxRunDrainContext,
  dependencies: SandboxRunDrainDependencies = {},
): Promise<SandboxRunDrainReceipt> {
  const now = dependencies.now ?? (() => new Date());
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = dependencies.timeoutMs ?? positiveMs(
    "FACTORY_SANDBOX_RUN_DRAIN_TIMEOUT_MS",
    process.env.NODE_ENV === "test" ? 150 : 15_000,
  );
  const pollMs = dependencies.pollMs ?? positiveMs(
    "FACTORY_SANDBOX_RUN_DRAIN_POLL_MS",
    process.env.NODE_ENV === "test" ? 10 : 250,
  );
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("sandbox run-drain timeout must be positive");
  if (!Number.isSafeInteger(pollMs) || pollMs <= 0 || pollMs > timeoutMs) {
    throw new Error("sandbox run-drain poll interval must be positive and no greater than timeout");
  }
  const listRuns = dependencies.listRuns ?? (() => getDb()
    .select({ id: runs.id, status: runs.status, subject: runs.subject })
    .from(runs)
    .where(eq(runs.tenantId, ctx.tenantId))
    .all());
  const sendCancel = dependencies.sendCancel ?? (async (event) => {
    await getTenantInngest(ctx.tenantSlug).send(event as never);
  });

  const startedAt = now();
  markSandboxRunDrainStarted(ctx.lease, startedAt);
  const deadline = startedAt.getTime() + timeoutMs;
  const initial = new Map<string, SandboxRunRow>();
  const signals = new Map<string, { eventId: string; acceptedAt: string }>();
  const signalErrors = new Map<string, string>();

  try {
    while (true) {
      const rows = listRuns();
      const currentIds = new Set(rows.map((row) => row.id));
      const disappeared = [...initial.keys()].filter((id) => !currentIds.has(id));
      if (disappeared.length) {
        throw new Error(`sandbox run rows disappeared before terminal proof: ${disappeared.join(", ")}`);
      }
      for (const row of rows) if (!initial.has(row.id)) initial.set(row.id, { ...row });

      const active = rows.filter((row) => !TERMINAL.has(row.status));
      for (const row of active) {
        if (signals.has(row.id)) continue;
        if (!row.subject?.trim()) {
          signalErrors.set(row.id, "persisted run subject is missing; cancelOn cannot target this execution safely");
          continue;
        }
        const eventId = cancelEventId(ctx.attemptId, row.id);
        try {
          await sendCancel({
            id: eventId,
            name: tenantEventName(ctx.tenantSlug, "run.cancel"),
            data: {
              runId: row.id,
              subject: row.subject,
              cancelledBy: "agent-factory-cleanup",
              previousStatus: row.status,
              sandboxAttemptId: ctx.attemptId,
              appId: ctx.appId,
            },
          });
          signals.set(row.id, { eventId, acceptedAt: now().toISOString() });
          signalErrors.delete(row.id);
        } catch (error) {
          signalErrors.set(row.id, String((error as Error)?.message ?? error).slice(0, 240));
        }
      }

      if (active.length === 0) {
        const completedAt = now();
        const observedRuns = rows
          .map((row) => {
            if (!TERMINAL.has(row.status)) throw new Error(`run ${row.id} is not terminal`);
            const first = initial.get(row.id)!;
            const signal = signals.get(row.id);
            return {
              runId: row.id,
              initialStatus: first.status,
              finalStatus: row.status as "ok" | "failed" | "cancelled",
              subjectHash: subjectHash(first.subject),
              ...(signal ? { cancelEventId: signal.eventId, cancelAcceptedAt: signal.acceptedAt } : {}),
            };
          })
          .sort((a, b) => a.runId.localeCompare(b.runId));
        const body: Omit<SandboxRunDrainReceipt, "evidenceHash"> = {
          schema: SANDBOX_RUN_DRAIN_RECEIPT_SCHEMA,
          sandboxAttemptId: ctx.attemptId,
          appId: ctx.appId,
          sandboxTenantSlug: ctx.tenantSlug,
          startedAt: startedAt.toISOString(),
          completedAt: completedAt.toISOString(),
          observedRuns,
        };
        const receipt: SandboxRunDrainReceipt = {
          ...body,
          evidenceHash: sandboxRunDrainReceiptHash(body),
        };
        markSandboxRunDrainVerified(ctx.lease, receipt);
        return receipt;
      }

      if (now().getTime() >= deadline) {
        const details = active.map((row) =>
          `${row.id}:${row.status}${signalErrors.get(row.id) ? ` (${signalErrors.get(row.id)})` : ""}`,
        );
        throw new Error(`sandbox runs did not reach terminal status before timeout: ${details.join(", ")}`);
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - now().getTime())));
    }
  } catch (error) {
    try {
      markSandboxRunDrainFailed(ctx.lease, error);
    } catch {
      // The original drain failure remains the operator-facing cause.
    }
    throw error;
  }
}
