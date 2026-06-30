"use client";

/**
 * Agent 工厂 — the CENTER TRANSCRIPT: the complete, full-fidelity thinking process (think →
 * tool → code → refine → budget → …). This is intentionally lossless — every block kind the
 * brain emits renders here. The redesign only ADDS the three previously-invisible reasoning
 * blocks (score / revert / refine diff). The dropped 轨迹 tab's one unique value — a dense,
 * filterable index — survives as the filter strip (TRANSCRIPT_FILTERS) applied on top.
 */

import { useState, type ReactNode } from "react";
import { Button, StatusDot } from "@/app/portal/components";
import { chip } from "./atoms";
import type { Block, ScoreDims } from "./model";

// ── milestone view ────────────────────────────────────────────────────────────────
// The transcript is lossless, but routine narration (think deltas, tool calls, searches,
// code-render, catalog/budget ticks) buries the moments that matter. The milestone view folds
// consecutive routine blocks into ONE expandable "思考与操作 · N 步" cluster, so the thread reads
// as: brain message → plan → agent decisions → validation → sandbox verdict → HITL gates → done.
const NOISE_KINDS = new Set<Block["kind"]>(["think", "tool", "web", "toolsearch", "toolschema", "inspect", "code", "catalog", "budget", "compaction"]);
export const isNoiseBlock = (k: Block["kind"]) => NOISE_KINDS.has(k);

// ── transcript filter (salvaged 轨迹) ──────────────────────────────────────────────
export const TRANSCRIPT_FILTERS: Array<{ key: string; label: string; kinds: Block["kind"][] | null }> = [
  { key: "all", label: "全部", kinds: null },
  { key: "think", label: "思考", kinds: ["think", "message"] },
  { key: "tool", label: "工具", kinds: ["tool", "toolnew", "web", "toolsearch", "toolschema", "inspect", "code", "subagent", "skill", "catalog"] },
  { key: "decide", label: "决策", kinds: ["plan", "validation", "sandbox", "boundarycases", "boundarydecided", "testcases", "clarify"] },
  { key: "refine", label: "修订", kinds: ["refine", "score", "revert"] },
  { key: "error", label: "错误", kinds: ["error"] },
];

export function filterBlocks(blocks: Block[], key: string): Block[] {
  const f = TRANSCRIPT_FILTERS.find((x) => x.key === key);
  if (!f || !f.kinds) return blocks;
  const set = new Set<Block["kind"]>(f.kinds);
  // A filter must NEVER hide a HITL gate the brain is parked on — its approve/classify/answer
  // controls live only inside the card, so filtering it out would strand the run with no way to act.
  return blocks.filter((b) => set.has(b.kind) || ((b.kind === "boundarycases" || b.kind === "testcases" || b.kind === "clarify") && b.awaiting));
}

