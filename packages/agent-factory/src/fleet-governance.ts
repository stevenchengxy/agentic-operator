// #P7 治理闭环纯核心（融合蓝图 §08「生产回归从责任工位重入」）。
//
// 论据：工厂交付的业务 function 上线后会跑出成败遥测。治理闭环要把「生产证据」变成
// 工厂的重入信号——定时聚合各 function 的失败率 + 保真回归 + 安全发现，越过阈值就（经
// 人签核）重开一次「返工 run」，把生产事故预置成阻塞缺陷，让 function 从它当初的责任
// 工位重新入厂修根因，而不是换提示词糊过去。
//
// 既有被动版在 apps/api/src/services/agent-factory/index.ts 的 fleet.list 里：聚合近 14 天
// 失败率（total≥3 && failed/total≥0.5），对反复翻车的 agent 落一条当日 caveat 反思——但
// 「从不重开 run」。本模块是「主动版」的纯逻辑内核：只做判定，产出确定性的 ReworkDecision，
// 由调用层（apps/api 的 cron 服务）拿去开返工 run。聚合口径与被动版对齐（minRuns=3、
// failRate≥0.5、失败=failed|error），并新增 fidelity_regression / security 两路触发。
//
// 硬约束：纯函数、零副作用、无 Date.now/Math.random/无 I/O——同输入逐字节同输出、可单测。
// 「当前窗口标识」由调用方按日期/窗口生成后经 FunctionHealth.windowKey 传入（本文件内绝不
// 生成时间），幂等键据此而成，防 cron 重放/重叠 tick 对同一 (function, 窗口) 双开返工。

export interface FunctionHealth {
  /** 交付 function 的 id/slug。 */
  functionId: string;
  /** 归属业务域（可选，仅用于展示/回查）。 */
  domain?: string;
  /** 统计窗口天数（仅用于人读 reason；口径本身由调用方聚合时决定）。 */
  windowDays: number;
  /**
   * 当前统计窗口的稳定标识，由调用方按日期/窗口生成（如 "2026-07-10" 或 "2026-W28"）。
   * 纯函数内绝不用 Date.now() 生成时间——windowKey 一律外部传入，幂等键据此而成，保证
   * 同一 (functionId, 窗口) 只触发一次返工。
   */
  windowKey: string;
  /** 窗口内运行总次数。 */
  total: number;
  /** 窗口内失败次数（调用方按 status ∈ {failed, error} 聚合，与被动版一致）。 */
  failed: number;
  /** 窗口内保真回归次数（可选，缺省视作 0）。 */
  fidelityRegressions?: number;
  /** 窗口内新增安全发现数（可选，缺省视作 0）。 */
  newSecurityFindings?: number;
}

/** 越阈值的信号类别——哪些生产证据把 function 拉回工厂。 */
export type ReworkTrigger = "failure_rate" | "fidelity_regression" | "security";

export interface ReworkDecision {
  functionId: string;
  shouldRework: boolean;
  /** 哪些信号越阈值（按 failure_rate → fidelity_regression → security 的稳定顺序）。 */
  triggers: ReworkTrigger[];
  /** 失败率 = failed/total（total=0 时为 0）。 */
  failureRate: number;
  /** 人可读的判定说明（中文，供 UI/日志/签核卡）。 */
  reason: string;
  /** 幂等键：同一 (functionId, window) 只触发一次，防 cron 重放/重叠 tick 双开。 */
  idempotencyKey: string;
  /** 供签核排序：security 或 failureRate≥0.8 → high，否则 medium。 */
  severity: "high" | "medium";
}

export interface GovernancePolicy {
  /** 触发 failure_rate 所需的最小运行样本量（默认 3）。 */
  minRuns?: number;
  /** 触发 failure_rate 的失败率阈值（默认 0.5）。 */
  failRateThreshold?: number;
  /** 触发 fidelity_regression 的回归次数阈值（默认 1）。 */
  fidelityRegressionThreshold?: number;
}

const DEFAULT_MIN_RUNS = 3;
const DEFAULT_FAIL_RATE_THRESHOLD = 0.5;
const DEFAULT_FIDELITY_REGRESSION_THRESHOLD = 1;
/** 失败率越过此线即判高危（与阈值判定解耦，纯排序用）。 */
const HIGH_SEVERITY_FAIL_RATE = 0.8;

const TRIGGER_ZH: Record<ReworkTrigger, string> = {
  failure_rate: "失败率",
  fidelity_regression: "保真回归",
  security: "安全",
};

