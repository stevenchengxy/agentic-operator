"use client";

/**
 * Agent 工厂 — the 活动日志 (Activity Log). The COMPLETE step-by-step record of what the brain did
 * this run: its thinking, every tool call with full INPUT + OUTPUT, the code it wrote, the problems
 * it found in review, how it refined them (per-round score moves), reverts, clarifications, the
 * sandbox outcome. #5/#6: nothing is omitted — this is the full narrative the AI reviewer also
 * reads. (The 决策流 stays the high-level path; this is the detailed log.)
 */

import { useState } from "react";
import { Empty, StatusDot, HelpTip, Markdown } from "@/app/portal/components";
import { CodeBox } from "./atoms";
import type { Block } from "./model";

type ToolBlock = Extract<Block, { kind: "tool" }>;

// #7 — difficulty tier the model was routed by (fast=便宜读/规划, default=设计, hard=写码/精修/评审).
const TIER_LABEL: Record<string, string> = { fast: "快", default: "设计", hard: "强" };
const TIER_COLOR: Record<string, string> = { fast: "var(--text-3)", default: "var(--signal)", hard: "var(--green)" };

const labelStyle: React.CSSProperties = { fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "6px 0 3px" };
const rowStyle = (color: string): React.CSSProperties => ({ borderLeft: `2px solid ${color}`, paddingLeft: 10, marginBottom: 8 });
const headStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, lineHeight: 1.5 };

function ToolStep({ s }: { s: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const pending = s.ok === undefined;
  const hasIO = s.input !== undefined || !!s.summary || !!s.output;
  const col = pending ? "var(--text-3)" : s.ok ? "var(--green)" : "var(--red)";
  return (
    <div style={rowStyle(col)}>
      <button onClick={() => hasIO && setOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", background: "none", border: "none", cursor: hasIO ? "pointer" : "default", padding: 0 }}>
        <StatusDot status={pending ? "running" : s.ok ? "ok" : "failed"} size={6} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--mono)" }}>{s.role && <span style={{ color: "var(--signal)" }}>{s.role} · </span>}{s.name}</span>
        <span style={{ fontSize: 11, color: col }}>{pending ? `运行中…${s.elapsedS ? ` 已 ${s.elapsedS >= 60 ? `${Math.floor(s.elapsedS / 60)}m${s.elapsedS % 60}s` : `${s.elapsedS}s`}` : ""}` : s.ok ? "✓" : "✗"}</span>
        {s.model && <span title={`本步使用的模型${s.tier ? ` · ${TIER_LABEL[s.tier] ?? s.tier} 档` : ""}`} style={{ fontSize: 9.5, color: "var(--text-3)", fontFamily: "var(--mono)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px" }}>🧠 {s.model.split("/").pop()}{s.tier && <span style={{ marginLeft: 4, color: TIER_COLOR[s.tier] ?? "var(--text-3)" }}>·{TIER_LABEL[s.tier] ?? s.tier}</span>}</span>}
        {hasIO && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)" }}>{open ? "收起" : "输入/输出"}</span>}
      </button>
      {s.reasoning && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 3, lineHeight: 1.5 }}><Markdown>{s.reasoning}</Markdown></div>}
      {open && (
        <div style={{ marginTop: 4 }}>
          {s.input !== undefined && (<><div style={labelStyle}>输入</div><CodeBox code={typeof s.input === "string" ? s.input : JSON.stringify(s.input, null, 2)} /></>)}
          {s.summary && (<><div style={labelStyle}>结果（摘要）</div><div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.6, background: "var(--panel-3)", borderRadius: 6, padding: "6px 8px" }}><Markdown>{s.summary}</Markdown></div></>)}
          {s.output && (<><div style={labelStyle}>完整输出</div><CodeBox code={s.output} /></>)}
        </div>
      )}
    </div>
  );
}

/** A compact one-line activity row with an icon + label + text; optional expandable detail. */
function Row({ icon, color, title, text, detail, markdown }: { icon: string; color: string; title: string; text?: string; detail?: string; markdown?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={rowStyle(color)}>
      <div style={headStyle}>
        <span>{icon}</span>
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{title}</span>
        {detail && <button onClick={() => setOpen((o) => !o)} style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)", background: "none", border: "none", cursor: "pointer" }}>{open ? "收起" : "展开"}</button>}
      </div>
      {text && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2, lineHeight: 1.55, whiteSpace: markdown ? "normal" : "pre-wrap" }}>{markdown ? <Markdown>{text}</Markdown> : text}</div>}
      {detail && open && <div style={{ marginTop: 4 }}><CodeBox code={detail} /></div>}
    </div>
  );
}

