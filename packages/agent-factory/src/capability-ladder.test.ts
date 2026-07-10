import { describe, it, expect } from "vitest";
import { resolveCapabilityLadder, validateSpawnSpec, nextLifecycle, type SpawnSpec } from "./capability-ladder";

describe("#P5 resolveCapabilityLadder — 六级能力解析", () => {
  it("① fleet 复用优先于一切", () => {
    const r = resolveCapabilityLadder({ description: "解析简历", fleetHas: true, toolHas: "parseResumeApi", skillHas: { slug: "s", lifecycle: "active" } });
    expect(r.level).toBe(1);
    expect(r.action).toBe("reuse_function");
    expect(r.createsAsset).toBe(false);
  });
  it("② 工具命中(无 fleet)", () => {
    const r = resolveCapabilityLadder({ description: "调 API", toolHas: "parseResumeApi" });
    expect(r).toMatchObject({ level: 2, action: "call_tool", target: "parseResumeApi" });
  });
  it("③ MCP 命中(无 fleet/工具)", () => {
    const r = resolveCapabilityLadder({ description: "外部服务", mcpHas: "robohire.match" });
    expect(r).toMatchObject({ level: 3, action: "call_mcp", target: "robohire.match" });
  });
  it("④ active 技能 → 实例化 sub-agent", () => {
    const r = resolveCapabilityLadder({ description: "分类错误", skillHas: { slug: "err-classifier", lifecycle: "active" } });
    expect(r).toMatchObject({ level: 4, action: "instantiate_subagent", target: "err-classifier" });
  });
  it("draft/deprecated 技能不可实例化 → 继续往下造(并在 reason 里点名)", () => {
    const draft = resolveCapabilityLadder({ description: "x", skillHas: { slug: "half-baked", lifecycle: "draft" } });
    expect(draft.action).toBe("forge_skill");
    expect(draft.reason).toContain("half-baked");
    const dep = resolveCapabilityLadder({ description: "x", skillHas: { slug: "retired", lifecycle: "deprecated" } });
    expect(dep.action).toBe("forge_skill");
  });
  it("⑤ 无现成 + 需要会推理的 sub-agent → 锻造技能(产生资产)", () => {
    const r = resolveCapabilityLadder({ description: "需要判断候选人身份等价" });
    expect(r).toMatchObject({ level: 5, action: "forge_skill", createsAsset: true });
  });
  it("⑥ 无现成 + 本质缺工具 → 造工具(产生资产)", () => {
    const r = resolveCapabilityLadder({ description: "调一个没接的 HTTP API", isMissingTool: true });
    expect(r).toMatchObject({ level: 6, action: "create_tool", createsAsset: true });
  });
});

describe("#P5 nextLifecycle — 生命周期(失败技能退场)", () => {
  it("draft 首用成功 → active", () => {
    expect(nextLifecycle("draft", { kind: "supervised_success" })).toBe("active");
  });
  it("draft 首用失败 → 立刻 deprecated(别污染库)", () => {
    expect(nextLifecycle("draft", { kind: "instantiation_failed" })).toBe("deprecated");
  });
  it("active 累计失败到阈值才 deprecated", () => {
    expect(nextLifecycle("active", { kind: "instantiation_failed" }, { failStreak: 0, failThreshold: 3 })).toBe("active");
    expect(nextLifecycle("active", { kind: "instantiation_failed" }, { failStreak: 2, failThreshold: 3 })).toBe("deprecated");
  });
  it("长期零用 → deprecated;deprecated 是终态", () => {
    expect(nextLifecycle("active", { kind: "long_unused" })).toBe("deprecated");
    expect(nextLifecycle("deprecated", { kind: "supervised_success" })).toBe("deprecated");
  });
});

describe("#P5 validateSpawnSpec — 实例化前校验 + 工具面交集", () => {
  const registry = new Set(["read_ontology", "parseResumeApi", "http.fetch", "deploy_prod"]);
  const stationTools = new Set(["read_ontology", "parseResumeApi", "http.fetch"]); // 站长没有 deploy_prod
  const good: SpawnSpec = {
    roleName: "错误分类审计员",
    systemPrompt: "你负责把一次运行的失败按业务/基础设施/终态分类,给出证据引用。",
    toolAllowlist: ["read_ontology", "parseResumeApi"],
    strategyDefault: "react",
    exemplarRefs: ["rule-check:isInfraFailure"],
    checklist: ["每个判定都引证据"],
  };

  it("合法 spawnSpec 通过,生效工具=交集", () => {
    const v = validateSpawnSpec(good, registry, stationTools);
    expect(v.ok).toBe(true);
    expect(v.effectiveTools).toEqual(["read_ontology", "parseResumeApi"]);
    expect(v.deniedTools).toEqual([]);
  });
  it("越权工具(站长没有)被剔除并暴露,不算硬错误", () => {
    const v = validateSpawnSpec({ ...good, toolAllowlist: ["read_ontology", "deploy_prod"] }, registry, stationTools);
    expect(v.deniedTools).toEqual(["deploy_prod"]); // 交集剔除
    expect(v.effectiveTools).toEqual(["read_ontology"]);
    expect(v.ok).toBe(true); // denied 不是硬错误
  });
  it("悬空工具引用(registry 不存在)→ 硬错误,归因锻造方", () => {
    const v = validateSpawnSpec({ ...good, toolAllowlist: ["read_ontology", "nonexistent_tool"] }, registry, stationTools);
    expect(v.ok).toBe(false);
    expect(v.danglingTools).toEqual(["nonexistent_tool"]);
    expect(v.errors.join()).toContain("nonexistent_tool");
  });
  it("systemPrompt 过短 / roleName 空 → 硬错误", () => {
    expect(validateSpawnSpec({ ...good, systemPrompt: "太短" }, registry, stationTools).ok).toBe(false);
    expect(validateSpawnSpec({ ...good, roleName: "" }, registry, stationTools).ok).toBe(false);
  });
  it("spawnSpec 缺失 → 拒绝", () => {
    expect(validateSpawnSpec(null, registry, stationTools).ok).toBe(false);
  });
});
