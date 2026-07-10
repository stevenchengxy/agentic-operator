/**
 * Agent 工厂 — shared data model.
 *
 * Pure (no JSX): the BrainEvent → Block reducer, the agent derivation, and the pipeline
 * STAGE derivation that drives the live canvas + health strip. The center transcript keeps
 * EVERY block kind at full fidelity (the complete thinking process) — this redesign only ADDS
 * the three reasoning events that were emitted-but-invisible (score.delta / revert / refine.diff).
 */

import type { BrainEvent } from "@/lib/hooks/useBrainStream";

// ── pickers / history ───────────────────────────────────────────────────────────
export interface DomainRow { id: string; name?: string; counts?: { actions: number; events: number; objects: number; rules: number; workflow: number } }
export interface RunRow { id: string; domain: string; goal: string; status: string; tokensUsed: number; turns: number; agentsCount: number; reachedTerminal: boolean; createdAt: string }
export interface AgentIO { agentShort: string; status: string; degraded?: boolean; triggerEvent?: string | null; outputEvent?: string | null; tools?: string[]; inputPayload?: Record<string, unknown> | null; outputPayload?: Record<string, unknown> | null; reasoning?: string; runId?: string; url?: string }
export interface DraftRow { slug: string; createdAt: string; spec: { nameZh?: string; short?: string; actionName?: string; tools?: string[] } }

export interface ScoreDims { toolResolution: number; promptRichness: number; decisionCoverage: number; refineHealth: number }
export interface RefineDiff { systemPromptChanged: boolean; toolsAdded: string[]; toolsRemoved: string[]; decisionLogicChanged: boolean }

// ── transcript blocks ─────────────────────────────────────────────────────────────
export type Block =
  | { kind: "think"; id: string; text: string }
  | { kind: "message"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; reasoning: string; role?: string; elapsedS?: number; progressNote?: string; input?: unknown; ok?: boolean; summary?: string; output?: string; model?: string; tier?: string }
  | { kind: "plan"; id: string; summary: string; agents: number }
  | { kind: "validation"; id: string; ok: boolean; issues: string[] }
  | { kind: "sandbox"; id: string; ev: Record<string, unknown> }
  | { kind: "refine"; id: string; action: string; critique: string; diff?: RefineDiff }
  | { kind: "score"; id: string; action: string; prior: number; next: number; delta: number; regression: boolean; dims: ScoreDims }
  | { kind: "revert"; id: string; action: string; toAttempt: number }
  | { kind: "testcases"; id: string; cases: Array<{ name: string; kind: string; scenario: string; entryEvent: string; expectedOutcome: string; payload?: Record<string, unknown> }>; awaiting: boolean; coverage?: { required: string[]; covered: string[]; backfilled: string[]; uncoveredNeedingData: string[] } }
  | { kind: "boundarycases"; id: string; proposals: Array<{ event: string; suggestedKind: string; why: string; producers: string[]; consumer?: string; payloadContract?: string }>; awaiting: boolean }
  | { kind: "boundarydecided"; id: string; events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }> }
  | { kind: "clarify"; id: string; question: string; options?: Array<{ label: string; value: string; recommended?: boolean }>; context?: string; awaiting: boolean }
  | { kind: "compaction"; id: string; summary: string; state: string }
  | { kind: "skill"; id: string; name: string; purpose: string }
  | { kind: "subagent"; id: string; task: string; summary?: string }
  | { kind: "budget"; id: string; text: string; level?: string }
  | { kind: "reflect"; id: string; text: string }
  | { kind: "catalog"; id: string; text: string }
  | { kind: "toolnew"; id: string; name: string; desc: string }
  | { kind: "web"; id: string; query: string; count: number }
  | { kind: "toolsearch"; id: string; query: string; count: number }
  | { kind: "toolschema"; id: string; name: string; method: string; url: string; fields: number }
  | { kind: "inspect"; id: string; agentSlug: string; status: string; degraded?: boolean; error?: string }
  | { kind: "code"; id: string; actionName: string; codeSource: string }
  | { kind: "done"; id: string; status: string }
  | { kind: "error"; id: string; text: string };

const ZERO_DIMS: ScoreDims = { toolResolution: 0, promptRichness: 0, decisionCoverage: 0, refineHealth: 0 };

