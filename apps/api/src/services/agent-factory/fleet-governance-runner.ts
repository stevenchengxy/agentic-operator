// #P7-infra — 治理巡检服务(把 P7 纯核心 fleet-governance.ts 定时跑起来的基础设施层)。
//
// 形态对标 demo-runner:env 门控 + NODE_ENV=test 无 op + setInterval().unref() + 优雅收尾。定时对每个
// 租户的【已交付 function】聚合近 14 天生产战绩 → evaluateFleet 判定要返工的 → 幂等去重(防同一
// function×窗口重复开)→ 落盘成【待人签核】的决策(蓝图明示:开返工 run 前必须人签核,故这里只
// SURFACE,不自动开)。真正的返工 run 由用户在 UI 签核后触发(startRun)。
//
// 与既有【被动 fleet reflux】(services/agent-factory/index.ts)对齐:同一条 runs 表 14 天查询、同一
// 阈值(total≥3 && failed/total≥0.5、status∈{failed,error})——本模块是它的【主动版】:不只写 caveat
// 反思,而是产出结构化 ReworkDecision + 幂等键,供治理面板签核。

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  evaluateFleet,
  dedupeReworkDecisions,
  governanceSummary,
  type FunctionHealth,
  type ReworkDecision,
  type GovernancePolicy,
} from "@agentic/agent-factory";

const WINDOW_DAYS = 14;
const noop = () => {};

function dataRoot(): string {
  const r = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.isAbsolute(r) ? r : path.resolve(process.cwd(), r);
}
const govFile = (tenantSlug: string) => path.join(dataRoot(), "governance", `${(tenantSlug || "_").replace(/[^a-zA-Z0-9._-]/g, "-")}.json`);

/** 14 天窗口的 key(按 ISO 日期,与被动版 [生产回流:slug:日期] 的日粒度幂等对齐)。纯,可测。 */
export function windowKeyForDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 已落盘的治理决策(待签核 + 幂等来源)。 */
export interface FsGovernanceStore {
  list(tenantSlug: string): Promise<ReworkDecision[]>;
  /** 追加 fresh 决策(按 idempotencyKey 去重);返回落盘后的全量。 */
  record(tenantSlug: string, fresh: ReworkDecision[]): Promise<ReworkDecision[]>;
  openedKeys(tenantSlug: string): Promise<Set<string>>;
}

export const fsGovernanceStore: FsGovernanceStore = {
  async list(tenantSlug) {
    try {
      return JSON.parse(await fs.readFile(govFile(tenantSlug), "utf8")) as ReworkDecision[];
    } catch {
      return [];
    }
  },
  async record(tenantSlug, fresh) {
    const cur = await this.list(tenantSlug);
    const seen = new Set(cur.map((d) => d.idempotencyKey));
    const merged = [...cur, ...fresh.filter((d) => !seen.has(d.idempotencyKey))];
    const f = govFile(tenantSlug);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, JSON.stringify(merged, null, 2), "utf8");
    return merged;
  },
  async openedKeys(tenantSlug) {
    return new Set((await this.list(tenantSlug)).map((d) => d.idempotencyKey));
  },
};

/** DB 适配器:聚合一个租户【已交付 function】近 14 天生产战绩 → FunctionHealth[]。
 *  复用被动 fleet reflux 的完全相同查询与口径(runs 表、status∈{failed,error})。 */
