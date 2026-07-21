/**
 * Agent 工厂 — 后台面板的会话任务投影（pure，无 JSX、无 IO）。
 *
 * deriveSessionTasks 把当前会话的 BrainEvent 流分解成 Claude-Desktop 式任务条目：
 * Harness（工厂大脑 ReAct 主循环）、每个 Agent 的构建（含其内部 plan/工具/沙箱 I/O）、
 * Sub-agent（design_subagent 固化的 + 运行时 ctx.spawn 的）、Tool（造工具）、
 * Sandbox（每次沙箱部署）。每条任务带自己的 transcript 切片（View transcript）。
 * 纯投影：历史运行回放渲染结果一致。
 */

import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import type { Translate } from "@/app/portal/lib/preferences-context";
import {
  isAnswerCompletion,
  isDeliveryCompletion,
  normalizeFactoryCompletionKind,
  type FactoryCompletionKind,
} from "./model";

export type SessionTaskKind = "harness" | "agent" | "subagent" | "tool" | "sandbox";
export type SessionTaskStatus = "running" | "ok" | "error" | "idle";

export interface TaskTranscriptItem {
  id: string;
  kind: "think" | "message" | "tool" | "gate" | "stage" | "event" | "error";
  label: string;
  detail?: string;
  ok?: boolean;
}

export interface SessionTask {
  id: string;
  kind: SessionTaskKind;
  /** Claude-desktop-style type chip, e.g. "Agent · CodeAct" / "Sub-agent" / "Sandbox · 真实". */
  typeLabel: string;
  title: string;
  /** one mono meta line under the title. */
  meta: string;
  status: SessionTaskStatus;
  /** last-activity event index — the panel sorts most-recent first. */
  order: number;
  /** set for kind agent/subagent — enables 「在右栏查看」 jump to the inspector. */
  agentSlug?: string;
  /** Stable generated-tool identity; never infer it back from a translated title. */
  toolName?: string;
  transcript: TaskTranscriptItem[];
  /** #UI-DRILL — 该 agent 的宏观→微观决策下钻数据（仅 kind=agent/subagent）。 */
  drill?: AgentDrill;
}

/** #UI-DRILL — 一个 agent 的 L2 决策卡组数据：计划/思考 · 工具 · 问题 · sub-agent · 真实 I/O。 */
export interface AgentDrill {
  /** 设计推理（harness 为这个 agent 想了什么）。 */
  reasoning: string;
  /** #P4+ — 这个 agent 自选的推理方法/组合（如 "tot → debate"；不默认 ReAct）。 */
  strategy?: string;
  /** 分支决策逻辑。 */
  decisionLogic: string;
  /** 校验/契约/保真发现的问题（validation.agentIssueMap + fidelity）。 */
  problems: string[];
  /** 修订史（每次 refine 的批评意见）。 */
  refineCritiques: string[];
  /** 该 agent 生成/挂载的 sub-agent（agent.created.parentAgent 归组）。 */
  subAgents: Array<{ slug: string; name: string }>;
  /** 父 agent（自己是 sub-agent 时）。 */
  parentAgent?: string;
  /** 沙箱真实 I/O（最近一次）。 */
  io?: { triggerEvent?: string; outputEvent?: string; status?: string; input?: string; output?: string };
  /** 真实 emit 载荷违反下游契约（execution_fidelity）。 */
  fidelityFail?: boolean;
  /** #CHECKLIST — harness 持有的该 agent 验收清单（acceptance 事件的 perAgent 投影；大脑无权改，
   *  条目翻绿只能靠真实执行证据：注册/真跑/code_ran 回执/保真评分）。 */
  checklist?: Array<{ key: string; label: string; pass: boolean; detail: string }>;
}

/** #CHECKLIST — 舰队级验收清单快照（最近一次 finish 尝试的 acceptance 事件）。 */
export interface AcceptanceSnap {
  allPass: boolean;
  evidenceValid: boolean;
  criteria: Array<{ key: string; label: string; pass: boolean; detail: string }>;
  perAgent: Array<{ slug: string; short: string; pass: boolean; items: Array<{ key: string; label: string; pass: boolean; detail: string }> }>;
}