export function toBlocks(events: BrainEvent[]): Block[] {
  const blocks: Block[] = [];
  let buf = "";
  let tid = 0;
  let currentModel = ""; // #7 — the model the current turn was routed to; stamped on tool steps.
  let currentTier = ""; // #7 — the difficulty tier (fast/default/hard) that selected the model.
  const flush = () => { if (buf.trim()) blocks.push({ kind: "think", id: `t-${tid++}`, text: buf.trim() }); buf = ""; };
  events.forEach((e, i) => {
    const id = `b-${i}`;
    switch (e.t) {
      case "model": currentModel = String(e.model ?? ""); currentTier = String(e.tier ?? ""); break;
      case "think": buf += String(e.delta ?? ""); break;
      case "message": {
        // A no-tool-call turn streams its content as think DELTAS and then lands the SAME text as
        // the message event — flushing both rendered the reply twice (thought bubble + message).
        // If the pending think buffer IS this message (or its prefix — stream may cut early), drop
        // the buffer and keep only the message. Genuine reasoning that differs still flushes.
        const text = String(e.text ?? "");
        const b = buf.trim();
        const m = text.trim();
        if (b && m && (b === m || m.startsWith(b) || b.startsWith(m))) buf = "";
        flush();
        blocks.push({ kind: "message", id, text });
        break;
      }
      case "tool.call": flush(); blocks.push({ kind: "tool", id: String(e.id ?? id), name: String(e.name ?? ""), role: e.role ? String(e.role) : undefined, reasoning: String(e.reasoning ?? ""), input: e.input, model: currentModel || undefined, tier: currentTier || undefined }); break;
      // #HEARTBEAT — 长工具心跳：把 elapsed/升级提示写回打开中的 tool block（慢/卡/死可区分）。
      case "tool.progress": { const pb = [...blocks].reverse().find((b) => b.kind === "tool" && b.id === String(e.id)) as Extract<Block, { kind: "tool" }> | undefined; if (pb && pb.ok === undefined) { pb.elapsedS = Number(e.elapsedS ?? 0) || undefined; if (e.note) pb.progressNote = String(e.note); } break; }
      case "tool.result": { const tb = [...blocks].reverse().find((b) => b.kind === "tool" && b.id === String(e.id)) as Extract<Block, { kind: "tool" }> | undefined; if (tb) { tb.ok = Boolean(e.ok); tb.summary = String(e.summary ?? ""); tb.output = e.output ? String(e.output) : undefined; } break; }
      case "plan": flush(); blocks.push({ kind: "plan", id, summary: String((e.plan as Record<string, unknown>)?.summary ?? ""), agents: ((e.plan as Record<string, unknown>)?.agents as unknown[])?.length ?? 0 }); break;
      case "validation": flush(); blocks.push({ kind: "validation", id, ok: Boolean(e.ok), issues: (e.issues as string[]) ?? [] }); break;
      case "sandbox": flush(); blocks.push({ kind: "sandbox", id, ev: e }); break;
      case "refine": flush(); blocks.push({ kind: "refine", id, action: String(e.actionName ?? ""), critique: String(e.critique ?? ""), diff: (e.diff as RefineDiff) ?? undefined }); break;
      // score.delta + revert were EMITTED but never had a toBlocks case — the brain's quality
      // movement + rollbacks were invisible. Now they render in the transcript + run summary.
      case "score.delta": flush(); blocks.push({ kind: "score", id, action: String(e.actionName ?? ""), prior: Number(e.priorTotal ?? 0), next: Number(e.newTotal ?? 0), delta: Number(e.delta ?? 0), regression: Boolean(e.regression), dims: (e.dimensions as ScoreDims) ?? ZERO_DIMS }); break;
      case "revert": flush(); blocks.push({ kind: "revert", id, action: String(e.actionName ?? ""), toAttempt: Number(e.revertedToAttempt ?? 0) }); break;
      case "test.cases": flush(); blocks.push({ kind: "testcases", id, cases: ((e.cases as Array<Record<string, unknown>>) ?? []).map((c) => ({ name: String(c.name ?? ""), kind: String(c.kind ?? "pass"), scenario: String(c.scenario ?? ""), entryEvent: String(c.entryEvent ?? ""), expectedOutcome: String(c.expectedOutcome ?? ""), payload: (c.payload as Record<string, unknown>) ?? undefined })), awaiting: Boolean(e.awaitingApproval), coverage: (e.coverage as { required: string[]; covered: string[]; backfilled: string[]; uncoveredNeedingData: string[] }) ?? undefined }); break;
      case "test.decision": {
        flush();
        const tcb = [...blocks].reverse().find((b) => b.kind === "testcases") as Extract<Block, { kind: "testcases" }> | undefined;
        if (tcb) tcb.awaiting = false;
        blocks.push({ kind: "message", id, text: e.decision === "approve" ? "✅ 已确认执行测试用例" : `🔄 重新生成测试用例${e.note ? `：${e.note}` : ""}` });
        break;
      }
      case "boundary.cases": flush(); blocks.push({ kind: "boundarycases", id, proposals: ((e.proposals as Array<Record<string, unknown>>) ?? []).map((p) => ({ event: String(p.event ?? ""), suggestedKind: String(p.suggestedKind ?? "external"), why: String(p.why ?? ""), producers: (p.producers as string[]) ?? [], consumer: typeof p.consumer === "string" ? p.consumer : undefined, payloadContract: typeof p.payloadContract === "string" ? p.payloadContract : undefined })), awaiting: Boolean(e.awaitingDecision) }); break;
      case "boundary.decided": {
        flush();
        const bcb = [...blocks].reverse().find((b) => b.kind === "boundarycases") as Extract<Block, { kind: "boundarycases" }> | undefined;
        if (bcb) bcb.awaiting = false;
        blocks.push({ kind: "boundarydecided", id, events: ((e.events as Array<Record<string, unknown>>) ?? []).map((v) => ({ event: String(v.event ?? ""), kind: String(v.kind ?? "external"), consumer: typeof v.consumer === "string" ? v.consumer : undefined, payloadContract: typeof v.payloadContract === "string" ? v.payloadContract : undefined })) });
        break;
      }
      case "clarify": flush(); blocks.push({ kind: "clarify", id, question: String(e.question ?? ""), options: (e.options as Array<{ label: string; value: string; recommended?: boolean }>) ?? undefined, context: e.context ? String(e.context) : undefined, awaiting: Boolean(e.awaitingAnswer) }); break;
      case "compaction": flush(); blocks.push({ kind: "compaction", id, summary: String(e.summary ?? ""), state: String(e.state ?? "") }); break;
      case "skill.created": flush(); blocks.push({ kind: "skill", id, name: String(e.name ?? ""), purpose: String(e.purpose ?? "") }); break;
      case "subagent.start": flush(); blocks.push({ kind: "subagent", id, task: String(e.task ?? "") }); break;
      case "subagent.done": {
        // Prefer TASK-matched pairing: parallel specialists (四维分治) finish in random order, so
        // "last unsummarized" alone would attach summaries to the wrong cards.
        const open = [...blocks].reverse().filter((b): b is Extract<Block, { kind: "subagent" }> => b.kind === "subagent" && !(b as Extract<Block, { kind: "subagent" }>).summary);
        const sb = open.find((b) => b.task === String(e.task ?? "")) ?? open[0];
        if (sb) sb.summary = String(e.summary ?? "");
        break;
      }
      case "budget": blocks.push({ kind: "budget", id, text: `已用 ${e.turn}/${e.maxTurns} 轮 · ${Math.round(Number(e.tokens) / 1000)}k tokens · ${e.specsBuilt} agent`, level: String(e.level ?? "ok") }); break;
      case "reflect": flush(); blocks.push({ kind: "reflect", id, text: String(e.lesson ?? "") }); break;
      case "catalog": flush(); blocks.push({ kind: "catalog", id, text: `读到本体：${e.actions} 动作（${e.agentActions} 个要造 agent）· ${e.events} 事件` }); break;
      case "tool.created": flush(); blocks.push({ kind: "toolnew", id, name: String(e.name ?? ""), desc: String(e.description ?? "") }); break;
      case "web.result": flush(); blocks.push({ kind: "web", id, query: String(e.query ?? ""), count: ((e.results as unknown[]) ?? []).length }); break;
      case "tool.search": flush(); blocks.push({ kind: "toolsearch", id, query: String(e.query ?? ""), count: ((e.results as unknown[]) ?? []).length }); break;
      case "tool.schema": flush(); blocks.push({ kind: "toolschema", id, name: String(e.name ?? ""), method: String(e.method ?? ""), url: String(e.url ?? ""), fields: Number(e.fields ?? 0) }); break;
      case "inspect": flush(); blocks.push({ kind: "inspect", id, agentSlug: String(e.agentSlug ?? ""), status: String(e.status ?? ""), degraded: Boolean(e.degraded), error: e.error ? String(e.error) : undefined }); break;
      case "code": flush(); blocks.push({ kind: "code", id, actionName: String(e.actionName ?? ""), codeSource: String(e.codeSource ?? "render") }); break;
      case "done": flush(); blocks.push({ kind: "done", id, status: String(e.status ?? "") }); break;
      case "error": flush(); blocks.push({ kind: "error", id, text: String(e.message ?? "") }); break;
      // "stage" carries no transcript block — it only drives the canvas rail (see deriveStages).
    }
  });
  flush();
  return blocks;
}

