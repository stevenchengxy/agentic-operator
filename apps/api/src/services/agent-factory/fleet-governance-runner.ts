// #P7-infra — 治理巡检服务(把 P7 纯核心 fleet-governance.ts 定时跑起来的基础设施层)。
//
// env 门控 + NODE_ENV=test 无 op + setInterval().unref() + 优雅收尾。定时对每个
// 租户的【已交付 function】聚合近 14 天生产战绩 → evaluateFleet 判定要返工的 → 幂等去重(防同一
// function×窗口重复开)→ 落盘成【待人签核】的决策(蓝图明示:开返工 run 前必须人签核,故这里只
// SURFACE,不自动开)。真正的返工 run 由用户在 UI 签核后触发(startRun)。
//
// 与既有【被动 fleet reflux】(services/agent-factory/index.ts)对齐:同一条 runs 表 14 天查询、同一
// 阈值(total≥3 && failed/total≥0.5、status∈{failed,error})——本模块是它的【主动版】:不只写 caveat
// 反思,而是产出结构化 ReworkDecision + 幂等键,供治理面板签核。

import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  evaluateFleet,
  dedupeReworkDecisions,
  evaluateGeneralPromotion,
  governanceSummary,
  type FunctionHealth,
  type ReworkDecision,
  type GovernancePolicy,
} from "@agentic/agent-factory";

/** Governance stats window (days). Shared with the passive fleet-reflux query in index.ts so the
 * active sweep and the passive reflux always aggregate the SAME horizon (the alignment this module's
 * header demands). AGENTIC_GOVERNANCE_WINDOW_DAYS overrides; default 14. */
