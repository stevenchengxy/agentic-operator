// In-process background-run registry — migrated from the OLD repo's
// lib/agent-factory-v3/brain/run-registry.ts.
//
// Decouples the autonomous brain from the SSE request lifecycle: the conductor runs
// in a DETACHED driver here, so navigating away (closing the EventSource) no longer
// aborts it — the run keeps going server-side and a later reconnect re-attaches to the
// live stream. A stop button aborts it explicitly. The transcript mirrors to
// factory_runs every few seconds, so a reconnect after eviction/restart replays from
// the durable row. Limitation (accepted): in-process, so an api restart ends in-flight
// runs (the durable row keeps `running` → the UI offers 继续 via the conversation checkpoint).

import { runBrain, type BrainEvent } from "@agentic/agent-factory";
import { makeId } from "@agentic/shared";
import { makeFactoryPorts, recordRunStart, recordRunFinish, recordRunTranscript, getRun, markRunAborted, listRunningRuns } from "./index";

export type RunStatus = "running" | "done" | "error" | "aborted" | "failed";
type Frame = BrainEvent | { t: "run.started"; runId: string };
type Subscriber = (e: Frame) => void;

interface ActiveRun {
  runId: string;
  domain: string;
  goal: string;
  tenantSlug?: string; // scopes uploaded-ontology resolution to the run's tenant
  events: BrainEvent[];
  subscribers: Set<Subscriber>;
  status: RunStatus;
  abort: AbortController;
  tokensUsed: number;
  turns: number;
  agentsCount: number;
  reachedTerminal: boolean;
  errorMessage: string | null;
  sawDone: boolean;
  sawSandbox: boolean;
  evictTimer?: ReturnType<typeof setTimeout>;
}

const runsReg = new Map<string, ActiveRun>();
const EVICT_AFTER_MS = 10 * 60_000;
// #5/#6: the persisted transcript the activity log + AI reviewer read. Raised + configurable so a
// long run's narrative (incl. the sandbox/done outcome) isn't lost; when exceeded we keep the most
// RECENT events (the outcome) rather than dropping new ones.
// #P0-6 — raised 30k→100k (configurable) so long factory runs keep far more of their reasoning before
// any fold; and on overflow we DON'T silently drop — we fold deterministically (a marker event records
// how many early events were compacted), so the audit trail shows the gap instead of vanishing.
const MAX_BUFFER = Number(process.env.FACTORY_RUN_BUFFER_MAX) || 100_000;

export function isActiveRun(runId: string): boolean {
  const r = runsReg.get(runId);
  return !!r && r.status === "running";
}
export function hasRun(runId: string): boolean {
  return runsReg.has(runId);
}

function emit(r: ActiveRun, e0: BrainEvent): void {
  // #OBSERVABILITY — stamp a REAL server-side wall-clock ts on every event at the single emit choke
  // point, so the UI can render true per-phase / per-agent durations (Workflow-panel style) for BOTH
  // live AND replayed runs (client arrival time would cluster on reconnect). Idempotent: never
  // re-stamp an event that already carries ts. Cast: the strict BrainEvent union has no ts member; the
  // web side reads it as an optional field (BrainEvent = {t;[k]:unknown}).
  const e: BrainEvent = (e0 as { ts?: number }).ts != null ? e0 : ({ ...(e0 as Record<string, unknown>), ts: Date.now() } as unknown as BrainEvent);
  // Keep the most recent MAX_BUFFER events (drop oldest if over) so the run OUTCOME — the tail:
  // sandbox result + done — is never lost on a very long run (the old `< MAX` guard dropped the
  // tail, hiding exactly what the reviewer needs).
  r.events.push(e);
  if (r.events.length > MAX_BUFFER) {
    // #P0-6 — deterministic fold: instead of silently dropping the oldest events, remove them but
    // leave a single marker so a reviewer sees "N early events were compacted" rather than a gap that
    // reads as if nothing happened. The fold is idempotent (a prior marker's count is rolled forward).
    const overflow = r.events.length - MAX_BUFFER;
    const dropped = r.events.splice(0, overflow);
    const priorFold = dropped.find((d) => (d as { t?: string }).t === "reflect" && String((d as { kind?: string }).kind) === "buffer-fold");
    const priorCount = priorFold ? Number((priorFold as { count?: number }).count ?? 0) : 0;
    r.events.unshift({ t: "reflect", kind: "buffer-fold", lesson: `已折叠 ${priorCount + overflow} 条早期事件（超出 ${MAX_BUFFER} 缓冲上限）`, count: priorCount + overflow }); // #W1-15 typed (count is on the reflect member now)
  }
  for (const cb of r.subscribers) {
    try {
      cb(e);
    } catch {
      /* a dead subscriber never blocks the run */
    }
  }
}