// ── agents ──────────────────────────────────────────────────────────────────────
export interface AgentCardData { slug: string; actionName: string; short: string; nameZh: string; trigger: string[]; emit: string[]; tools: string[]; reasoning?: string; systemPrompt?: string; decisionLogic?: string; code?: string; codeSource?: string; codeExecuted?: boolean; probeReason?: string }
export function deriveAgents(events: BrainEvent[]): AgentCardData[] {
  const map = new Map<string, AgentCardData>();
  for (const e of events) {
    if (e.t !== "agent.created") continue;
    const s = e.spec as Record<string, unknown>;
    const d = (e.design as Record<string, unknown>) ?? {};
    map.set(String(s.slug), { slug: String(s.slug), actionName: String(s.actionName ?? ""), short: String(s.short ?? ""), nameZh: String(s.nameZh ?? ""), trigger: (s.trigger as string[]) ?? [], emit: (s.emit as string[]) ?? [], tools: (s.tools as string[]) ?? [], reasoning: d.reasoning ? String(d.reasoning) : undefined, systemPrompt: d.systemPrompt ? String(d.systemPrompt) : undefined, decisionLogic: d.decisionLogic ? String(d.decisionLogic) : undefined, code: d.code ? String(d.code) : undefined, codeSource: d.codeSource ? String(d.codeSource) : undefined, codeExecuted: d.codeExecuted === true, probeReason: d.probeReason ? String(d.probeReason) : undefined });
  }
  return [...map.values()];
}

