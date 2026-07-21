/**
 * OntoCode — projection layer over the factory brain stream.
 *
 * Pure functions only. The factory's `toBlocks`/`deriveAgents`/`deriveBrainFlow`
 * remain the source of truth; this module reshapes those outputs into the
 * OntoCode surfaces: the decision todo queue (待你决定), the single execution
 * line (执行行), and the event-flow graph (事件与业务流).
 */

import type { BrainEvent } from "@/lib/hooks/useBrainStream";
import type { AgentCardData, Block } from "../factory/model";

// ── 待你决定 (todo queue) ──────────────────────────────────────────────────────

export type TodoKind = "clarify" | "test_approval" | "boundary";

export interface TodoItem {
  id: string;
  interactionId?: string;
  kind: TodoKind;
  /** All park gates block the run in P0, so every open todo is required. */
  required: true;
  /** Clarify gates raised for a missing credential render the guide variant. */
  credentialLike: boolean;
  title: string;
  context?: string;
  options?: Array<{ label: string; value: string; recommended?: boolean }>;
  cases?: Extract<Block, { kind: "testcases" }>["cases"];
  coverage?: Extract<Block, { kind: "testcases" }>["coverage"];
  proposals?: Extract<Block, { kind: "boundarycases" }>["proposals"];
}

const CREDENTIAL_RE = /凭证|密钥|credential|api[ _-]?key|token|secret/i;

export function deriveTodos(blocks: Block[]): TodoItem[] {
  const todos: TodoItem[] = [];
  for (const b of blocks) {
    if (b.kind === "clarify" && b.awaiting) {
      todos.push({
        id: b.interactionId ?? b.id,
        interactionId: b.interactionId,
        kind: "clarify",
        required: true,
        credentialLike: CREDENTIAL_RE.test(`${b.question} ${b.context ?? ""}`),
        title: b.question,
        context: b.context,
        options: b.options,
      });
    } else if (b.kind === "testcases" && b.awaiting) {
      todos.push({
        id: b.interactionId ?? b.id,
        interactionId: b.interactionId,
        kind: "test_approval",
        required: true,
        credentialLike: false,
        title: `批准 ${b.cases.length} 条沙箱测试用例`,
        cases: b.cases,
        coverage: b.coverage,
      });
    } else if (b.kind === "boundarycases" && b.awaiting) {
      todos.push({
        id: b.interactionId ?? b.id,
        interactionId: b.interactionId,
        kind: "boundary",
        required: true,
        credentialLike: false,
        title: `${b.proposals.length} 个边界事件需要分类`,
        proposals: b.proposals,
      });
    }
  }
  return todos;
}

// Wire tags are parsed by the brain — must stay byte-identical to the factory page.
export function clarifyAnswerText(answer: string): string {
  return `[澄清回答] ${answer}`;
}
export function testDecisionText(decision: "approve" | "regenerate", note?: string): string {
  return `[测试用例决策: ${decision === "approve" ? "执行" : "重新生成"}] ${note ?? ""}`.trim();
}
export function boundaryDecisionText(
  events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>,
): string {
  return `[边界事件决策] ${JSON.stringify(events)}`;
}

// ── 执行行 (single in-place execution line) ───────────────────────────────────

export interface ExecLineState {
  state: "idle" | "running" | "done" | "error";
  /** Main line text, e.g. `调用 gohireMatchResumeApi` / `完成`. */
  text: string;
  detail?: string;
  toolCount: number;
  agentCount: number;
}

export function deriveExecLine(events: BrainEvent[], running: boolean): ExecLineState {
  let toolCount = 0;
  const openTools: Array<{ id: string; name: string }> = [];
  const agentSlugs = new Set<string>();
  let done: { status: string } | null = null;
  let lastError: string | null = null;
  let sawAny = false;

  for (const e of events) {
    sawAny = true;
    switch (e.t) {
      case "tool.call": {
        toolCount += 1;
        openTools.push({ id: String(e.id ?? ""), name: String(e.name ?? "") });
        break;
      }
      case "tool.result": {
        const idx = openTools.findIndex((o) => o.id === String(e.id ?? ""));
        if (idx >= 0) openTools.splice(idx, 1);
        break;
      }
      case "agent.created": {
        const spec = e.spec as Record<string, unknown> | undefined;
        if (spec?.slug) agentSlugs.add(String(spec.slug));
        break;
      }
      case "done": done = { status: String(e.status ?? "") }; lastError = null; break;
      case "error": lastError = String(e.message ?? "执行出错"); break;
    }
  }

  const base = { toolCount, agentCount: agentSlugs.size };
  if (lastError && !running) return { state: "error", text: lastError, ...base };
  if (running) {
    const current = openTools[openTools.length - 1];
    return {
      state: "running",
      text: current ? `调用 ${current.name}` : "推理中",
      ...base,
    };
  }
  if (done) {
    return {
      state: "done",
      text: done.status === "waiting_human" ? "等待你的决定" : "完成",
      detail: done.status,
      ...base,
    };
  }
  return { state: sawAny ? "done" : "idle", text: sawAny ? "已结束" : "", ...base };
}

// ── 事件与业务流 (event-flow graph) ───────────────────────────────────────────

export interface FlowGraphData {
  nodes: Array<{ slug: string; name: string; trigger: string[]; emit: string[] }>;
  /** agent → agent edges labelled by the connecting event. */
  edges: Array<{ from: string; to: string; event: string }>;
  /** Events consumed by an agent but produced by no agent (external entries). */
  entryEvents: Array<{ event: string; to: string }>;
  /** Events produced by an agent but consumed by no agent (terminals). */
  terminalEvents: Array<{ event: string; from: string }>;
}

export function deriveFlowGraph(agents: AgentCardData[]): FlowGraphData {
  const producers = new Map<string, string[]>();
  for (const a of agents) {
    for (const ev of a.emit) {
      const list = producers.get(ev) ?? [];
      list.push(a.slug);
      producers.set(ev, list);
    }
  }
  const edges: FlowGraphData["edges"] = [];
  const entryEvents: FlowGraphData["entryEvents"] = [];
  const consumed = new Set<string>();
  for (const a of agents) {
    for (const ev of a.trigger) {
      consumed.add(ev);
      const from = producers.get(ev);
      if (from?.length) {
        for (const producer of from) edges.push({ from: producer, to: a.slug, event: ev });
      } else {
        entryEvents.push({ event: ev, to: a.slug });
      }
    }
  }
  const terminalEvents: FlowGraphData["terminalEvents"] = [];
  for (const a of agents) {
    for (const ev of a.emit) {
      if (!consumed.has(ev)) terminalEvents.push({ event: ev, from: a.slug });
    }
  }
  return {
    nodes: agents.map((a) => ({
      slug: a.slug,
      name: a.actionName || a.nameZh || a.short || a.slug,
      trigger: a.trigger,
      emit: a.emit,
    })),
    edges,
    entryEvents,
    terminalEvents,
  };
}

// ── 下一步建议 (post-run suggestion chips) ────────────────────────────────────

export interface NextStep { id: string; label: string; href?: string }

export function deriveNextSteps(
  exec: ExecLineState,
  todos: TodoItem[],
  tenant: string,
): NextStep[] {
  if (exec.state !== "done") return [];
  const steps: NextStep[] = [];
  if (todos.some((t) => t.credentialLike)) {
    steps.push({ id: "credential", label: "去配置生产凭证", href: `/portal/${tenant}/settings` });
  }
  if (exec.agentCount > 0) {
    steps.push({ id: "advanced", label: "在高级模式中查看", href: `/portal/${tenant}/factory` });
  }
  return steps;
}
