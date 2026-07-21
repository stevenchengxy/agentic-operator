"use client";

/**
 * Agent 工厂 — the AGENT INSPECTOR / final-delivered-agent detail. Opened by clicking a node on
 * the live canvas. Consolidates the old 智能体 tab (spec + design reasoning + prompt + code) and
 * the 验证 per-agent sandbox I/O, and adds (R12): a per-agent SVG (trigger → tools → emit), the
 * code/prompt VERSION HISTORY (every authored revision), and a 补充信息 + 重新生成 control so the
 * user can supplement context and have the brain re-design just this one agent.
 */

import { useState } from "react";
import { Button, Markdown } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { chip, Field } from "./atoms";
import type { AgentCardData, AgentIO } from "./model";
import type { SessionTask } from "./workers";
import { TaskTranscript } from "./background-panel";

// ── per-agent mini event-flow ──────────────────────────────────────────────────────
function MiniAgentSvg({ agent }: { agent: AgentCardData }) {
  const { t } = useI18n();
  const rows = Math.max(1, agent.trigger.length, agent.emit.length);
  const H = 22 + rows * 26;
  const W = 340;
  const cy = H / 2;
  const ev = (list: string[], x: number, anchor: "start" | "end", color: string) =>
    list.slice(0, 4).map((e, i) => {
      const y = 18 + i * 26;
      return (
        <g key={e + i}>
          <line x1={anchor === "start" ? 116 : 224} y1={cy} x2={anchor === "start" ? x : x} y2={y - 4} stroke="var(--border-2)" strokeWidth={1} />
          <text x={x} y={y} textAnchor={anchor} fontSize={9.5} fill={color} fontFamily="var(--mono)">{e.length > 18 ? e.slice(0, 17) + "…" : e}</text>
        </g>
      );
    });
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {ev(agent.trigger, 110, "end", "var(--blue)")}
      {ev(agent.emit, 230, "start", "var(--violet)")}
      <rect x={116} y={cy - 18} width={108} height={36} rx={9} fill="var(--panel-2)" stroke="var(--signal)" strokeWidth={1.4} />
      <text x={170} y={cy - 2} textAnchor="middle" fontSize={11} fontWeight={700} fill="var(--text)">{(agent.actionName || agent.short).slice(0, 14)}</text>
      <text x={170} y={cy + 11} textAnchor="middle" fontSize={8.5} fill="var(--text-3)" fontFamily="var(--mono)">{agent.tools.length}🔧 · {agent.codeSource === "ai" ? t("factory.inspector.codeSource.aiShort") : t("factory.inspector.codeSource.rendered")}</text>
    </svg>
  );
}

// ── code / prompt version history ──────────────────────────────────────────────────
function VersionHistory({ versions, onShowCode }: { versions: AgentCardData[]; onShowCode: (a: AgentCardData) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (versions.length <= 1) return null;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--panel-2)", overflow: "hidden" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "9px 12px", background: "none", border: "none", cursor: "pointer", color: "var(--text-2)" }}>
        <span style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("factory.inspector.versionHistory.title", { count: versions.length })}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)" }}>{open ? t("factory.inspector.common.collapse") : t("factory.inspector.common.expand")}</span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {versions.map((v, i) => (
            <div key={i} style={{ borderLeft: `2px solid ${i === versions.length - 1 ? "var(--signal)" : "var(--border-2)"}`, paddingLeft: 10 }}>
              <div style={{ fontSize: 11.5, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
                <b>v{i + 1}</b>{i === versions.length - 1 && chip(t("factory.inspector.versionHistory.current"), "var(--signal)")}{chip(v.codeSource === "ai" ? t("factory.inspector.codeSource.aiWritten") : t("factory.inspector.codeSource.rendered"), "var(--text-3)")}<span style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 10 }}>{t("factory.inspector.versionHistory.toolCount", { count: v.tools.length })}</span>
                {v.code && <button onClick={() => onShowCode(v)} style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--green)", background: "none", border: "none", cursor: "pointer" }}>{t("factory.inspector.versionHistory.viewCode")}</button>}
              </div>
              {v.systemPrompt && <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 3, lineHeight: 1.5, maxHeight: 48, overflow: "hidden" }}>{v.systemPrompt.slice(0, 120)}{v.systemPrompt.length > 120 ? "…" : ""}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── supplement + regenerate ────────────────────────────────────────────────────────
function RegenerateBox({ actionName, onRegenerate }: { actionName: string; onRegenerate: (actionName: string, supplement: string) => void | Promise<void> }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onRegenerate(actionName, text.trim());
      setText("");
    } catch (cause) {
      setError(cause instanceof Error && cause.message ? cause.message : t("factory.inspector.regenerate.error"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--panel-2)" }}>
      <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase", marginBottom: 6 }}>{t("factory.inspector.regenerate.heading")}</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder={t("factory.inspector.regenerate.placeholder")} style={{ width: "100%", resize: "none", fontSize: 12, padding: "7px 9px", background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "var(--sans)" }} />
      <div style={{ marginTop: 8 }}>
        <Button icon="replay" tone="primary" disabled={busy} onClick={() => void submit()}>{busy ? t("factory.inspector.regenerate.submitting") : t("factory.inspector.regenerate.submit")}</Button>
      </div>
      {error && <div role="alert" style={{ marginTop: 7, color: "var(--red)", fontSize: 11.5 }}>{error}</div>}
    </div>
  );
}