/** Every authored VERSION of each agent (R12) — agent.created re-emits on design / codegen /
 *  refine / revert, so the sequence per slug is the change history. Consecutive identical
 *  snapshots (same prompt+code+tools) are collapsed so versions reflect real changes. */
export function deriveAgentVersions(events: BrainEvent[]): Map<string, AgentCardData[]> {
  const m = new Map<string, AgentCardData[]>();
  const sig = (c: AgentCardData) => `${c.systemPrompt ?? ""}|${c.code ?? ""}|${c.tools.join(",")}|${c.decisionLogic ?? ""}`;
  for (const e of events) {
    if (e.t !== "agent.created") continue;
    const s = e.spec as Record<string, unknown>;
    const d = (e.design as Record<string, unknown>) ?? {};
    const card: AgentCardData = { slug: String(s.slug), actionName: String(s.actionName ?? ""), short: String(s.short ?? ""), nameZh: String(s.nameZh ?? ""), trigger: (s.trigger as string[]) ?? [], emit: (s.emit as string[]) ?? [], tools: (s.tools as string[]) ?? [], reasoning: d.reasoning ? String(d.reasoning) : undefined, systemPrompt: d.systemPrompt ? String(d.systemPrompt) : undefined, decisionLogic: d.decisionLogic ? String(d.decisionLogic) : undefined, code: d.code ? String(d.code) : undefined, codeSource: d.codeSource ? String(d.codeSource) : undefined };
    const arr = m.get(card.slug) ?? m.set(card.slug, []).get(card.slug)!;
    const last = arr[arr.length - 1];
    if (!last || sig(last) !== sig(card)) arr.push(card);
  }
  return m;
}

/** The latest score delta per agent slug-ish (keyed by action name / short) — floated on the
 *  canvas node + listed in the run summary refinement timeline. */
export function deriveScores(events: BrainEvent[]): Map<string, { delta: number; next: number; regression: boolean }> {
  const m = new Map<string, { delta: number; next: number; regression: boolean }>();
  for (const e of events) {
    if (e.t !== "score.delta") continue;
    m.set(String(e.actionName ?? ""), { delta: Number(e.delta ?? 0), next: Number(e.newTotal ?? 0), regression: Boolean(e.regression) });
  }
  return m;
}

