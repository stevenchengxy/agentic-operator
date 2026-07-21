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
import { useI18n } from "@/app/portal/lib/preferences-context";
import { CodeBox } from "./atoms";
import {
  isAnswerCompletion,
  isDeliveryCompletion,
  type Block,
} from "./model";

type ToolBlock = Extract<Block, { kind: "tool" }>;

// #7 — difficulty tier the model was routed by (fast=便宜读/规划, default=设计, hard=写码/精修/评审).
const TIER_KEYS = new Set(["fast", "default", "hard"]);
const TIER_COLOR: Record<string, string> = { fast: "var(--text-3)", default: "var(--signal)", hard: "var(--green)" };

const labelStyle: React.CSSProperties = { fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.04em", margin: "6px 0 3px" };
const rowStyle = (color: string): React.CSSProperties => ({ borderLeft: `2px solid ${color}`, paddingLeft: 10, marginBottom: 8 });
const headStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, lineHeight: 1.5 };

function ToolStep({ s }: { s: ToolBlock }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const pending = s.ok === undefined;
  const hasIO = s.input !== undefined || !!s.summary || !!s.output;
  const col = pending ? "var(--text-3)" : s.ok ? "var(--green)" : "var(--red)";
  const tierLabel = (tier: string): string => (TIER_KEYS.has(tier) ? t(`factory.activityLog.tier.${tier}`) : tier);
  return (
    <div style={rowStyle(col)}>
      <button onClick={() => hasIO && setOpen((o) => !o)} style={{ display: "flex", alignItems: "center", gap: 7, width: "100%", textAlign: "left", background: "none", border: "none", cursor: hasIO ? "pointer" : "default", padding: 0 }}>
        <StatusDot status={pending ? "running" : s.ok ? "ok" : "failed"} size={6} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--mono)" }}>{s.role && <span style={{ color: "var(--signal)" }}>{s.role} · </span>}{s.name}</span>
        <span style={{ fontSize: 11, color: col }}>{pending ? `${t("factory.activityLog.tool.running")}${s.elapsedS ? t("factory.activityLog.tool.elapsed", { time: s.elapsedS >= 60 ? `${Math.floor(s.elapsedS / 60)}m${s.elapsedS % 60}s` : `${s.elapsedS}s` }) : ""}` : s.ok ? "✓" : "✗"}</span>
        {s.model && <span title={`${t("factory.activityLog.tool.modelTitle")}${s.tier ? t("factory.activityLog.tool.tierSuffix", { tier: tierLabel(s.tier) }) : ""}`} style={{ fontSize: 9.5, color: "var(--text-3)", fontFamily: "var(--mono)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 4px" }}>🧠 {s.model.split("/").pop()}{s.tier && <span style={{ marginLeft: 4, color: TIER_COLOR[s.tier] ?? "var(--text-3)" }}>·{tierLabel(s.tier)}</span>}</span>}
        {hasIO && <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)" }}>{open ? t("factory.activityLog.common.collapse") : t("factory.activityLog.tool.io")}</span>}
      </button>
      {s.reasoning && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 3, lineHeight: 1.5 }}><Markdown>{s.reasoning}</Markdown></div>}
      {open && (
        <div style={{ marginTop: 4 }}>
          {s.input !== undefined && (<><div style={labelStyle}>{t("factory.activityLog.tool.input")}</div><CodeBox code={typeof s.input === "string" ? s.input : JSON.stringify(s.input, null, 2)} /></>)}
          {s.summary && (<><div style={labelStyle}>{t("factory.activityLog.tool.resultSummary")}</div><div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.6, background: "var(--panel-3)", borderRadius: 6, padding: "6px 8px" }}><Markdown>{s.summary}</Markdown></div></>)}
          {s.output && (<><div style={labelStyle}>{t("factory.activityLog.tool.fullOutput")}</div><CodeBox code={s.output} /></>)}
        </div>
      )}
    </div>
  );
}

/** A compact one-line activity row with an icon + label + text; optional expandable detail. */
function Row({ icon, color, title, text, detail, markdown }: { icon: string; color: string; title: string; text?: string; detail?: string; markdown?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div style={rowStyle(color)}>
      <div style={headStyle}>
        <span>{icon}</span>
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{title}</span>
        {detail && <button onClick={() => setOpen((o) => !o)} style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)", background: "none", border: "none", cursor: "pointer" }}>{open ? t("factory.activityLog.common.collapse") : t("factory.activityLog.common.expand")}</button>}
      </div>
      {text && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2, lineHeight: 1.55, whiteSpace: markdown ? "normal" : "pre-wrap" }}>{markdown ? <Markdown>{text}</Markdown> : text}</div>}
      {detail && open && <div style={{ marginTop: 4 }}><CodeBox code={detail} /></div>}
    </div>
  );
}

