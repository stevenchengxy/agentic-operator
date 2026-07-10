import { describe, it, expect } from "vitest";
import { supervisorAudit, reconcileDefects, blockingDefects, supervisorSummary, type VersionLockedDefect } from "./supervisor";
import type { AttributionEntry } from "./failure-attribution";

function attr(over: Partial<AttributionEntry> = {}): AttributionEntry {
  return {
    agentShort: "ResumeAgent", agentSlug: "raas-resume", event: "RESUME_PROCESSED",
    affectedConsumers: ["ruleCheck"], recommend: "refine_producer",
    instruction: "补齐字段 candidate_id", ...over,
  };
}

describe("#P3 supervisorAudit — 客观证据 → 版本锁定缺陷", () => {
  it("保真违约 → blocking 缺陷,锁定当前版本", () => {
    const d = supervisorAudit({ attribution: [attr()], versions: { "raas-resume": 3 } });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ agentSlug: "raas-resume", severity: "blocking", status: "open", foundAtVersion: 3, recommend: "refine_producer" });
    expect(d[0]!.id).toBe("raas-resume:fidelity:RESUME_PROCESSED:refine_producer");
  });
  it("reject 用例到 FAIL 不算缺陷(正确拒绝)", () => {
    const d = supervisorAudit({ attribution: [], caseFailures: [{ kind: "reject", reason: "score<40" }, { kind: "edge", reason: "空简历崩溃" }] });
    expect(d).toHaveLength(1);
    expect(d[0]!.evidence).toContain("空简历崩溃");
  });
  it("确定性:同证据同缺陷(稳定排序+去重)", () => {
    const ev = { attribution: [attr({ agentShort: "B", agentSlug: "b" }), attr({ agentShort: "A", agentSlug: "a" })] };
    expect(supervisorAudit(ev)).toEqual(supervisorAudit(ev));
    expect(supervisorAudit(ev)[0]!.agentSlug).toBe("a"); // id 排序
  });
});

describe("#P3 reconcileDefects — 复验才关闭(防同版本重跑洗白)", () => {
  const prev: VersionLockedDefect[] = supervisorAudit({ attribution: [attr()], versions: { "raas-resume": 2 } });

  it("证据仍在 → 保持 open", () => {
    const fresh = supervisorAudit({ attribution: [attr()], versions: { "raas-resume": 2 } });
    const out = reconcileDefects(prev, fresh, { "raas-resume": 2 });
    expect(out[0]!.status).toBe("open");
  });
  it("证据消失但版本没变 → 仍 open(不算修复)", () => {
    const out = reconcileDefects(prev, [], { "raas-resume": 2 }); // 同版本 2
    expect(out[0]!.status).toBe("open");
    expect(blockingDefects(out)).toHaveLength(1);
  });
  it("证据消失且版本已更新(复验) → resolved", () => {
    const out = reconcileDefects(prev, [], { "raas-resume": 3 }); // 版本 2→3
    expect(out[0]!.status).toBe("resolved");
    expect(blockingDefects(out)).toHaveLength(0);
  });
  it("新证据 → 追加新 open 缺陷", () => {
    const fresh = supervisorAudit({ attribution: [attr(), attr({ agentShort: "JD", agentSlug: "raas-jd", event: "JD_GENERATED" })], versions: { "raas-resume": 2, "raas-jd": 1 } });
    const out = reconcileDefects(prev, fresh, { "raas-resume": 2, "raas-jd": 1 });
    expect(out).toHaveLength(2);
  });
});

describe("#P3 supervisorSummary + blockingDefects", () => {
  it("有阻塞 → 列出;清零 → 可交付", () => {
    const withDefect = supervisorAudit({ attribution: [attr()] });
    expect(supervisorSummary(withDefect)).toContain("阻塞缺陷未清");
    expect(supervisorSummary([])).toContain("0 阻塞缺陷");
    const resolved = reconcileDefects(supervisorAudit({ attribution: [attr()], versions: { "raas-resume": 1 } }), [], { "raas-resume": 2 });
    expect(supervisorSummary(resolved)).toContain("已复验关闭");
  });
});