export function governanceWindowDays(): number {
  const n = Number(process.env.AGENTIC_GOVERNANCE_WINDOW_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 14;
}
const noop = () => {};

function dataRoot(): string {
  const r = process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
  return path.isAbsolute(r) ? r : path.resolve(process.cwd(), r);
}
const govFile = (tenantSlug: string) =>
  path.join(
    dataRoot(),
    "governance",
    `${(tenantSlug || "_").replace(/[^a-zA-Z0-9._-]/g, "-")}.json`,
  );

/** 14 天窗口的 key(按 ISO 日期,与被动版 [生产回流:slug:日期] 的日粒度幂等对齐)。纯,可测。 */
export function windowKeyForDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** 已落盘的治理决策(待签核 + 幂等来源)。 */
export interface FsGovernanceStore {
  list(tenantSlug: string): Promise<ReworkDecision[]>;
  /** 追加 fresh 决策(按 idempotencyKey 去重);返回落盘后的全量。 */
  record(
    tenantSlug: string,
    fresh: ReworkDecision[],
  ): Promise<ReworkDecision[]>;
  openedKeys(tenantSlug: string): Promise<Set<string>>;
}

export const fsGovernanceStore: FsGovernanceStore = {
  async list(tenantSlug) {
    try {
      const parsed = JSON.parse(
        await fs.readFile(govFile(tenantSlug), "utf8"),
      ) as unknown;
      if (!Array.isArray(parsed))
        throw new Error(
          `invalid governance store for ${tenantSlug}: expected an array`,
        );
      return parsed as ReworkDecision[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  async record(tenantSlug, fresh) {
    const cur = await this.list(tenantSlug);
    const seen = new Set(cur.map((d) => d.idempotencyKey));
    const merged = [
      ...cur,
      ...fresh.filter((d) => !seen.has(d.idempotencyKey)),
    ];
    const f = govFile(tenantSlug);
    await fs.mkdir(path.dirname(f), { recursive: true });
    const temp = path.join(
      path.dirname(f),
      `.${path.basename(f)}.${process.pid}.${randomUUID()}.tmp`,
    );
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(merged, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(temp, f);
      const dirHandle = await fs.open(path.dirname(f), "r");
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } catch (error) {
      await fs.unlink(temp).catch(() => undefined);
      throw error;
    }
    return merged;
  },
  async openedKeys(tenantSlug) {
    return new Set((await this.list(tenantSlug)).map((d) => d.idempotencyKey));
  },
};

/** DB 适配器:聚合一个租户【已交付 function】近 14 天生产战绩 → FunctionHealth[]。
 *  复用被动 fleet reflux 的完全相同查询与口径(runs 表、status∈{failed,error})。 */
export async function aggregateFleetHealth(
  tenantSlug: string,
  windowKey: string,
): Promise<FunctionHealth[]> {
  const { getDb, tenants, workflows, agents, runs, eq } =
    await import("@agentic/db");
  const { and, gte, inArray } = await import("drizzle-orm");
  const db = getDb();
  const t = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!t) return [];
  const live: Array<{ id: string; kebabId: string }> = [];
  for (const wf of db
    .select()
    .from(workflows)
    .where(eq(workflows.tenantId, t.id))
    .all())
    for (const a of db
      .select()
      .from(agents)
      .where(eq(agents.workflowId, wf.id))
      .all())
      live.push({ id: a.id, kebabId: a.kebabId });
  if (!live.length) return [];
  const windowDays = governanceWindowDays();
  const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
  const stats = new Map<string, { total: number; failed: number }>();
  for (const r of db
    .select({ agentId: runs.agentId, status: runs.status })
    .from(runs)
    .where(
      and(
        eq(runs.tenantId, t.id),
        gte(runs.startedAt, since),
        inArray(
          runs.agentId,
          live.map((l) => l.id),
        ),
      ),
    )
    .all()) {
    const s = stats.get(r.agentId) ?? { total: 0, failed: 0 };
    s.total++;
    const st = String(r.status);
    if (st === "failed" || st === "error") s.failed++;
    stats.set(r.agentId, s);
  }
  return live.map((l) => {
    const s = stats.get(l.id) ?? { total: 0, failed: 0 };
    return {
      functionId: l.kebabId,
      domain: tenantSlug,
      windowDays,
      windowKey,
      total: s.total,
      failed: s.failed,
    };
  });
}

export interface GovernanceSweepResult {
  decisions: ReworkDecision[]; // fresh(去重后)需要人签核的
  summary: string;
  scannedFunctions: number;
  error?: string;
}

/** 一次治理巡检:聚合 → 判定 → 幂等去重 → 落盘待签核。DI(healthSource/store)便于测试。
 * Failures are returned explicitly and the scheduler logs them; an empty decision list is never
 * used to disguise an unavailable data source or broken persistence layer. */
export async function runGovernanceSweep(
  tenantSlug: string,
  opts: {
    now?: Date;
    policy?: GovernancePolicy;
    healthSource?: (
      tenantSlug: string,
      windowKey: string,
    ) => Promise<FunctionHealth[]>;
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
    return {
      decisions: fresh,
      summary: governanceSummary(fresh),
      scannedFunctions: healths.length,
    };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 240);
    return {
      decisions: [],
      summary: `治理巡检失败:${error}`,
      scannedFunctions: 0,
      error,
    };
  }
}

/** #SKILL-PROMOTE (P2) — 通用道晋升巡检：跨 ≥2 域各自验证有效的技能自动落一份 general 行
 * （domainKey=""，`DrizzleSkillStore.list` 早已把 general 行并入每个域的召回）。判定在纯核
 * `evaluateGeneralPromotion`（agent-factory 包）；本函数只做 I/O：查租户 → 拉全量技能行 →
 * 判定 → 用【无 expectedDomain 的 store】save({domain:null}) 落 general。晋升只复制已过
 * 安全门的赢家内容（不生成新文本），故自动写入可接受；FACTORY_SKILL_PROMOTION=0 关。 */
export async function runSkillPromotionSweep(
  tenantSlug: string,
): Promise<{ promoted: number; slugs: string[]; error?: string }> {
  if (process.env.FACTORY_SKILL_PROMOTION === "0") return { promoted: 0, slugs: [] };
  try {
    const [{ getDb, tenants, factorySkills, eq }, { DrizzleSkillStore }] = await Promise.all([
      import("@agentic/db"),
      import("./stores"),
    ]);
    const tenant = getDb().select().from(tenants).where(eq(tenants.slug, tenantSlug)).all()[0];
    if (!tenant) return { promoted: 0, slugs: [], error: `tenant ${tenantSlug} not found` };
    const rows = getDb()
      .select()
      .from(factorySkills)
      .where(eq(factorySkills.scopeKey, tenant.id))
      .all()
      .map((r) => ({
        slug: r.slug,
        domainKey: r.domainKey,
        name: r.name,
        purpose: r.purpose,
        promptFragment: r.promptFragment,
        tools: (r.tools as string[]) ?? [],
        decisionRule: r.decisionRule,
        useCount: r.useCount,
        evalCount: r.evalCount,
        successCount: r.successCount,
      }));
    const decisions = evaluateGeneralPromotion(rows);
    if (!decisions.length) return { promoted: 0, slugs: [] };
    // expectedDomain 留空：save 才会尊重 domain:null → domainKey ""（通用行）。
    const store = new DrizzleSkillStore(tenant.id);
    for (const d of decisions) {
      await store.save({ slug: d.slug, name: d.name, purpose: d.purpose, promptFragment: d.promptFragment, tools: d.tools, decisionRule: d.decisionRule, domain: null });
    }
    return { promoted: decisions.length, slugs: decisions.map((d) => d.slug) };
  } catch (e) {
    return { promoted: 0, slugs: [], error: String((e as Error)?.message ?? e).slice(0, 240) };
  }
}

let _active: { stop: () => void } | null = null;

/** Runtime truth for the API/UI.  Configuration alone does not mean the
 * scheduler actually started (tests, a failed bootstrap or a stopped server
 * may all leave AGENTIC_GOVERNANCE=1 with no live timer). */
export function governanceRunnerStatus(): {
  enabled: boolean;
  running: boolean;
} {
  return {
    enabled:
      process.env.AGENTIC_GOVERNANCE === "1" && process.env.NODE_ENV !== "test",
    running: _active !== null,
  };
}

/** 启动定时治理巡检(基础设施层)。gated:仅当 AGENTIC_GOVERNANCE=1 且非 test。timer.unref() 保证
 *  Ctrl-C 干净退出;返回 stop() 供 installGracefulShutdown 收尾。默认 6 小时一巡。 */
export async function startGovernanceRunner(opts: {
  tenantSlugs: () => string[];
  intervalMs?: number;
}): Promise<{ stop: () => void; running: boolean }> {
  if (process.env.NODE_ENV === "test") return { stop: noop, running: false };
  const enabledRaw = process.env.AGENTIC_GOVERNANCE?.trim() ?? "";
  if (enabledRaw && enabledRaw !== "0" && enabledRaw !== "1") {
    throw new Error("AGENTIC_GOVERNANCE must be 0 or 1");
  }
  if (enabledRaw !== "1") return { stop: noop, running: false };
  if (_active) return { stop: _active.stop, running: true };
  const rawInterval =
    opts.intervalMs ??
    Number(process.env.AGENTIC_GOVERNANCE_TICK_MS || 6 * 3600 * 1000);
  if (!Number.isSafeInteger(rawInterval) || rawInterval <= 0) {
    throw new Error("AGENTIC_GOVERNANCE_TICK_MS must be a positive integer");
  }
  const intervalMs = rawInterval;
  const tick = async () => {
    const failed: string[] = [];
    for (const slug of [...new Set(opts.tenantSlugs().filter(Boolean))]) {
      const r = await runGovernanceSweep(slug);
      if (r.error) {
        failed.push(slug);
        console.error(`[governance] ${slug}: sweep failed`);
      } else if (r.decisions.length) {
        console.warn(
          `[governance] ${slug}:${r.decisions.length} 个 function 建议返工(待人签核)——${r.summary}`,
        );
      }
      // #SKILL-PROMOTE — 附带的通用道晋升巡检（advisory：只是知识富集，失败不算治理巡检失败）。
      const promo = await runSkillPromotionSweep(slug);
      if (promo.error) console.error(`[governance] ${slug}: skill promotion sweep failed — ${promo.error}`);
      else if (promo.promoted) console.info(`[governance] ${slug}: 晋升 ${promo.promoted} 个跨域通用技能（${promo.slugs.join("、")}）`);
    }
    if (failed.length) {
      throw new Error(
        `governance sweep failed for tenant(s): ${failed.join(", ")}`,
      );
    }
  };
  // Configuration means a real supervision promise. Prove the DB + durable
  // governance store on the first pass before advertising the timer as live.
  await tick();
  let ticking = false;
  const timer = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void tick()
      .catch(() => console.error("[governance] scheduled sweep failed"))
      .finally(() => {
        ticking = false;
      });
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  const stop = () => {
    clearInterval(timer);
    _active = null;
  };
  _active = { stop };
  console.info(
    `[governance] 治理巡检已启动 — 每 ${Math.round(intervalMs / 3600000)}h 一巡(AGENTIC_GOVERNANCE=1)。`,
  );
  return { stop, running: true };
}

export function stopGovernanceRunner(): void {
  _active?.stop();
}
