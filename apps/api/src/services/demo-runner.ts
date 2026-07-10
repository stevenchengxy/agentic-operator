/**
 * Demo-runner — periodic synthetic-traffic generator for `AGENTIC_DEMO_MODE`.
 *
 * Architectural rule (locked 2026-05-26): production mode = ZERO mock data,
 * demo mode = seed + loop. This module IS "the loop" — once started it
 * fires plausible events at random tenants on a configurable cadence so
 * the dashboard isn't a static snapshot. Stop it cleanly on shutdown.
 *
 * Cadence (env-overridable; defaults shipped):
 *   • Every `AGENTIC_DEMO_TICK_MS` (default 30_000 ms)
 *       → publish one random event on a random tenant w/ deployed workflow
 *   • Every `AGENTIC_DEMO_TASK_RESOLVE_MS` (default 90_000 ms)
 *       → resolve one open HITL task with a random approve/reject
 *   • Every `AGENTIC_DEMO_HEARTBEAT_MS` (default 300_000 ms ≡ 5 min)
 *       → log `[demo-runner] tick — N events fired, K tasks resolved`
 *
 * Safety:
 *   • No-op when `AGENTIC_DEMO_MODE !== true` (defense in depth — refuses
 *     even if accidentally imported and started by another module).
 *   • No-op when `NODE_ENV === "test"` (prevents vitest from seeing
 *     background traffic that would flake row-count assertions).
 *   • Every tick is wrapped in try/catch so a single failure (DB
 *     contention, no tenants yet, missing event types) NEVER crashes
 *     the api — the failure is logged and the loop continues.
 *   • Backpressure: when ≥ `AGENTIC_DEMO_RUN_BACKPRESSURE` (default 25)
 *     runs are in flight for the picked tenant, the tick skips so demo
 *     traffic doesn't snowball in a slow dev env.
 *   • SIGTERM-clean: integrated into Fastify's `onClose` chain via
 *     `apps/api/src/bootstrap.ts` so `installGracefulShutdown` stops the
 *     interval before `process.exit` runs.
 *
 * The runner uses the in-process Inngest client + DB helpers directly
 * rather than re-entering its own HTTP surface — same wire format as
 * `POST /v1/events`, no localhost round-trip, no header juggling.
 */

import { and, eq, sql, inArray } from "drizzle-orm";
import {
  agents as agentsTable,
  deployments as deploymentsTable,
  events as eventsTable,
  eventTypes as eventTypesTable,
  getDb,
  runs as runsTable,
  tasks as tasksTable,
  tenants as tenantsTable,
  workflows as workflowsTable,
} from "@agentic/db";
import { appendToLedger, getTenantInngest } from "@agentic/runtime";
import { makeId } from "@agentic/shared";
import { isDemoMode } from "../config/demo-mode.js";

