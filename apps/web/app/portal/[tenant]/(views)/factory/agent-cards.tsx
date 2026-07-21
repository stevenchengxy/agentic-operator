"use client";

/**
 * Agent 工厂 — the browsable AGENT CARD LIST + the SANDBOX I/O panel (ported from the old AO's
 * right-sidebar 智能体 + SandboxIOPanel). #F: an FDE scans ALL agents' status + reasoning at a
 * glance (vs the new AO's one-at-a-time click-into-inspector), and sees each test case's input +
 * each agent run's INPUT and OUTPUT + per-case PASS/FAIL.
 */

import { useState } from "react";
import { Empty, HelpTip } from "@/app/portal/components";
import { useI18n, type Translate } from "@/app/portal/lib/preferences-context";
import { chip, Field, CodeBox } from "./atoms";
import type { AgentCardData, AgentIO } from "./model";

// per-agent mini event-flow (trigger → agent → emit), compact.
function MiniSvg({ a }: { a: AgentCardData }) {
  const rows = Math.max(1, a.trigger.length, a.emit.length);
  const H = 20 + rows * 22, W = 320, cy = H / 2;
  const ev = (list: string[], x: number, anchor: "start" | "end", color: string) =>
    list.slice(0, 3).map((e, i) => (
      <text key={e + i} x={x} y={16 + i * 22} textAnchor={anchor} fontSize={9} fill={color} fontFamily="var(--mono)">{e.length > 20 ? e.slice(0, 19) + "…" : e}</text>
    ));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
      {ev(a.trigger, 104, "end", "var(--blue)")}
      {ev(a.emit, 216, "start", "var(--violet)")}
      <rect x={110} y={cy - 15} width={100} height={30} rx={8} fill="var(--panel-3)" stroke="var(--signal)" strokeWidth={1.2} />
      <text x={160} y={cy + 3} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="var(--text)">{(a.actionName || a.short).slice(0, 14)}</text>
    </svg>
  );
}

function agentStatus(t: Translate, a: AgentCardData, degraded: Set<string>, io?: AgentIO): { label: string; color: string } {
  if (degraded.has(a.slug)) return { label: t("factory.agentCards.status.degraded"), color: "var(--amber)" };
  if (io && /^ok$|complet/i.test(io.status)) return { label: t("factory.agentCards.status.ranOk"), color: "var(--green)" };
  if (io && /miss|fail/i.test(io.status)) return { label: io.status, color: "var(--amber)" };
  if (io) return { label: io.status, color: "var(--text-3)" };
  if (!a.code && !a.systemPrompt) return { label: t("factory.agentCards.status.draft"), color: "var(--text-3)" };
  return { label: t("factory.agentCards.status.notTriggered"), color: "var(--text-3)" };
}

