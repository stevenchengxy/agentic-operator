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
export type SandboxEvidenceStatus = "real" | "simulated_only" | "none";
export type FactoryCompletionKind = "delivery" | "answer" | "incomplete" | "legacy_unknown";
export interface RunRow { id: string; domain: string; goal: string; status: string; tokensUsed: number; turns: number; agentsCount: number; reachedTerminal: boolean; evidenceStatus: SandboxEvidenceStatus; realExecutionSucceeded: boolean; completionKind: FactoryCompletionKind; createdAt: string }
export interface AgentIO { agentShort: string; status: string; degraded?: boolean; triggerEvent?: string | null; outputEvent?: string | null; tools?: string[]; inputPayload?: Record<string, unknown> | null; outputPayload?: Record<string, unknown> | null; reasoning?: string; runId?: string; url?: string }
export interface DraftRow {
  slug: string;
  createdAt: string;
  versionId?: string;
  replayReady?: boolean;
  regressionReady?: boolean;
  regressionStatus?: "missing" | "legacy_ready" | "pending_replay" | "ready" | "invalid";
  regression?: { artifact: string; evidenceFingerprint: string; suiteFingerprint: string };
  promotionEligible?: boolean;
  promotionGateAdmission?: boolean;
  promotionEvidenceReady?: boolean;
  promotionBlockers?: string[];
  evidenceQualification?: {
    schema: "agent-factory-regression-evidence-qualification/v1";
    replay: "sandbox_verified" | "blocked";
    promotion: "candidate" | "blocked";
    blockers: Array<{ code: string; detail: string }>;
  };
  spec: { nameZh?: string; short?: string; actionName?: string; tools?: string[]; isMock?: boolean; mock?: boolean };
}

export interface ScoreDims { toolResolution: number; promptRichness: number; decisionCoverage: number; refineHealth: number }
export interface RefineDiff { systemPromptChanged: boolean; toolsAdded: string[]; toolsRemoved: string[]; decisionLogicChanged: boolean }

// ── transcript blocks ─────────────────────────────────────────────────────────────
export type Block =
  | { kind: "think"; id: string; text: string }
  | { kind: "message"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
  | { kind: "reasoning"; id: string; strategy: string; text: string; forAgent?: string }
  | { kind: "viz"; id: string; title: string; svgs: Array<{ title: string; svg: string }>; note?: string }
  | { kind: "tool"; id: string; name: string; reasoning: string; role?: string; elapsedS?: number; progressNote?: string; input?: unknown; ok?: boolean; summary?: string; output?: string; model?: string; tier?: string }
  | { kind: "plan"; id: string; summary: string; agents: number }
  | { kind: "validation"; id: string; ok: boolean; issues: string[] }
  | { kind: "sandbox"; id: string; ev: Record<string, unknown> }
  | { kind: "refine"; id: string; action: string; critique: string; diff?: RefineDiff }
  | { kind: "score"; id: string; action: string; prior: number; next: number; delta: number; regression: boolean; dims: ScoreDims }
  | { kind: "revert"; id: string; action: string; toAttempt: number }
  | { kind: "testcases"; id: string; interactionId?: string; cases: Array<{ id: string; name: string; kind: string; scenario: string; entryEvent: string; expectedOutcome: string; payload?: Record<string, unknown> }>; awaiting: boolean; coverage?: { required: string[]; covered: string[]; backfilled: string[]; uncoveredNeedingData: string[] } }
  | { kind: "boundarycases"; id: string; interactionId?: string; proposals: Array<{ event: string; suggestedKind: string; why: string; producers: string[]; consumer?: string; payloadContract?: string }>; awaiting: boolean }
  | { kind: "boundarydecided"; id: string; events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }> }
  | { kind: "clarify"; id: string; interactionId?: string; question: string; options?: Array<{ label: string; value: string; recommended?: boolean }>; context?: string; awaiting: boolean }
  | { kind: "compaction"; id: string; summary: string; state: string }
  | { kind: "skill"; id: string; name: string; purpose: string }
  | { kind: "subagent"; id: string; task: string; summary?: string; groupId?: string }
  | { kind: "group"; id: string; groupId: string; label: string; members: number; mode: string; done: boolean; ok?: number; total?: number; summary?: string }
  | { kind: "budget"; id: string; text: string; level?: string }
  | { kind: "reflect"; id: string; text: string }
  | { kind: "catalog"; id: string; text: string }
  | { kind: "toolnew"; id: string; name: string; desc: string }
  | { kind: "web"; id: string; query: string; count: number }
  | { kind: "toolsearch"; id: string; query: string; count: number }
  | { kind: "toolschema"; id: string; name: string; method: string; url: string; fields: number }
  | { kind: "inspect"; id: string; agentSlug: string; status: string; degraded?: boolean; error?: string }
  | { kind: "code"; id: string; actionName: string; codeSource: string }
  | { kind: "done"; id: string; status: string; completionKind: FactoryCompletionKind }
  | { kind: "error"; id: string; text: string };

