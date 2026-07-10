"use client";

/**
 * #W3-UI — UNIFIED InteractionDock: ONE pinned surface for every pending brain↔human interaction
 * (澄清 clarify / 测试用例批准 approval / 边界事件分类 boundary). Previously the three interactions
 * rendered only inline in the transcript with three separate UI shapes; a long transcript could
 * scroll the pending question out of view, and clarify answers were free-text only.
 *
 * Design (mirrors the backend's tag routing, conductor.ts #W2-HITL):
 *   - Derives the CURRENT pending interaction from blocks (latest awaiting=true wins; STOP-priority
 *     order matches the conductor: clarify > approval > boundary).
 *   - Clarify options render VALUE-IZED (radio-style buttons + explicit "其它" free-text) — no more
 *     loose free-text parsing for multiple-choice questions.
 *   - One consistent frame + kind chip, always visible above the composer.
 * The transcript keeps its inline rendering as history; this dock is the ACTION surface.
 */

import { useMemo, useState } from "react";
import type { Block } from "./model";

type ClarifyBlock = Extract<Block, { kind: "clarify" }>;
type TestBlock = Extract<Block, { kind: "testcases" }>;
type BoundaryBlock = Extract<Block, { kind: "boundarycases" }>;

export interface InteractionDockProps {
  blocks: Block[];
  onClarify: (answer: string) => void | Promise<void>;
  onDecide: (decision: "approve" | "regenerate", note?: string) => void | Promise<void>;
  onBoundary: (evs: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => void | Promise<void>;
}

const kindChip = (label: string, color: string) => (
  <span style={{ fontSize: 10.5, fontWeight: 700, fontFamily: "var(--mono)", color, border: `1px solid ${color}`, borderRadius: 6, padding: "1px 8px", flexShrink: 0 }}>{label}</span>
);

export function InteractionDock({ blocks, onClarify, onDecide, onBoundary }: InteractionDockProps) {
  // Latest pending interaction of each kind; priority mirrors the conductor's gate order.
  const pending = useMemo(() => {
    const rev = [...blocks].reverse();
    const clarify = rev.find((b): b is ClarifyBlock => b.kind === "clarify" && b.awaiting);
    if (clarify) return { kind: "clarify" as const, clarify };
    const test = rev.find((b): b is TestBlock => b.kind === "testcases" && b.awaiting);
    if (test) return { kind: "approval" as const, test };
    const boundary = rev.find((b): b is BoundaryBlock => b.kind === "boundarycases" && b.awaiting);
    if (boundary) return { kind: "boundary" as const, boundary };
    return null;
  }, [blocks]);

  const [otherText, setOtherText] = useState("");
  const [note, setNote] = useState("");
  const [boundaryPick, setBoundaryPick] = useState<Record<string, string>>({});
  const [sent, setSent] = useState<string | null>(null); // block id already answered (optimistic hide)

  if (!pending) return null;
  const activeId = pending.kind === "clarify" ? pending.clarify.id : pending.kind === "approval" ? pending.test.id : pending.boundary.id;
  if (sent === activeId) return null;

  const frame = (title: string, chip: React.ReactNode, body: React.ReactNode) => (
    <div style={{ border: "1px solid var(--signal)", borderRadius: 10, padding: "10px 12px", margin: "0 12px 8px", background: "var(--panel-2)", boxShadow: "0 0 0 1px rgba(208,255,0,.08)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        {chip}
        <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text)" }}>{title}</span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>大脑已暂停，等你决策</span>
      </div>
      {body}
    </div>
  );

  if (pending.kind === "clarify") {
    const c = pending.clarify;
    return frame(
      c.question,
      kindChip("澄清", "var(--blue)"),
      <div>
        {c.context && <div style={{ fontSize: 11.5, color: "var(--text-3)", marginBottom: 6 }}>{c.context}</div>}
        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
          {(c.options ?? []).map((o) => (
            <button
              key={o.value}
              onClick={() => { setSent(c.id); void onClarify(o.value || o.label); }}
              style={{ textAlign: "left", fontSize: 12.5, padding: "7px 10px", borderRadius: 8, cursor: "pointer", border: `1px solid ${o.recommended ? "var(--signal)" : "var(--border)"}`, background: "var(--panel)", color: "var(--text)" }}
            >
              {o.label}{o.recommended ? <span style={{ marginLeft: 8, fontSize: 10, color: "var(--signal)" }}>推荐</span> : null}
            </button>
          ))}
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && otherText.trim()) { setSent(c.id); void onClarify(otherText.trim()); } }}
              placeholder={c.options?.length ? "其它（自由输入）…" : "输入你的回答…"}
              style={{ flex: 1, fontSize: 12.5, padding: "7px 10px", background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8 }}
            />
            <button disabled={!otherText.trim()} onClick={() => { setSent(c.id); void onClarify(otherText.trim()); }} style={{ fontSize: 12, padding: "7px 12px", borderRadius: 8, border: "1px solid var(--border-2)", background: "var(--panel-3)", color: "var(--text)", cursor: "pointer" }}>回答 ↵</button>
          </div>
        </div>
      </div>,
    );
  }

  if (pending.kind === "approval") {
    const t = pending.test;
    return frame(
      `确认这 ${t.cases.length} 条测试用例？`,
      kindChip("用例批准", "var(--amber)"),
      <div>
        <div style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 6, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {t.cases.slice(0, 6).map((c, i) => <span key={i} style={{ fontFamily: "var(--mono)", fontSize: 10.5, border: "1px solid var(--border)", borderRadius: 6, padding: "1px 7px", color: "var(--text-2)" }}>{c.kind}·{c.name.slice(0, 24)}</span>)}
          {t.cases.length > 6 && <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>+{t.cases.length - 6}</span>}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={() => { setSent(t.id); void onDecide("approve"); }} style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 8, border: "1px solid var(--green)", background: "rgba(66,211,146,.12)", color: "var(--green)", cursor: "pointer" }}>✓ 执行试运行</button>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="重做要求（可选）…" style={{ flex: 1, fontSize: 12, padding: "7px 10px", background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8 }} />
          <button onClick={() => { setSent(t.id); void onDecide("regenerate", note.trim() || undefined); }} style={{ fontSize: 12.5, padding: "7px 12px", borderRadius: 8, border: "1px solid var(--amber)", background: "transparent", color: "var(--amber)", cursor: "pointer" }}>↻ 重新生成</button>
        </div>
      </div>,
    );
  }

  const b = pending.boundary;
  const KINDS = [
    { v: "external", label: "外部交接" },
    { v: "terminal", label: "终态" },
    { v: "break", label: "断点待修" },
  ];
  return frame(
    `${b.proposals.length} 个边界事件需要分类`,
    kindChip("边界分类", "var(--violet)"),
    <div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 8 }}>
        {b.proposals.map((p) => (
          <div key={p.event} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
            <span style={{ fontFamily: "var(--mono)", color: "var(--text)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={p.why}>{p.event}</span>
            <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
              {KINDS.map((k) => {
                const picked = (boundaryPick[p.event] ?? p.suggestedKind) === k.v;
                return (
                  <button key={k.v} onClick={() => setBoundaryPick((m) => ({ ...m, [p.event]: k.v }))} style={{ fontSize: 10.5, padding: "3px 8px", borderRadius: 6, cursor: "pointer", border: `1px solid ${picked ? "var(--signal)" : "var(--border)"}`, background: picked ? "var(--panel-3)" : "transparent", color: picked ? "var(--text)" : "var(--text-3)" }}>
                    {k.label}{p.suggestedKind === k.v ? "·建议" : ""}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <button
        onClick={() => { setSent(b.id); void onBoundary(b.proposals.map((p) => ({ event: p.event, kind: boundaryPick[p.event] ?? p.suggestedKind, consumer: p.consumer, payloadContract: p.payloadContract }))); }}
        style={{ fontSize: 12.5, fontWeight: 700, padding: "7px 14px", borderRadius: 8, border: "1px solid var(--signal)", background: "rgba(208,255,0,.1)", color: "var(--signal)", cursor: "pointer" }}
      >
        ✓ 提交分类
      </button>
    </div>,
  );
}