function AgentCard({ a, st, onShowCode, onRegenerate, onSelect }: { a: AgentCardData; st: { label: string; color: string }; onShowCode: (a: AgentCardData) => void; onRegenerate?: (actionName: string, supplement: string) => void | Promise<void>; onSelect?: (slug: string) => void }) {
  const { t } = useI18n();
  const [view, setView] = useState<null | "prompt" | "code" | "logic">(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState("");
  const regenerate = async () => {
    if (!onRegenerate || regenerating) return;
    setRegenerating(true);
    setRegenerateError("");
    try {
      await onRegenerate(a.actionName || a.slug, "");
    } catch (cause) {
      setRegenerateError(cause instanceof Error && cause.message ? cause.message : t("factory.agentCards.regenerateFailed"));
    } finally {
      setRegenerating(false);
    }
  };
  const tab = (k: "prompt" | "code" | "logic", label: string, has: boolean) => (
    <button disabled={!has} onClick={() => setView((v) => (v === k ? null : k))} style={{ fontSize: 11, padding: "3px 10px", borderRadius: 14, cursor: has ? "pointer" : "default", border: `1px solid ${view === k ? "var(--signal)" : "var(--border)"}`, background: view === k ? "var(--panel-3)" : "transparent", color: has ? (view === k ? "var(--text)" : "var(--text-2)") : "var(--text-4)" }}>{label}</button>
  );
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 11, background: "var(--panel-2)", marginBottom: 8 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <button onClick={() => onSelect?.(a.slug)} style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)", background: "none", border: "none", cursor: "pointer", padding: 0, textAlign: "left" }}>{a.nameZh || a.short}</button>
        <span style={{ fontSize: 9.5, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{a.actionName || a.slug}</span>
        {/* #REDESIGN FU3 — reviewLoop execution grade: ⚙ CodeAct (编译+安全+加载探针 → 沙箱真跑) vs 📄 声明式. */}
        <span title={a.codeExecuted ? t("factory.agentCards.codeExecuted.codeactTitle") : t("factory.agentCards.codeExecuted.declarativeTitle") + (a.probeReason ? t("factory.agentCards.codeExecuted.declarativeProbeReason", { reason: a.probeReason }) : "")} style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, color: a.codeExecuted ? "var(--violet, #a78bfa)" : "var(--text-3)", border: `1px solid ${a.codeExecuted ? "var(--violet, #a78bfa)" : "var(--border)"}`, borderRadius: 6, padding: "1px 7px" }}>{a.codeExecuted ? t("factory.agentCards.badge.codeact") : t("factory.agentCards.badge.declarative")}</span>
        <span style={{ fontSize: 10.5, fontWeight: 700, color: st.color, border: `1px solid ${st.color}`, borderRadius: 6, padding: "1px 7px" }}>{st.label}</span>
      </div>
      <div style={{ marginTop: 6 }}><MiniSvg a={a} /></div>
      {a.tools.length > 0 && <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>{a.tools.slice(0, 6).map((toolName) => chip("🔧 " + toolName, "var(--text-2)"))}</div>}
      <div style={{ display: "flex", gap: 6, marginTop: 8, alignItems: "center", flexWrap: "wrap" }}>
        {tab("prompt", t("factory.agentCards.tab.prompt"), !!a.systemPrompt)}
        {tab("code", t("factory.agentCards.tab.code") + (a.codeSource === "ai" ? t("factory.agentCards.tab.codeAiSuffix") : ""), !!a.code)}
        {tab("logic", t("factory.agentCards.tab.logic"), !!a.decisionLogic)}
        {onRegenerate && <button disabled={regenerating} onClick={() => void regenerate()} style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)", background: "none", border: "none", cursor: regenerating ? "wait" : "pointer", opacity: regenerating ? 0.6 : 1 }}>{regenerating ? t("factory.agentCards.regenerating") : t("factory.agentCards.regenerate")}</button>}
      </div>
      {regenerateError && <div role="alert" style={{ marginTop: 6, color: "var(--red)", fontSize: 11.5 }}>{regenerateError}</div>}
      {view === "prompt" && a.systemPrompt && <div style={{ marginTop: 6 }}><Field label={t("factory.agentCards.field.systemPrompt")} text={a.systemPrompt} mono /></div>}
      {view === "logic" && a.decisionLogic && <div style={{ marginTop: 6 }}><Field label={t("factory.agentCards.field.branchLogic")} text={a.decisionLogic} markdown /></div>}
      {view === "code" && a.code && <div style={{ marginTop: 6 }}><div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 3 }}><button onClick={() => onShowCode(a)} style={{ fontSize: 10.5, color: "var(--green)", background: "none", border: "none", cursor: "pointer" }}>{t("factory.agentCards.fullscreen")}</button></div><CodeBox code={a.code} /></div>}
    </div>
  );
}

