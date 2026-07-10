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
  transcript: TaskTranscriptItem[];
  /** #UI-DRILL — 该 agent 的宏观→微观决策下钻数据（仅 kind=agent/subagent）。 */
  drill?: AgentDrill;
}

/** #UI-DRILL — 一个 agent 的 L2 决策卡组数据：计划/思考 · 工具 · 问题 · sub-agent · 真实 I/O。 */
export interface AgentDrill {
  /** 设计推理（harness 为这个 agent 想了什么）。 */
  reasoning: string;
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
  parentAgent?: string;
  problems: string[];
  refineCritiques: string[];
  fidelityFail?: boolean;
  io?: { triggerEvent?: string; outputEvent?: string; status?: string; input?: string; output?: string };
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

export function deriveSessionTasks(events: BrainEvent[], running: boolean): SessionTask[] {
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
  let doneStatus: string | null = null;
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
    const t = thinkBuf.trim();
    thinkBuf = "";
    if (!t) return;
    thinkBursts++;
    harnessItems.push({ id: nid(), kind: "think", label: "推理", detail: clip(t, 160) });
    // Also attribute the burst to the agent under the cursor. Harness keeps the full stream above,
    // so this is additive — no regression to the harness card.
    const cur = currentAgentSlug ? agents.get(currentAgentSlug) : undefined;
    if (cur) { cur.transcript.push({ id: nid(), kind: "think", label: "推理", detail: clip(t, 200) }); cur.lastEventIdx = Math.max(cur.lastEventIdx, harnessLastIdx); }
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
          harnessItems.push({ id: nid(), kind: "message", label: "回复", detail: clip(text, 220) });
          const cur = currentAgentSlug ? agents.get(currentAgentSlug) : undefined;
          if (cur) { cur.transcript.push({ id: nid(), kind: "message", label: "回复", detail: clip(text, 260) }); cur.lastEventIdx = idx; }
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
          label: acc.versions === 1 ? "设计完成 · v1" : `重新设计 · v${acc.versions}`,
          detail: clip(s(design.reasoning), 120) || undefined,
          ok: true,
        });
        agents.set(slug, acc);
        harnessItems.push({ id: nid(), kind: "event", label: `产出智能体 ${acc.name}`, ok: true });
        currentAgentSlug = slug; // subsequent reasoning is about the agent we just designed
        break;
      }
      case "code": {
        const a = agentOf(s(e.actionName));
        if (a) {
          a.lastEventIdx = idx;
          a.transcript.push({ id: nid(), kind: "event", label: `生成代码（${s(e.codeSource) || "render"}）`, ok: true });
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
          a.transcript.push({ id: nid(), kind: "event", label: "修订", detail: clip(s(e.critique), 120) });
          if (s(e.critique)) a.refineCritiques.push(clip(s(e.critique), 200));
          currentAgentSlug = a.slug;
        }
        break;
      }
      case "score.delta": {
        const a = agentOf(s(e.actionName));
        if (a) {
          const d = Number(e.delta ?? 0);
          a.transcript.push({ id: nid(), kind: "event", label: `评分 ${d >= 0 ? `▲+${d}` : `▼${d}`}`, ok: !e.regression });
          currentAgentSlug = a.slug;
        }
        break;
      }
      case "revert": {
        const a = agentOf(s(e.actionName));
        if (a) { a.transcript.push({ id: nid(), kind: "event", label: `回滚到第 ${s(e.revertedToAttempt)} 版之前`, ok: false }); currentAgentSlug = a.slug; }
        break;
      }
      case "inspect": {
        const a = agentOf(s(e.agentSlug));
        if (a) {
          a.lastEventIdx = idx;
          if (e.error || s(e.status) === "error") a.error = s(e.error) || "运行出错";
          a.transcript.push({ id: nid(), kind: "event", label: `试运行 ${s(e.status)}`, detail: e.error ? clip(s(e.error), 100) : undefined, ok: !e.error && s(e.status) !== "error" });
          currentAgentSlug = a.slug;
        }
        break;
      }
      case "sandbox": {
        flushThink();
        currentAgentSlug = null; // whole-chain deploy → harness scope
        harnessLastIdx = idx;
        const ok = Boolean(e.fullChainRan) || Boolean(e.reachedSuccessTerminal);
        const items: TaskTranscriptItem[] = [];
        const runs = (e.agentRuns as Array<Record<string, unknown>> | undefined) ?? [];
        // #R3 — execution-fidelity failures (agentShort list) → per-agent drill badge
        const fidelityFail = new Set(((e.fidelityFailures as string[] | undefined) ?? []).map(String));
        for (const r of runs) {
          items.push({
            id: nid(),
            kind: "event",
            label: `${s(r.agentShort)} · ${s(r.status)}`,
            detail: clip(`${s(r.triggerEvent)} → ${s(r.outputEvent) || "（无产出事件）"}`, 110),
            ok: s(r.status) !== "error",
          });
          const a = agentOf(s(r.agentShort)) ?? agentOf(s(r.agentSlug));
          if (a) {
            a.sandboxStatus = s(r.status);
            a.lastEventIdx = idx;
            a.transcript.push({ id: nid(), kind: "event", label: `沙箱 I/O · ${s(r.status)}`, detail: clip(`${s(r.triggerEvent)} → ${s(r.outputEvent)}`, 100), ok: s(r.status) !== "error" });
            // #UI-DRILL — latest real I/O snapshot (payloads clipped: drill shows the head, not blobs)
            const asStr = (v: unknown) => { try { return v == null ? undefined : clip(JSON.stringify(v), 600); } catch { return undefined; } };
            a.io = { triggerEvent: s(r.triggerEvent) || undefined, outputEvent: s(r.outputEvent) || undefined, status: s(r.status) || undefined, input: asStr(r.inputPayload), output: asStr(r.outputPayload) };
            if (fidelityFail.has(a.short) || fidelityFail.has(a.name)) a.fidelityFail = true;
          }
        }
        sandboxes.push({
          idx,
          simulated: Boolean(e.simulated),
          ok,
          meta: `函数 ${s(e.functionsRegistered ?? 0)} · 跑 ${s(e.ran ?? 0)}${e.reachedSuccessTerminal ? " · 终点达成" : ""}`,
          items,
        });
        harnessItems.push({ id: nid(), kind: "event", label: e.simulated ? "沙箱（模拟）部署" : "真沙箱部署", detail: `部署 ${s(e.functionsRegistered ?? 0)} · 跑 ${s(e.ran ?? 0)}`, ok });
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
            return clip(s(o.kind) ? `${s(o.kind)}${o.event ? ` · ${s(o.event)}` : ""}${o.field ? ` · ${s(o.field)}` : ""}${o.missingFields ? ` · 缺 ${(o.missingFields as string[]).join("/")}` : ""}` : JSON.stringify(o), 160);
          });
          a.lastEventIdx = idx;
        }
        harnessItems.push({ id: nid(), kind: "event", label: e.ok ? "校验通过" : "校验发现问题", detail: e.ok ? undefined : clip(((e.issues as string[]) ?? []).join("；"), 140), ok: Boolean(e.ok) });
        break;
      }
      case "subagent.start": {
        flushThink();
        currentAgentSlug = null; // a spawned sub-brain is not a deployed agent → harness scope
        harnessLastIdx = idx;
        const task = s(e.task);
        // #ROLE — 子大脑的角色由 AI 在 spawn 时自动设定（开放词汇）；卡片用角色称呼它。
        spawns.push({ task, role: s(e.role) || undefined, startIdx: idx, items: [{ id: nid(), kind: "event", label: "启动", detail: clip(task, 140) }] });
        harnessItems.push({ id: nid(), kind: "event", label: task.startsWith("认知专家") ? "派生认知专家" : "派生子大脑", detail: clip(task.replace(/^认知专家 · /, ""), 120) });
        break;
      }
      case "subagent.done": {
        // Task-matched pairing first — parallel cognitive specialists finish out of order.
        const opens = [...spawns].reverse().filter((x) => x.summary === undefined);
        const open = opens.find((x) => x.task === s(e.task)) ?? opens[0];
        if (open) {
          open.summary = s(e.summary);
          open.items.push({ id: nid(), kind: "event", label: "完成", detail: clip(s(e.summary), 140), ok: true });
        }
        break;
      }
      case "tool.created":
        flushThink();
        currentAgentSlug = null; // tool authoring → harness scope
        harnessLastIdx = idx;
        toolTasks.push({ name: s(e.name), desc: s(e.description), idx });
        harnessItems.push({ id: nid(), kind: "event", label: `造工具 ${s(e.name)}`, ok: true });
        break;
      case "tool.schema":
        harnessItems.push({ id: nid(), kind: "event", label: `提取 API schema · ${s(e.name)}`, detail: `${s(e.method)} ${clip(s(e.url), 60)}`, ok: true });
        break;
      case "tool.search":
        harnessItems.push({ id: nid(), kind: "event", label: `搜工具「${clip(s(e.query), 24)}」`, detail: `${((e.results as unknown[]) ?? []).length} 个候选` });
        break;
      case "skill.created":
        harnessItems.push({ id: nid(), kind: "event", label: `造技能 ${s(e.name)}`, detail: clip(s(e.purpose), 80), ok: true });
        break;
      case "compaction":
        harnessItems.push({ id: nid(), kind: "stage", label: "上下文折叠", detail: clip(s(e.summary), 100) });
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
          label: `本体修订提案 · ${props.length} 条`,
          detail: clip(props.slice(0, 2).map((p) => `${s(p.event)}.${s(p.field)}(${s(p.kind)})`).join("；"), 120),
        });
        break;
      }
      case "policy": {
        // #POLICY — 前置路由的可解释决策：这次请求走什么路线、为什么。
        const PIPELINE_ZH: Record<string, string> = { full: "完整生成", skinny: "定点修改", analyze: "只读分析", ask_first: "先澄清" };
        harnessItems.push({
          id: nid(),
          kind: "stage",
          label: `推理路线 · ${PIPELINE_ZH[s(e.pipeline)] ?? s(e.pipeline)}（${s(e.band)}）${e.deepUnderstand ? " · 深读" : ""}${e.deepCritique ? " · 深评" : ""}${s(e.tierBias) ? ` · ${s(e.tierBias)}档` : ""}`,
          detail: clip(((e.reasons as string[]) ?? []).join("；"), 140),
        });
        break;
      }
      case "clarify":
        flushThink();
        currentAgentSlug = null; // HITL gate → harness scope
        harnessItems.push({ id: nid(), kind: "gate", label: "询问用户", detail: clip(s(e.question), 120) });
        break;
      case "test.cases":
        flushThink();
        currentAgentSlug = null;
        harnessItems.push({ id: nid(), kind: "gate", label: "等待测试用例确认", detail: `${((e.cases as unknown[]) ?? []).length} 个用例` });
        break;
      case "boundary.cases":
        flushThink();
        currentAgentSlug = null;
        harnessItems.push({ id: nid(), kind: "gate", label: "等待边界事件分类", detail: `${((e.proposals as unknown[]) ?? []).length} 个` });
        break;
      case "stage": {
        currentAgentSlug = null; // a new stage is a harness-level phase transition
        if (s(e.status) === "active") harnessItems.push({ id: nid(), kind: "stage", label: `进入阶段 · ${s(e.stage)}${s(e.role) ? `（${s(e.role)}）` : ""}` });
        break;
      }
      case "error":
        flushThink();
        currentAgentSlug = null;
        sawError = true;
        harnessItems.push({ id: nid(), kind: "error", label: "出错", detail: clip(s(e.message), 140), ok: false });
        break;
      case "done":
        flushThink();
        currentAgentSlug = null;
        doneStatus = s(e.status);
        harnessItems.push({ id: nid(), kind: "event", label: `结束 · ${doneStatus}`, ok: doneStatus === "finished" });
        break;
    }
  });
  flushThink();

  const tasks: SessionTask[] = [];
  const lastIdx = events.length - 1;

  if (harnessItems.length) {
    tasks.push({
      id: "harness",
      kind: "harness",
      typeLabel: "Harness · ReAct 主循环",
      title: "工厂大脑",
      meta: `${turns} 轮 · ${toolCalls} 次工具 · ${thinkBursts} 段推理${tokens ? ` · ${Math.round(tokens / 1000)}k tok` : ""}${refines ? ` · ${refines} 修订` : ""}`,
      status: running ? "running" : sawError || (doneStatus && doneStatus !== "finished") ? "error" : doneStatus === "finished" ? "ok" : "ok",
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
      typeLabel: a.isSubAgent ? "Sub-agent · 可部署" : a.codeExecuted ? "Agent · CodeAct" : "Agent · 声明式工作流",
      title: a.name,
      meta: `${a.trigger[0] ? `⚡${clip(a.trigger[0]!, 20)} · ` : ""}${a.tools.length} 工具 · v${a.versions}${a.refines ? ` · ${a.refines} 修订` : ""}${a.sandboxStatus ? ` · 沙箱 ${a.sandboxStatus}` : ""}${a.fidelityFail ? " · ⚠契约违约" : ""}`,
      status,
      order: a.lastEventIdx,
      agentSlug: a.slug,
      transcript: a.transcript.slice(-140),
      drill: {
        reasoning: a.reasoning ?? "",
        decisionLogic: a.decisionLogic ?? "",
        problems: [...a.problems, ...(a.fidelityFail ? ["执行保真失败：真实 emit 载荷不满足下游契约"] : [])],
        refineCritiques: a.refineCritiques,
        subAgents,
        parentAgent: a.parentAgent,
        io: a.io,
        fidelityFail: a.fidelityFail,
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
      typeLabel: x.role ? `Sub-agent · ${x.role}` : isSpecialist ? "Sub-agent · 认知专家" : "Sub-agent · 子大脑",
      title: clip(isSpecialist ? x.task.replace(/^认知专家 · /, "") : x.task, 30) || `子智能体 #${i + 1}`,
      meta: x.summary !== undefined ? clip(x.summary, 60) : "推理中…",
      status: x.summary !== undefined ? "ok" : running ? "running" : "idle",
      order: x.startIdx,
      transcript: x.items,
    });
  });

  toolTasks.forEach((t) => {
    tasks.push({
      id: `tool-${t.name}`,
      kind: "tool",
      typeLabel: "Tool · 声明式",
      title: `造工具 ${t.name}`,
      meta: clip(t.desc, 70) || "已写入工具库",
      status: "ok",
      order: t.idx,
      transcript: [{ id: `tt-${t.idx}`, kind: "event", label: `create_tool ${t.name}`, detail: clip(t.desc, 140), ok: true }],
    });
  });

  sandboxes.forEach((sb, i) => {
    tasks.push({
      id: `sandbox-${i}`,
      kind: "sandbox",
      typeLabel: sb.simulated ? "Sandbox · 模拟" : "Sandbox · 真实 Inngest",
      title: `沙箱部署 #${i + 1}`,
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