/** 取最近一次 acceptance 快照（未有 finish 尝试 → null）。纯函数，回放一致。 */
export function deriveAcceptance(t: Translate, events: BrainEvent[]): AcceptanceSnap | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.t === "acceptance") {
      const latestRealSandbox = events
        .slice(0, i)
        .reverse()
        .find(
          (event) =>
            event.t === "sandbox" && !event.simulated,
        );
      const evidenceValid = Boolean(
        latestRealSandbox &&
          (latestRealSandbox.fullChainRan ||
            latestRealSandbox.reachedSuccessTerminal),
      );
      const criteria = Array.isArray(e.criteria)
        ? (e.criteria as AcceptanceSnap["criteria"])
        : [];
      const perAgent = Array.isArray(e.perAgent)
        ? (e.perAgent as AcceptanceSnap["perAgent"])
        : [];
      return {
        allPass: evidenceValid && Boolean(e.allPass),
        evidenceValid,
        criteria: evidenceValid
          ? criteria
          : [
              {
                key: "real_sandbox_evidence",
                label: t("factory.workers.acceptance.realSandboxEvidenceLabel"),
                pass: false,
                detail: t("factory.workers.acceptance.invalidEvidenceDetail"),
              },
              ...criteria.map((criterion) => ({
                ...criterion,
                pass: false,
                detail: t("factory.workers.acceptance.noRealEvidenceSuffix", { detail: criterion.detail }),
              })),
            ],
        perAgent: evidenceValid
          ? perAgent
          : perAgent.map((agent) => ({
              ...agent,
              pass: false,
              items: agent.items.map((item) => ({ ...item, pass: false })),
            })),
      };
    }
  }
  return null;
}

const s = (v: unknown): string => (v == null ? "" : String(v));
const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

interface AgentAcc {
  slug: string;
  name: string;
  short: string;
  actionName: string;
  trigger: string[];
  tools: string[];
  isSubAgent: boolean;
  codeExecuted: boolean;
  versions: number;
  refines: number;
  error?: string;
  sandboxStatus?: string;
  lastEventIdx: number;
  transcript: TaskTranscriptItem[];
  // #UI-DRILL — drill-in payload accumulated per agent
  reasoning?: string;
  decisionLogic?: string;
  // #P4+ — the reasoning method/combo this agent chose (e.g. "tot → debate")；AI 自选,非默认 ReAct。
  strategy?: string;
  parentAgent?: string;
  problems: string[];
  refineCritiques: string[];
  fidelityFail?: boolean;
  io?: { triggerEvent?: string; outputEvent?: string; status?: string; input?: string; output?: string };
  checklist?: Array<{ key: string; label: string; pass: boolean; detail: string }>;
}

/** Serialize a tool.call input ONCE (capped — inputs can carry base64 blobs) for agent matching. */
function callText(input: unknown): string {
  if (input == null) return "";
  try {
    return JSON.stringify(input).slice(0, 20_000);
  } catch {
    return "";
  }
}