export function AgentCardList({ agents, degraded, ioByShort, onShowCode, onRegenerate, onSelect }: { agents: AgentCardData[]; degraded: Set<string>; ioByShort: Map<string, AgentIO>; onShowCode: (a: AgentCardData) => void; onRegenerate?: (actionName: string, supplement: string) => void | Promise<void>; onSelect?: (slug: string) => void }) {
  const { t } = useI18n();
  if (!agents.length) return <Empty title={<>{t("factory.agentCards.emptyAgents.title")} <HelpTip>{t("factory.agentCards.emptyAgents.help")}</HelpTip></>} />;
  return (
    <div>
      <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 8 }}>{t("factory.agentCards.agentsCount", { count: agents.length })}</div>
      {agents.map((a) => <AgentCard key={a.slug} a={a} st={agentStatus(t, a, degraded, ioByShort.get(a.short))} onShowCode={onShowCode} onRegenerate={onRegenerate} onSelect={onSelect} />)}
    </div>
  );
}

// ── Sandbox I/O panel: test cases (input) + per-agent runs (input + OUTPUT) + per-case verdict ──
export function SandboxIOPanel({ testCases, agentRuns, onShowCode: _osc }: { testCases: Array<{ name: string; kind: string; entryEvent: string; expectedOutcome?: string; payload?: Record<string, unknown> }>; agentRuns: AgentIO[]; onShowCode?: () => void }) {
  const { t } = useI18n();
  if (!testCases.length && !agentRuns.length) return <Empty title={<>{t("factory.agentCards.emptySandbox.title")} <HelpTip>{t("factory.agentCards.emptySandbox.help")}</HelpTip></>} />;
  const kindColor = (k: string) => (/reject|拒绝|fail/i.test(k) ? "var(--amber)" : /edge|边界/i.test(k) ? "var(--violet)" : "var(--green)");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {testCases.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6 }}>{t("factory.agentCards.testCasesCount", { count: testCases.length })}</div>
          {testCases.map((c, i) => (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 9, padding: 10, marginBottom: 7, background: "var(--panel-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{c.name}</span>
                {chip(c.kind, kindColor(c.kind))}
                <span style={{ marginLeft: "auto", fontSize: 10, fontFamily: "var(--mono)", color: "var(--blue)" }}>◂ {c.entryEvent}</span>
              </div>
              {c.expectedOutcome && <div style={{ fontSize: 11.5, color: "var(--text-2)", marginTop: 3 }}>{t("factory.agentCards.expectedOutcome", { outcome: c.expectedOutcome })}</div>}
              {c.payload && <div style={{ marginTop: 5 }}><Field label={t("factory.agentCards.field.inputPayload")} text={JSON.stringify(c.payload, null, 2)} mono /></div>}
            </div>
          ))}
        </div>
      )}
      {agentRuns.length > 0 && (
        <div>
          <div style={{ fontSize: 11, color: "var(--text-3)", marginBottom: 6 }}>{t("factory.agentCards.agentRunsCount", { count: agentRuns.length })}</div>
          {agentRuns.map((io, i) => (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 9, padding: 10, marginBottom: 7, background: "var(--panel-2)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{io.agentShort}</span>
                <span style={{ fontSize: 10.5, color: /complet/i.test(io.status) ? "var(--green)" : "var(--amber)", fontFamily: "var(--mono)" }}>{io.status}{io.degraded ? t("factory.agentCards.degradedSuffix") : ""}</span>
                {io.url && <a href={io.url} target="_blank" rel="noreferrer" style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--signal)" }} title={t("factory.agentCards.runRecord.title")}>{t("factory.agentCards.runRecord.link")}</a>}
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginTop: 4 }}>
                {io.triggerEvent && chip(`◂ ${io.triggerEvent}`, "var(--blue)")}
                {io.outputEvent && chip(`▸ ${io.outputEvent}`, "var(--violet)")}
              </div>
              {io.inputPayload && <div style={{ marginTop: 5 }}><Field label={t("factory.agentCards.field.input")} text={JSON.stringify(io.inputPayload, null, 2)} mono /></div>}
              {io.outputPayload && <div style={{ marginTop: 5 }}><Field label={t("factory.agentCards.field.output")} text={JSON.stringify(io.outputPayload, null, 2)} mono /></div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