const ZERO_DIMS: ScoreDims = { toolResolution: 0, promptRichness: 0, decisionCoverage: 0, refineHealth: 0 };

const FIXTURE_REFERENCE_HIDDEN = "[内部测试资产引用已隐藏]";
const FIXTURE_CONTENT_HIDDEN = "[测试文件内容已隐藏]";

/**
 * Fixture bytes and opaque asset ids are execution-layer details. They may be
 * present in persisted tool frames, but must never be copied into the visible
 * transcript/activity log. Keep non-sensitive shape information so an
 * operator can still understand which case/path the tool worked on.
 */
function redactFixtureTranscriptText(value: unknown): string {
  return String(value ?? "")
    .replace(/("(?:asset_id|assetId)"\s*:\s*")[^"]*(")/gi, `$1${FIXTURE_REFERENCE_HIDDEN}$2`)
    .replace(/("base64"\s*:\s*")[^"]*(")/gi, `$1${FIXTURE_CONTENT_HIDDEN}$2`)
    .replace(/data:[^;,\s]+;base64,[a-z0-9+/=_-]+/gi, FIXTURE_CONTENT_HIDDEN);
}

function redactFixtureTranscriptValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFixtureTranscriptValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => {
      const normalized = key.replace(/[_-]/g, "").toLowerCase();
      if (normalized === "assetid") return [key, FIXTURE_REFERENCE_HIDDEN];
      if (normalized === "base64") return [key, FIXTURE_CONTENT_HIDDEN];
      return [key, redactFixtureTranscriptValue(nested)];
    }));
  }
  return typeof value === "string" ? redactFixtureTranscriptText(value) : value;
}

/**
 * Historical transcript frames predate completionKind. Keep those records
 * explicitly unknown instead of guessing that an `incomplete` frame was a
 * successful answer (or that a `finished` frame was a delivery).
 */
export function normalizeFactoryCompletionKind(value: unknown): FactoryCompletionKind {
  return value === "delivery" || value === "answer" || value === "incomplete"
    ? value
    : "legacy_unknown";
}

export function isAnswerCompletion(
  status: unknown,
  completionKind: unknown,
): boolean {
  return normalizeFactoryCompletionKind(completionKind) === "answer"
    && (status === "incomplete" || status === "finished" || status === "done");
}

export function isDeliveryCompletion(
  status: unknown,
  completionKind: unknown,
): boolean {
  return normalizeFactoryCompletionKind(completionKind) === "delivery"
    && (status === "finished" || status === "done");
}

/** Only a non-simulated sandbox event can serve as execution evidence. */
export function sandboxEvidenceStatus(
  events: BrainEvent[],
): SandboxEvidenceStatus {
  let sawSimulated = false;
  for (const event of events) {
    if (event.t !== "sandbox") continue;
    if (event.simulated) sawSimulated = true;
    else return "real";
  }
  return sawSimulated ? "simulated_only" : "none";
}

/**
 * Historical rows can carry old terminal statuses, but only a successful
 * final real sandbox execution may be presented as completed.
 */
export function factoryRunDisplayStatus(
  run: Pick<RunRow, "status" | "evidenceStatus" | "realExecutionSucceeded" | "completionKind">,
): string {
  if (isAnswerCompletion(run.status, run.completionKind)) return "answer_completed";
  if (run.status !== "finished" && run.status !== "done") return run.status;
  const completionKind = normalizeFactoryCompletionKind(run.completionKind);
  if (completionKind === "legacy_unknown") return "legacy_unknown";
  if (completionKind !== "delivery") return "incomplete";
  if (run.evidenceStatus === "real" && run.realExecutionSucceeded) return run.status;
  if (run.evidenceStatus === "real") return "failed_real_execution";
  return run.evidenceStatus === "simulated_only"
    ? "invalid_evidence"
    : "unverified_evidence";
}