/** Subscribe: immediately REPLAY run.started + buffered events (late joiner sees the
 *  whole story), then stream live. Returns unsub, or null if the run isn't registered
 *  (caller falls back to the durable factory_runs transcript). */
export function subscribeRun(runId: string, cb: Subscriber): null | (() => void) {
  const r = runsReg.get(runId);
  if (!r) return null;
  cb({ t: "run.started", runId });
  for (const e of r.events) cb(e);
  if (r.status !== "running") return () => {};
  r.subscribers.add(cb);
  return () => {
    r.subscribers.delete(cb);
  };
}

/** Abort a run (the stop button) — signals the conductor, which breaks at the next
 *  turn boundary and runs its cleanup (sandbox teardown etc.). */
export function abortRun(runId: string): boolean {
  const r = runsReg.get(runId);
  if (!r || r.status !== "running") return false;
  r.status = "aborted";
  try {
    r.abort.abort();
  } catch {
    /* already aborted */
  }
  emit(r, { t: "message", text: "⏹ 已请求停止——大脑会在当前步骤后收尾，已生成的内容都保留。" });
  return true;
}

/** Start (or return the already-active) background run. IDEMPOTENT: a second
 *  connection with the same runId attaches to the SAME run. The driver is detached. */
export function startRun(opts: { domain: string; goal: string; tenantId?: string; tenantSlug?: string; conversationId?: string; runId?: string }): ActiveRun {
  const runId = opts.runId ?? opts.conversationId ?? makeId("frn");
  const existing = runsReg.get(runId);
  // Only RE-ATTACH to a still-RUNNING run (a reconnect). If the run under this id is
  // FINISHED, this is a NEW turn in the same conversation — start a fresh run (it resumes
  // the conversation context via conversationId). Returning the finished run instead made
  // subscribeRun REPLAY its buffered answer and silently drop the new message — the
  // "re-greet / 0-turn / 0-token" bug. (runId == conversationId here by design.)
  if (existing && existing.status === "running") return existing;
  recordRunStart(opts.domain, opts.goal, opts.tenantId, runId);
  const r: ActiveRun = {
    runId,
    domain: opts.domain,
    goal: opts.goal,
    tenantSlug: opts.tenantSlug,
    events: [],
    subscribers: new Set(),
    status: "running",
    abort: new AbortController(),
    tokensUsed: 0,
    turns: 0,
    agentsCount: 0,
    reachedTerminal: false,
    errorMessage: null,
    sawDone: false,
    sawSandbox: false,
  };
  runsReg.set(runId, r);
  void drive(r, opts.conversationId ?? runId);
  return r;
}