// ── per-agent reasoning stream (#per-agent-think) ──────────────────────────────────
/** The agent's OWN process timeline — the harness reasoning/kernel steps/tool calls that were
 *  attributed to this agent (forAgent), same projection the background panel uses. This is the
 *  "点开卡片看它内部推理流程" surface: strategy chosen, each executed reasoning method, each
 *  tool call with ✓/✗ — not just the final design artifacts. */
function ReasoningStream({ task }: { task: SessionTask }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  const steps = task.transcript.length;
  if (!steps) return null;
  const strategy = task.drill?.strategy;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--panel-2)", overflow: "hidden" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "9px 12px", background: "none", border: "none", cursor: "pointer", color: "var(--text-2)" }}>
        <span style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>{t("factory.inspector.reasoningStream.title", { count: steps })}</span>
        {strategy && chip(t("factory.inspector.reasoningStream.method", { strategy }), "var(--violet)")}
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)" }}>{open ? t("factory.inspector.common.collapse") : t("factory.inspector.common.expand")}</span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: "4px 10px", maxHeight: 340, overflowY: "auto" }}>
          <TaskTranscript task={task} />
        </div>
      )}
    </div>
  );
}

// ── the inspector ──────────────────────────────────────────────────────────────────
export function AgentInspector({ agent, io, score, versions, task, onBack, onShowCode, onRegenerate }: {
  agent: AgentCardData;
  io?: AgentIO;
  score?: { delta: number; next: number; regression: boolean };
  versions?: AgentCardData[];
  /** 该 agent 的会话过程任务（deriveSessionTasks 投影）——内部推理流的数据源。 */
  task?: SessionTask;
  onBack: () => void;
  onShowCode: (a: AgentCardData) => void;
  onRegenerate?: (actionName: string, supplement: string) => void | Promise<void>;
}) {
  const { t } = useI18n();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button icon="chevron-left" onClick={onBack}>{t("factory.inspector.actions.backToCanvas")}</Button>
        {agent.code && <Button icon="code" onClick={() => onShowCode(agent)}>{t("factory.inspector.actions.viewCode")}{agent.codeSource === "ai" ? t("factory.inspector.codeSource.aiParen") : t("factory.inspector.codeSource.renderedParen")}</Button>}
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--panel-2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{agent.nameZh || agent.short}</div>
          <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{agent.actionName || agent.slug}</span>
        </div>
        {score && (
          <div style={{ fontSize: 11.5, marginTop: 4, color: score.regression ? "var(--red)" : "var(--green)" }}>
            {t("factory.inspector.score.label")} {score.next} · {t("factory.inspector.score.lastRefinement")} {score.delta >= 0 ? "▲ +" : "▼ "}{score.delta}{score.regression ? t("factory.inspector.score.regression") : ""}
          </div>
        )}
        <div style={{ marginTop: 8 }}><MiniAgentSvg agent={agent} /></div>
        {agent.tools.length > 0 && <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>{agent.tools.map((t) => chip("🔧 " + t, "var(--text-2)"))}</div>}
      </div>

      {(agent.reasoning || agent.decisionLogic || agent.systemPrompt) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {agent.reasoning && <Field label={t("factory.inspector.fields.designReasoning")} text={agent.reasoning} markdown />}
          {agent.decisionLogic && <Field label={t("factory.inspector.fields.branchLogic")} text={agent.decisionLogic} markdown />}
          {agent.systemPrompt && <Field label={t("factory.inspector.fields.systemPrompt")} text={agent.systemPrompt} mono />}
        </div>
      )}

      {task && <ReasoningStream task={task} />}

      {versions && <VersionHistory versions={versions} onShowCode={onShowCode} />}

      {io && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--panel-2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase" }}>{t("factory.inspector.io.title")}</div>
            <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: /complet/i.test(io.status) ? "var(--green)" : /miss/i.test(io.status) ? "var(--amber)" : "var(--text-3)" }}>{io.status}{io.degraded ? t("factory.inspector.io.degraded") : ""}</span>
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
            {io.triggerEvent && chip(`◂ ${io.triggerEvent}`, "var(--blue)")}
            {io.outputEvent && chip(`▸ ${io.outputEvent}`, "var(--violet)")}
          </div>
          {io.inputPayload && <Field label={t("factory.inspector.io.input")} text={JSON.stringify(io.inputPayload, null, 2)} mono />}
          {io.outputPayload && <Field label={t("factory.inspector.io.output")} text={JSON.stringify(io.outputPayload, null, 2)} mono />}
          {io.reasoning && <div style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 6, lineHeight: 1.5 }}><Markdown>{io.reasoning}</Markdown></div>}
        </div>
      )}

      {onRegenerate && <RegenerateBox actionName={agent.actionName || agent.slug} onRegenerate={onRegenerate} />}
    </div>
  );
}
