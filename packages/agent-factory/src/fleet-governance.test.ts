import { describe, it, expect } from "vitest";
import {
  evaluateFunctionHealth,
  evaluateFleet,
  dedupeReworkDecisions,
  governanceSummary,
  type FunctionHealth,
} from "./fleet-governance";

const base = (over: Partial<FunctionHealth> & Pick<FunctionHealth, "functionId">): FunctionHealth => ({
  windowDays: 14,
  windowKey: "2026-W28",
  total: 0,
  failed: 0,
  ...over,
});

describe("evaluateFunctionHealth (#P7 治理闭环)", () => {
  it("① total<minRuns 不触发 failure_rate（样本不足）", () => {
    // 2/2 全失败，但样本 < 默认 minRuns(3) → 不返工
    const d = evaluateFunctionHealth(base({ functionId: "f-thin", total: 2, failed: 2 }));
    expect(d.shouldRework).toBe(false);
    expect(d.triggers).toEqual([]);
    expect(d.failureRate).toBe(1);
    expect(d.reason).toContain("无需返工");
  });

  it("② 失败率达阈值触发 failure_rate", () => {
    // 5/10 = 0.5 ≥ 阈值 0.5，样本 10 ≥ 3 → 触发
    const d = evaluateFunctionHealth(base({ functionId: "f-flaky", total: 10, failed: 5 }));
    expect(d.shouldRework).toBe(true);
    expect(d.triggers).toEqual(["failure_rate"]);
    expect(d.failureRate).toBe(0.5);
    expect(d.severity).toBe("medium"); // 0.5 < 0.8
    expect(d.reason).toContain("失败率");
    expect(d.reason).toContain("5/10");
    expect(d.idempotencyKey).toBe("rework:f-flaky:2026-W28");
  });

  it("② 高失败率 (≥0.8) → high 严重度", () => {
    const d = evaluateFunctionHealth(base({ functionId: "f-broken", total: 10, failed: 9 }));
    expect(d.shouldRework).toBe(true);
    expect(d.triggers).toEqual(["failure_rate"]);
    expect(d.severity).toBe("high");
  });

  it("③ fidelity 回归触发 fidelity_regression（即便失败率不达标）", () => {
    // 失败率 0（1/10 都没），但保真回归 2 次 ≥ 阈值 1 → 触发
    const d = evaluateFunctionHealth(base({ functionId: "f-drift", total: 10, failed: 0, fidelityRegressions: 2 }));
    expect(d.shouldRework).toBe(true);
    expect(d.triggers).toEqual(["fidelity_regression"]);
    expect(d.severity).toBe("medium");
    expect(d.reason).toContain("保真回归");
  });

  it("④ security 触发 + high 严重度（哪怕样本很少）", () => {
    const d = evaluateFunctionHealth(base({ functionId: "f-cve", total: 1, failed: 0, newSecurityFindings: 1 }));
    expect(d.shouldRework).toBe(true);
    expect(d.triggers).toEqual(["security"]);
    expect(d.severity).toBe("high");
    expect(d.reason).toContain("安全");
  });

  it("多信号叠加：triggers 稳定有序 failure_rate → fidelity_regression → security", () => {
    const d = evaluateFunctionHealth(
      base({ functionId: "f-all", total: 10, failed: 9, fidelityRegressions: 3, newSecurityFindings: 2 }),
    );
    expect(d.triggers).toEqual(["failure_rate", "fidelity_regression", "security"]);
    expect(d.severity).toBe("high");
  });

  it("policy 覆盖默认阈值", () => {
    const h = base({ functionId: "f-cfg", total: 4, failed: 2 }); // 0.5
    // 抬高阈值到 0.6 → 不触发
    expect(evaluateFunctionHealth(h, { failRateThreshold: 0.6 }).shouldRework).toBe(false);
    // 抬高 minRuns 到 5 → 样本 4 不足 → 不触发
    expect(evaluateFunctionHealth(h, { minRuns: 5 }).shouldRework).toBe(false);
    // 抬高 fidelity 阈值到 3 → 2 次回归不达标
    const h2 = base({ functionId: "f-cfg2", fidelityRegressions: 2 });
    expect(evaluateFunctionHealth(h2, { fidelityRegressionThreshold: 3 }).shouldRework).toBe(false);
  });

  it("total=0 → failureRate=0，不崩（除零保护）", () => {
    const d = evaluateFunctionHealth(base({ functionId: "f-idle", total: 0, failed: 0 }));
    expect(d.failureRate).toBe(0);
    expect(d.shouldRework).toBe(false);
  });
});