async function drive(r: ActiveRun, conversationId: string): Promise<void> {
  const seenAgents = new Set<string>();
  // #AUDIT-FIX(M21) — transcript 周期镜像（每 5s，.unref 不挡退出）：崩溃时 factory_runs 行
  // 不再只有上一次交互的旧转录（"实时镜像"的注释承诺此前是假的）。
  const mirror = setInterval(() => {
    try {
      if (r.status === "running") recordRunTranscript(r.runId, r.events.slice(0, MAX_BUFFER));
    } catch { /* mirror is best-effort */ }
  }, 5000);
  (mirror as unknown as { unref?: () => void }).unref?.();
  try {
    const ports = makeFactoryPorts(r.tenantSlug);
    for await (const ev of runBrain({ domain: r.domain, goal: r.goal, ports, signal: r.abort.signal, conversationId })) {
      if (ev.t === "agent.created") seenAgents.add((ev.spec as { slug: string }).slug);
      else if (ev.t === "sandbox") { r.sawSandbox = true; r.reachedTerminal = ev.fullChainRan ?? false; }
      else if (ev.t === "done") {
        r.sawDone = true;
        r.turns = ev.turns;
        r.tokensUsed = ev.tokensUsed;
        // Honest terminal status: errored→error; finished→done; an info/chat/Q&A turn
        // (0 agents, no sandbox) is a SUCCESSFUL answer, not a failed generation→done;
        // otherwise (had agents / ran sandbox but didn't cleanly finish)→failed.
        if (r.status === "running") {
          if (ev.status === "errored") r.status = "error";
          else if (ev.status === "finished") r.status = "done";
          else if (r.agentsCount === 0 && !r.sawSandbox) r.status = "done";
          else r.status = "failed";
        }
      } else if (ev.t === "error") {
        if (r.status === "running") r.status = "error";
        r.errorMessage = ev.message;
      }
      r.agentsCount = seenAgents.size;
      emit(r, ev);
    }
    if (r.status === "running") r.status = "done";
  } catch (e) {
    if (r.status === "running") r.status = r.abort.signal.aborted ? "aborted" : "error";
    r.errorMessage = (e as Error).message;
    if (!r.abort.signal.aborted) emit(r, { t: "error", message: (e as Error).message });
  } finally {
    clearInterval(mirror); // #AUDIT-FIX(M21)
    // Guarantee a terminal `done` so any subscriber unblocks even on abort/crash.
    if (!r.sawDone) {
      emit(r, { t: "done", tokensUsed: r.tokensUsed, turns: r.turns, status: r.status === "aborted" ? "incomplete" : r.status === "error" ? "errored" : "incomplete" });
    }
    recordRunFinish(r.runId, {
      status: r.status === "running" ? "done" : r.status,
      tokensUsed: r.tokensUsed,
      turns: r.turns,
      agentsCount: r.agentsCount,
      reachedTerminal: r.reachedTerminal,
      errorMessage: r.errorMessage ?? undefined,
      transcript: r.events.slice(0, MAX_BUFFER),
    });
    if (r.evictTimer) clearTimeout(r.evictTimer);
    r.evictTimer = setTimeout(() => {
      if (runsReg.get(r.runId) === r) runsReg.delete(r.runId);
    }, EVICT_AFTER_MS);
  }
}

/** Replay a finalized/orphaned run from the durable factory_runs row (reconnect after
 *  eviction or restart). Returns the saved transcript so the client replays. `deleted` lets
 *  the reconnect path show a tombstone instead of silently replaying a soft-deleted run. */
export function readDurableRun(runId: string, tenantId?: string): { status: string; transcript: BrainEvent[]; deleted: boolean } | null {
  const row = getRun(runId, tenantId);
  if (!row) return null;
  return { status: row.status, transcript: (row.transcript as BrainEvent[]) ?? [], deleted: !!row.deletedAt };
}

const ORPHAN_REASON = "运行中断（服务器重启/进程丢失，无活跃驱动）";

/** /stop fallback: when abortRun finds no live driver, the run is ORPHANED — an api/HMR
 *  restart wiped the in-process registry but left the durable row 'running'. Flip that
 *  row to 'aborted' so the stuck "运行中" the user can't otherwise stop actually clears.
 *  Returns true iff a running row was changed. */
export function forceFinalizeAborted(runId: string): boolean {
  if (!runId) return false;
  return markRunAborted(runId, ORPHAN_REASON);
}

/** Zombie sweep: durable rows still 'running' but with NO live driver (isActiveRun) and
 *  past a short grace window → mark aborted. A genuinely-live run is in the registry and
 *  is therefore never swept. Called before listing runs so stuck "运行中" history rows
 *  auto-clear. Returns how many were swept. */
