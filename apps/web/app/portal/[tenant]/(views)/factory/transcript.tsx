"use client";

/**
 * Agent 工厂 — the CENTER TRANSCRIPT: the complete, full-fidelity thinking process (think →
 * tool → code → refine → budget → …). This is intentionally lossless — every block kind the
 * brain emits renders here. The redesign only ADDS the three previously-invisible reasoning
 * blocks (score / revert / refine diff). The dropped 轨迹 tab's one unique value — a dense,
 * filterable index — survives as the filter strip (TRANSCRIPT_FILTERS) applied on top.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Button, StatusDot, Markdown } from "@/app/portal/components";
import { chip } from "./atoms";
import {
  isAnswerCompletion,
  isDeliveryCompletion,
  type Block,
  type ScoreDims,
} from "./model";

// ── milestone view ────────────────────────────────────────────────────────────────
// The transcript is lossless, but routine narration (think deltas, tool calls, searches,
// code-render, catalog/budget ticks) buries the moments that matter. The milestone view folds
// consecutive routine blocks into ONE expandable "思考与操作 · N 步" cluster, so the thread reads
// as: brain message → plan → agent decisions → validation → sandbox verdict → HITL gates → done.
// PROCESS 块（大脑的思考/工具/反思/评分等过程）默认折叠，只有大脑对你说的话（message）、里程碑
// （plan/validation/sandbox）、结束/出错、待决策门保持可见——聊天区读起来是对话，不是刷屏日志。
const NOISE_KINDS = new Set<Block["kind"]>(["think", "reasoning", "tool", "web", "toolsearch", "toolschema", "inspect", "code", "catalog", "budget", "compaction", "reflect", "score", "refine", "revert", "subagent", "skill", "toolnew", "boundarydecided"]);
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

// ── think (expand/collapse long reasoning; 详尽模式默认全文) ─────────────────────────
function ThinkBlock({ text, expandAll }: { text: string; expandAll?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 160;
  const showFull = expandAll || open || !long; // markdown-render the full body; keep the collapsed preview plain
  return (
    <div className="rise" style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text-2)", padding: "8px 12px", borderLeft: "2px solid var(--border-2)", margin: "2px 0" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span style={{ color: "var(--text-3)", fontSize: 10.5, fontFamily: "var(--mono)", flexShrink: 0, marginTop: 2 }}>思考</span>
        {showFull
          ? <div style={{ flex: 1, minWidth: 0 }}><Markdown>{text}</Markdown></div>
          : <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap" }}>{text.slice(0, 160) + "…"}</span>}
        {long && !expandAll && <button onClick={() => setOpen((v) => !v)} style={{ fontSize: 11, color: "var(--signal)", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>{open ? "收起" : "展开"}</button>}
      </div>
    </div>
  );
}

// ── reasoning.step (#CLEAN-ANSWER) — a real kernel deliberation behind an answer/blueprint phase.
// Same foldable affordance as think, but violet-accented + strategy-labelled so 详尽 view can show
// the full "真推理", while 精简 folds it into the cluster and the message card stays a clean answer.
const STRATEGY_ZH: Record<string, string> = { cot: "链式推理", reflection: "反思重写", debate: "多方论证", tot: "思维树", react: "行动规划" };
function ReasoningBlock({ b, expandAll }: { b: Extract<Block, { kind: "reasoning" }>; expandAll?: boolean }) {
  const [open, setOpen] = useState(false);
  const long = b.text.length > 200;
  const showFull = expandAll || open || !long;
  const label = `推理 · ${STRATEGY_ZH[b.strategy] ?? b.strategy}${b.forAgent ? ` · ${b.forAgent}` : ""}`;
  return (
    <div className="rise" style={{ fontSize: 12.5, lineHeight: 1.7, color: "var(--text-2)", padding: "8px 12px", borderLeft: "2px solid var(--violet)", margin: "2px 0" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span style={{ color: "var(--violet)", fontSize: 10.5, fontFamily: "var(--mono)", flexShrink: 0, marginTop: 2, whiteSpace: "nowrap" }}>{label}</span>
        {showFull
          ? <div style={{ flex: 1, minWidth: 0 }}><Markdown>{b.text}</Markdown></div>
          : <span style={{ flex: 1, minWidth: 0, whiteSpace: "pre-wrap" }}>{b.text.slice(0, 200) + "…"}</span>}
        {long && !expandAll && <button onClick={() => setOpen((v) => !v)} style={{ fontSize: 11, color: "var(--signal)", background: "none", border: "none", cursor: "pointer", flexShrink: 0 }}>{open ? "收起" : "展开"}</button>}
      </div>
    </div>
  );
}

// ── user bubble (#USER-MESSAGE) — the human side of the dialogue ─────────────────────
function UserBubble({ text }: { text: string }) {
  return (
    <div className="rise" style={{ display: "flex", justifyContent: "flex-end", margin: "8px 0" }}>
      <div style={{ maxWidth: "78%", padding: "9px 13px", borderRadius: "14px 14px 4px 14px", background: "var(--panel-3)", border: "1px solid var(--border-2)", fontSize: 13.5, lineHeight: 1.65, color: "var(--text)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
        <div style={{ fontSize: 10, color: "var(--text-3)", marginBottom: 3, textAlign: "right" }}>你</div>
        {text}
      </div>
    </div>
  );
}

// ── inline visualization (#VIZ-INLINE) — thumbnail in chat, click → lightbox ─────────
/** Download a server-rendered SVG verbatim. The bytes are the SAME deterministic artifact the
 * report/蓝图 tab embed, so a saved file always matches what was on screen. */