export function toBlocks(events: BrainEvent[]): Block[] {
  const blocks: Block[] = [];
  let buf = "";
  let tid = 0;
  let currentModel = ""; // #7 — the model the current turn was routed to; stamped on tool steps.
  let currentTier = ""; // #7 — the difficulty tier (fast/default/hard) that selected the model.
  const flush = () => { if (buf.trim()) blocks.push({ kind: "think", id: `t-${tid++}`, text: redactFixtureTranscriptText(buf.trim()) }); buf = ""; };
  events.forEach((e, i) => {
    const id = `b-${i}`;
    switch (e.t) {
      case "model": currentModel = String(e.model ?? ""); currentTier = String(e.tier ?? ""); break;
      // #USER-MESSAGE — the human's words render as their own bubble (goal / injected note / gate answer).
      case "user.message": flush(); blocks.push({ kind: "user", id, text: redactFixtureTranscriptText(String(e.text ?? "")) }); break;
      // #CLEAN-ANSWER — a real reasoning-kernel step (cot/reflection/…): the deliberation behind an
      // answer or a blueprint phase. Foldable noise — hidden in 精简, fully shown in 详尽 — so the
      // message card stays a clean answer while the process stays inspectable.
      case "reasoning.step": {
        flush();
        const text = redactFixtureTranscriptText(String(e.output ?? ""));
        if (text.trim()) blocks.push({ kind: "reasoning", id, strategy: String(e.strategy ?? "cot"), text, ...(e.forAgent ? { forAgent: String(e.forAgent) } : {}) });
        break;
      }
      // #VIZ-INLINE — server-rendered diagrams land IN the chat as clickable thumbnails (the 蓝图 tab
      // keeps the full panel; this is the conversational surfacing of the same deterministic SVGs).
      case "flow.blueprint": {
        flush();
        const m = (e.model ?? {}) as { domain?: string; phases?: unknown[]; unresolved?: unknown[]; diagrams?: Array<{ kind?: string; title?: string; svg?: string }> };
        const svgs = (m.diagrams ?? []).filter((d) => typeof d.svg === "string" && d.svg).map((d) => ({ title: String(d.title ?? d.kind ?? "图"), svg: String(d.svg) }));
        if (svgs.length) blocks.push({ kind: "viz", id, title: `🗺 本体蓝图 · ${m.phases?.length ?? 0} 阶段 · ${svgs.length} 张图`, svgs, note: `${(m.unresolved?.length ?? 0) > 0 ? `${m.unresolved!.length} 项缺本体证据未接地 · ` : ""}点图放大；完整蓝图（含推理细化/未接地清单）在「蓝图」标签页` });
        break;
      }
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
        blocks.push({ kind: "message", id, text: redactFixtureTranscriptText(text) });
        break;
      }
      case "tool.call": flush(); blocks.push({ kind: "tool", id: String(e.id ?? id), name: String(e.name ?? ""), role: e.role ? String(e.role) : undefined, reasoning: redactFixtureTranscriptText(e.reasoning ?? ""), input: redactFixtureTranscriptValue(e.input), model: currentModel || undefined, tier: currentTier || undefined }); break;
      // #HEARTBEAT — 长工具心跳：把 elapsed/升级提示写回打开中的 tool block（慢/卡/死可区分）。
      case "tool.progress": { const pb = [...blocks].reverse().find((b) => b.kind === "tool" && b.id === String(e.id)) as Extract<Block, { kind: "tool" }> | undefined; if (pb && pb.ok === undefined) { pb.elapsedS = Number(e.elapsedS ?? 0) || undefined; if (e.note) pb.progressNote = String(e.note); } break; }
      case "tool.result": { const tb = [...blocks].reverse().find((b) => b.kind === "tool" && b.id === String(e.id)) as Extract<Block, { kind: "tool" }> | undefined; if (tb) { tb.ok = Boolean(e.ok); tb.summary = redactFixtureTranscriptText(e.summary ?? ""); tb.output = e.output ? redactFixtureTranscriptText(e.output) : undefined; } break; }
      case "plan": flush(); blocks.push({ kind: "plan", id, summary: String((e.plan as Record<string, unknown>)?.summary ?? ""), agents: ((e.plan as Record<string, unknown>)?.agents as unknown[])?.length ?? 0 }); break;
      case "validation": flush(); blocks.push({ kind: "validation", id, ok: Boolean(e.ok), issues: (e.issues as string[]) ?? [] }); break;
      case "sandbox": flush(); blocks.push({ kind: "sandbox", id, ev: e }); break;
      case "refine": flush(); blocks.push({ kind: "refine", id, action: String(e.actionName ?? ""), critique: String(e.critique ?? ""), diff: (e.diff as RefineDiff) ?? undefined }); break;
      // score.delta + revert were EMITTED but never had a toBlocks case — the brain's quality
      // movement + rollbacks were invisible. Now they render in the transcript + run summary.
      case "score.delta": flush(); blocks.push({ kind: "score", id, action: String(e.actionName ?? ""), prior: Number(e.priorTotal ?? 0), next: Number(e.newTotal ?? 0), delta: Number(e.delta ?? 0), regression: Boolean(e.regression), dims: (e.dimensions as ScoreDims) ?? ZERO_DIMS }); break;
      case "revert": flush(); blocks.push({ kind: "revert", id, action: String(e.actionName ?? ""), toAttempt: Number(e.revertedToAttempt ?? 0) }); break;
      case "test.cases": flush(); blocks.push({ kind: "testcases", id, interactionId: typeof e.interactionId === "string" ? e.interactionId : undefined, cases: ((e.cases as Array<Record<string, unknown>>) ?? []).map((c) => ({ id: String(c.id ?? ""), name: String(c.name ?? ""), kind: String(c.kind ?? "pass"), scenario: String(c.scenario ?? ""), entryEvent: String(c.entryEvent ?? ""), expectedOutcome: String(c.expectedOutcome ?? ""), payload: (c.payload as Record<string, unknown>) ?? undefined })), awaiting: Boolean(e.awaitingApproval), coverage: (e.coverage as { required: string[]; covered: string[]; backfilled: string[]; uncoveredNeedingData: string[] }) ?? undefined }); break;
      case "test.decision": {
        flush();
        const decision = String(e.decision ?? "");
        const interactionId = typeof e.interactionId === "string" ? e.interactionId : undefined;
        const tcb = [...blocks].reverse().find((b): b is Extract<Block, { kind: "testcases" }> =>
          b.kind === "testcases" && (interactionId ? b.interactionId === interactionId : b.interactionId === undefined));
        // supply_data is not an approval outcome. The brain remains parked on
        // the same gate until it applies the supplied fixture and emits a new
        // test.cases frame (or the user explicitly approves/regenerates).
        if (tcb && (decision === "approve" || decision === "regenerate")) tcb.awaiting = false;
        const text = decision === "approve"
          ? "✅ 已确认执行测试用例"
          : decision === "regenerate"
            ? `🔄 已要求重新生成测试用例${e.note ? `：${redactFixtureTranscriptText(e.note)}` : ""}`
            : decision === "supply_data"
              ? "📎 已补充测试数据，工厂正在应用；应用完成后仍需你确认测试用例"
              : "已记录测试用例决策，等待工厂确认状态";
        blocks.push({ kind: "message", id, text });
        break;
      }
      case "boundary.cases": flush(); blocks.push({ kind: "boundarycases", id, interactionId: typeof e.interactionId === "string" ? e.interactionId : undefined, proposals: ((e.proposals as Array<Record<string, unknown>>) ?? []).map((p) => ({ event: String(p.event ?? ""), suggestedKind: String(p.suggestedKind ?? "external"), why: String(p.why ?? ""), producers: (p.producers as string[]) ?? [], consumer: typeof p.consumer === "string" ? p.consumer : undefined, payloadContract: typeof p.payloadContract === "string" ? p.payloadContract : undefined })), awaiting: Boolean(e.awaitingDecision) }); break;
      case "boundary.decided": {
        flush();
        const interactionId = typeof e.interactionId === "string" ? e.interactionId : undefined;
        const bcb = [...blocks].reverse().find((b): b is Extract<Block, { kind: "boundarycases" }> =>
          b.kind === "boundarycases" && (interactionId ? b.interactionId === interactionId : b.interactionId === undefined));
        if (bcb) bcb.awaiting = false;
        blocks.push({ kind: "boundarydecided", id, events: ((e.events as Array<Record<string, unknown>>) ?? []).map((v) => ({ event: String(v.event ?? ""), kind: String(v.kind ?? "external"), consumer: typeof v.consumer === "string" ? v.consumer : undefined, payloadContract: typeof v.payloadContract === "string" ? v.payloadContract : undefined })) });
        break;
      }
      case "clarify": {
        flush();
        if (e.awaitingAnswer === false) {
          // #CLARIFY-CLEAR — the resolution frame flips the pending card to answered (mirrors
          // test.decision/boundary.decided) instead of pushing a new card; without it awaiting stays
          // true for the life of the transcript and the "等你回答" banner/dock never clear.
          const interactionId = typeof e.interactionId === "string" ? e.interactionId : undefined;
          const cb = [...blocks].reverse().find((b): b is Extract<Block, { kind: "clarify" }> =>
            b.kind === "clarify" && b.awaiting && (interactionId ? b.interactionId === interactionId : b.interactionId === undefined));
          if (cb) cb.awaiting = false;
          break;
        }
        blocks.push({ kind: "clarify", id, interactionId: typeof e.interactionId === "string" ? e.interactionId : undefined, question: String(e.question ?? ""), options: (e.options as Array<{ label: string; value: string; recommended?: boolean }>) ?? undefined, context: e.context ? String(e.context) : undefined, awaiting: true });
        break;
      }
      case "compaction": flush(); blocks.push({ kind: "compaction", id, summary: String(e.summary ?? ""), state: String(e.state ?? "") }); break;
      case "skill.created": flush(); blocks.push({ kind: "skill", id, name: String(e.name ?? ""), purpose: String(e.purpose ?? "") }); break;
      case "subagent.start": flush(); blocks.push({ kind: "subagent", id, task: String(e.task ?? ""), ...(e.groupId ? { groupId: String(e.groupId) } : {}) }); break;
      // #SUBAGENT-GROUP — a reasoning-driven group of sub-brains: render one header card, then the member
      // subagent cards (which carry the same groupId) stream below it.
      case "group.start": flush(); blocks.push({ kind: "group", id, groupId: String(e.groupId ?? ""), label: String(e.label ?? "子智能体组"), members: Number(e.members ?? 0), mode: String(e.mode ?? "research"), done: false }); break;
      case "group.done": {
        const gb = [...blocks].reverse().find((b): b is Extract<Block, { kind: "group" }> => b.kind === "group" && b.groupId === String(e.groupId ?? "") && !b.done);
        if (gb) { gb.done = true; gb.ok = Number(e.ok ?? 0); gb.total = Number(e.total ?? 0); gb.summary = String(e.summary ?? ""); }
        break;
      }
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
      case "done": flush(); blocks.push({ kind: "done", id, status: String(e.status ?? ""), completionKind: normalizeFactoryCompletionKind(e.completionKind) }); break;
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
  let finalStageLabel = STAGE_LABELS.deliver;
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
      else if (e.t === "done") status.deliver = "active";
    }
  }

  const lastDone = [...events].reverse().find((event) => event.t === "done");
  const answerCompleted = Boolean(
    lastDone && isAnswerCompletion(lastDone.status, lastDone.completionKind),
  );
  const deliveryCompleted = Boolean(
    lastDone && isDeliveryCompletion(lastDone.status, lastDone.completionKind),
  );
  if (lastDone) {
    current = "deliver";
    if (lastDone.status === "waiting_human") {
      finalStageLabel = "等待人工";
      status.deliver = "idle";
    } else if (answerCompleted) {
      // The fixed six-stage rail reuses its final slot, but changes the visible
      // semantic label. A Q&A answer is successful without claiming delivery.
      finalStageLabel = "回答";
      status.deliver = "ok";
    } else if (deliveryCompleted) {
      status.deliver = "ok";
    } else {
      finalStageLabel = normalizeFactoryCompletionKind(lastDone.completionKind) === "legacy_unknown"
        ? "结束（类型未知）"
        : "结束";
      status.deliver = "error";
    }
  }

  // Historical test-mode runs may contain a simulated sandbox followed by
  // optimistic stage/done events. Such records remain useful diagnostics,
  // but they can never make the execution or delivery stages green.
  const sandboxEvents = events.filter((event) => event.t === "sandbox");
  const latestRealSandbox = [...sandboxEvents]
    .reverse()
    .find((event) => !event.simulated);
  let realSandboxSucceeded = false;
  if (latestRealSandbox) {
    realSandboxSucceeded = Boolean(
      latestRealSandbox.fullChainRan ||
        latestRealSandbox.reachedSuccessTerminal,
    );
    status.sandbox =
      realSandboxSucceeded ? "ok" : "error";
    if (deliveryCompleted && status.deliver === "ok" && !realSandboxSucceeded) {
      status.deliver = "error";
    }
  } else if (sandboxEvents.some((event) => event.simulated)) {
    status.sandbox = "error";
    if (deliveryCompleted && status.deliver === "ok") status.deliver = "error";
  } else if (deliveryCompleted && status.deliver === "ok") {
    status.deliver = "error";
  }

  // Monotonic completion: anything strictly before the furthest-reached stage that is still
  // merely "active" is implicitly done — mark it ok so the rail reads as progress, not a gap.
  const reachedIdx = STAGE_ORDER.reduce((mx, s, i) => (status[s] !== "idle" ? i : mx), -1);
  for (let i = 0; i < reachedIdx; i++) {
    const s = STAGE_ORDER[i]!;
    if (status[s] === "active") status[s] = "ok";
  }

  // Completion of a Q&A response can advance the final rail slot, but can
  // never manufacture a green sandbox stage. The same invariant also guards
  // explicit historical `stage: sandbox, status: ok` markers without evidence.
  if (!realSandboxSucceeded && status.sandbox === "ok") status.sandbox = "error";

  return { stages: STAGE_ORDER.map((id) => ({ id, label: id === "deliver" ? finalStageLabel : STAGE_LABELS[id], status: status[id] })), current };
}

