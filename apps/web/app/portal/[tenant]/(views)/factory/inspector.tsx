"use client";

/**
 * Agent 工厂 — the AGENT INSPECTOR / final-delivered-agent detail. Opened by clicking a node on
 * the live canvas. Consolidates the old 智能体 tab (spec + design reasoning + prompt + code) and
 * the 验证 per-agent sandbox I/O, and adds (R12): a per-agent SVG (trigger → tools → emit), the
 * code/prompt VERSION HISTORY (every authored revision), and a 补充信息 + 重新生成 control so the
 * user can supplement context and have the brain re-design just this one agent.
 */

import { useState } from "react";
import { Button } from "@/app/portal/components";
import { chip, Field, CodeBox } from "./atoms";
import type { AgentCardData, AgentIO } from "./model";

// ── per-agent mini event-flow ──────────────────────────────────────────────────────
function MiniAgentSvg({ agent }: { agent: AgentCardData }) {
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
      <text x={170} y={cy + 11} textAnchor="middle" fontSize={8.5} fill="var(--text-3)" fontFamily="var(--mono)">{agent.tools.length}🔧 · {agent.codeSource === "ai" ? "AI码" : "渲染码"}</text>
    </svg>
  );
}

// ── code / prompt version history ──────────────────────────────────────────────────
function VersionHistory({ versions, onShowCode }: { versions: AgentCardData[]; onShowCode: (a: AgentCardData) => void }) {
  const [open, setOpen] = useState(false);
  if (versions.length <= 1) return null;
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, background: "var(--panel-2)", overflow: "hidden" }}>
      <button onClick={() => setOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "9px 12px", background: "none", border: "none", cursor: "pointer", color: "var(--text-2)" }}>
        <span style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.04em" }}>变更版本（{versions.length}）</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)" }}>{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div style={{ borderTop: "1px solid var(--border)", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {versions.map((v, i) => (
            <div key={i} style={{ borderLeft: `2px solid ${i === versions.length - 1 ? "var(--signal)" : "var(--border-2)"}`, paddingLeft: 10 }}>
              <div style={{ fontSize: 11.5, color: "var(--text)", display: "flex", alignItems: "center", gap: 8 }}>
                <b>v{i + 1}</b>{i === versions.length - 1 && chip("当前", "var(--signal)")}{chip(v.codeSource === "ai" ? "AI写码" : "渲染码", "var(--text-3)")}<span style={{ color: "var(--text-3)", fontFamily: "var(--mono)", fontSize: 10 }}>{v.tools.length} 工具</span>
                {v.code && <button onClick={() => onShowCode(v)} style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--green)", background: "none", border: "none", cursor: "pointer" }}>看代码 ⛶</button>}
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
function RegenerateBox({ actionName, onRegenerate }: { actionName: string; onRegenerate: (actionName: string, supplement: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--panel-2)" }}>
      <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase", marginBottom: 6 }}>补充信息 · 重新生成</div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="补充背景 / 要求 / 修正（如：这个外部 API 的返回字段是 …），大脑会只重做这一个 agent。" style={{ width: "100%", resize: "none", fontSize: 12, padding: "7px 9px", background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "var(--sans)" }} />
      <div style={{ marginTop: 8 }}>
        <Button icon="replay" tone="primary" onClick={() => { onRegenerate(actionName, text.trim()); setText(""); }}>重新生成这个 agent</Button>
      </div>
    </div>
  );
}

// ── the inspector ──────────────────────────────────────────────────────────────────
export function AgentInspector({ agent, io, score, versions, onBack, onShowCode, onRegenerate }: {
  agent: AgentCardData;
  io?: AgentIO;
  score?: { delta: number; next: number; regression: boolean };
  versions?: AgentCardData[];
  onBack: () => void;
  onShowCode: (a: AgentCardData) => void;
  onRegenerate?: (actionName: string, supplement: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Button icon="chevron-left" onClick={onBack}>返回画布</Button>
        {agent.code && <Button icon="code" onClick={() => onShowCode(agent)}>查看代码{agent.codeSource === "ai" ? "（AI写）" : "（渲染）"}</Button>}
      </div>

      <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--panel-2)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "var(--text)" }}>{agent.nameZh || agent.short}</div>
          <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{agent.actionName || agent.slug}</span>
        </div>
        {score && (
          <div style={{ fontSize: 11.5, marginTop: 4, color: score.regression ? "var(--red)" : "var(--green)" }}>
            评分 {score.next} · 最近一轮精修 {score.delta >= 0 ? "▲ +" : "▼ "}{score.delta}{score.regression ? "（退步）" : ""}
          </div>
        )}
        <div style={{ marginTop: 8 }}><MiniAgentSvg agent={agent} /></div>
        {agent.tools.length > 0 && <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 6 }}>{agent.tools.map((t) => chip("🔧 " + t, "var(--text-2)"))}</div>}
      </div>

      {(agent.reasoning || agent.decisionLogic || agent.systemPrompt) && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {agent.reasoning && <Field label="设计推理" text={agent.reasoning} />}
          {agent.decisionLogic && <Field label="分支决策逻辑" text={agent.decisionLogic} />}
          {agent.systemPrompt && <Field label="system prompt（指令）" text={agent.systemPrompt} mono />}
        </div>
      )}

      {versions && <VersionHistory versions={versions} onShowCode={onShowCode} />}

      {io && (
        <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "var(--panel-2)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase" }}>真实运行 I/O</div>
            <span style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: /complet/i.test(io.status) ? "var(--green)" : /miss/i.test(io.status) ? "var(--amber)" : "var(--text-3)" }}>{io.status}{io.degraded ? " · 降级" : ""}</span>
          </div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 6 }}>
            {io.triggerEvent && chip(`◂ ${io.triggerEvent}`, "var(--blue)")}
            {io.outputEvent && chip(`▸ ${io.outputEvent}`, "var(--violet)")}
          </div>
          {io.inputPayload && <Field label="输入" text={JSON.stringify(io.inputPayload, null, 2)} mono />}
          {io.outputPayload && <Field label="输出" text={JSON.stringify(io.outputPayload, null, 2)} mono />}
          {io.reasoning && <div style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 6, lineHeight: 1.5 }}>{io.reasoning}</div>}
        </div>
      )}

      {onRegenerate && <RegenerateBox actionName={agent.actionName || agent.slug} onRegenerate={onRegenerate} />}
    </div>
  );
}
