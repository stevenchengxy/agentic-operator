// #P5 — 能力梯 + 可实例化技能(融合蓝图 §06)。用户诉求⑤的核心逻辑:
//   「缺 sub-agent → 用工具写 SKILL → SKILL 生成这个 sub-agent」。
//
// 本模块是 P5 的【纯逻辑核心】(确定性、可测试、无 DB/无 conductor 副作用):
//   · resolveCapabilityLadder — 六级能力解析(复用→工具→MCP→技能实例化→锻造→造工具);
//   · SpawnSpec / SkillLifecycle — 可实例化技能的结构 + 生命周期;
//   · validateSpawnSpec — 实例化前的结构校验 + 工具面交集(永不越站长之权);
//   · nextLifecycle — draft→active→deprecated 生命周期转移(治理三洞之一:失败技能退场)。
//
// 运行时的 instantiate_subagent / skill_forge 执行(把这些决策接进 conductor 的 spawn 机制)依赖
// P2.5 的站长工具面先落地(蓝图明示 P5 依赖 P2.5),故本批只交付决策核心 + 只读 resolve 工具。

/** 可实例化技能携带的"如何生成一个 sub-agent"配方。 */
export interface SpawnSpec {
  /** 角色名,如「信封解包工」「错误分类审计员」。 */
  roleName: string;
  /** 完整角色系统提示词(非碎片)。 */
  systemPrompt: string;
  /** 允许的工具;实例化时与派生站长的工具面取交集,永不越权。 */
  toolAllowlist: string[];
  /** 默认推理策略(轴2)。 */
  strategyDefault: "react" | "reflection" | "debate";
  /** 黄金范例锚点(按模式组织,防过拟合)。 */
  exemplarRefs: string[];
  /** 完工自检清单。 */
  checklist: string[];
}

/** 技能生命周期(治理:锻造零审批 / 失败不退场 两洞的答案)。
 *  draft      = 刚锻造,只能在锻造它的这次运行内、监督下首用;
 *  active     = 首用成功后 promote,入库共享、可被 instantiate;
 *  deprecated = 连续失败或长期零用,不可实例化(可查阅)。 */
export type SkillLifecycle = "draft" | "active" | "deprecated";

/** 生命周期转移事件。 */
export type LifecycleEvent =
  | { kind: "supervised_success" } // draft 首用成功 → active
  | { kind: "instantiation_failed" } // 累计失败
  | { kind: "long_unused" }; // 长期零用

/** 纯函数生命周期转移。failStreak 是当前连续失败次数(调用方维护/持久化)。 */
export function nextLifecycle(
  current: SkillLifecycle,
  event: LifecycleEvent,
  opts: { failStreak?: number; failThreshold?: number } = {},
): SkillLifecycle {
  const failThreshold = opts.failThreshold ?? 3;
  const failStreak = opts.failStreak ?? 0;
  if (current === "deprecated") return "deprecated"; // 终态(需人工复活)
  if (event.kind === "supervised_success") return current === "draft" ? "active" : "active";
  if (event.kind === "long_unused") return "deprecated";
  if (event.kind === "instantiation_failed") {
    // draft 首用即失败 → 立刻退回 deprecated(别污染库);active 累计到阈值才降级。
    if (current === "draft") return "deprecated";
    return failStreak + 1 >= failThreshold ? "deprecated" : "active";
  }
  return current;
}

// ── 能力梯 ────────────────────────────────────────────────────────────────
export type LadderAction =
  | "reuse_function" // ① 已交付函数复用/组合
  | "call_tool" // ② 全局/租户工具直接调
  | "call_mcp" // ③ MCP 服务器工具
  | "instantiate_subagent" // ④ 从 active 技能实例化 L2 工人
  | "forge_skill" // ⑤ 锻造新技能(落 draft),再回④
  | "create_tool"; // ⑥ 造声明式工具,再回②

export interface CapabilityNeed {
  /** 缺什么能力的自然语言描述。 */
  description: string;
  /** ① 已交付函数覆盖此意图? */
  fleetHas?: boolean;
  /** ② 命中的已注册工具名(null=无)。 */
  toolHas?: string | null;
  /** ③ 命中的 MCP 工具名(<server>.<tool>,null=无)。 */
  mcpHas?: string | null;
  /** ④ 命中的可实例化技能(需 lifecycle=active 才可用)。 */
  skillHas?: { slug: string; lifecycle: SkillLifecycle } | null;
  /** ⑥ 该能力本质是"缺一个工具/集成"(而非缺一个会推理的 sub-agent)。 */
  isMissingTool?: boolean;
}