export function sweepZombieRuns(domain: string | null, tenantId?: string): number {
  const now = Date.now();
  let swept = 0;
  for (const row of listRunningRuns(domain, tenantId)) {
    if (!isActiveRun(row.id) && now - row.createdAt > 120_000) {
      if (markRunAborted(row.id, ORPHAN_REASON)) swept++;
    }
  }
  return swept;
}

// #SCALE-RESUME — crash-safety without moving the brain onto Inngest: on api boot, every factory_runs
// row stuck "running" (the process died mid-run) is AUTO-RESUMED via its conversation checkpoint —
// serializeCtx persisted the full ctx (specs/plan/parked HITL gates included), so the brain picks up
// where it crashed instead of leaving a zombie for the user to manually 继续. Opt out: FACTORY_AUTORESUME=0.
export function autoResumeCrashedRuns(): number {
  if (process.env.FACTORY_AUTORESUME === "0") return 0;
  const { getDb, factoryRuns, tenants, eq, and } = require("@agentic/db") as typeof import("@agentic/db");
  const { isNull } = require("drizzle-orm") as typeof import("drizzle-orm");
  let resumed = 0;
  try {
    // #AUDIT-FIX(H8) — join tenants 取回 slug：无 slug 恢复的 run 拿到未限定 ports（上传本体层
    // 为空、report/fleet 缺失），行为与原 run 静默不同。
    const rows = getDb()
      .select({ id: factoryRuns.id, domain: factoryRuns.domain, goal: factoryRuns.goal, tenantId: factoryRuns.tenantId, tenantSlug: tenants.slug, createdAt: factoryRuns.createdAt })
      .from(factoryRuns)
      .leftJoin(tenants, eq(tenants.id, factoryRuns.tenantId))
      .where(and(eq(factoryRuns.status, "running"), isNull(factoryRuns.deletedAt)))
      .all();
    // #AUDIT-FIX(M23) — 年龄上限 + 单次启动恢复数上限：老僵尸行标记 aborted 而不是无限重跑；
    // 一次 boot 最多恢复 3 个（其余标记，防止重启风暴挤爆进程）。
    const MAX_AGE_MS = Math.max(3600_000, Number(process.env.FACTORY_AUTORESUME_MAX_AGE_MS) || 24 * 3600_000);
    const MAX_RESUME = Math.max(1, Number(process.env.FACTORY_AUTORESUME_MAX) || 3);
    for (const r of rows) {
      if (isActiveRun(r.id)) continue; // already live in this process
      const age = Date.now() - new Date(r.createdAt as unknown as string | number | Date).getTime();
      if (Number.isFinite(age) && age > MAX_AGE_MS) {
        try { markRunAborted(r.id, `中断超过 ${Math.round(MAX_AGE_MS / 3600_000)}h 未恢复——按放弃处理（可从历史运行重新发起）`); } catch { /* best-effort */ }
        continue;
      }
      if (resumed >= MAX_RESUME) {
        try { markRunAborted(r.id, "本次启动恢复名额已满——按中断处理（可从历史运行重新发起）"); } catch { /* best-effort */ }
        continue;
      }
      try {
        // #AUDIT-FIX(L28) — 哨兵目标：conductor 识别 "[恢复继续]" 前缀后跳过意图门/policy/目标追加，
        // 避免同一请求被登记两次意图、注入错误路线。
        startRun({ domain: r.domain, goal: `[恢复继续] 进程重启后自动续跑：从状态摘要与最近上下文接续先前任务，不要重复已完成的步骤。`, tenantId: r.tenantId ?? undefined, tenantSlug: (r as { tenantSlug?: string | null }).tenantSlug ?? undefined, conversationId: r.id, runId: r.id });
        resumed += 1;
      } catch { /* one bad row never blocks the rest */ }
    }
    if (resumed) console.log(`[factory] crash-resume — re-attached ${resumed} interrupted run(s) from their conversation checkpoints`);
  } catch { /* boot resume best-effort */ }
  return resumed;
}
