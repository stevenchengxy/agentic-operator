// #OBSERVABILITY — Workflow→Phase→Agent 遥测投影(参考 Claude 的 Workflow 面板)。把一次工厂运行
// 按【六段 stage 作 phase】分组,每个 phase 汇总真实的 tokens / tools / time + 在该 phase 内跑过的
// 子 agent(专家/研究员)。纯函数、确定性、replay-safe。
//
// 诚实口径(数据真实性):
//  · phase 级 tokens = budget 事件(运行总额)在该 phase 的【增量】——真实;
//  · phase 级 tools  = 该 phase 内 tool.call 计数——真实;
//  · phase 级 time   = 该 phase 内首/末事件的 server ts 之差——真实(emit 处服务端盖章);
//  · 子 agent time   = subagent.start→done 的 ts 差——真实;
//  · 子 agent tokens = 【无】——工厂未按子脑单独记 budget,故不显示(不编造)。

import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import {
  isAnswerCompletion,
  isDeliveryCompletion,
  normalizeFactoryCompletionKind,
} from "./model";

export interface PhaseAgentLite {
  key: string;
  name: string;
  role?: string;
  tools: number;
  durationMs?: number;
  status: "running" | "ok" | "error";
}

export interface PhaseGroup {
  stage: string;
  label: string;
  status: "active" | "ok" | "error";
  /** 子 agent(在此 phase 内派生的专家/研究员)。 */
  agents: PhaseAgentLite[];
  tokens: number;
  tools: number;
  durationMs: number;
}

export interface PhaseTimeline {
  phases: PhaseGroup[];
  totalTokens: number;
  totalTools: number;
  totalDurationMs: number;
}

const STAGE_LABEL: Record<string, string> = {
  intake: "接收 · 理解",
  read: "读业务",
  plan: "规划",
  design: "设计",
  validate: "校验",
  sandbox: "试运行",
  deliver: "交付",
  answer: "回答",
  incomplete: "未完成",
  completion_unknown: "结束（类型未知）",
};

const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

interface PhaseAcc extends Omit<PhaseGroup, "agents"> {
  firstTs?: number;
  lastTs?: number;
  tokenStart?: number;
  tokenEnd?: number;
  agents: Map<string, PhaseAgentLite & { startTs?: number }>;
}

/** Group a run's BrainEvents into a Workflow→Phase→Agent timeline with REAL rolled-up telemetry. */
export function derivePhaseTimeline(events: BrainEvent[]): PhaseTimeline {
  const order: string[] = [];
  const phases = new Map<string, PhaseAcc>();
  let curStage = "intake";
  let runningTokens = 0;
  let latestRealSandboxSucceeded = false;

  const phaseOf = (stage: string): PhaseAcc => {
    let p = phases.get(stage);
    if (!p) {
      p = { stage, label: STAGE_LABEL[stage] ?? stage, status: "active", agents: new Map(), tokens: 0, tools: 0, durationMs: 0 };
      phases.set(stage, p);
      order.push(stage);
    }
    return p;
  };

  const moveFinalPhase = (from: string, to: string): PhaseAcc => {
    if (from === to) return phaseOf(to);
    const existing = phases.get(from);
    if (!existing) return phaseOf(to);
    phases.delete(from);
    existing.stage = to;
    existing.label = STAGE_LABEL[to] ?? to;
    phases.set(to, existing);
    const index = order.indexOf(from);
    if (index >= 0) order[index] = to;
    return existing;
  };

  for (const e of events) {
    const t = s(e.t);
    const ts = num((e as { ts?: number }).ts);
    if (t === "sandbox" && !e.simulated) {
      latestRealSandboxSucceeded = Boolean(
        e.fullChainRan || e.reachedSuccessTerminal,
      );
    }
    // running token total (budget carries a monotonic run-wide total).
    if (t === "budget") { const tk = num(e.tokens); if (tk != null) runningTokens = tk; }
    // phase switch on an ACTIVE stage marker.
    if (t === "stage") {
      const st = s(e.stage) || curStage;
      if (s(e.status) === "active") curStage = st;
      const p = phaseOf(st);
      if (s(e.status) === "error") p.status = "error";
      else if (s(e.status) === "ok" && p.status !== "error") p.status = "ok";
    }
    if (t === "done") {
      const completionKind = normalizeFactoryCompletionKind(e.completionKind);
      if (e.status === "waiting_human") {
        // Suspension is neither success nor failure. Keep the current phase
        // active so the separate HITL gate remains the actionable state.
        phaseOf(curStage).status = "active";
      } else if (isAnswerCompletion(e.status, completionKind)) {
        moveFinalPhase(curStage === "deliver" ? "deliver" : "answer", "answer");
        curStage = "answer";
        phaseOf(curStage).status = "ok";
      } else if (isDeliveryCompletion(e.status, completionKind)) {
        curStage = "deliver";
        phaseOf(curStage).status = latestRealSandboxSucceeded ? "ok" : "error";
      } else {
        const nextStage = completionKind === "legacy_unknown"
          ? "completion_unknown"
          : "incomplete";
        moveFinalPhase(curStage === "deliver" ? "deliver" : nextStage, nextStage);
        curStage = nextStage;
        phaseOf(curStage).status = "error";
      }
    }
    const p = phaseOf(curStage);
    // time bounds + token span for the current phase (real server ts).
    if (ts != null) { if (p.firstTs == null) p.firstTs = ts; p.lastTs = ts; }
    if (p.tokenStart == null) p.tokenStart = runningTokens;
    p.tokenEnd = runningTokens;
    // per-phase tool count.
    if (t === "tool.call") p.tools++;
    // sub-agents (specialists / research sub-brains) that ran in this phase.
    if (t === "subagent.start") {
      const key = `${curStage}:${p.agents.size}:${s(e.role) || s(e.task)}`;
      p.agents.set(key, { key, name: s(e.role) || s(e.task) || "子脑", role: s(e.role) || undefined, tools: 0, status: "running", startTs: ts });
    } else if (t === "subagent.done") {
      // close the most recent still-running sub-agent in this phase.
      const openArr = [...p.agents.values()].filter((a) => a.status === "running");
      const last = openArr[openArr.length - 1];
      if (last) { last.status = "ok"; if (ts != null && last.startTs != null) last.durationMs = Math.max(0, ts - last.startTs); }
    }
  }

  const outPhases: PhaseGroup[] = order.map((st) => {
    const p = phases.get(st)!;
    const durationMs = p.firstTs != null && p.lastTs != null ? Math.max(0, p.lastTs - p.firstTs) : 0;
    const tokens = Math.max(0, (p.tokenEnd ?? 0) - (p.tokenStart ?? 0));
    const agents = [...p.agents.values()].map(({ startTs: _s, ...a }) => a);
    return { stage: p.stage, label: p.label, status: p.status, agents, tokens, tools: p.tools, durationMs };
  });

  return {
    phases: outPhases,
    totalTokens: outPhases.reduce((n, p) => n + p.tokens, 0),
    totalTools: outPhases.reduce((n, p) => n + p.tools, 0),
    totalDurationMs: outPhases.reduce((n, p) => n + p.durationMs, 0),
  };
}