function ActivityRow({ b }: { b: Block }) {
  const { t } = useI18n();
  switch (b.kind) {
    case "tool": return <ToolStep s={b} />;
    case "think": return <Row icon="💭" color="var(--border-2)" title={t("factory.activityLog.block.think")} text={b.text} markdown />;
    case "message": return <Row icon="🗣" color="var(--signal)" title={t("factory.activityLog.block.brain")} text={b.text} markdown />;
    case "plan": return <Row icon="🗺" color="var(--signal)" title={t("factory.activityLog.block.plan", { count: b.agents })} text={b.summary} markdown />;
    case "code": return <Row icon="📝" color="var(--signal)" title={t("factory.activityLog.block.code", { actionName: b.actionName, codeSource: b.codeSource })} />;
    case "validation": return <Row icon="🔎" color={b.ok ? "var(--green)" : "var(--red)"} title={b.ok ? t("factory.activityLog.block.validationOk") : t("factory.activityLog.block.validationFail")} text={b.ok ? undefined : b.issues.join(t("factory.activityLog.common.listSeparator"))} />;
    case "refine": return <Row icon="♻" color="var(--amber)" title={t("factory.activityLog.block.refine", { action: b.action })} text={b.critique} markdown />;
    case "score": return <Row icon="📊" color={b.regression ? "var(--red)" : "var(--green)"} title={t("factory.activityLog.block.score", { action: b.action })} text={t("factory.activityLog.block.scoreChange", { prior: b.prior, next: b.next, delta: `${b.delta >= 0 ? "+" : ""}${b.delta}`, regression: b.regression ? t("factory.activityLog.block.regressedSuffix") : "" })} />;
    case "revert": return <Row icon="⏪" color="var(--amber)" title={t("factory.activityLog.block.revert", { action: b.action })} text={t("factory.activityLog.block.revertText", { n: b.toAttempt })} />;
    case "clarify": return <Row icon="❓" color="var(--amber)" title={t("factory.activityLog.block.clarify")} text={b.question} markdown />;
    case "compaction": return <Row icon="🗜" color="var(--border-2)" title={t("factory.activityLog.block.compaction")} text={b.summary} detail={b.state || undefined} markdown />;
    case "sandbox": {
      const ev = b.ev as Record<string, unknown>;
      const simulated = Boolean(ev.simulated);
      const ok =
        !simulated &&
        (Boolean(ev.fullChainRan) || Boolean(ev.reachedSuccessTerminal));
      const outcome = ok
        ? t("factory.activityLog.sandbox.fullChain")
        : simulated
          ? t("factory.activityLog.sandbox.notExecuted")
          : t("factory.activityLog.sandbox.notRun");
      return (
        <Row
          icon="🧪"
          color={ok ? "var(--green)" : "var(--red)"}
          title={
            simulated
              ? t("factory.activityLog.sandbox.simulatedTitle")
              : t("factory.activityLog.sandbox.realTitle")
          }
          text={t("factory.activityLog.sandbox.stats", { deployed: String(ev.functionsRegistered ?? 0), ran: String(ev.ran ?? 0), outcome })}
        />
      );
    }
    case "reflect": return <Row icon="💡" color="var(--border-2)" title={t("factory.activityLog.block.reflect")} text={b.text} markdown />;
    case "subagent": return <Row icon="🧩" color="var(--signal)" title={t("factory.activityLog.block.subagent")} text={b.summary ?? b.task} markdown />;
    case "toolnew": return <Row icon="🛠" color="var(--signal)" title={t("factory.activityLog.block.toolnew", { name: b.name })} text={b.desc} markdown />;
    case "web": return <Row icon="🌐" color="var(--signal)" title={t("factory.activityLog.block.web", { count: b.count })} text={b.query} />;
    case "inspect": return <Row icon="🔬" color={b.degraded ? "var(--amber)" : "var(--text-3)"} title={t("factory.activityLog.block.inspect", { agentSlug: b.agentSlug })} text={b.error || b.status} />;
    case "error": return <Row icon="⛔" color="var(--red)" title={t("factory.activityLog.block.error")} text={b.text} />;
    case "done": {
      if (b.status === "waiting_human") {
        return <Row icon="⏸" color="var(--amber)" title={t("factory.activityLog.done.waitingTitle")} text={t("factory.activityLog.done.waitingText")} />;
      }
      if (isAnswerCompletion(b.status, b.completionKind)) {
        return <Row icon="🏁" color="var(--green)" title={t("factory.activityLog.done.answerTitle")} text={t("factory.activityLog.done.answerText")} />;
      }
      if (isDeliveryCompletion(b.status, b.completionKind)) {
        return <Row icon="🏁" color="var(--green)" title={t("factory.activityLog.done.deliveryTitle")} />;
      }
      if (b.completionKind === "legacy_unknown") {
        return <Row icon="🏁" color="var(--amber)" title={t("factory.activityLog.done.unknownTitle")} text={t("factory.activityLog.done.unknownText")} />;
      }
      return <Row icon="🏁" color="var(--text-3)" title={t("factory.activityLog.done.finished", { status: b.status })} />;
    }
    default: return null;
  }
}

// Block kinds rendered in the activity log (the full narrative). HITL prompt cards (testcases /
// boundary) live in the center transcript; here we keep the brain's own work record.
const SHOWN = new Set<Block["kind"]>(["tool", "think", "message", "plan", "code", "validation", "refine", "score", "revert", "clarify", "compaction", "sandbox", "reflect", "subagent", "toolnew", "web", "inspect", "error", "done"]);

export function ActivityLog({ blocks }: { blocks: Block[] }) {
  const { t } = useI18n();
  const steps = blocks.filter((b) => SHOWN.has(b.kind));
  if (!steps.length) return <Empty title={<>{t("factory.activityLog.empty.title")} <HelpTip>{t("factory.activityLog.empty.hint")}</HelpTip></>} />;
  const toolCount = steps.filter((b) => b.kind === "tool").length;
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>{t("factory.activityLog.summary", { count: steps.length, toolCount })}</div>
      {steps.map((b) => <ActivityRow key={b.id} b={b} />)}
    </div>
  );
}