/**
 * 判定单个交付 function 是否需要返工重入工厂。纯函数、确定性。
 * - 失败率 = failed/total（total=0 → 0）。
 * - failure_rate 触发：total≥minRuns 且 failureRate≥failRateThreshold。
 * - fidelity_regression 触发：fidelityRegressions≥fidelityRegressionThreshold。
 * - security 触发：newSecurityFindings>0。
 * - shouldRework = 任一触发；severity：security 或 failureRate≥0.8 → high，否则 medium。
 * - idempotencyKey = `rework:${functionId}:${windowKey}`，windowKey 由调用方传入。
 */
export function evaluateFunctionHealth(h: FunctionHealth, policy?: GovernancePolicy): ReworkDecision {
  const minRuns = policy?.minRuns ?? DEFAULT_MIN_RUNS;
  const failRateThreshold = policy?.failRateThreshold ?? DEFAULT_FAIL_RATE_THRESHOLD;
  const fidelityRegressionThreshold = policy?.fidelityRegressionThreshold ?? DEFAULT_FIDELITY_REGRESSION_THRESHOLD;

  const total = h.total;
  const failed = h.failed;
  const fidelityRegressions = h.fidelityRegressions ?? 0;
  const newSecurityFindings = h.newSecurityFindings ?? 0;
  const failureRate = total > 0 ? failed / total : 0;

  const triggers: ReworkTrigger[] = [];
  if (total >= minRuns && failureRate >= failRateThreshold) triggers.push("failure_rate");
  if (fidelityRegressions >= fidelityRegressionThreshold) triggers.push("fidelity_regression");
  if (newSecurityFindings > 0) triggers.push("security");

  const shouldRework = triggers.length > 0;
  const severity: "high" | "medium" =
    triggers.includes("security") || failureRate >= HIGH_SEVERITY_FAIL_RATE ? "high" : "medium";

  const pct = Math.round(failureRate * 100);
  const signals: string[] = [];
  if (triggers.includes("failure_rate"))
    signals.push(`失败率 ${pct}%（${failed}/${total}，阈值 ${Math.round(failRateThreshold * 100)}%、样本≥${minRuns}）`);
  if (triggers.includes("fidelity_regression"))
    signals.push(`保真回归 ${fidelityRegressions} 次（阈值 ${fidelityRegressionThreshold}）`);
  if (triggers.includes("security")) signals.push(`新增安全发现 ${newSecurityFindings} 项`);

  const reason = shouldRework
    ? `「${h.functionId}」需返工重入工厂（${severity === "high" ? "高危" : "中危"}）：${signals.join("；")}。`
    : `「${h.functionId}」生产健康达标：失败率 ${pct}%（${failed}/${total}，近 ${h.windowDays} 天），无需返工。`;

  return {
    functionId: h.functionId,
    shouldRework,
    triggers,
    failureRate,
    reason,
    idempotencyKey: `rework:${h.functionId}:${h.windowKey}`,
    severity,
  };
}

function severityRank(s: "high" | "medium"): number {
  return s === "high" ? 1 : 0;
}

/**
 * 批量判定：只返回需返工的 function，按 severity（high 先）再按 failureRate 降序稳定排序。
 * 依赖 V8 的稳定排序保序（同 severity + 同 failureRate 者维持输入顺序）。
 */
export function evaluateFleet(healths: FunctionHealth[], policy?: GovernancePolicy): ReworkDecision[] {
  return healths
    .map((h) => evaluateFunctionHealth(h, policy))
    .filter((d) => d.shouldRework)
    .sort((a, b) => severityRank(b.severity) - severityRank(a.severity) || b.failureRate - a.failureRate);
}

/**
 * 幂等去重：剔除 idempotencyKey 已在 alreadyOpened 里的决定
 * （模拟「这个 function×窗口是否已开过 rework」）。保序、纯函数。
 */
export function dedupeReworkDecisions(decisions: ReworkDecision[], alreadyOpened: Set<string>): ReworkDecision[] {
  return decisions.filter((d) => !alreadyOpened.has(d.idempotencyKey));
}

/** 一句话/多行中文摘要，供 UI/日志。纯函数。 */
export function governanceSummary(decisions: ReworkDecision[]): string {
  if (!decisions.length) return "治理巡检：全部交付 function 生产健康达标，无需返工。";
  const high = decisions.filter((d) => d.severity === "high").length;
  const lines = decisions.map((d, i) => {
    const pct = Math.round(d.failureRate * 100);
    const tags = d.triggers.map((t) => TRIGGER_ZH[t]).join("/");
    return `${i + 1}. [${d.severity === "high" ? "高" : "中"}] ${d.functionId} — ${tags}（失败率 ${pct}%）`;
  });
  return `治理巡检：${decisions.length} 个交付 function 需返工重入工厂（其中高危 ${high} 个）。\n${lines.join("\n")}`;
}