// ── pipeline stages (drives the live canvas rail + health strip) ──────────────────
export type FactoryStageId = "read" | "plan" | "design" | "validate" | "sandbox" | "deliver";
export type StageStatus = "idle" | "active" | "ok" | "error";
export const STAGE_ORDER: FactoryStageId[] = ["read", "plan", "design", "validate", "sandbox", "deliver"];
export const STAGE_LABELS: Record<FactoryStageId, string> = { read: "读业务", plan: "规划", design: "设计", validate: "校验", sandbox: "试运行", deliver: "交付" };
export interface StageState { id: FactoryStageId; label: string; status: StageStatus }

/** Client fallback: infer a stage from a transcript event type, for runs recorded before the
 *  conductor emitted explicit `stage` events (and sub-agent runs). Mirrors STAGE_OF_TOOL. */
function stageOfEvent(t: string): FactoryStageId | null {
  switch (t) {
    case "catalog": return "read";
    case "plan": return "plan";
    case "agent.created": case "code": case "refine": case "score.delta": case "revert": return "design";
    case "validation": case "boundary.cases": case "boundary.decided": return "validate";
    case "sandbox": case "inspect": case "test.cases": return "sandbox";
    case "done": return "deliver";
    default: return null;
  }
}

/** Per-stage status + the current (most-recently-entered) stage. Prefers the explicit `stage`
 *  events; falls back to event.t inference when a transcript has none. */
export function deriveStages(events: BrainEvent[]): { stages: StageState[]; current: FactoryStageId | null } {
  const status: Record<FactoryStageId, StageStatus> = { read: "idle", plan: "idle", design: "idle", validate: "idle", sandbox: "idle", deliver: "idle" };
  let current: FactoryStageId | null = null;
  const hasExplicit = events.some((e) => e.t === "stage");

  if (hasExplicit) {
    for (const e of events) {
      if (e.t !== "stage") continue;
      const st = e.stage as FactoryStageId;
      if (!STAGE_ORDER.includes(st)) continue;
      current = st;
      const s = String(e.status);
      if (s === "ok" || s === "error") status[st] = s;
      else if (status[st] !== "ok") status[st] = "active";
    }
  } else {
    for (const e of events) {
      const st = stageOfEvent(e.t);
      if (!st) continue;
      current = st;
      if (status[st] !== "ok" && status[st] !== "error") status[st] = "active";
      if (e.t === "validation") status.validate = e.ok ? "ok" : "error";
      else if (e.t === "sandbox") status.sandbox = e.fullChainRan || e.reachedSuccessTerminal ? "ok" : "active";
      else if (e.t === "done") status.deliver = e.status === "finished" ? "ok" : "error";
    }
  }

  // Monotonic completion: anything strictly before the furthest-reached stage that is still
  // merely "active" is implicitly done — mark it ok so the rail reads as progress, not a gap.
  const reachedIdx = STAGE_ORDER.reduce((mx, s, i) => (status[s] !== "idle" ? i : mx), -1);
  for (let i = 0; i < reachedIdx; i++) {
    const s = STAGE_ORDER[i]!;
    if (status[s] === "active") status[s] = "ok";
  }

  return { stages: STAGE_ORDER.map((id) => ({ id, label: STAGE_LABELS[id], status: status[id] })), current };
}

// ── brain decision flow (the 大脑 view) ───────────────────────────────────────────
// A linearized picture of HOW the brain reasoned — distinct from the 交付图 (WHAT it built).
// Each step is one decision/act; the renderer draws status colors, HITL diamonds, and refine
// loop-back arcs. Derived from the same event stream so a replayed run reproduces it.
export type BrainStepStatus = "ok" | "fail" | "warn" | "await" | "info" | "neutral";
export interface BrainStep { id: string; kind: "read" | "plan" | "design" | "validate" | "refine" | "revert" | "gate" | "sandbox" | "deliver" | "error" | "subagent" | "skill" | "reflect"; label: string; detail?: string; status: BrainStepStatus }