interface DemoRunnerLogger {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

interface DemoRunnerState {
  eventsFired: number;
  tasksResolved: number;
  ticksSkipped: number;
  errors: number;
}

interface ActiveRunner {
  stop: () => void;
  /** Exposed for tests; the demo-runner reports cumulative counts. */
  state: DemoRunnerState;
}

const TRUTHY = new Set(["true", "1", "yes"]);
function envBool(name: string): boolean {
  const v = process.env[name];
  return v ? TRUTHY.has(v.toLowerCase().trim()) : false;
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const SUBJECT_PREFIX = "REQ-DEMO";

function randomHex(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) {
    s += Math.floor(Math.random() * 16).toString(16);
  }
  return s.toUpperCase();
}

function pick<T>(arr: readonly T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Tenants that have at least one live deployment AND at least one declared
 * event type. Demo traffic for tenants in either gap would just become
 * "unhandled event" noise.
 */
async function listTenantsWithLiveWorkflows(): Promise<
  Array<{ id: string; slug: string }>
> {
  const db = getDb();
  // Pull all non-archived tenants up front, then filter by JOIN existence.
  const rows = db
    .select({
      id: tenantsTable.id,
      slug: tenantsTable.slug,
    })
    .from(tenantsTable)
    .innerJoin(workflowsTable, eq(workflowsTable.tenantId, tenantsTable.id))
    .innerJoin(
      deploymentsTable,
      and(
        eq(deploymentsTable.tenantId, tenantsTable.id),
        eq(deploymentsTable.status, "live"),
      ),
    )
    .all();
  // Dedup by slug (multiple deployments per tenant inflate the join).
  const seen = new Set<string>();
  const out: Array<{ id: string; slug: string }> = [];
  for (const r of rows) {
    if (seen.has(r.slug)) continue;
    seen.add(r.slug);
    out.push({ id: r.id, slug: r.slug });
  }
  return out;
}

/** All event-type names declared for the tenant. */
function listEventTypeNames(tenantId: string): string[] {
  const db = getDb();
  return db
    .select({ name: eventTypesTable.name })
    .from(eventTypesTable)
    .where(eq(eventTypesTable.tenantId, tenantId))
    .all()
    .map((r) => r.name);
}

/** Count currently active runs for the tenant (running / queued / waiting). */
function countActiveRuns(tenantId: string): number {
  const db = getDb();
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(runsTable)
    .where(
      and(
        eq(runsTable.tenantId, tenantId),
        inArray(runsTable.status, ["running", "queued", "waiting"]),
      ),
    )
    .all()[0];
  return Number(row?.c ?? 0);
}

/**
 * Publish one synthetic event for the tenant. Mirrors the relevant chunks
 * of `POST /v1/events` in `apps/api/src/routes/v1/events.ts` — append to
 * the per-tenant NDJSON ledger, insert the events row, fan out via Inngest.
 * Returns the new event id, or null if nothing eligible to publish.
 */
async function tickPublishEvent(
  log: DemoRunnerLogger,
  backpressure: number,
): Promise<string | null> {
  const liveTenants = await listTenantsWithLiveWorkflows();
  const tenant = pick(liveTenants);
  if (!tenant) {
    log.warn("[demo-runner] no tenants with live workflows; skipping tick");
    return null;
  }
  const eventNames = listEventTypeNames(tenant.id);
  const eventName = pick(eventNames);
  if (!eventName) {
    log.warn(
      `[demo-runner] tenant ${tenant.slug} has no declared event types; skipping tick`,
    );
    return null;
  }
  const active = countActiveRuns(tenant.id);
  if (active >= backpressure) {
    return null;
  }

  const subject = `${SUBJECT_PREFIX}-${randomHex(4)}`;
  const eventId = makeId("evt");

  const payloadRef = await appendToLedger(tenant.slug, {
    id: eventId,
    name: eventName,
    subject,
    data: { __demo: true, generatedAt: Date.now() },
    ts: Date.now(),
  });

  const db = getDb();
  const catalogRow = db
    .select({ category: eventTypesTable.category })
    .from(eventTypesTable)
    .where(
      and(
        eq(eventTypesTable.tenantId, tenant.id),
        eq(eventTypesTable.name, eventName),
      ),
    )
    .all()[0];
  db.insert(eventsTable)
    .values({
      id: eventId,
      tenantId: tenant.id,
      name: eventName,
      category: catalogRow?.category ?? null,
      subject,
      payloadRef,
    })
    .run();

  const namespaced = `${tenant.slug}/${eventName}` as `${string}/${string}`;
  await getTenantInngest(tenant.slug).send({
    name: namespaced,
    data: {
      __demo: true,
      __triggerEventId: eventId,
      subject,
      generatedAt: Date.now(),
    },
  });

  return eventId;
}

/**
 * Resolve one open HITL task with a random approve/reject decision. Mirrors
 * the resolve path in `apps/api/src/routes/v1/tasks.ts` — flip the row +
 * emit `task.resolved` so any `step.waitForEvent` upstream wakes.
 */
async function tickResolveTask(log: DemoRunnerLogger): Promise<string | null> {
  const db = getDb();
  const openRows = db
    .select({
      id: tasksTable.id,
      tenantId: tasksTable.tenantId,
      tenantSlug: tenantsTable.slug,
    })
    .from(tasksTable)
    .innerJoin(tenantsTable, eq(tenantsTable.id, tasksTable.tenantId))
    .where(eq(tasksTable.status, "open"))
    .limit(50)
    .all();
  const target = pick(openRows);
  if (!target) {
    return null;
  }
  const decision: "approve" | "reject" = Math.random() < 0.7 ? "approve" : "reject";

  db.update(tasksTable)
    .set({
      status: "resolved",
      resolvedAt: new Date(),
      resolutionJson: { decision, by: "demo-runner" } as never,
    })
    .where(eq(tasksTable.id, target.id))
    .run();

  try {
    await getTenantInngest(target.tenantSlug).send({
      name: `${target.tenantSlug}/task.resolved` as `${string}/${string}`,
      data: {
        taskId: target.id,
        tenantId: target.tenantId,
        decision,
        payload: { __demo: true },
      },
    });
  } catch (err) {
    log.warn(`[demo-runner] task.resolved emit failed: ${String(err)}`);
  }

  return `${target.id}=${decision}`;
}

let _activeRunner: ActiveRunner | null = null;

/**
 * Boot-time entry. Returns immediately when not in demo mode; otherwise
 * spins up the interval timers and returns a stop() function the
 * shutdown plugin can wire into Fastify's `onClose`.
 *
 * Idempotent: a second call while the runner is already active returns
 * the existing handle.
 */
export function startDemoRunner(
  logger: DemoRunnerLogger,
): { stop: () => void; running: boolean } {
  if (process.env.NODE_ENV === "test") {
    return { stop: noop, running: false };
  }
  if (!isDemoMode()) {
    return { stop: noop, running: false };
  }
  if (_activeRunner) {
    return { stop: _activeRunner.stop, running: true };
  }

  const tickMs = envInt("AGENTIC_DEMO_TICK_MS", 30_000);
  const taskResolveMs = envInt("AGENTIC_DEMO_TASK_RESOLVE_MS", 90_000);
  const heartbeatMs = envInt("AGENTIC_DEMO_HEARTBEAT_MS", 300_000);
  const backpressure = envInt("AGENTIC_DEMO_RUN_BACKPRESSURE", 25);
  const synchronousFirstTick = envBool("AGENTIC_DEMO_SYNC_FIRST_TICK");

  const state: DemoRunnerState = {
    eventsFired: 0,
    tasksResolved: 0,
    ticksSkipped: 0,
    errors: 0,
  };

  logger.info(
    `[demo-runner] starting — eventTick=${tickMs}ms, taskResolveTick=${taskResolveMs}ms, heartbeat=${heartbeatMs}ms, backpressure=${backpressure}`,
  );

  const eventTimer = setInterval(() => {
    void tickPublishEvent(logger, backpressure)
      .then((id) => {
        if (id) state.eventsFired += 1;
        else state.ticksSkipped += 1;
      })
      .catch((err) => {
        state.errors += 1;
        logger.error(`[demo-runner] event tick failed: ${String(err)}`);
      });
  }, tickMs);
  // Don't keep the event loop alive solely for this interval — clean Ctrl-C.
  eventTimer.unref?.();

  const taskTimer = setInterval(() => {
    void tickResolveTask(logger)
      .then((id) => {
        if (id) state.tasksResolved += 1;
      })
      .catch((err) => {
        state.errors += 1;
        logger.error(`[demo-runner] task tick failed: ${String(err)}`);
      });
  }, taskResolveMs);
  taskTimer.unref?.();

  const heartbeatTimer = setInterval(() => {
    logger.info(
      `[demo-runner] tick — ${state.eventsFired} events fired, ${state.tasksResolved} tasks resolved, ${state.ticksSkipped} ticks skipped, ${state.errors} errors`,
    );
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  // Optionally fire one event immediately so test/E2E suites don't have to
  // wait `tickMs` for the first signal.
  if (synchronousFirstTick) {
    void tickPublishEvent(logger, backpressure)
      .then((id) => {
        if (id) state.eventsFired += 1;
      })
      .catch(() => {
        // already logged inside tickPublishEvent on the path that matters
      });
  }

  const stop = () => {
    clearInterval(eventTimer);
    clearInterval(taskTimer);
    clearInterval(heartbeatTimer);
    if (_activeRunner) {
      logger.info(
        `[demo-runner] stopped — totals: ${state.eventsFired} events, ${state.tasksResolved} tasks, ${state.errors} errors`,
      );
    }
    _activeRunner = null;
  };

  _activeRunner = { stop, state };
  return { stop, running: true };
}

/** Test-only accessor — returns null when not running. */
export function _getDemoRunnerForTests(): ActiveRunner | null {
  return _activeRunner;
}

/**
 * Stop the active demo-runner if one is up; no-op otherwise. Used by:
 *   - Fastify `onClose` hook (graceful shutdown drain).
 *   - `POST /v1/demo/stop` (UI toggle off).
 *
 * Returns true if a runner was actually stopped, false if no runner was
 * active. Safe to call from anywhere — no exceptions thrown.
 */
export function stopDemoRunner(): boolean {
  if (!_activeRunner) return false;
  _activeRunner.stop();
  return true;
}

/** Is the demo-runner currently active? */
export function isDemoRunnerActive(): boolean {
  return _activeRunner !== null;
}

/** Snapshot of demo-runner counters; null when not running. */
export function getDemoRunnerStats(): DemoRunnerState | null {
  return _activeRunner ? { ..._activeRunner.state } : null;
}

function noop(): void {
  /* intentional */
}
