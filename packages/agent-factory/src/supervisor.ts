// #P3 — 独立监督者审计 + 版本锁定缺陷(融合蓝图 §05/§10)。
//
// 【结构性独立】在纯逻辑层的体现:supervisorAudit 的输入类型里【根本没有】生产者的思维链
// (designReasoning / messages / toolRationale)——它只吃客观证据(保真违约 attribution + 失败用例),
// 所以它无法继承、也无法被生产者的自我合理化说服。它也不产出/不建议"怎么改代码"(那是评审组的活),
// 只做归因 + 判定缺陷。
//
// 【版本锁定缺陷】:一个缺陷锚定在(agentSlug, foundAtVersion, 证据 key)。它必须在【更新的版本】上
// 证据消失才算 resolved——同版本重跑证据偶然不见【不算修复】(防"不改 spec 重跑洗白")。finish 门
// 要求 0 个 open 的 blocking 缺陷。

import type { AttributionEntry, RecommendedAction } from "./failure-attribution";

export type DefectSeverity = "blocking" | "advisory";
export type DefectStatus = "open" | "resolved";

export interface VersionLockedDefect {
  /** 稳定 id = `${agentSlug}:${key}`(同一证据类别在同一 agent 上只有一个缺陷,便于结转去重)。 */
  id: string;
  agentShort: string;
  agentSlug: string;
  /** 证据类别 key(稳定去重):如 `fidelity:EVENT:refine_producer`、`case:edge:REASON`。 */
  key: string;
  severity: DefectSeverity;
  status: DefectStatus;
  recommend: RecommendedAction;
  /** 引证据(客观,来自 attribution / caseVerdict)。 */
  evidence: string;
  /** 锁定的工件版本(缺陷在哪个版本被发现;必须在【更新的】版本重验才能关闭)。 */
  foundAtVersion: number;
  /** 定点修复指令(来自 attribution;监督者转述,不自造)。 */
  instruction: string;
  affectedConsumers: string[];
}

/** 监督者的【客观证据】输入——注意:没有任何生产者思维链字段。 */
export interface SupervisorEvidence {
  /** 来自 attributeFidelityFailures(保真违约的确定性归因)。 */
  attribution: AttributionEntry[];
  /** 各 agent 当前工件版本(slug → version);缺省视为 1。 */
  versions?: Record<string, number>;
  /** 失败的测试用例(客观)。reject 用例到 FAIL 是"正确拒绝",不是缺陷——调用方应已过滤或此处跳过。 */
  caseFailures?: Array<{ kind: string; reason: string }>;
}

/** 独立审计:客观证据 → 版本锁定缺陷。确定性、稳定排序。 */
export function supervisorAudit(ev: SupervisorEvidence): VersionLockedDefect[] {
  const versions = ev.versions ?? {};
  const defects: VersionLockedDefect[] = [];
  for (const a of ev.attribution) {
    const key = `fidelity:${a.event ?? "?"}:${a.recommend}`;
    defects.push({
      id: `${a.agentSlug}:${key}`,
      agentShort: a.agentShort,
      agentSlug: a.agentSlug,
      key,
      severity: "blocking", // 保真违约 = 下游会 output_parse_error = 阻塞
      status: "open",
      recommend: a.recommend,
      evidence: `emit「${a.event ?? "?"}」保真违约,影响下游 ${a.affectedConsumers.join("、") || "(无)"}`,
      foundAtVersion: versions[a.agentSlug] ?? 1,
      instruction: a.instruction,
      affectedConsumers: a.affectedConsumers,
    });
  }
  for (const c of ev.caseFailures ?? []) {
    if (c.kind === "reject") continue; // reject→FAIL 是正确拒绝,不是缺陷
    const key = `case:${c.kind}:${c.reason}`.slice(0, 80);
    defects.push({
      id: `chain:${key}`,
      agentShort: "(链路)",
      agentSlug: "(chain)",
      key,
      severity: "blocking",
      status: "open",
      recommend: "refine_producer",
      evidence: `用例(${c.kind})失败:${c.reason}`,
      foundAtVersion: 0,
      instruction: `修复导致用例失败的环节:${c.reason}`,
      affectedConsumers: [],
    });
  }
  return dedupeSort(defects);
}

/** 缺陷复验/结转:证据仍在 → 保持 open(锁定原 foundAtVersion);证据消失【且版本已更新】→ resolved;
 *  证据消失【但版本没变】→ 仍 open(同版本重跑不算修复,防洗白)。新证据 → 新 open 缺陷。 */
export function reconcileDefects(
  prev: VersionLockedDefect[],
  fresh: VersionLockedDefect[],
  curVersions: Record<string, number> = {},
): VersionLockedDefect[] {
  const freshIds = new Set(fresh.map((d) => d.id));
  const prevIds = new Set(prev.map((d) => d.id));
  const out: VersionLockedDefect[] = [];
  for (const p of prev) {
    if (freshIds.has(p.id)) {
      out.push({ ...p, status: "open" }); // 证据仍在
    } else {
      const cur = curVersions[p.agentSlug] ?? p.foundAtVersion;
      out.push({ ...p, status: cur > p.foundAtVersion ? "resolved" : "open" }); // 复验才关闭
    }
  }
  for (const f of fresh) if (!prevIds.has(f.id)) out.push(f); // 新缺陷
  return dedupeSort(out);
}

/** 仍在阻塞的缺陷(open + blocking)——finish 门必须清零。 */
export function blockingDefects(defects: VersionLockedDefect[]): VersionLockedDefect[] {
  return defects.filter((d) => d.severity === "blocking" && d.status === "open");
}

/** 监督者结论摘要(拼进 sandbox_run summary / UI)。 */
export function supervisorSummary(defects: VersionLockedDefect[]): string {
  const open = blockingDefects(defects);
  if (!open.length) {
    const resolved = defects.filter((d) => d.status === "resolved").length;
    return resolved ? `【监督者】0 阻塞缺陷(${resolved} 个已复验关闭)——可交付。` : "【监督者】0 阻塞缺陷——可交付。";
  }
  const lines = open.map((d, i) => `${i + 1}. [${d.agentShort} v${d.foundAtVersion}] ${d.evidence} → ${d.instruction}`);
  return `【监督者:${open.length} 个阻塞缺陷未清(finish 前必须复验关闭)】\n${lines.join("\n")}`;
}

function dedupeSort(defects: VersionLockedDefect[]): VersionLockedDefect[] {
  const byId = new Map<string, VersionLockedDefect>();
  for (const d of defects) if (!byId.has(d.id)) byId.set(d.id, d); // 同 id 保留首个(稳定)
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