export function deriveBrainFlow(events: BrainEvent[]): BrainStep[] {
  const steps: BrainStep[] = [];
  const seenDesign = new Set<string>();
  let i = 0;
  const lastOf = (kind: BrainStep["kind"], label?: string) => [...steps].reverse().find((s) => s.kind === kind && (label === undefined || s.label === label));
  for (const e of events) {
    const id = `bs-${i++}`;
    switch (e.t) {
      case "catalog": steps.push({ id, kind: "read", label: "读本体", detail: `${e.actions} 动作 · ${e.events} 事件`, status: "neutral" }); break;
      case "plan": steps.push({ id, kind: "plan", label: "规划", detail: `${((e.plan as Record<string, unknown>)?.agents as unknown[])?.length ?? 0} 个智能体`, status: "neutral" }); break;
      // #F: make recursive reasoning visible in the decision flow — sub-brain spawns + skill creation.
      case "subagent.start": steps.push({ id, kind: "subagent", label: "🧩 子智能体", detail: String(e.task ?? "").slice(0, 44), status: "info" }); break;
      case "subagent.done": { const sb = [...steps].reverse().find((s) => s.kind === "subagent" && !s.detail?.includes(" → ")); if (sb) sb.detail = `${sb.detail ?? ""} → ${String(e.summary ?? "").slice(0, 30)}`; break; }
      case "skill.created": steps.push({ id, kind: "skill", label: `🛠 造技能 ${String(e.name ?? "")}`, detail: String(e.purpose ?? "").slice(0, 40), status: "info" }); break;
      case "reflect": steps.push({ id, kind: "reflect", label: "💡 反思", detail: String(e.lesson ?? "").slice(0, 44), status: "neutral" }); break;
      case "agent.created": {
        const s = e.spec as Record<string, unknown>;
        const slug = String(s.slug ?? "");
        if (seenDesign.has(slug)) break; // re-emit on refine — the refine event records that, not a new design step
        seenDesign.add(slug);
        steps.push({ id, kind: "design", label: `设计 ${String(s.actionName || s.short || slug)}`, status: "ok" });
        break;
      }
      case "validation": steps.push({ id, kind: "validate", label: e.ok ? "校验闭合" : "校验未闭合", detail: e.ok ? "含字段合同" : `${((e.issues as unknown[]) ?? []).length} 个问题`, status: e.ok ? "ok" : "fail" }); break;
      case "refine": steps.push({ id, kind: "refine", label: `修订 ${String(e.actionName ?? "")}`, detail: String(e.critique ?? "").slice(0, 44), status: "warn" }); break;
      case "score.delta": {
        const d = Number(e.delta ?? 0);
        const txt = `评分 ${d >= 0 ? "▲+" : "▼"}${d}`;
        const ref = lastOf("refine");
        if (ref) ref.detail = ref.detail ? `${ref.detail} · ${txt}` : txt;
        break;
      }
      case "revert": steps.push({ id, kind: "revert", label: `回滚 ${String(e.actionName ?? "")}`, detail: `到第 ${e.revertedToAttempt} 次之前`, status: "warn" }); break;
      case "test.cases": steps.push({ id, kind: "gate", label: "用例确认", detail: `${((e.cases as unknown[]) ?? []).length} 个用例`, status: e.awaitingApproval ? "await" : "ok" }); break;
      case "test.decision": { const g = lastOf("gate", "用例确认"); if (g) g.status = e.decision === "approve" ? "ok" : "warn"; break; }
      case "boundary.cases": steps.push({ id, kind: "gate", label: "边界事件分类", detail: `${((e.proposals as unknown[]) ?? []).length} 个`, status: e.awaitingDecision ? "await" : "ok" }); break;
      case "clarify": steps.push({ id, kind: "gate", label: "询问用户", detail: String(e.question ?? "").slice(0, 40), status: e.awaitingAnswer ? "await" : "ok" }); break;
      case "boundary.decided": { const g = lastOf("gate", "边界事件分类"); if (g) g.status = "ok"; break; }
      case "sandbox": {
        const sim = Boolean(e.simulated);
        const ok = Boolean(e.fullChainRan);
        steps.push({ id, kind: "sandbox", label: ok ? (sim ? "沙箱(模拟)闭合" : "真沙箱跑通") : "沙箱未跑通", detail: `${sim ? "模拟" : "真实"} · 部署 ${e.functionsRegistered ?? 0} · 跑 ${e.ran ?? 0}`, status: ok ? "ok" : "fail" }); break;
      }
      case "done": if (e.status !== "incomplete" || steps.length) steps.push({ id, kind: "deliver", label: e.status === "finished" ? "交付完成" : `结束 · ${e.status}`, status: e.status === "finished" ? "ok" : "fail" }); break;
      case "error": steps.push({ id, kind: "error", label: "出错", detail: String(e.message ?? "").slice(0, 44), status: "fail" }); break;
    }
  }
  return steps;
}