export async function aggregateFleetHealth(tenantSlug: string, windowKey: string): Promise<FunctionHealth[]> {
  const { getDb, tenants, workflows, agents, runs, eq } = await import("@agentic/db");
  const { and, gte, inArray } = await import("drizzle-orm");
  const db = getDb();
  const t = db.select().from(tenants).where(eq(tenants.slug, tenantSlug)).all()[0];
  if (!t) return [];
  const live: Array<{ id: string; kebabId: string }> = [];
  for (const wf of db.select().from(workflows).where(eq(workflows.tenantId, t.id)).all())
    for (const a of db.select().from(agents).where(eq(agents.workflowId, wf.id)).all()) live.push({ id: a.id, kebabId: a.kebabId });
  if (!live.length) return [];
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  const stats = new Map<string, { total: number; failed: number }>();
  for (const r of db
    .select({ agentId: runs.agentId, status: runs.status })
    .from(runs)
    .where(and(eq(runs.tenantId, t.id), gte(runs.startedAt, since), inArray(runs.agentId, live.map((l) => l.id))))
    .all()) {
    const s = stats.get(r.agentId) ?? { total: 0, failed: 0 };
    s.total++;
    const st = String(r.status);
    if (st === "failed" || st === "error") s.failed++;
    stats.set(r.agentId, s);
  }
  return live.map((l) => {
    const s = stats.get(l.id) ?? { total: 0, failed: 0 };
    return { functionId: l.kebabId, domain: tenantSlug, windowDays: WINDOW_DAYS, windowKey, total: s.total, failed: s.failed };
  });
}

export interface GovernanceSweepResult {
  decisions: ReworkDecision[]; // fresh(去重后)需要人签核的
  summary: string;
  scannedFunctions: number;
}

/** 一次治理巡检:聚合 → 判定 → 幂等去重 → 落盘待签核。DI(healthSource/store)便于测试。never throws。 */
export async function runGovernanceSweep(
  tenantSlug: string,
  opts: {
    now?: Date;
    policy?: GovernancePolicy;
    healthSource?: (tenantSlug: string, windowKey: string) => Promise<FunctionHealth[]>;
    store?: FsGovernanceStore;
  } = {},
): Promise<GovernanceSweepResult> {
  const store = opts.store ?? fsGovernanceStore;
  const source = opts.healthSource ?? aggregateFleetHealth;
  const windowKey = windowKeyForDate(opts.now ?? new Date());
  try {
    const healths = await source(tenantSlug, windowKey);
    const decisions = evaluateFleet(healths, opts.policy);
    const alreadyOpened = await store.openedKeys(tenantSlug);
    const fresh = dedupeReworkDecisions(decisions, alreadyOpened);
    if (fresh.length) await store.record(tenantSlug, fresh);
    return { decisions: fresh, summary: governanceSummary(fresh), scannedFunctions: healths.length };
  } catch (e) {
    return { decisions: [], summary: `治理巡检失败:${String((e as Error)?.message ?? e).slice(0, 120)}`, scannedFunctions: 0 };
  }
}

let _active: { stop: () => void } | null = null;

/** 启动定时治理巡检(基础设施层)。gated:仅当 AGENTIC_GOVERNANCE=1 且非 test。timer.unref() 保证
 *  Ctrl-C 干净退出;返回 stop() 供 installGracefulShutdown 收尾。默认 6 小时一巡。 */
export function startGovernanceRunner(opts: { tenantSlugs: () => string[]; intervalMs?: number }): { stop: () => void; running: boolean } {
  if (process.env.NODE_ENV === "test") return { stop: noop, running: false };
  if (process.env.AGENTIC_GOVERNANCE !== "1") return { stop: noop, running: false };
  if (_active) return { stop: _active.stop, running: true };
  const intervalMs = opts.intervalMs ?? (Number(process.env.AGENTIC_GOVERNANCE_TICK_MS) || 6 * 3600 * 1000);
  const tick = async () => {
    for (const slug of opts.tenantSlugs()) {
      const r = await runGovernanceSweep(slug);
      if (r.decisions.length) {
        try { console.warn(`[governance] ${slug}:${r.decisions.length} 个 function 建议返工(待人签核)——${r.summary}`); } catch { /* best-effort */ }
      }
    }
  };
  void tick(); // 启动即巡检一次
  const timer = setInterval(() => void tick(), intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  const stop = () => { clearInterval(timer); _active = null; };
  _active = { stop };
  try { console.info(`[governance] 治理巡检已启动 — 每 ${Math.round(intervalMs / 3600000)}h 一巡(AGENTIC_GOVERNANCE=1)。`); } catch { /* best-effort */ }
  return { stop, running: true };
}

export function stopGovernanceRunner(): void {
  _active?.stop();
}
