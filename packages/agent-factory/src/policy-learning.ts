// #POLICY-LEARN — 前置路由的学习回喂 v2（Meta-Reasoner / Route-to-Reason 的工程化最小版）。
//
// v1 的 selectPolicy 是确定性规则。本模块把【历史运行结果】回喂进来：每个 arm =
// (pipeline|band)，记录 {跑了几次, 成功几次, 保真违约几次}；下次选路时用保守规则做
// 【只加不减】的调整——历史保真差的 arm 强制深评，fast 档答不好的 arm 撤销降档。
// 不做 epsilon 探索（生成任务不适合拿用户的运行当探索样本），只做证据驱动的偏置修正。
// 纯函数 + 可序列化状态 → 存储由 ports.policyStats（api 侧 fs JSON）负责；无存储时零行为变化。

import type { ReasoningPolicy, DifficultyBand } from "./reasoning-policy";

export type PolicyArmStats = { n: number; ok: number; fidelityBad: number };
export type PolicyStats = Record<string, PolicyArmStats>;

export function armKey(pipeline: string, band: string): string {
  return `${pipeline}|${band}`;
}

export type PolicyOutcome = {
  pipeline: string;
  band: string;
  /** 运行是否体面收束（finished，非 errored/budget_exhausted）。 */
  ok: boolean;
  /** 本次是否出现保真违约（真实 emit 载荷不满足下游契约）。 */
  fidelityBad: boolean;
};

/** 纯累加（返回新对象，不改入参）——conductor 在 run 收束时调用并交给 ports 持久化。 */
export function recordOutcome(stats: PolicyStats | null | undefined, o: PolicyOutcome): PolicyStats {
  const key = armKey(o.pipeline, o.band);
  const cur = stats?.[key] ?? { n: 0, ok: 0, fidelityBad: 0 };
  return {
    ...(stats ?? {}),
    [key]: { n: cur.n + 1, ok: cur.ok + (o.ok ? 1 : 0), fidelityBad: cur.fidelityBad + (o.fidelityBad ? 1 : 0) },
  };
}

/** 最少样本数——低于它不做任何调整（两三次的波动不构成证据）。 */
const MIN_N = 3;

/** 证据驱动的保守调整（只加不减）：
 *  1. 该 (full|band) arm 历史保真违约率 ≥ 50% → 强制 deepCritique（设计期就多一道三视角审，
 *     把 output_parse_error 类问题挡在 sandbox 前）。
 *  2. (analyze|band) arm 历史成功率 < 50% → 撤销 fast 降档（答疑答砸了就别省这个钱）。
 *  调整原因追加进 reasons，全程可解释。无统计/样本不足 → 原样返回。 */
export function adjustPolicyWithStats(policy: ReasoningPolicy, stats: PolicyStats | null | undefined, band: DifficultyBand): ReasoningPolicy {
  if (!stats) return policy;
  const arm = stats[armKey(policy.pipeline, band)];
  if (!arm || arm.n < MIN_N) return policy;
  let out = policy;
  if (policy.pipeline === "full" && !policy.deepCritique && arm.fidelityBad / arm.n >= 0.5) {
    out = { ...out, deepCritique: true, reasons: [...out.reasons, `历史回喂：该难度下 ${arm.fidelityBad}/${arm.n} 次保真违约 → 强制三视角深评`] };
  }
  if (policy.pipeline === "analyze" && policy.tierBias === "fast" && arm.ok / arm.n < 0.5) {
    out = { ...out, tierBias: null, reasons: [...out.reasons, `历史回喂：fast 档答疑成功率 ${arm.ok}/${arm.n} → 撤销降档`] };
  }
  return out;
}