describe("evaluateFleet (#P7)", () => {
  it("⑤ 只返回要返工的，且按 severity(high 先) 再 failureRate 降序", () => {
    const fleet: FunctionHealth[] = [
      base({ functionId: "fnB-mid50", total: 10, failed: 5 }), // medium 0.5
      base({ functionId: "fnA-high100", total: 3, failed: 3 }), // high 1.0
      base({ functionId: "fnC-healthy", total: 10, failed: 1 }), // 0.1 → 过滤掉
      base({ functionId: "fnD-mid60", total: 10, failed: 6 }), // medium 0.6
    ];
    const out = evaluateFleet(fleet);
    // fnC 被过滤；high 先，medium 内 0.6 > 0.5
    expect(out.map((d) => d.functionId)).toEqual(["fnA-high100", "fnD-mid60", "fnB-mid50"]);
    expect(out.every((d) => d.shouldRework)).toBe(true);
  });

  it("空舰队 → 空数组", () => {
    expect(evaluateFleet([])).toEqual([]);
  });
});

describe("dedupeReworkDecisions (#P7 幂等)", () => {
  it("⑥ 剔除 idempotencyKey 已开过的（防 cron 重放/重叠 tick 双开）", () => {
    const fleet: FunctionHealth[] = [
      base({ functionId: "fnA", total: 3, failed: 3, windowKey: "2026-W28" }),
      base({ functionId: "fnB", total: 10, failed: 6, windowKey: "2026-W28" }),
    ];
    const decisions = evaluateFleet(fleet);
    const alreadyOpened = new Set(["rework:fnA:2026-W28"]);
    const fresh = dedupeReworkDecisions(decisions, alreadyOpened);
    expect(fresh.map((d) => d.functionId)).toEqual(["fnB"]);
  });

  it("同 function 换窗口(windowKey) → 幂等键不同 → 允许再开一次", () => {
    const wk1 = evaluateFunctionHealth(base({ functionId: "fnA", total: 3, failed: 3, windowKey: "2026-W28" }));
    const wk2 = evaluateFunctionHealth(base({ functionId: "fnA", total: 3, failed: 3, windowKey: "2026-W29" }));
    expect(wk1.idempotencyKey).not.toBe(wk2.idempotencyKey);
    const opened = new Set([wk1.idempotencyKey]);
    expect(dedupeReworkDecisions([wk1, wk2], opened).map((d) => d.functionId)).toEqual(["fnA"]);
  });
});

describe("governanceSummary (#P7)", () => {
  it("空 → 健康提示；非空 → 计数 + 高危统计", () => {
    expect(governanceSummary([])).toContain("无需返工");
    const decisions = evaluateFleet([
      base({ functionId: "fnA", total: 3, failed: 3 }), // high
      base({ functionId: "fnB", total: 10, failed: 5 }), // medium
    ]);
    const s = governanceSummary(decisions);
    expect(s).toContain("2 个");
    expect(s).toContain("高危 1 个");
    expect(s).toContain("fnA");
    expect(s).toContain("fnB");
  });
});

describe("确定性 (#P7 纯函数)", () => {
  it("⑦ 同输入两次全等（逐字节）", () => {
    const fleet: FunctionHealth[] = [
      base({ functionId: "fnA", total: 10, failed: 9, fidelityRegressions: 1 }),
      base({ functionId: "fnB", total: 4, failed: 2, newSecurityFindings: 2 }),
      base({ functionId: "fnC", total: 5, failed: 1 }),
    ];
    expect(evaluateFleet(fleet)).toEqual(evaluateFleet(fleet));
    expect(evaluateFunctionHealth(fleet[0]!)).toEqual(evaluateFunctionHealth(fleet[0]!));
    expect(governanceSummary(evaluateFleet(fleet))).toBe(governanceSummary(evaluateFleet(fleet)));
  });
});