// ── score dimension bars ────────────────────────────────────────────────────────────
const DIM_LABELS: Array<[keyof ScoreDims, string]> = [
  ["toolResolution", "工具解析"],
  ["promptRichness", "提示丰度"],
  ["decisionCoverage", "分支覆盖"],
  ["refineHealth", "精修健康"],
];
function DimBars({ dims }: { dims: ScoreDims }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", gap: "3px 8px", alignItems: "center", marginTop: 6 }}>
      {DIM_LABELS.map(([k, label]) => {
        const v = Math.max(0, Math.min(100, Math.round(Number(dims[k] ?? 0))));
        return (
          <div key={k} style={{ display: "contents" }}>
            <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{label}</span>
            <span style={{ height: 5, borderRadius: 3, background: "var(--border)", position: "relative" }}>
              <span style={{ position: "absolute", left: 0, top: 0, height: 5, borderRadius: 3, width: `${v}%`, background: v >= 70 ? "var(--green)" : v >= 40 ? "var(--amber)" : "var(--red)" }} />
            </span>
            <span style={{ fontSize: 10.5, color: "var(--text-2)", fontFamily: "var(--mono)" }}>{v}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── think (expand/collapse long reasoning) ──────────────────────────────────────────
function ThinkBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160;
  return (
    <div className="rise" style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text-2)", padding: "8px 12px", borderLeft: "2px solid var(--border-2)", margin: "2px 0", whiteSpace: "pre-wrap" }}>
      <span style={{ color: "var(--text-3)", fontSize: 10.5, fontFamily: "var(--mono)", marginRight: 6 }}>思考</span>
      {long && !open ? text.slice(0, 160) + "…" : text}
      {long && <button onClick={() => setOpen((v) => !v)} style={{ marginLeft: 6, fontSize: 11, color: "var(--signal)", background: "none", border: "none", cursor: "pointer" }}>{open ? "收起" : "展开"}</button>}
    </div>
  );
}

// ── HITL boundary-event decision card ─────────────────────────────────────────────────
function BoundaryCard({ proposals, awaiting, onSubmit }: { proposals: Array<{ event: string; suggestedKind: string; why: string; producers: string[]; consumer?: string; payloadContract?: string }>; awaiting: boolean; onSubmit?: (events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => void }) {
  const [rows, setRows] = useState(() => proposals.map((p) => ({ event: p.event, kind: p.suggestedKind, consumer: p.consumer ?? "", payloadContract: p.payloadContract ?? "" })));
  const [sent, setSent] = useState(false);
  const set = (i: number, patch: Partial<{ kind: string; consumer: string; payloadContract: string }>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const pending = awaiting && !sent;
  const kinds: Array<[string, string, string]> = [["external", "外部交接", "var(--blue)"], ["terminal", "终态", "var(--green)"], ["break", "真断点", "var(--red)"]];
  return (
    <div className="rise" style={{ padding: "12px 14px", border: `1px solid ${pending ? "var(--amber)" : "var(--border)"}`, borderRadius: 10, margin: "6px 0", background: "var(--panel-2)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>🔗 这些事件没有内部消费者 · 你来判断{pending ? "" : "（已提交）"}</div>
      <div style={{ fontSize: 12, color: "var(--text-2)", marginBottom: 8 }}>Inngest 事件是全局的，emit 可能由外部平台消费。判为外部交接/终态的不再算断点；真断点会去修。</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {proposals.map((p, i) => (
          <div key={p.event} style={{ borderLeft: "3px solid var(--border)", paddingLeft: 10 }}>
            <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--mono)" }}>{p.event}{p.producers.length ? <span style={{ fontWeight: 400, color: "var(--text-3)", marginLeft: 6 }}>来自 {p.producers.join("、")}</span> : null}</div>
            {p.why && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2 }}>{p.why}</div>}
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              {kinds.map(([k, label, col]) => (
                <button key={k} disabled={!pending} onClick={() => set(i, { kind: k })} style={{ fontSize: 11.5, padding: "4px 10px", borderRadius: 7, cursor: pending ? "pointer" : "default", border: `1px solid ${rows[i]!.kind === k ? col : "var(--border)"}`, background: rows[i]!.kind === k ? col : "var(--panel)", color: rows[i]!.kind === k ? "#fff" : "var(--text-2)" }}>{label}</button>
              ))}
            </div>
            {rows[i]!.kind === "external" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 7 }}>
                <input disabled={!pending} placeholder="外部消费方（平台/服务/团队）" value={rows[i]!.consumer} onChange={(e) => set(i, { consumer: e.target.value })} style={{ fontSize: 12, padding: "6px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
                <input disabled={!pending} placeholder="payload 契约（外部方会拿到哪些字段）" value={rows[i]!.payloadContract} onChange={(e) => set(i, { payloadContract: e.target.value })} style={{ fontSize: 12, padding: "6px 9px", borderRadius: 7, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
              </div>
            )}
          </div>
        ))}
      </div>
      {pending && onSubmit && (
        <div style={{ marginTop: 12 }}>
          <Button tone="primary" onClick={() => { setSent(true); onSubmit(rows.map((r) => ({ event: r.event, kind: r.kind, consumer: r.consumer || undefined, payloadContract: r.payloadContract || undefined }))); }}>确认分类</Button>
        </div>
      )}
    </div>
  );
}

// ── auto-compaction (expandable) ──────────────────────────────────────────────────────
function CompactionBlock({ b }: { b: Extract<Block, { kind: "compaction" }> }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rise" style={{ fontSize: 12, color: "var(--text-3)", padding: "8px 12px", border: "1px dashed var(--border-2)", borderRadius: 8, margin: "4px 0", background: "var(--panel-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span>🗜 {b.summary}</span>
        {b.state && <button onClick={() => setOpen((o) => !o)} style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>{open ? "收起" : "看折叠内容"}</button>}
      </div>
      {open && b.state && <pre style={{ marginTop: 6, fontSize: 11.5, fontFamily: "var(--mono)", color: "var(--text-2)", background: "var(--panel-3)", borderRadius: 6, padding: 10, whiteSpace: "pre-wrap", lineHeight: 1.6 }}>{b.state}</pre>}
    </div>
  );
}

// ── ask_user clarification card ───────────────────────────────────────────────────────
function ClarifyCard({ b, onSubmit }: { b: Extract<Block, { kind: "clarify" }>; onSubmit?: (answer: string) => void }) {
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  // Two-step: pick an option (highlights it) → a CONFIRM bar appears → confirm to submit. A single
  // click never auto-commits (the old bug: clicking any option fired immediately, so it looked like
  // the recommended one got chosen + executed). `selected` is the option index awaiting confirmation.
  const [selected, setSelected] = useState<number | null>(null);
  const pending = b.awaiting && !sent;
  const submit = (answer: string) => { if (!answer.trim() || !onSubmit || !pending) return; setSent(true); onSubmit(answer.trim()); };
  const chosen = selected != null ? b.options?.[selected] : undefined;
  return (
    <div className="rise" style={{ padding: "12px 14px", border: `1px solid ${pending ? "var(--violet)" : "var(--border)"}`, borderRadius: 10, margin: "6px 0", background: "var(--panel-2)" }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>❓ 大脑在问你{pending ? "" : "（已回答）"}</div>
      <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}>{b.question}</div>
      {b.context && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4, lineHeight: 1.5 }}>{b.context}</div>}
      {b.options && b.options.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
          {b.options.map((o, i) => {
            const isSel = selected === i;
            return (
              <button key={i} disabled={!pending} onClick={() => setSelected(i)} style={{ textAlign: "left", padding: "7px 10px", borderRadius: 8, cursor: pending ? "pointer" : "default", border: isSel ? "2px solid var(--violet)" : `1px solid ${o.recommended ? "var(--green)" : "var(--border)"}`, background: isSel ? "var(--panel-3)" : o.recommended ? "var(--panel-3)" : "var(--panel)", color: "var(--text)", fontSize: 12.5 }}>
                {o.recommended && <span style={{ color: "var(--green)", marginRight: 6, fontSize: 11 }}>★ 推荐</span>}{o.label}
                {isSel && <span style={{ color: "var(--violet)", marginLeft: 8, fontSize: 11, fontWeight: 700 }}>✓ 已选</span>}
              </button>
            );
          })}
          {pending && chosen && (
            <div style={{ display: "flex", gap: 8, marginTop: 2, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 12, color: "var(--text-2)" }}>确认选「{chosen.label.length > 28 ? chosen.label.slice(0, 27) + "…" : chosen.label}」？</span>
              <Button tone="primary" onClick={() => submit(chosen.value)}>确认</Button>
              <Button tone="ghost" onClick={() => setSelected(null)}>取消</Button>
            </div>
          )}
        </div>
      )}
      {pending && (
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
          <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") submit(text); }} placeholder="或直接补充你的回答…" style={{ flex: 1, fontSize: 12.5, padding: "7px 9px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text)" }} />
          <Button tone="primary" onClick={() => submit(text)} disabled={!text.trim()}>回答</Button>
        </div>
      )}
    </div>
  );
}

// ── the block dispatcher ──────────────────────────────────────────────────────────────
export function BlockView({ b, onDecide, onBoundary, onClarify }: { b: Block; onDecide?: (d: "approve" | "regenerate", note?: string) => void; onBoundary?: (events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => void; onClarify?: (answer: string) => void }) {
  switch (b.kind) {
    case "think":
      return <ThinkBlock text={b.text} />;
    case "compaction": return <CompactionBlock b={b} />;
    case "clarify": return <ClarifyCard b={b} onSubmit={onClarify} />;
    case "boundarycases": return <BoundaryCard proposals={b.proposals} awaiting={b.awaiting} onSubmit={onBoundary} />;
    case "boundarydecided":
      return (
        <div className="rise" style={{ padding: "12px 14px", border: "1px solid var(--border)", borderRadius: 10, margin: "6px 0", background: "var(--panel-2)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>🔗 边界事件已确认</div>
          {b.events.map((v, i) => (
            <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "5px 0", borderTop: i ? "1px solid var(--border)" : "none" }}>
              {chip(v.kind === "external" ? "外部交接" : v.kind === "terminal" ? "终态" : "待修断点", v.kind === "external" ? "var(--blue)" : v.kind === "terminal" ? "var(--green)" : "var(--red)")}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: "var(--text)", fontFamily: "var(--mono)" }}>{v.event}{v.consumer ? ` → ${v.consumer}` : ""}</div>
                {v.kind === "external" && v.payloadContract && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 1 }}>契约：{v.payloadContract}</div>}
              </div>
            </div>
          ))}
        </div>
      );
    case "testcases": {
      const tone = (k: string) => (k === "pass" ? "var(--green)" : k === "reject" ? "var(--amber)" : "var(--blue)");
      return (
        <div className="rise" style={{ padding: "12px 14px", border: `1px solid ${b.awaiting ? "var(--amber)" : "var(--border)"}`, borderRadius: 10, margin: "6px 0", background: "var(--panel-2)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>🧪 测试用例（{b.cases.length}）{b.awaiting ? " · 待你确认" : ""}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {b.cases.map((c, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${tone(c.kind)}`, paddingLeft: 10 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{chip(c.kind, tone(c.kind))} {c.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2, lineHeight: 1.5 }}>{c.scenario}</div>
                <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)", marginTop: 2 }}>入口 {c.entryEvent} · 预期 {c.expectedOutcome}</div>
              </div>
            ))}
          </div>
          {b.awaiting && onDecide && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button tone="primary" icon="play" onClick={() => onDecide("approve")}>执行这些用例</Button>
              <Button icon="replay" onClick={() => onDecide("regenerate")}>重新生成</Button>
            </div>
          )}
        </div>
      );
    }
    case "message": return <div className="rise" style={{ fontSize: 13.5, lineHeight: 1.7, color: "var(--text)", padding: "10px 12px", borderLeft: "2px solid var(--signal)", margin: "4px 0", whiteSpace: "pre-wrap" }}>{b.text}</div>;
    case "tool": { const pending = b.ok === undefined; return <div className="rise" style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px", background: "var(--panel-2)", borderRadius: 8, margin: "4px 0" }}><StatusDot status={pending ? "running" : b.ok ? "ok" : "failed"} size={7} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--mono)" }}>{b.name}<span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: pending ? "var(--text-3)" : b.ok ? "var(--green)" : "var(--red)" }}>{pending ? "运行中…" : b.ok ? "✓" : "✗"}</span></div>{b.reasoning && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2 }}>{b.reasoning}</div>}{b.summary && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3, lineHeight: 1.5 }}>{b.summary}</div>}</div></div>; }
    case "plan": return <div className="rise" style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, margin: "4px 0" }}><div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>📋 方案 · {b.agents} 个 agent</div><div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 3, lineHeight: 1.6 }}>{b.summary}</div></div>;
    case "validation": return <div className="rise" style={{ padding: "10px 12px", border: `1px solid ${b.ok ? "var(--green)" : "var(--amber)"}`, borderRadius: 8, margin: "4px 0" }}><div style={{ fontSize: 12.5, fontWeight: 600, color: b.ok ? "var(--green)" : "var(--amber)" }}>{b.ok ? "✓ 事件图闭合（含字段合同）" : "⚠ 事件图未闭合"}</div>{!b.ok && b.issues.slice(0, 5).map((i, k) => <div key={k} style={{ fontSize: 12, color: "var(--text-2)", marginTop: 3 }}>· {i}</div>)}</div>;
    case "sandbox": { const sev = b.ev as { appId?: string; functionsRegistered?: number; registeredIds?: string[]; agentRuns?: Array<{ agentSlug?: string; agentShort?: string; status?: string }> }; const sim = Boolean(b.ev.simulated); const ok = Boolean(b.ev.fullChainRan); const col = sim ? "var(--amber)" : ok ? "var(--green)" : "var(--amber)"; const title = b.ev.deployFailed ? "🧪 沙箱部署未生效" : sim ? (ok ? "🧪 沙箱（模拟）图闭包推断可跑通" : "🧪 沙箱（模拟）未闭合") : (ok ? "🧪 沙箱端到端真跑通 ✓" : "🧪 沙箱未完全跑通"); return <div className="rise" style={{ padding: "10px 12px", border: `1px solid ${col}`, borderRadius: 8, margin: "4px 0", background: "var(--panel-2)" }}><div style={{ fontSize: 12.5, fontWeight: 600, color: col }}>{title}</div><div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 6 }}>{chip(sim ? "⚠ 模拟·未真实执行" : "真实部署执行", sim ? "var(--amber)" : "var(--green)")}{chip(`部署 ${b.ev.functionsRegistered ?? 0}`)}{chip(`跑 ${b.ev.ran ?? 0}`)}{chip(`成功终态 ${b.ev.reachedSuccessTerminal ? "是" : "否"}`, b.ev.reachedSuccessTerminal ? "var(--green)" : "var(--amber)")}{Number(b.ev.externalTerminals ?? 0) > 0 ? chip(`${Number(b.ev.internalChains ?? 0)} 内部链 + ${Number(b.ev.externalTerminals)} 外部交接终态`, "var(--violet)") : null}</div>{sev.appId && <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid var(--border)" }}><div style={{ fontSize: 11.5, color: "var(--text-2)" }}>🚀 Inngest 沙箱 App：<span style={{ fontFamily: "var(--mono)", color: "var(--text)", fontWeight: 700 }}>{sev.appId}</span> · 注册 {sev.functionsRegistered ?? 0} 个函数{Array.isArray(sev.registeredIds) ? ` · 部署 ${sev.registeredIds.length} 个智能体` : ""}</div>{Array.isArray(sev.registeredIds) && sev.registeredIds.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>{sev.registeredIds.map((id: string, i: number) => { const ar = (sev.agentRuns ?? []).find((a) => a.agentSlug === id); const st = ar?.status; const ran = st === "ok" || st === "Completed"; const stCol = ran ? "var(--green)" : st === "running" ? "var(--blue)" : st ? "var(--amber)" : "var(--text-3)"; return <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontFamily: "var(--mono)" }}><span style={{ color: "var(--green)" }}>✓</span><span style={{ color: "var(--text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ar?.agentShort || id}</span><span style={{ color: stCol, flexShrink: 0 }}>· {ar ? (ran ? "已注册·已跑通" : st === "running" ? "已注册·运行中" : `已注册·${st}`) : "已注册"}</span></div>; })}</div>}</div>}{Number(b.ev.externalTerminals ?? 0) > 0 && <div style={{ fontSize: 11, color: "var(--text-3)", marginTop: 5 }}>有 {Number(b.ev.externalTerminals)} 个 agent 的产出是交给外部平台消费的「外部交接终态」（如 JD_GENERATED→外部系统），算合法终态、不是断链。</div>}{sim && <div style={{ fontSize: 11, color: "var(--text-2)", marginTop: 5 }}>模拟＝按事件图闭包推断会跑通，未真实部署执行。设 FACTORY_REAL_DEPLOY=1 做真实验证。</div>}</div>; }
    // Tier-3 narration: muted, borderless one-liners (no panel fill, no entrance animation) so they
    // sit quietly beneath the tier-1/2 milestones. Container gap owns vertical rhythm.
    case "refine": return (
      <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>
        🔧 精修「{b.action}」：{b.critique}
        {b.diff && (
          <span style={{ display: "inline-flex", gap: 5, flexWrap: "wrap", marginLeft: 6, verticalAlign: "middle" }}>
            {b.diff.systemPromptChanged && chip("改了 prompt", "var(--blue)")}
            {b.diff.decisionLogicChanged && chip("改了分支逻辑", "var(--violet)")}
            {b.diff.toolsAdded.map((t) => chip(`+${t}`, "var(--green)"))}
            {b.diff.toolsRemoved.map((t) => chip(`−${t}`, "var(--red)"))}
          </span>
        )}
      </div>
    );
    case "score": return (
      <div className="rise" style={{ padding: "9px 12px", border: `1px solid ${b.regression ? "var(--red)" : "var(--green)"}`, borderRadius: 10, background: "var(--panel-2)" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>📈 评分「{b.action}」</span>
          <span style={{ fontSize: 12, fontFamily: "var(--mono)", color: "var(--text-2)" }}>{b.prior} → {b.next}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: b.regression ? "var(--red)" : "var(--green)" }}>{b.delta >= 0 ? "▲ +" : "▼ "}{b.delta}{b.regression ? " · 退步" : ""}</span>
        </div>
        <DimBars dims={b.dims} />
      </div>
    );
    case "revert": return <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}><span style={{ color: "var(--amber)" }}>↩</span> 回滚「{b.action}」到第 {b.toAttempt} 次精修之前（这轮退步了）。</div>;
    case "skill": return <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>✨ 创造技能「{b.name}」：{b.purpose}</div>;
    case "subagent": return <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>🧠 子大脑：{b.task}{b.summary ? ` → ${b.summary.slice(0, 120)}` : "（进行中…）"}</div>;
    case "budget": return <div style={{ fontSize: 11, color: b.level === "high" ? "var(--amber)" : "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>⏱ {b.text}</div>;
    case "reflect": return <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>🧠 反思：{b.text}</div>;
    case "catalog": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>📖 {b.text}</div>;
    case "toolnew": return <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>🔧 造工具「{b.name}」{b.desc ? `：${b.desc}` : ""}</div>;
    case "web": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>🔍 检索「{b.query}」· {b.count} 条结果</div>;
    case "toolsearch": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>🔎 工具搜索「{b.query}」· {b.count} 个候选</div>;
    case "toolschema": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>🔗 解析出工具 {b.name}（{b.method || "?"} · {b.fields} 字段）</div>;
    case "inspect": return <div style={{ fontSize: 12, color: b.degraded ? "var(--amber)" : "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>🔬 诊断 {b.agentSlug}：{b.status}{b.degraded ? " · 降级" : ""}{b.error ? ` · ${b.error.slice(0, 80)}` : ""}</div>;
    case "code": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>✍️ 为「{b.actionName}」{b.codeSource === "ai" ? "亲手写好代码（AI）" : "渲染脚手架代码"}</div>;
    case "done": return <div className="rise" style={{ padding: "10px 12px", border: `1px solid ${b.status === "finished" ? "var(--green)" : "var(--border)"}`, borderRadius: 8, margin: "6px 0", textAlign: "center", fontSize: 12.5, fontWeight: 600, color: b.status === "finished" ? "var(--green)" : "var(--text-2)" }}>{b.status === "finished" ? "✅ 交付完成" : `结束（${b.status}）`}</div>;
    case "error": return <div className="rise" style={{ padding: "10px 12px", border: "1px solid var(--red)", borderRadius: 8, margin: "4px 0", fontSize: 12.5, color: "var(--red)" }}>⚠ {b.text}</div>;
  }
}

// ── collapsed cluster of routine (think/tool) blocks ───────────────────────────────────
function NoiseCluster({ blocks }: { blocks: Block[] }) {
  const [open, setOpen] = useState(false);
  const thinks = blocks.filter((b) => b.kind === "think").length;
  const ops = blocks.length - thinks;
  const label = thinks && ops ? `思考 ${thinks} · 操作 ${ops}` : thinks ? `思考 ${thinks} 步` : `操作 ${ops} 步`;
  return (
    <div className="rise" style={{ margin: "2px 0" }}>
      <button onClick={() => setOpen((o) => !o)} className="hover-row" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "5px 12px", background: "none", border: "none", borderLeft: "2px solid var(--border-2)", cursor: "pointer", color: "var(--text-3)", fontSize: 12, borderRadius: 6 }}>
        <span style={{ display: "inline-flex", transition: "transform 0.15s", transform: open ? "none" : "rotate(-90deg)", opacity: 0.7 }}><StatusDot status="idle" size={5} /></span>
        <span>💭 {label}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)" }}>{open ? "收起" : "展开"}</span>
      </button>
      {open && <div style={{ marginLeft: 5, paddingLeft: 6, borderLeft: "1px dashed var(--border)" }}>{blocks.map((b) => <BlockView key={b.id} b={b} />)}</div>}
    </div>
  );
}