function ActivityRow({ b }: { b: Block }) {
  switch (b.kind) {
    case "tool": return <ToolStep s={b} />;
    case "think": return <Row icon="💭" color="var(--border-2)" title="思考" text={b.text} markdown />;
    case "message": return <Row icon="🗣" color="var(--signal)" title="大脑" text={b.text} markdown />;
    case "plan": return <Row icon="🗺" color="var(--signal)" title={`规划 · ${b.agents} 个智能体`} text={b.summary} markdown />;
    case "code": return <Row icon="📝" color="var(--signal)" title={`写代码 · ${b.actionName} (${b.codeSource})`} />;
    case "validation": return <Row icon="🔎" color={b.ok ? "var(--green)" : "var(--red)"} title={b.ok ? "校验闭合" : "校验未闭合"} text={b.ok ? undefined : b.issues.join("；")} />;
    case "refine": return <Row icon="♻" color="var(--amber)" title={`精修 · ${b.action}`} text={b.critique} markdown />;
    case "score": return <Row icon="📊" color={b.regression ? "var(--red)" : "var(--green)"} title={`评分 · ${b.action}`} text={`${b.prior} → ${b.next}（${b.delta >= 0 ? "+" : ""}${b.delta}${b.regression ? " 退步" : ""}）`} />;
    case "revert": return <Row icon="⏪" color="var(--amber)" title={`回滚 · ${b.action}`} text={`回到第 ${b.toAttempt} 次之前`} />;
    case "clarify": return <Row icon="❓" color="var(--amber)" title="询问用户" text={b.question} markdown />;
    case "compaction": return <Row icon="🗜" color="var(--border-2)" title="上下文自动压缩" text={b.summary} detail={b.state || undefined} markdown />;
    case "sandbox": { const ev = b.ev as Record<string, unknown>; const sim = Boolean(ev.simulated); return <Row icon="🧪" color={ev.fullChainRan ? "var(--green)" : "var(--red)"} title={`沙箱${sim ? "（模拟）" : "（真实）"}`} text={`部署 ${ev.functionsRegistered ?? 0} · 跑 ${ev.ran ?? 0} · ${ev.fullChainRan ? "整链跑通" : "未跑通"}`} />; }
    case "reflect": return <Row icon="💡" color="var(--border-2)" title="反思" text={b.text} markdown />;
    case "subagent": return <Row icon="🧩" color="var(--signal)" title="子智能体" text={b.summary ?? b.task} markdown />;
    case "toolnew": return <Row icon="🛠" color="var(--signal)" title={`新建工具 · ${b.name}`} text={b.desc} markdown />;
    case "web": return <Row icon="🌐" color="var(--signal)" title={`联网检索 · ${b.count} 条`} text={b.query} />;
    case "inspect": return <Row icon="🔬" color={b.degraded ? "var(--amber)" : "var(--text-3)"} title={`检视 · ${b.agentSlug}`} text={b.error || b.status} />;
    case "error": return <Row icon="⛔" color="var(--red)" title="错误" text={b.text} />;
    case "done": return <Row icon="🏁" color="var(--text-3)" title={`结束 · ${b.status}`} />;
    default: return null;
  }
}

// Block kinds rendered in the activity log (the full narrative). HITL prompt cards (testcases /
// boundary) live in the center transcript; here we keep the brain's own work record.
const SHOWN = new Set<Block["kind"]>(["tool", "think", "message", "plan", "code", "validation", "refine", "score", "revert", "clarify", "compaction", "sandbox", "reflect", "subagent", "toolnew", "web", "inspect", "error", "done"]);

export function ActivityLog({ blocks }: { blocks: Block[] }) {
  const steps = blocks.filter((b) => SHOWN.has(b.kind));
  if (!steps.length) return <Empty title={<>还没有活动 <HelpTip>运行后，这里完整记录大脑每一步：思考、工具调用(输入/输出)、写的代码、评审与精修、沙箱结果——不遗漏</HelpTip></>} />;
  const toolCount = steps.filter((b) => b.kind === "tool").length;
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>完整活动叙事 · {steps.length} 条（{toolCount} 次工具调用）</div>
      {steps.map((b) => <ActivityRow key={b.id} b={b} />)}
    </div>
  );
}