export function deriveSessionTasks(t: Translate, events: BrainEvent[], running: boolean): SessionTask[] {
  const harnessItems: TaskTranscriptItem[] = [];
  const agents = new Map<string, AgentAcc>();
  const spawns: Array<{ task: string; role?: string; summary?: string; startIdx: number; items: TaskTranscriptItem[] }> = [];
  const toolTasks: Array<{ name: string; desc: string; idx: number }> = [];
  const sandboxes: Array<{ idx: number; simulated: boolean; ok: boolean; meta: string; items: TaskTranscriptItem[] }> = [];

  let thinkBuf = "";
  let thinkBursts = 0;
  let toolCalls = 0;
  let turns = 0;
  let tokens = 0;
  let refines = 0;
  let hasRealSandboxSuccess = false;
  let doneStatus: string | null = null;
  let doneCompletionKind: FactoryCompletionKind = "legacy_unknown";
  let sawError = false;
  let harnessLastIdx = 0;
  // #per-agent-think — attribution cursor: the slug of the agent currently being worked on. Moves
  // onto an agent at agent.created / a forAgent-targeted tool.call / code|refine|inspect|score, and
  // returns to the harness (null) on any harness-scope boundary (harness-level tool.call, sandbox,
  // gates, stage, subagent, done…). think/message bursts flush onto whatever this points at, so an
  // agent card shows its own reasoning stream — not just event summaries. Purely a function of the
  // event order → deterministic on replay.
  let currentAgentSlug: string | null = null;
  const callsById = new Map<string, TaskTranscriptItem>();
  const callKeysById = new Map<string, string[]>();
  let idc = 0;
  const nid = () => `st-${idc++}`;

  const flushThink = () => {
    const text = thinkBuf.trim();
    thinkBuf = "";
    if (!text) return;
    thinkBursts++;
    harnessItems.push({ id: nid(), kind: "think", label: t("factory.workers.transcript.thinkLabel"), detail: clip(text, 160) });
    // Also attribute the burst to the agent under the cursor. Harness keeps the full stream above,
    // so this is additive — no regression to the harness card.
    const cur = currentAgentSlug ? agents.get(currentAgentSlug) : undefined;
    if (cur) { cur.transcript.push({ id: nid(), kind: "think", label: t("factory.workers.transcript.thinkLabel"), detail: clip(text, 200) }); cur.lastEventIdx = Math.max(cur.lastEventIdx, harnessLastIdx); }
  };

  const agentOf = (key: string): AgentAcc | undefined => {
    if (!key) return undefined;
    for (const a of agents.values()) {
      if (a.slug === key || a.actionName === key || a.short === key) return a;
    }
    return undefined;
  };

  events.forEach((e, idx) => {
    switch (e.t) {
      case "model":
        turns++;
        break;
      case "budget":
        tokens = Number(e.tokens ?? tokens) || tokens;
        break;
      case "think":
        thinkBuf += s(e.delta);
        harnessLastIdx = idx;
        break;
      case "message": {
        // A free-form (no-tool-call) reply. The same text usually streamed as think deltas first,
        // so drop the buffer when it duplicates the message (mirrors toBlocks) before recording it.
        const text = s(e.text).trim();
        const b = thinkBuf.trim();
        if (b && text && (b === text || text.startsWith(b) || b.startsWith(text))) thinkBuf = "";
        flushThink();
        if (text) {
          harnessItems.push({ id: nid(), kind: "message", label: t("factory.workers.transcript.messageLabel"), detail: clip(text, 220) });
          const cur = currentAgentSlug ? agents.get(currentAgentSlug) : undefined;
          if (cur) { cur.transcript.push({ id: nid(), kind: "message", label: t("factory.workers.transcript.messageLabel"), detail: clip(text, 260) }); cur.lastEventIdx = idx; }
        }
        harnessLastIdx = idx;
        break;
      }
      case "tool.call": {
        flushThink();
        toolCalls++;
        harnessLastIdx = idx;
        const item: TaskTranscriptItem = { id: s(e.id) || nid(), kind: "tool", label: s(e.role) ? `${s(e.role)} · ${s(e.name)}` : s(e.name), detail: clip(s(e.reasoning), 140) };
        harnessItems.push(item);
        callsById.set(s(e.id), item);
        const keys: string[] = [];
        // #UI-DRILL — prefer the server-provided `forAgent` (the actionName this harness step
        // targets) for RELIABLE attribution; fall back to the legacy substring guess only when it's
        // absent or the agent isn't built yet (e.g. the first design_agent call before agent.created).
        const targeted = agentOf(s(e.forAgent));
        if (targeted) {
          keys.push(targeted.slug);
          targeted.lastEventIdx = idx;
          targeted.transcript.push({ id: nid(), kind: "tool", label: s(e.role) ? `${s(e.role)} · ${s(e.name)}` : s(e.name), detail: clip(s(e.reasoning), 120) });
        } else {
          const text = callText(e.input);
          if (text) {
            for (const a of agents.values()) {
              if ([a.actionName, a.slug, a.short].some((k) => k.length > 2 && text.includes(k))) {
                keys.push(a.slug);
                a.lastEventIdx = idx;
                a.transcript.push({ id: nid(), kind: "tool", label: s(e.role) ? `${s(e.role)} · ${s(e.name)}` : s(e.name), detail: clip(s(e.reasoning), 120) });
              }
            }
          }
        }
        // #per-agent-think — a forAgent-targeted call moves the cursor onto that agent (subsequent
        // reasoning is about it); an untargeted call is harness orchestration → back to the harness.
        currentAgentSlug = targeted ? targeted.slug : null;
        callKeysById.set(s(e.id), keys);
        break;
      }
      case "tool.result": {
        const item = callsById.get(s(e.id));
        if (item) {
          item.ok = Boolean(e.ok);
          if (!item.detail) item.detail = clip(s(e.summary), 140);
        }
        for (const slug of callKeysById.get(s(e.id)) ?? []) {
          const a = agents.get(slug);
          const last = a?.transcript[a.transcript.length - 1];
          if (last && last.kind === "tool") last.ok = Boolean(e.ok);
        }
        break;
      }
      case "agent.created": {
        flushThink();
        const spec = (e.spec ?? {}) as Record<string, unknown>;
        const design = (e.design ?? {}) as Record<string, unknown>;
        const slug = s(spec.slug);
        if (!slug) break;
        const acc =
          agents.get(slug) ??
          ({
            slug,
            name: s(spec.nameZh) || s(spec.short) || slug,
            short: s(spec.short),
            actionName: s(spec.actionName),
            trigger: [],
            tools: [],
            isSubAgent: false,
            codeExecuted: false,
            versions: 0,
            refines: 0,
            lastEventIdx: idx,
            transcript: [],
            problems: [],
            refineCritiques: [],
          } satisfies AgentAcc);
        acc.versions++;
        acc.trigger = (spec.trigger as string[]) ?? acc.trigger;
        acc.tools = (spec.tools as string[]) ?? acc.tools;
        // spec.isSubAgent 现在随事件下发（cardOf 已带上）；slug 约定 "<parent>-sub-<task>" 仅作老转录回放的回退。
        acc.isSubAgent = Boolean(spec.isSubAgent) || slug.includes("-sub-") || acc.isSubAgent;
        acc.codeExecuted = design.codeExecuted === true || acc.codeExecuted;
        // #UI-DRILL — capture the harness's design reasoning + branch logic + parent backref
        acc.reasoning = s(design.reasoning) || acc.reasoning;
        acc.decisionLogic = s(design.decisionLogic) || acc.decisionLogic;
        acc.parentAgent = s(e.parentAgent) || acc.parentAgent;
        if (acc.versions > 1) acc.sandboxStatus = undefined; // re-design voids prior sandbox evidence
        acc.lastEventIdx = idx;
        acc.transcript.push({
          id: nid(),
          kind: "event",
          label: acc.versions === 1 ? t("factory.workers.transcript.designDoneV1") : t("factory.workers.transcript.redesignVersion", { version: acc.versions }),
          detail: clip(s(design.reasoning), 120) || undefined,
          ok: true,
        });
        agents.set(slug, acc);
        harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.producedAgent", { name: acc.name }), ok: true });
        currentAgentSlug = slug; // subsequent reasoning is about the agent we just designed
        break;
      }
      case "code": {
        const a = agentOf(s(e.actionName));
        if (a) {
          a.lastEventIdx = idx;
          a.transcript.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.generateCode", { source: s(e.codeSource) || "render" }), ok: true });
          currentAgentSlug = a.slug;
        }
        break;
      }
      case "refine": {
        refines++;
        const a = agentOf(s(e.actionName));
        if (a) {
          a.refines++;
          a.sandboxStatus = undefined; // a refine invalidates the last sandbox verdict
          a.lastEventIdx = idx;
          a.transcript.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.refineLabel"), detail: clip(s(e.critique), 120) });
          if (s(e.critique)) a.refineCritiques.push(clip(s(e.critique), 200));
          currentAgentSlug = a.slug;
        }
        break;
      }
      case "score.delta": {
        const a = agentOf(s(e.actionName));
        if (a) {
          const d = Number(e.delta ?? 0);
          a.transcript.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.score", { delta: d >= 0 ? `▲+${d}` : `▼${d}` }), ok: !e.regression });
          currentAgentSlug = a.slug;
        }
        break;
      }
      case "revert": {
        const a = agentOf(s(e.actionName));
        if (a) { a.transcript.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.revert", { attempt: s(e.revertedToAttempt) }), ok: false }); currentAgentSlug = a.slug; }
        break;
      }
      case "inspect": {
        const a = agentOf(s(e.agentSlug));
        if (a) {
          a.lastEventIdx = idx;
          if (e.error || s(e.status) === "error") a.error = s(e.error) || t("factory.workers.agent.runError");
          a.transcript.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.trialRun", { status: s(e.status) }), detail: e.error ? clip(s(e.error), 100) : undefined, ok: !e.error && s(e.status) !== "error" });
          currentAgentSlug = a.slug;
        }
        break;
      }
      case "sandbox": {
        flushThink();
        currentAgentSlug = null; // whole-chain deploy → harness scope
        harnessLastIdx = idx;
        const simulated = Boolean(e.simulated);
        const ok =
          !simulated &&
          (Boolean(e.fullChainRan) || Boolean(e.reachedSuccessTerminal));
        if (!simulated) hasRealSandboxSuccess = ok;
        const items: TaskTranscriptItem[] = [];
        const runs = (e.agentRuns as Array<Record<string, unknown>> | undefined) ?? [];
        // #R3 — execution-fidelity failures (agentShort list) → per-agent drill badge
        const fidelityFail = new Set(((e.fidelityFailures as string[] | undefined) ?? []).map(String));
        for (const r of runs) {
          items.push({
            id: nid(),
            kind: "event",
            label: `${s(r.agentShort)} · ${s(r.status)}`,
            detail: clip(`${s(r.triggerEvent)} → ${s(r.outputEvent) || t("factory.workers.transcript.noOutputEvent")}`, 110),
            ok: simulated ? false : s(r.status) !== "error",
          });
          const a = agentOf(s(r.agentShort)) ?? agentOf(s(r.agentSlug));
          if (a && !simulated) {
            a.sandboxStatus = s(r.status);
            a.lastEventIdx = idx;
            a.transcript.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.sandboxIo", { status: s(r.status) }), detail: clip(`${s(r.triggerEvent)} → ${s(r.outputEvent)}`, 100), ok: s(r.status) !== "error" });
            // #UI-DRILL — latest real I/O snapshot (payloads clipped: drill shows the head, not blobs)
            const asStr = (v: unknown) => { try { return v == null ? undefined : clip(JSON.stringify(v), 600); } catch { return undefined; } };
            a.io = { triggerEvent: s(r.triggerEvent) || undefined, outputEvent: s(r.outputEvent) || undefined, status: s(r.status) || undefined, input: asStr(r.inputPayload), output: asStr(r.outputPayload) };
            if (fidelityFail.has(a.short) || fidelityFail.has(a.name)) a.fidelityFail = true;
          }
        }
        sandboxes.push({
          idx,
          simulated,
          ok,
          meta: `${simulated ? t("factory.workers.sandbox.invalidEvidencePrefix") : ""}${t("factory.workers.sandbox.meta", { fns: s(e.functionsRegistered ?? 0), ran: s(e.ran ?? 0) })}${!simulated && e.reachedSuccessTerminal ? t("factory.workers.sandbox.reachedTerminal") : ""}`,
          items,
        });
        harnessItems.push({ id: nid(), kind: "event", label: simulated ? t("factory.workers.transcript.simulatedRecord") : t("factory.workers.transcript.realSandboxDeploy"), detail: t("factory.workers.transcript.sandboxDeployDetail", { fns: s(e.functionsRegistered ?? 0), ran: s(e.ran ?? 0) }), ok });
        break;
      }
      case "validation": {
        currentAgentSlug = null; // graph-wide validation → harness scope
        // #UI-DRILL — per-agent problems from validate_graph (agentIssueMap keyed by actionName)
        const map = (e.agentIssueMap as Record<string, unknown[]> | undefined) ?? {};
        for (const [action, list] of Object.entries(map)) {
          const a = agentOf(action);
          if (!a || !Array.isArray(list) || !list.length) continue;
          a.problems = list.slice(0, 8).map((it) => {
            const o = it as Record<string, unknown>;
            return clip(s(o.kind) ? `${s(o.kind)}${o.event ? ` · ${s(o.event)}` : ""}${o.field ? ` · ${s(o.field)}` : ""}${o.missingFields ? t("factory.workers.transcript.missingFields", { fields: (o.missingFields as string[]).join("/") }) : ""}` : JSON.stringify(o), 160);
          });
          a.lastEventIdx = idx;
        }
        harnessItems.push({ id: nid(), kind: "event", label: e.ok ? t("factory.workers.transcript.validationPassed") : t("factory.workers.transcript.validationFoundIssues"), detail: e.ok ? undefined : clip(((e.issues as string[]) ?? []).join("; "), 140), ok: Boolean(e.ok) });
        break;
      }
      case "subagent.start": {
        flushThink();
        currentAgentSlug = null; // a spawned sub-brain is not a deployed agent → harness scope
        harnessLastIdx = idx;
        const task = s(e.task);
        // #ROLE — 子大脑的角色由 AI 在 spawn 时自动设定（开放词汇）；卡片用角色称呼它。
        spawns.push({ task, role: s(e.role) || undefined, startIdx: idx, items: [{ id: nid(), kind: "event", label: t("factory.workers.transcript.spawnStart"), detail: clip(task, 140) }] });
        harnessItems.push({ id: nid(), kind: "event", label: task.startsWith("认知专家") ? t("factory.workers.transcript.spawnCognitiveSpecialist") : t("factory.workers.transcript.spawnSubBrain"), detail: clip(task.replace(/^认知专家 · /, ""), 120) });
        break;
      }
      case "subagent.done": {
        // Task-matched pairing first — parallel cognitive specialists finish out of order.
        const opens = [...spawns].reverse().filter((x) => x.summary === undefined);
        const open = opens.find((x) => x.task === s(e.task)) ?? opens[0];
        if (open) {
          open.summary = s(e.summary);
          open.items.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.spawnDone"), detail: clip(s(e.summary), 140), ok: true });
        }
        break;
      }
      case "group.start": {
        // #SUBAGENT-GROUP — narrate a reasoning-driven group fan-out in the background panel.
        flushThink();
        currentAgentSlug = null;
        harnessLastIdx = idx;
        harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.groupStart", { label: s(e.label) }), detail: clip(t("factory.workers.transcript.groupStartDetail", { count: Number(e.members ?? 0) }), 120) });
        break;
      }
      case "group.done":
        harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.groupDone", { label: s(e.label) }), detail: clip(t("factory.workers.transcript.groupDoneDetail", { ok: Number(e.ok ?? 0), total: Number(e.total ?? 0) }), 120), ok: Number(e.ok ?? 0) > 0 });
        break;
      case "tool.created":
        flushThink();
        currentAgentSlug = null; // tool authoring → harness scope
        harnessLastIdx = idx;
        toolTasks.push({ name: s(e.name), desc: s(e.description), idx });
        harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.toolCreated", { name: s(e.name) }), ok: true });
        break;
      case "tool.schema":
        harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.toolSchema", { name: s(e.name) }), detail: `${s(e.method)} ${clip(s(e.url), 60)}`, ok: true });
        break;
      case "tool.search":
        harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.toolSearch", { query: clip(s(e.query), 24) }), detail: t("factory.workers.transcript.toolSearchDetail", { count: ((e.results as unknown[]) ?? []).length }) });
        break;
      case "skill.created":
        harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.skillCreated", { name: s(e.name) }), detail: clip(s(e.purpose), 80), ok: true });
        break;
      case "acceptance": {
        // #CHECKLIST — harness 持有的验收清单：finish 每次尝试都发一份快照。harness 卡记一条
        // gate 事件；per-agent items 落到各 agent 的 drill（大脑无权改，翻绿=真实执行证据）。
        currentAgentSlug = null;
        const crit = Array.isArray(e.criteria)
          ? (e.criteria as Array<{ label: string; pass: boolean }>).map(
              (criterion) => ({
                ...criterion,
                pass: hasRealSandboxSuccess && criterion.pass,
              }),
            )
          : [];
        const failing = crit.filter((c) => !c.pass);
        const acceptancePass = hasRealSandboxSuccess && Boolean(e.allPass);
        harnessItems.push({ id: nid(), kind: "gate", label: acceptancePass ? t("factory.workers.transcript.acceptanceAllGreen") : t("factory.workers.transcript.acceptanceProgress", { passed: crit.length - failing.length, total: crit.length }), detail: !hasRealSandboxSuccess ? t("factory.workers.transcript.acceptanceNoEvidence") : failing.length ? clip(failing.map((c) => c.label).join("; "), 140) : undefined, ok: acceptancePass });
        for (const p of Array.isArray(e.perAgent) ? (e.perAgent as Array<Record<string, unknown>>) : []) {
          const a = agentOf(s(p.slug)) ?? agentOf(s(p.short));
          if (!a) continue;
          a.checklist = Array.isArray(p.items)
            ? (p.items as Array<{ key: string; label: string; pass: boolean; detail: string }>).map(
                (item) => ({
                  ...item,
                  pass: hasRealSandboxSuccess && item.pass,
                }),
              )
            : [];
          a.lastEventIdx = idx;
        }
        break;
      }
      case "strategy": {
        // #P4+ — AI 就某子问题自选的推理方法/组合(不默认 ReAct)。归给对应 agent(forAgent)或当前 agent,
        // 显示在它的卡上;无归属则进 harness。
        const chain = (Array.isArray(e.steps) ? (e.steps as unknown[]).map((x) => s(x)) : []).filter(Boolean).join(" → ") || "react";
        const via = s(e.chosenBy) === "ai" ? t("factory.workers.strategy.chosenByAi") : t("factory.workers.strategy.chosenByDefault");
        const target = agentOf(s(e.forAgent)) ?? (currentAgentSlug ? agents.get(currentAgentSlug) : undefined);
        if (target) {
          target.strategy = chain;
          target.transcript.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.reasoningMethod", { chain }), detail: clip(s(e.rationale), 90) });
        } else {
          harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.reasoningMethodVia", { chain, via }), detail: clip(s(e.rationale), 90) });
        }
        break;
      }
      case "reasoning.step": {
        // #REASONING-KERNEL — a reasoning method actually EXECUTED (not just declared): show the method +
        // its real conclusion (combo → one per step, index/total). Under the agent it was for, else harness.
        const strat = s(e.strategy) || t("factory.workers.strategy.defaultStrategyName");
        const stepN = Number(e.index ?? 0) + 1;
        const totalN = Number(e.total ?? 1);
        const label = t("factory.workers.transcript.reasoningExec", { strat, steps: totalN > 1 ? ` (${stepN}/${totalN})` : "" });
        const detail = clip(s(e.output), 160);
        const target = agentOf(s(e.forAgent)) ?? (currentAgentSlug ? agents.get(currentAgentSlug) : undefined);
        if (target) target.transcript.push({ id: nid(), kind: "event", label, detail });
        else harnessItems.push({ id: nid(), kind: "event", label, detail });
        break;
      }
      case "compaction":
        harnessItems.push({ id: nid(), kind: "stage", label: t("factory.workers.transcript.compaction"), detail: clip(s(e.summary), 100) });
        break;
      case "tool.progress": {
        // #HEARTBEAT — 心跳只刷新活跃度（保持"运行中"状态），不刷屏。
        harnessLastIdx = idx;
        for (const slug of callKeysById.get(s(e.id)) ?? []) { const a = agents.get(slug); if (a) a.lastEventIdx = idx; }
        break;
      }
      case "ontology.revision": {
        // #REVISION — 本体漂移提案：真实载荷 vs event_data 持续不一致，等 ask_user 确认。
        const props = (e.proposals as Array<Record<string, unknown>> | undefined) ?? [];
        harnessItems.push({
          id: nid(),
          kind: "gate",
          label: t("factory.workers.transcript.ontologyRevision", { count: props.length }),
          detail: clip(props.slice(0, 2).map((p) => `${s(p.event)}.${s(p.field)}(${s(p.kind)})`).join("; "), 120),
        });
        break;
      }
      case "policy": {
        // #POLICY — 前置路由的可解释决策：这次请求走什么路线、为什么。
        const pipelineKey: Record<string, string> = { full: "full", skinny: "skinny", analyze: "analyze", ask_first: "askFirst" };
        const pipeline = pipelineKey[s(e.pipeline)] ? t(`factory.workers.pipeline.${pipelineKey[s(e.pipeline)]}`) : s(e.pipeline);
        harnessItems.push({
          id: nid(),
          kind: "stage",
          label: `${t("factory.workers.transcript.reasoningRoute", { pipeline, band: s(e.band) })}${e.deepUnderstand ? t("factory.workers.transcript.routeDeepRead") : ""}${e.deepCritique ? t("factory.workers.transcript.routeDeepCritique") : ""}${s(e.tierBias) ? t("factory.workers.transcript.routeTier", { tier: s(e.tierBias) }) : ""}`,
          detail: clip(((e.reasons as string[]) ?? []).join("; "), 140),
        });
        break;
      }
      case "clarify":
        flushThink();
        currentAgentSlug = null; // HITL gate → harness scope
        harnessItems.push({ id: nid(), kind: "gate", label: t("factory.workers.transcript.askUser"), detail: clip(s(e.question), 120) });
        break;
      case "test.cases":
        flushThink();
        currentAgentSlug = null;
        harnessItems.push({ id: nid(), kind: "gate", label: t("factory.workers.transcript.awaitTestCases"), detail: t("factory.workers.transcript.testCasesDetail", { count: ((e.cases as unknown[]) ?? []).length }) });
        break;
      case "boundary.cases":
        flushThink();
        currentAgentSlug = null;
        harnessItems.push({ id: nid(), kind: "gate", label: t("factory.workers.transcript.awaitBoundaryCases"), detail: t("factory.workers.transcript.boundaryCasesDetail", { count: ((e.proposals as unknown[]) ?? []).length }) });
        break;
      case "stage": {
        currentAgentSlug = null; // a new stage is a harness-level phase transition
        if (s(e.status) === "active") {
          const stage = ["read", "plan", "design", "validate", "sandbox", "deliver"].includes(s(e.stage)) ? t(`factory.model.stage.${s(e.stage)}`) : s(e.stage);
          harnessItems.push({ id: nid(), kind: "stage", label: t("factory.workers.transcript.enterStage", { stage, role: s(e.role) ? ` (${s(e.role)})` : "" }) });
        }
        break;
      }
      case "error":
        flushThink();
        currentAgentSlug = null;
        sawError = true;
        harnessItems.push({ id: nid(), kind: "error", label: t("factory.workers.transcript.errorLabel"), detail: clip(s(e.message), 140), ok: false });
        break;
      case "done":
        flushThink();
        currentAgentSlug = null;
        doneStatus = s(e.status);
        doneCompletionKind = normalizeFactoryCompletionKind(e.completionKind);
        if (doneStatus === "waiting_human") {
          harnessItems.push({ id: nid(), kind: "gate", label: t("factory.workers.transcript.awaitHumanReply"), detail: t("factory.workers.transcript.checkpointSaved") });
        } else if (isAnswerCompletion(doneStatus, doneCompletionKind)) {
          harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.answerComplete"), ok: true });
        } else if (isDeliveryCompletion(doneStatus, doneCompletionKind)) {
          harnessItems.push({ id: nid(), kind: "event", label: hasRealSandboxSuccess ? t("factory.workers.transcript.deliveryCompletePass") : t("factory.workers.transcript.deliveryRecordNoEvidence"), ok: hasRealSandboxSuccess });
        } else if (doneCompletionKind === "legacy_unknown") {
          harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.endUnknownKind") });
        } else {
          harnessItems.push({ id: nid(), kind: "event", label: t("factory.workers.transcript.endStatus", { status: doneStatus }), ok: false });
        }
        break;
    }
  });
  flushThink();

  const tasks: SessionTask[] = [];
  const lastIdx = events.length - 1;
  const answerCompleted = isAnswerCompletion(doneStatus, doneCompletionKind);
  const deliveryCompleted = isDeliveryCompletion(doneStatus, doneCompletionKind) && hasRealSandboxSuccess;
  const ambiguousLegacyCompletion = doneStatus !== null && doneCompletionKind === "legacy_unknown";

  if (harnessItems.length) {
    tasks.push({
      id: "harness",
      kind: "harness",
      typeLabel: t("factory.workers.task.harnessTypeLabel"),
      title: t("factory.workers.task.harnessTitle"),
      meta: `${t("factory.workers.task.harnessMeta", { turns, toolCalls, thinkBursts })}${tokens ? t("factory.workers.task.harnessMetaTokens", { tokens: Math.round(tokens / 1000) }) : ""}${refines ? t("factory.workers.task.metaRevisions", { refines }) : ""}`,
      status: running ? "running" : sawError ? "error" : doneStatus === "waiting_human" ? "idle" : answerCompleted || deliveryCompleted ? "ok" : ambiguousLegacyCompletion ? "idle" : doneStatus ? "error" : "ok",
      order: harnessLastIdx,
      transcript: harnessItems.slice(-240),
    });
  }

  for (const a of agents.values()) {
    // Errors take precedence over the recency "running" heuristic — a sandbox failure
    // must read red immediately, not pulse green for the next 15 events.
    const status: SessionTaskStatus = a.error || a.sandboxStatus === "error" || a.fidelityFail ? "error" : running && lastIdx - a.lastEventIdx < 15 ? "running" : "ok";
    // #UI-DRILL — sub-agents this agent spawned: reliable parentAgent backref first, slug-prefix
    // convention ("<parent>-sub-") as the replay fallback for old transcripts.
    const subAgents = [...agents.values()]
      .filter((x) => x.slug !== a.slug && (x.parentAgent === a.actionName || (x.isSubAgent && x.slug.startsWith(`${a.slug}-sub-`))))
      .map((x) => ({ slug: x.slug, name: x.name }));
    tasks.push({
      id: a.slug,
      kind: a.isSubAgent ? "subagent" : "agent",
      typeLabel: a.isSubAgent ? t("factory.workers.task.subagentDeployable") : a.codeExecuted ? t("factory.workers.task.agentCodeAct") : t("factory.workers.task.agentDeclarative"),
      title: a.name,
      meta: `${a.trigger[0] ? `⚡${clip(a.trigger[0]!, 20)} · ` : ""}${t("factory.workers.task.agentMeta", { tools: a.tools.length, versions: a.versions })}${a.refines ? t("factory.workers.task.metaRevisions", { refines: a.refines }) : ""}${a.sandboxStatus ? t("factory.workers.task.agentMetaSandbox", { status: a.sandboxStatus }) : ""}${a.fidelityFail ? t("factory.workers.task.agentMetaContractViolation") : ""}`,
      status,
      order: a.lastEventIdx,
      agentSlug: a.slug,
      transcript: a.transcript.slice(-140),
      drill: {
        reasoning: a.reasoning ?? "",
        strategy: a.strategy,
        decisionLogic: a.decisionLogic ?? "",
        problems: [...a.problems, ...(a.fidelityFail ? [t("factory.workers.drill.fidelityFailProblem")] : [])],
        refineCritiques: a.refineCritiques,
        subAgents,
        parentAgent: a.parentAgent,
        io: a.io,
        fidelityFail: a.fidelityFail,
        checklist: a.checklist,
      },
    });
  }

  spawns.forEach((x, i) => {
    // 认知专家（specialists 轻通道）与重通道子大脑分开标注——它们是工厂内部的两种派生。
    const isSpecialist = x.task.startsWith("认知专家");
    tasks.push({
      id: `spawn-${i}`,
      kind: "subagent",
      // #ROLE — AI 设定的角色优先（「证据调查员」），其次固定内部角色（认知专家/子大脑）。
      typeLabel: x.role ? `Sub-agent · ${x.role}` : isSpecialist ? t("factory.workers.task.subagentCognitiveSpecialist") : t("factory.workers.task.subagentSubBrain"),
      title: clip(isSpecialist ? x.task.replace(/^认知专家 · /, "") : x.task, 30) || t("factory.workers.task.subagentFallbackTitle", { n: i + 1 }),
      meta: x.summary !== undefined ? clip(x.summary, 60) : t("factory.workers.task.subagentReasoning"),
      status: x.summary !== undefined ? "ok" : running ? "running" : "idle",
      order: x.startIdx,
      transcript: x.items,
    });
  });

  toolTasks.forEach((tool) => {
    tasks.push({
      id: `tool-${tool.name}`,
      kind: "tool",
      toolName: tool.name,
      typeLabel: t("factory.workers.task.toolTypeLabel"),
      title: t("factory.workers.task.toolTitle", { name: tool.name }),
      meta: clip(tool.desc, 70) || t("factory.workers.task.toolMetaWritten"),
      status: "ok",
      order: tool.idx,
      transcript: [{ id: `tt-${tool.idx}`, kind: "event", label: `create_tool ${tool.name}`, detail: clip(tool.desc, 140), ok: true }],
    });
  });

  sandboxes.forEach((sb, i) => {
    tasks.push({
      id: `sandbox-${i}`,
      kind: "sandbox",
      typeLabel: sb.simulated ? t("factory.workers.task.sandboxInvalidTypeLabel") : t("factory.workers.task.sandboxRealTypeLabel"),
      title: t("factory.workers.task.sandboxTitle", { n: i + 1 }),
      meta: sb.meta,
      status: sb.ok ? "ok" : "error",
      order: sb.idx,
      transcript: sb.items,
    });
  });

  // Most-recent activity first (Claude-desktop ordering); the live harness naturally floats up.
  tasks.sort((a, b) => b.order - a.order);
  return tasks;
}

export interface GeneratedToolRow {
  name: string;
  description: string;
}

/** Tools the brain created DURING this transcript — drives the「存入工具库？」ask-user cards. */
export function deriveGeneratedTools(events: BrainEvent[]): GeneratedToolRow[] {
  const m = new Map<string, GeneratedToolRow>();
  for (const e of events) {
    if (e.t !== "tool.created") continue;
    const name = s(e.name);
    if (name) m.set(name, { name, description: s(e.description) });
  }
  return [...m.values()];
}
