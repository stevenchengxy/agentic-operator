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
  kind: "think" | "tool" | "gate" | "stage" | "event" | "error";
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
  const spawns: Array<{ task: string; summary?: string; startIdx: number; items: TaskTranscriptItem[] }> = [];
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
      case "tool.call": {
        flushThink();
        toolCalls++;
        harnessLastIdx = idx;
        const item: TaskTranscriptItem = { id: s(e.id) || nid(), kind: "tool", label: s(e.name), detail: clip(s(e.reasoning), 140) };
        harnessItems.push(item);
        callsById.set(s(e.id), item);
        const text = callText(e.input);
        const keys: string[] = [];
        if (text) {
          for (const a of agents.values()) {
            if ([a.actionName, a.slug, a.short].some((k) => k.length > 2 && text.includes(k))) {
              keys.push(a.slug);
              a.lastEventIdx = idx;
              a.transcript.push({ id: nid(), kind: "tool", label: s(e.name), detail: clip(s(e.reasoning), 120) });
            }
          }
        }
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
          } satisfies AgentAcc);
        acc.versions++;
        acc.trigger = (spec.trigger as string[]) ?? acc.trigger;
        acc.tools = (spec.tools as string[]) ?? acc.tools;
        // design_subagent 的 slug 约定 "<parent>-sub-<task>"（spec.isSubAgent 未随事件下发）。
        acc.isSubAgent = Boolean(spec.isSubAgent) || slug.includes("-sub-") || acc.isSubAgent;
        acc.codeExecuted = design.codeExecuted === true || acc.codeExecuted;
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
        break;
      }
      case "code": {
        const a = agentOf(s(e.actionName));
        if (a) {
          a.lastEventIdx = idx;
          a.transcript.push({ id: nid(), kind: "event", label: `生成代码（${s(e.codeSource) || "render"}）`, ok: true });
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
        }
        break;
      }
      case "score.delta": {
        const a = agentOf(s(e.actionName));
        if (a) {
          const d = Number(e.delta ?? 0);
          a.transcript.push({ id: nid(), kind: "event", label: `评分 ${d >= 0 ? `▲+${d}` : `▼${d}`}`, ok: !e.regression });
        }
        break;
      }
      case "revert": {
        const a = agentOf(s(e.actionName));
        if (a) a.transcript.push({ id: nid(), kind: "event", label: `回滚到第 ${s(e.revertedToAttempt)} 版之前`, ok: false });
        break;
      }
      case "inspect": {
        const a = agentOf(s(e.agentSlug));
        if (a) {
          a.lastEventIdx = idx;
          if (e.error || s(e.status) === "error") a.error = s(e.error) || "运行出错";
          a.transcript.push({ id: nid(), kind: "event", label: `试运行 ${s(e.status)}`, detail: e.error ? clip(s(e.error), 100) : undefined, ok: !e.error && s(e.status) !== "error" });
        }
        break;
      }
      case "sandbox": {
        flushThink();
        harnessLastIdx = idx;
        const ok = Boolean(e.fullChainRan) || Boolean(e.reachedSuccessTerminal);
        const items: TaskTranscriptItem[] = [];
        const runs = (e.agentRuns as Array<Record<string, unknown>> | undefined) ?? [];
        for (const r of runs) {
          items.push({
            id: nid(),
            kind: "event",
            label: `${s(r.agentShort)} · ${s(r.status)}`,
            detail: clip(`${s(r.triggerEvent)} → ${s(r.outputEvent) || "（无产出事件）"}`, 110),
            ok: s(r.status) !== "error",
          });
          const a = agentOf(s(r.agentShort));
          if (a) {
            a.sandboxStatus = s(r.status);
            a.lastEventIdx = idx;
            a.transcript.push({ id: nid(), kind: "event", label: `沙箱 I/O · ${s(r.status)}`, detail: clip(`${s(r.triggerEvent)} → ${s(r.outputEvent)}`, 100), ok: s(r.status) !== "error" });
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
      case "subagent.start": {
        flushThink();
        harnessLastIdx = idx;
        const task = s(e.task);
        spawns.push({ task, startIdx: idx, items: [{ id: nid(), kind: "event", label: "启动", detail: clip(task, 140) }] });
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
      case "clarify":
        flushThink();
        harnessItems.push({ id: nid(), kind: "gate", label: "询问用户", detail: clip(s(e.question), 120) });
        break;
      case "test.cases":
        flushThink();
        harnessItems.push({ id: nid(), kind: "gate", label: "等待测试用例确认", detail: `${((e.cases as unknown[]) ?? []).length} 个用例` });
        break;
      case "boundary.cases":
        flushThink();
        harnessItems.push({ id: nid(), kind: "gate", label: "等待边界事件分类", detail: `${((e.proposals as unknown[]) ?? []).length} 个` });
        break;
      case "stage": {
        if (s(e.status) === "active") harnessItems.push({ id: nid(), kind: "stage", label: `进入阶段 · ${s(e.stage)}` });
        break;
      }
      case "error":
        flushThink();
        sawError = true;
        harnessItems.push({ id: nid(), kind: "error", label: "出错", detail: clip(s(e.message), 140), ok: false });
        break;
      case "done":
        flushThink();
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
    const status: SessionTaskStatus = a.error || a.sandboxStatus === "error" ? "error" : running && lastIdx - a.lastEventIdx < 15 ? "running" : "ok";
    tasks.push({
      id: a.slug,
      kind: a.isSubAgent ? "subagent" : "agent",
      typeLabel: a.isSubAgent ? "Sub-agent · 可部署" : a.codeExecuted ? "Agent · CodeAct" : "Agent · 声明式工作流",
      title: a.name,
      meta: `${a.trigger[0] ? `⚡${clip(a.trigger[0]!, 20)} · ` : ""}${a.tools.length} 工具 · v${a.versions}${a.refines ? ` · ${a.refines} 修订` : ""}${a.sandboxStatus ? ` · 沙箱 ${a.sandboxStatus}` : ""}`,
      status,
      order: a.lastEventIdx,
      agentSlug: a.slug,
      transcript: a.transcript.slice(-140),
    });
  }

  spawns.forEach((x, i) => {
    // 认知专家（specialists 轻通道）与重通道子大脑分开标注——它们是工厂内部的两种派生。
    const isSpecialist = x.task.startsWith("认知专家");
    tasks.push({
      id: `spawn-${i}`,
      kind: "subagent",
      typeLabel: isSpecialist ? "Sub-agent · 认知专家" : "Sub-agent · 子大脑",
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