/** Render the transcript. In `grouped` mode (the default 全部 view) consecutive routine blocks
 *  collapse into a NoiseCluster so the feed reads as milestones; a category filter renders flat. */
export function TranscriptFeed({ blocks, grouped, onDecide, onBoundary, onClarify }: { blocks: Block[]; grouped: boolean; onDecide?: (d: "approve" | "regenerate", note?: string) => void; onBoundary?: (events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => void; onClarify?: (answer: string) => void }) {
  if (!grouped) return <>{blocks.map((b) => <BlockView key={b.id} b={b} onDecide={onDecide} onBoundary={onBoundary} onClarify={onClarify} />)}</>;
  const out: ReactNode[] = [];
  let buf: Block[] = [];
  const flush = () => {
    if (!buf.length) return;
    // A lone routine block isn't worth a cluster — render it inline; 2+ collapse.
    if (buf.length === 1) out.push(<BlockView key={buf[0]!.id} b={buf[0]!} />);
    else out.push(<NoiseCluster key={`cluster-${buf[0]!.id}`} blocks={buf} />);
    buf = [];
  };
  for (const b of blocks) {
    if (isNoiseBlock(b.kind)) { buf.push(b); continue; }
    flush();
    out.push(<BlockView key={b.id} b={b} onDecide={onDecide} onBoundary={onBoundary} onClarify={onClarify} />);
  }
  flush();
  return <>{out}</>;
}