function downloadSvg(svg: string, name: string): void {
  const safe = (name.replace(/[\\/:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "") || "blueprint").slice(0, 80);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe}.svg`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

function VizLightbox({ svgs, title, index, onClose }: { svgs: Array<{ title: string; svg: string }>; title: string; index: number; onClose: () => void }) {
  // The server SVG carries BOTH viewBox and explicit width/height, so it renders at natural size
  // and could not be fitted or scaled. `.viz-full svg` drops the fixed size (viewBox keeps the
  // aspect ratio), and this zoom multiplies the wrapper width — 1 = fit-to-width.
  const [zoom, setZoom] = useState(1);
  const [tab, setTab] = useState(index);
  const current = svgs[tab] ?? svgs[0];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") setZoom((z) => ZOOM_STEPS[Math.min(ZOOM_STEPS.indexOf(z as 1) + 1, ZOOM_STEPS.length - 1)] ?? z);
      if (e.key === "-") setZoom((z) => ZOOM_STEPS[Math.max(ZOOM_STEPS.indexOf(z as 1) - 1, 0)] ?? z);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!current) return null;
  const btn = { fontSize: 12, padding: "3px 9px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text-2)", cursor: "pointer" } as const;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.72)", display: "flex", flexDirection: "column", padding: "3vh 3vw" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", borderRadius: 12, border: "1px solid var(--border)", background: "var(--panel)", overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--text)" }}>{title}</span>
          {svgs.length > 1 && (
            <span style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
              {svgs.map((d, i) => (
                <button key={i} onClick={() => setTab(i)} style={{ fontSize: 11.5, padding: "3px 10px", border: "none", cursor: "pointer", background: tab === i ? "var(--signal)" : "transparent", color: tab === i ? "var(--on-accent, #fff)" : "var(--text-3)" }}>{d.title}</button>
              ))}
            </span>
          )}
          <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6 }}>
            <button aria-label="缩小" style={btn} onClick={() => setZoom((z) => ZOOM_STEPS[Math.max(ZOOM_STEPS.indexOf(z as 1) - 1, 0)] ?? z)}>−</button>
            <span style={{ fontSize: 11.5, color: "var(--text-2)", fontFamily: "var(--mono)", minWidth: 58, textAlign: "center" }}>{zoom === 1 ? "适应宽度" : `${zoom}×`}</span>
            <button aria-label="放大" style={btn} onClick={() => setZoom((z) => ZOOM_STEPS[Math.min(ZOOM_STEPS.indexOf(z as 1) + 1, ZOOM_STEPS.length - 1)] ?? z)}>＋</button>
            <button style={btn} onClick={() => downloadSvg(current.svg, current.title)}>⬇ 下载 SVG</button>
            <button onClick={onClose} aria-label="关闭" style={{ ...btn, border: "none", background: "none", fontSize: 16, lineHeight: 1 }}>✕</button>
          </span>
          <span style={{ flexBasis: "100%", fontSize: 10.5, color: "var(--text-4)" }}>Esc 关闭 · +/− 缩放 · 点背景关闭</span>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 16, background: "var(--panel-3)" }}>
          <div className="viz-full" style={{ width: `${zoom * 100}%`, transition: "width 0.12s ease" }} dangerouslySetInnerHTML={{ __html: current.svg }} />
        </div>
      </div>
    </div>
  );
}

function VizCard({ b }: { b: Extract<Block, { kind: "viz" }> }) {
  const [openIdx, setOpenIdx] = useState<number | null>(null);
  return (
    <div className="rise" style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, margin: "6px 0", background: "var(--panel-2)" }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{b.title}</div>
      {b.note && <div style={{ fontSize: 11.5, color: "var(--text-3)", marginTop: 2 }}>{b.note}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 8, flexWrap: "wrap" }}>
        {b.svgs.map((d, i) => (
          <button key={i} onClick={() => setOpenIdx(i)} title={`点击放大 · ${d.title}`} style={{ position: "relative", width: "min(340px, 100%)", height: 170, overflow: "hidden", borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel)", cursor: "zoom-in", padding: 0, textAlign: "left" }}>
            <div className="viz-thumb" style={{ pointerEvents: "none" }} dangerouslySetInnerHTML={{ __html: d.svg }} />
            <span style={{ position: "absolute", left: 8, bottom: 6, fontSize: 10.5, color: "var(--text-2)", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 5, padding: "1px 7px", opacity: 0.92 }}>{d.title} · 🔍 放大</span>
          </button>
        ))}
      </div>
      {openIdx != null && <VizLightbox svgs={b.svgs} title={b.title} index={openIdx} onClose={() => setOpenIdx(null)} />}
    </div>
  );
}

// ── HITL boundary-event decision card ─────────────────────────────────────────────────
function BoundaryCard({ proposals, awaiting, onSubmit }: { proposals: Array<{ event: string; suggestedKind: string; why: string; producers: string[]; consumer?: string; payloadContract?: string }>; awaiting: boolean; onSubmit?: (events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => void }) {
  const [rows, setRows] = useState(() => proposals.map((p) => ({ event: p.event, kind: p.suggestedKind, consumer: p.consumer ?? "", payloadContract: p.payloadContract ?? "" })));
  const [sent, setSent] = useState(false);
  const set = (i: number, patch: Partial<{ kind: string; consumer: string; payloadContract: string }>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  // Actionable only with a wired callback — passive history otherwise (InteractionDock owns the
  // action; avoids the same decision being submittable in two places).
  const pending = awaiting && !sent && !!onSubmit;
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
                <button key={k} disabled={!pending} onClick={() => set(i, { kind: k })} style={{ fontSize: 11.5, padding: "4px 10px", borderRadius: 7, cursor: pending ? "pointer" : "default", border: `1px solid ${rows[i]!.kind === k ? col : "var(--border)"}`, background: rows[i]!.kind === k ? col : "var(--panel)", color: rows[i]!.kind === k ? "var(--on-accent)" : "var(--text-2)" }}>{label}</button>
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
  // Actionable ONLY when a submit callback is wired. The InteractionDock (pinned above the
  // composer) is the single action surface; the transcript keeps this card as passive history
  // (no callback → no input controls) so the same question isn't answerable in two places.
  const pending = b.awaiting && !sent && !!onSubmit;
  const submit = (answer: string) => { if (!answer.trim() || !onSubmit || !pending) return; setSent(true); onSubmit(answer.trim()); };
  const chosen = selected != null ? b.options?.[selected] : undefined;
  return (
    <div className="rise" style={{ padding: "12px 14px", border: `1px solid ${b.awaiting ? "var(--violet)" : "var(--border)"}`, borderRadius: 10, margin: "6px 0", background: "var(--panel-2)" }}>
      {/* #CLARIFY-CLEAR — label from b.awaiting (real state), not `pending` (whether it's answerable HERE);
          the passive transcript card has no callback so pending is always false — it must still read
          "waiting" while the brain is genuinely parked, and flip to "answered" only once resolved. */}
      <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 4 }}>❓ 大脑在问你{b.awaiting ? (pending ? "" : "（等待你回答 · 在下方交互区作答）") : "（已回答）"}</div>
      <div style={{ fontSize: 13, color: "var(--text)", lineHeight: 1.6 }}><Markdown>{b.question}</Markdown></div>
      {b.context && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 4, lineHeight: 1.5 }}><Markdown>{b.context}</Markdown></div>}
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
export function BlockView({ b, onDecide, onBoundary, onClarify, expandAll }: { b: Block; onDecide?: (d: "approve" | "regenerate", note?: string) => void; onBoundary?: (events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => void; onClarify?: (answer: string) => void; expandAll?: boolean }) {
  switch (b.kind) {
    case "think":
      return <ThinkBlock text={b.text} expandAll={expandAll} />;
    case "reasoning": return <ReasoningBlock b={b} expandAll={expandAll} />;
    case "user": return <UserBubble text={b.text} />;
    case "viz": return <VizCard b={b} />;
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
      // #W3-FAULT — fault gets its own violet tone + label so an error-propagation case reads
      // distinctly from a happy-path/reject/edge case.
      const tone = (k: string) => (k === "pass" ? "var(--green)" : k === "reject" ? "var(--amber)" : k === "fault" ? "var(--violet, #a78bfa)" : "var(--blue)");
      const kindLabel = (k: string) => (k === "pass" ? "正常通过" : k === "reject" ? "规则拦截" : k === "edge" ? "边界" : k === "fault" ? "⚡故障注入" : k);
      const cov = b.coverage;
      return (
        <div className="rise" style={{ padding: "12px 14px", border: `1px solid ${b.awaiting ? "var(--amber)" : "var(--border)"}`, borderRadius: 10, margin: "6px 0", background: "var(--panel-2)" }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>🧪 测试用例（{b.cases.length}）{b.awaiting ? " · 待你确认" : ""}</div>
          {cov && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
              {chip(`覆盖 ${cov.covered.length}/${cov.required.length} 格`, cov.uncoveredNeedingData.length ? "var(--amber)" : "var(--green)")}
              {cov.backfilled.length > 0 && chip(`矩阵补位 ${cov.backfilled.length}`, "var(--blue)")}
              {cov.uncoveredNeedingData.length > 0 && <span style={{ fontSize: 11, color: "var(--amber)" }}>⚠ 缺 {cov.uncoveredNeedingData.length} 格需真实数据（{cov.uncoveredNeedingData.slice(0, 3).join("、")}）</span>}
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {b.cases.map((c, i) => (
              <div key={i} style={{ borderLeft: `3px solid ${tone(c.kind)}`, paddingLeft: 10 }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>{chip(kindLabel(c.kind), tone(c.kind))} {c.name}</div>
                <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2, lineHeight: 1.5 }}>{c.scenario}</div>
                <div style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)", marginTop: 2 }}>入口 {c.entryEvent} · 预期 {c.expectedOutcome}</div>
              </div>
            ))}
          </div>
          {b.awaiting && onDecide && (
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button
                tone="primary"
                icon="play"
                disabled={Boolean(cov?.uncoveredNeedingData.length)}
                onClick={() => onDecide("approve")}
              >{cov?.uncoveredNeedingData.length ? "请在交互区确认覆盖豁免" : "执行这些用例"}</Button>
              <Button icon="replay" onClick={() => onDecide("regenerate")}>重新生成</Button>
            </div>
          )}
        </div>
      );
    }
    case "message": return <div className="rise" style={{ fontSize: 13.5, color: "var(--text)", padding: "10px 12px", borderLeft: "2px solid var(--signal)", margin: "4px 0" }}><Markdown>{b.text}</Markdown></div>;
    case "tool": { const pending = b.ok === undefined; return <div className="rise" style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "8px 12px", background: "var(--panel-2)", borderRadius: 8, margin: "4px 0" }}><StatusDot status={pending ? "running" : b.ok ? "ok" : "failed"} size={7} /><div style={{ flex: 1, minWidth: 0 }}><div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)", fontFamily: "var(--mono)" }}>{b.role && <span style={{ color: "var(--signal)" }}>{b.role} · </span>}{b.name}<span style={{ marginLeft: 8, fontSize: 11, fontWeight: 400, color: pending ? "var(--text-3)" : b.ok ? "var(--green)" : "var(--red)" }}>{pending ? `运行中…${b.elapsedS ? ` 已 ${b.elapsedS >= 60 ? `${Math.floor(b.elapsedS / 60)}m${b.elapsedS % 60}s` : `${b.elapsedS}s`}（有心跳，未卡死）` : ""}` : b.ok ? "✓" : "✗"}</span></div>{b.reasoning && <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 2 }}>{b.reasoning}</div>}{b.ok === undefined && b.progressNote && <div style={{ fontSize: 11.5, color: "var(--amber)", marginTop: 3 }}>⏳ {b.progressNote}</div>}{b.summary && <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 3, lineHeight: 1.5 }}>{b.summary}</div>}</div></div>; }
    case "plan": return <div className="rise" style={{ padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 8, margin: "4px 0" }}><div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>📋 方案 · {b.agents} 个 agent</div><div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 3, lineHeight: 1.6 }}><Markdown>{b.summary}</Markdown></div></div>;
    case "validation": return <div className="rise" style={{ padding: "10px 12px", border: `1px solid ${b.ok ? "var(--green)" : "var(--amber)"}`, borderRadius: 8, margin: "4px 0" }}><div style={{ fontSize: 12.5, fontWeight: 600, color: b.ok ? "var(--green)" : "var(--amber)" }}>{b.ok ? "✓ 事件图闭合（含字段合同）" : "⚠ 事件图未闭合"}</div>{!b.ok && b.issues.slice(0, 5).map((i, k) => <div key={k} style={{ fontSize: 12, color: "var(--text-2)", marginTop: 3 }}>· {i}</div>)}</div>;
    case "sandbox": {
      const sev = b.ev as {
        appId?: string;
        functionsRegistered?: number;
        registeredIds?: string[];
        codeRanAgents?: string[];
        agentRuns?: Array<{
          agentSlug?: string;
          agentShort?: string;
          status?: string;
        }>;
        caseVerdicts?: {
          allPass: boolean;
          results: Array<{ kind: string; pass: boolean; reason: string }>;
          byKind: Record<string, { total: number; passed: number }>;
        };
      };
      const simulated = Boolean(b.ev.simulated);
      const ok =
        !simulated &&
        (Boolean(b.ev.fullChainRan) ||
          Boolean(b.ev.reachedSuccessTerminal));
      const color = ok ? "var(--green)" : "var(--red)";
      const title = simulated
        ? "🧪 历史模拟记录 · legacy / invalid evidence"
        : b.ev.deployFailed
          ? "🧪 真实沙箱部署未生效"
          : ok
            ? "🧪 沙箱端到端真跑通 ✓"
            : "🧪 真实沙箱未完全跑通";
      return (
        <div
          className="rise"
          style={{
            padding: "10px 12px",
            border: `1px solid ${color}`,
            borderRadius: 8,
            margin: "4px 0",
            background: "var(--panel-2)",
          }}
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, color }}>
            {title}
          </div>
          <div
            style={{
              display: "flex",
              gap: 6,
              flexWrap: "wrap",
              marginTop: 6,
            }}
          >
            {chip(
              simulated
                ? "⚠ 未真实执行 · 不计入成功/覆盖/验收"
                : "真实部署执行",
              simulated ? "var(--red)" : "var(--green)",
            )}
            {chip(`部署 ${b.ev.functionsRegistered ?? 0}`)}
            {chip(`跑 ${b.ev.ran ?? 0}`)}
            {chip(
              simulated
                ? "成功终态：无有效证据"
                : `成功终态 ${b.ev.reachedSuccessTerminal ? "是" : "否"}`,
              !simulated && b.ev.reachedSuccessTerminal
                ? "var(--green)"
                : "var(--amber)",
            )}
            {!simulated && Number(b.ev.externalTerminals ?? 0) > 0
              ? chip(
                  `${Number(b.ev.internalChains ?? 0)} 内部链 + ${Number(b.ev.externalTerminals)} 外部交接终态`,
                  "var(--blue)",
                )
              : null}
          </div>
          {sev.appId && (
            <div
              style={{
                marginTop: 8,
                paddingTop: 8,
                borderTop: "1px solid var(--border)",
              }}
            >
              <div style={{ fontSize: 11.5, color: "var(--text-2)" }}>
                Inngest 沙箱 App：
                <span
                  style={{
                    fontFamily: "var(--mono)",
                    color: "var(--text)",
                    fontWeight: 700,
                  }}
                >
                  {sev.appId}
                </span>
                {" · "}
                注册 {sev.functionsRegistered ?? 0} 个函数
                {Array.isArray(sev.registeredIds)
                  ? ` · 记录 ${sev.registeredIds.length} 个智能体`
                  : ""}
              </div>
              {Array.isArray(sev.registeredIds) &&
                sev.registeredIds.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 3,
                      marginTop: 6,
                    }}
                  >
                    {sev.registeredIds.map((id: string, index: number) => {
                      const agentRun = (sev.agentRuns ?? []).find(
                        (agent) => agent.agentSlug === id,
                      );
                      const status = agentRun?.status;
                      const ran =
                        !simulated &&
                        (status === "ok" || status === "Completed");
                      const statusColor = simulated
                        ? "var(--red)"
                        : ran
                          ? "var(--green)"
                          : status === "running"
                            ? "var(--blue)"
                            : status
                              ? "var(--amber)"
                              : "var(--text-3)";
                      const codeReallyRan =
                        !simulated &&
                        (sev.codeRanAgents ?? []).some(
                          (agent) =>
                            agent === agentRun?.agentShort || agent === id,
                        );
                      return (
                        <div
                          key={index}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            fontSize: 11,
                            fontFamily: "var(--mono)",
                          }}
                        >
                          <span style={{ color: statusColor }}>
                            {ran ? "✓" : "✗"}
                          </span>
                          <span
                            style={{
                              color: "var(--text)",
                              minWidth: 0,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {agentRun?.agentShort || id}
                          </span>
                          <span style={{ color: statusColor, flexShrink: 0 }}>
                            ·{" "}
                            {simulated
                              ? "历史模拟记录，无执行证明"
                              : agentRun
                                ? ran
                                  ? "已注册·已跑通"
                                  : status === "running"
                                    ? "已注册·运行中"
                                    : `已注册·${status}`
                                : "已注册"}
                          </span>
                          {!simulated && (
                            <span
                              title={
                                codeReallyRan
                                  ? "生成代码在沙箱里真实执行（CodeAct）"
                                  : "走声明式执行（未跑生成代码）"
                              }
                              style={{
                                flexShrink: 0,
                                fontWeight: 700,
                                color: codeReallyRan
                                  ? "var(--violet, #a78bfa)"
                                  : "var(--text-3)",
                              }}
                            >
                              · {codeReallyRan ? "代码真跑" : "声明式"}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>
          )}
          {sev.caseVerdicts &&
            Array.isArray(sev.caseVerdicts.results) &&
            sev.caseVerdicts.results.length > 0 &&
            (() => {
              const verdicts = sev.caseVerdicts!;
              const kindLabel = (kind: string) =>
                kind === "pass"
                  ? "正常通过"
                  : kind === "reject"
                    ? "规则拦截"
                    : kind === "edge"
                      ? "边界"
                      : kind === "fault"
                        ? "故障注入"
                        : kind;
              const realAllPass = !simulated && verdicts.allPass;
              return (
                <div
                  style={{
                    marginTop: 8,
                    paddingTop: 8,
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      fontSize: 11.5,
                      color: "var(--text-2)",
                      marginBottom: 5,
                    }}
                  >
                    用例判定 · 逐类
                    <span
                      style={{
                        marginLeft: 6,
                        color: realAllPass
                          ? "var(--green)"
                          : "var(--amber)",
                        fontWeight: 700,
                      }}
                    >
                      {simulated
                        ? "历史记录值 · 不计入验收"
                        : realAllPass
                          ? "全类通过"
                          : "有未通过类"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    {Object.entries(verdicts.byKind)
                      .filter(([, summary]) => summary.total > 0)
                      .map(([kind, summary]) => (
                        <span key={kind}>
                          {chip(
                            `${kindLabel(kind)} ${summary.passed}/${summary.total}`,
                            simulated
                              ? "var(--amber)"
                              : summary.passed === summary.total
                                ? "var(--green)"
                                : "var(--red)",
                          )}
                        </span>
                      ))}
                  </div>
                </div>
              );
            })()}
          {!simulated && Number(b.ev.externalTerminals ?? 0) > 0 && (
            <div
              style={{
                fontSize: 11,
                color: "var(--text-3)",
                marginTop: 5,
              }}
            >
              有 {Number(b.ev.externalTerminals)} 个 agent 的产出交给外部平台消费，
              属于有真实回执的外部交接终态。
            </div>
          )}
          {simulated && (
            <div
              role="alert"
              style={{ fontSize: 11, color: "var(--red)", marginTop: 5 }}
            >
              这是旧版或测试环境留下的模拟诊断，仅保留作排障记录；它未执行真实部署，
              不会计入成功、覆盖率、验收或交付状态。请重新运行真实沙箱并取得执行回执。
            </div>
          )}
        </div>
      );
    }
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
    case "subagent": return <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55, ...(b.groupId ? { marginLeft: 16, borderLeft: "2px solid var(--border-2)", paddingLeft: 10 } : {}) }}>🧠 子大脑：{b.task}{b.summary ? ` → ${b.summary.slice(0, 120)}` : "（进行中…）"}</div>;
    // #SUBAGENT-GROUP — the header for a reasoning-driven group; its member 子大脑 cards (same groupId) indent below it.
    case "group": return (
      <div className="rise" style={{ margin: "6px 0", padding: "8px 12px", border: `1px solid ${b.done ? "var(--border)" : "var(--violet)"}`, borderRadius: 10, background: "var(--panel-2)" }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>🧩 子智能体组「{b.label}」<span style={{ fontWeight: 400, color: "var(--text-3)" }}> · {b.members} 成员 · {b.mode === "research" ? "只读调研" : b.mode === "build" ? "设计落地" : b.mode === "design" ? "并行设计" : b.mode === "review" ? "并行审查" : b.mode === "refine" ? "并行修复" : b.mode}{b.done ? ` · ${b.ok}/${b.total} ${b.mode === "build" || b.mode === "design" || b.mode === "refine" ? "落地" : "成功"}` : "（进行中…）"}</span></div>
        {b.done && b.summary ? <div style={{ fontSize: 12, color: "var(--text-2)", marginTop: 4, lineHeight: 1.55 }}>归并结论：{b.summary.slice(0, 200)}</div> : null}
      </div>
    );
    case "budget": return <div style={{ fontSize: 11, color: b.level === "high" ? "var(--amber)" : "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>⏱ {b.text}</div>;
    case "reflect": return <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>🧠 反思：{b.text}</div>;
    case "catalog": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>📖 {b.text}</div>;
    case "toolnew": return <div style={{ fontSize: 12, color: "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>🔧 造工具「{b.name}」{b.desc ? `：${b.desc}` : ""}</div>;
    case "web": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>🔍 检索「{b.query}」· {b.count} 条结果</div>;
    case "toolsearch": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>🔎 工具搜索「{b.query}」· {b.count} 个候选</div>;
    case "toolschema": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>🔗 解析出工具 {b.name}（{b.method || "?"} · {b.fields} 字段）</div>;
    case "inspect": return <div style={{ fontSize: 12, color: b.degraded ? "var(--amber)" : "var(--text-3)", padding: "3px 12px", lineHeight: 1.55 }}>🔬 诊断 {b.agentSlug}：{b.status}{b.degraded ? " · 降级" : ""}{b.error ? ` · ${b.error.slice(0, 80)}` : ""}</div>;
    case "code": return <div style={{ fontSize: 12, color: "var(--text-3)", fontFamily: "var(--mono)", padding: "2px 12px" }}>✍️ 为「{b.actionName}」{b.codeSource === "ai" ? "亲手写好代码（AI）" : "渲染脚手架代码"}</div>;
    case "done": {
      const answerCompleted = isAnswerCompletion(b.status, b.completionKind);
      const deliveryCompleted = isDeliveryCompletion(b.status, b.completionKind);
      const successful = answerCompleted || deliveryCompleted;
      const waitingHuman = b.status === "waiting_human";
      const label = waitingHuman
        ? "⏸ 已安全挂起，等待你的回复"
        : answerCompleted
        ? "✅ 回答完成（未产生交付或沙箱证据）"
        : deliveryCompleted
          ? "✅ 交付完成"
          : b.completionKind === "legacy_unknown"
            ? "结束（历史记录未标注完成类型）"
            : `结束（${b.status}）`;
      return <div className="rise" style={{ padding: "10px 12px", border: `1px solid ${successful ? "var(--green)" : waitingHuman || b.completionKind === "legacy_unknown" ? "var(--amber)" : "var(--border)"}`, borderRadius: 8, margin: "6px 0", textAlign: "center", fontSize: 12.5, fontWeight: 600, color: successful ? "var(--green)" : waitingHuman || b.completionKind === "legacy_unknown" ? "var(--amber)" : "var(--text-2)" }}>{label}</div>;
    }
    case "error": return <div className="rise" style={{ padding: "10px 12px", border: "1px solid var(--red)", borderRadius: 8, margin: "4px 0", fontSize: 12.5, color: "var(--red)" }}>⚠ {b.text}</div>;
  }
}

// ── collapsed cluster of routine (think/tool) blocks ───────────────────────────────────
// 精简模式的折叠簇标签给出【分类摘要】而非笼统计数——一眼可见折叠了什么（💭思考/🔧工具/🧠反思/🔍检索/✍️代码…）。
const CLUSTER_CATS: Array<{ icon: string; label: string; kinds: Block["kind"][] }> = [
  { icon: "💭", label: "思考", kinds: ["think"] },
  { icon: "🔬", label: "推理", kinds: ["reasoning"] },
  { icon: "🧠", label: "反思", kinds: ["reflect", "subagent"] },
  { icon: "🔧", label: "工具", kinds: ["tool", "toolnew", "toolschema", "inspect"] },
  { icon: "🔍", label: "检索", kinds: ["web", "toolsearch", "catalog"] },
  { icon: "✍️", label: "代码", kinds: ["code"] },
  { icon: "📈", label: "修订", kinds: ["score", "refine", "revert"] },
];
function clusterSummary(blocks: Block[]): string {
  const counted = new Set<Block["kind"]>();
  const parts: string[] = [];
  for (const c of CLUSTER_CATS) {
    const n = blocks.filter((b) => c.kinds.includes(b.kind)).length;
    c.kinds.forEach((k) => counted.add(k));
    if (n) parts.push(`${c.icon}${c.label} ${n}`);
  }
  const rest = blocks.filter((b) => !counted.has(b.kind)).length;
  if (rest) parts.push(`… ${rest}`);
  return parts.join(" · ") || `${blocks.length} 步`;
}

function NoiseCluster({ blocks, expandAll }: { blocks: Block[]; expandAll?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rise" style={{ margin: "2px 0" }}>
      <button onClick={() => setOpen((o) => !o)} className="hover-row" style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", padding: "5px 12px", background: "none", border: "none", borderLeft: "2px solid var(--border-2)", cursor: "pointer", color: "var(--text-3)", fontSize: 12, borderRadius: 6 }}>
        <span style={{ display: "inline-flex", transition: "transform 0.15s", transform: open ? "none" : "rotate(-90deg)", opacity: 0.7 }}><StatusDot status="idle" size={5} /></span>
        <span>{clusterSummary(blocks)}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--signal)" }}>{open ? "收起" : "展开"}</span>
      </button>
      {open && <div style={{ marginLeft: 5, paddingLeft: 6, borderLeft: "1px dashed var(--border)" }}>{blocks.map((b) => <BlockView key={b.id} b={b} expandAll={expandAll} />)}</div>}
    </div>
  );
}

/** Render the transcript. In `grouped` mode (the default 全部 view) consecutive routine blocks
 *  collapse into a NoiseCluster so the feed reads as milestones; a category filter renders flat.
 *  `expandAll` (详尽) additionally opens every long think block — 逐条且全文，无需逐个点开。 */
export function TranscriptFeed({ blocks, grouped, onDecide, onBoundary, onClarify, expandAll }: { blocks: Block[]; grouped: boolean; onDecide?: (d: "approve" | "regenerate", note?: string) => void; onBoundary?: (events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => void; onClarify?: (answer: string) => void; expandAll?: boolean }) {
  if (!grouped) return <>{blocks.map((b) => <BlockView key={b.id} b={b} onDecide={onDecide} onBoundary={onBoundary} onClarify={onClarify} expandAll={expandAll} />)}</>;
  const out: ReactNode[] = [];
  let buf: Block[] = [];
  const flush = () => {
    if (!buf.length) return;
    // 过程块一律折叠（哪怕只有一条思考/反思）——聊天区默认只见大脑的回答与里程碑，思考按需展开。
    out.push(<NoiseCluster key={`cluster-${buf[0]!.id}`} blocks={buf} expandAll={expandAll} />);
    buf = [];
  };
  for (const b of blocks) {
    if (isNoiseBlock(b.kind)) { buf.push(b); continue; }
    flush();
    out.push(<BlockView key={b.id} b={b} onDecide={onDecide} onBoundary={onBoundary} onClarify={onClarify} expandAll={expandAll} />);
  }
  flush();
  return <>{out}</>;
}