// ── brain decision flow (the 大脑 view) ───────────────────────────────────────────
// A linearized picture of HOW the brain reasoned — distinct from the 交付图 (WHAT it built).
// Each step is one decision/act; the renderer draws status colors, HITL diamonds, and refine
// loop-back arcs. Derived from the same event stream so a replayed run reproduces it.
export type BrainStepStatus = "ok" | "fail" | "warn" | "await" | "info" | "neutral";
export interface BrainStep { id: string; kind: "read" | "plan" | "design" | "validate" | "refine" | "revert" | "gate" | "sandbox" | "answer" | "deliver" | "error" | "subagent" | "skill" | "reflect"; label: string; detail?: string; status: BrainStepStatus; interactionId?: string }

export function deriveBrainFlow(events: BrainEvent[]): BrainStep[] {
  const steps: BrainStep[] = [];
  const seenDesign = new Set<string>();
  let i = 0;
  let hasRealSandboxSuccess = false;
  const lastOf = (kind: BrainStep["kind"], label?: string) => [...steps].reverse().find((s) => s.kind === kind && (label === undefined || s.label === label));
  for (const e of events) {
    const id = `bs-${i++}`;
    switch (e.t) {
      case "catalog": steps.push({ id, kind: "read", label: "读本体", detail: `${e.actions} 动作 · ${e.events} 事件`, status: "neutral" }); break;
      case "plan": steps.push({ id, kind: "plan", label: "规划", detail: `${((e.plan as Record<string, unknown>)?.agents as unknown[])?.length ?? 0} 个智能体`, status: "neutral" }); break;
      // #F: make recursive reasoning visible in the decision flow — sub-brain spawns + skill creation.
      case "subagent.start": steps.push({ id, kind: "subagent", label: "🧩 子智能体", detail: String(e.task ?? "").slice(0, 44), status: "info" }); break;
      case "group.start": steps.push({ id, kind: "subagent", label: "🧩 子智能体组", detail: `${String(e.label ?? "")}（${Number(e.members ?? 0)} 成员）`.slice(0, 44), status: "info" }); break;
      case "group.done": steps.push({ id, kind: "subagent", label: "🧩 子智能体组完成", detail: `${String(e.label ?? "")} · ${Number(e.ok ?? 0)}/${Number(e.total ?? 0)} 成功`.slice(0, 44), status: Number(e.ok ?? 0) > 0 ? "ok" : "warn" }); break;
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
      case "test.cases": steps.push({ id, kind: "gate", label: "用例确认", detail: `${((e.cases as unknown[]) ?? []).length} 个用例`, status: e.awaitingApproval ? "await" : "ok", interactionId: typeof e.interactionId === "string" ? e.interactionId : undefined }); break;
      case "test.decision": {
        const interactionId = typeof e.interactionId === "string" ? e.interactionId : undefined;
        const g = [...steps].reverse().find((step) => step.kind === "gate" && step.label === "用例确认" && (interactionId ? step.interactionId === interactionId : step.interactionId === undefined));
        if (g) {
          const decision = String(e.decision ?? "");
          if (decision === "approve") g.status = "ok";
          else if (decision === "regenerate") g.status = "warn";
          else if (decision === "supply_data") {
            g.status = "await";
            g.detail = "补充数据已提交 · 应用后仍需确认";
          }
        }
        break;
      }
      case "boundary.cases": steps.push({ id, kind: "gate", label: "边界事件分类", detail: `${((e.proposals as unknown[]) ?? []).length} 个`, status: e.awaitingDecision ? "await" : "ok", interactionId: typeof e.interactionId === "string" ? e.interactionId : undefined }); break;
      case "clarify": {
        // #CLARIFY-CLEAR — the resolution frame flips the existing gate step to ok, not a new step.
        if (e.awaitingAnswer === false) {
          const interactionId = typeof e.interactionId === "string" ? e.interactionId : undefined;
          const prev = [...steps].reverse().find((s) => s.kind === "gate" && s.label === "询问用户" && s.status === "await" && (interactionId ? s.interactionId === interactionId : s.interactionId === undefined));
          if (prev) prev.status = "ok";
          break;
        }
        steps.push({ id, kind: "gate", label: "询问用户", detail: String(e.question ?? "").slice(0, 40), status: "await", interactionId: typeof e.interactionId === "string" ? e.interactionId : undefined });
        break;
      }
      case "boundary.decided": { const interactionId = typeof e.interactionId === "string" ? e.interactionId : undefined; const g = [...steps].reverse().find((step) => step.kind === "gate" && step.label === "边界事件分类" && (interactionId ? step.interactionId === interactionId : step.interactionId === undefined)); if (g) g.status = "ok"; break; }
      case "sandbox": {
        const sim = Boolean(e.simulated);
        const ok =
          !sim &&
          (Boolean(e.fullChainRan) || Boolean(e.reachedSuccessTerminal));
        if (!sim) hasRealSandboxSuccess = ok;
        steps.push({
          id,
          kind: "sandbox",
          label: sim
            ? "历史模拟记录 · 无效执行证据"
            : ok
              ? "真沙箱跑通"
              : "真沙箱未跑通",
          detail: `${sim ? "legacy / invalid evidence" : "真实执行"} · 部署 ${e.functionsRegistered ?? 0} · 跑 ${e.ran ?? 0}`,
          status: ok ? "ok" : "fail",
        });
        break;
      }
      case "done": {
        const completionKind = normalizeFactoryCompletionKind(e.completionKind);
        if (e.status === "waiting_human") {
          steps.push({
            id,
            kind: "gate",
            label: "等待人工回复",
            detail: "已保存检查点，回复后继续",
            status: "await",
          });
          break;
        }
        if (isAnswerCompletion(e.status, completionKind)) {
          steps.push({
            id,
            kind: "answer",
            label: "回答完成",
            detail: "信息回答 · 未产生交付或沙箱证据",
            status: "ok",
          });
          break;
        }
        const verifiedFinished =
          isDeliveryCompletion(e.status, completionKind) && hasRealSandboxSuccess;
        steps.push({
          id,
          kind: "deliver",
          label: verifiedFinished
            ? "交付完成"
            : isDeliveryCompletion(e.status, completionKind)
              ? "交付记录 · 无有效真实成功证据"
              : completionKind === "legacy_unknown"
                ? "结束 · 历史记录未标注完成类型"
              : `结束 · ${e.status}`,
          status: verifiedFinished ? "ok" : completionKind === "legacy_unknown" ? "warn" : "fail",
        });
        break;
      }
      case "error": steps.push({ id, kind: "error", label: "出错", detail: String(e.message ?? "").slice(0, 44), status: "fail" }); break;
    }
  }
  return steps;
}