export interface LadderResolution {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  action: LadderAction;
  /** 命中的目标(函数/工具/技能 slug 等)。 */
  target?: string;
  reason: string;
  /** 这一步是否会产生新持久资产(工具/技能),供 UI 标注 + 治理关注。 */
  createsAsset: boolean;
}

/** 六级能力解析:一级比一级贵,优先复用,最后才造。确定性、可解释。 */
export function resolveCapabilityLadder(need: CapabilityNeed): LadderResolution {
  if (need.fleetHas) {
    return { level: 1, action: "reuse_function", reason: "已交付函数覆盖此能力 → 直接复用/组合(最省)", createsAsset: false };
  }
  if (need.toolHas) {
    return { level: 2, action: "call_tool", target: need.toolHas, reason: `工具库已有「${need.toolHas}」→ 直接调用`, createsAsset: false };
  }
  if (need.mcpHas) {
    return { level: 3, action: "call_mcp", target: need.mcpHas, reason: `MCP 服务器提供「${need.mcpHas}」→ 折叠调用`, createsAsset: false };
  }
  if (need.skillHas && need.skillHas.lifecycle === "active") {
    return { level: 4, action: "instantiate_subagent", target: need.skillHas.slug, reason: `技能库有 active 可实例化技能「${need.skillHas.slug}」→ 实例化 L2 工人`, createsAsset: false };
  }
  // 命中了技能但不可用(draft/deprecated)——说明它还没被验证/已退场,继续往下造。
  const staleSkillNote = need.skillHas ? `(命中技能「${need.skillHas.slug}」为 ${need.skillHas.lifecycle},不可实例化)` : "";
  if (need.isMissingTool) {
    return { level: 6, action: "create_tool", reason: `无现成能力,且本质是缺工具/集成 → 造声明式工具再走②${staleSkillNote}`, createsAsset: true };
  }
  return { level: 5, action: "forge_skill", reason: `无现成能力,需要一个会推理的 sub-agent → 锻造新技能(落 draft,监督下首用)${staleSkillNote}`, createsAsset: true };
}

// ── 实例化前校验(治理第三洞:实例化前零校验)────────────────────────────────
export interface SpawnSpecValidation {
  ok: boolean;
  errors: string[];
  /** toolAllowlist ∩ 站长工具面 = 实际生效工具(永不超过站长之权)。 */
  effectiveTools: string[];
  /** toolAllowlist 里引用了但 registry 不存在的工具(悬空引用)。 */
  danglingTools: string[];
  /** toolAllowlist 里被站长工具面挡下的(越权,已剔除)。 */
  deniedTools: string[];
}

/** 校验一个 spawnSpec 是否可安全实例化。availableTools=全局可用工具名集;stationTools=派生站长
 *  自己的工具面(实际生效=两者对 allowlist 的交集)。任一结构问题 → ok=false,归因到锻造方。 */
export function validateSpawnSpec(
  spec: Partial<SpawnSpec> | null | undefined,
  availableTools: ReadonlySet<string>,
  stationTools: ReadonlySet<string>,
): SpawnSpecValidation {
  const errors: string[] = [];
  if (!spec) return { ok: false, errors: ["spawnSpec 缺失"], effectiveTools: [], danglingTools: [], deniedTools: [] };
  if (!spec.roleName?.trim()) errors.push("roleName 为空");
  if (!spec.systemPrompt?.trim() || spec.systemPrompt.trim().length < 20) errors.push("systemPrompt 缺失或过短(<20 字符)");
  if (spec.strategyDefault && !["react", "reflection", "debate"].includes(spec.strategyDefault)) errors.push(`strategyDefault「${spec.strategyDefault}」非法`);
  const allowlist = spec.toolAllowlist ?? [];
  const dangling = allowlist.filter((t) => !availableTools.has(t));
  const denied = allowlist.filter((t) => availableTools.has(t) && !stationTools.has(t));
  const effective = allowlist.filter((t) => availableTools.has(t) && stationTools.has(t));
  if (dangling.length) errors.push(`toolAllowlist 引用了不存在的工具:${dangling.join("、")}`);
  // denied 不是硬错误(交集自动剔除),但要暴露(可能是锻造方误以为有权)。
  return { ok: errors.length === 0, errors, effectiveTools: effective, danglingTools: dangling, deniedTools: denied };
}
