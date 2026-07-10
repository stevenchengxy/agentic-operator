"use client";

/** Agent 工厂 — small shared presentational atoms (chip / Field / CodeBox / FullModal / EvalLine
 *  / Ledger), used across the transcript, the agent inspector, and the run-summary tab. */

import { useEffect } from "react";
import { Panel, Markdown } from "@/app/portal/components";

export const chip = (text: string, color = "var(--text-3)") => (
  <span key={text} style={{ fontSize: 10.5, fontFamily: "var(--mono)", color, border: "1px solid var(--border)", borderRadius: 5, padding: "1px 6px", whiteSpace: "nowrap" }}>{text}</span>
);

export function Field({ label, text, mono, markdown }: { label: string; text: string; mono?: boolean; markdown?: boolean }) {
  const asMd = markdown && !mono; // mono fields (prompts / JSON) stay verbatim
  return (
    <div>
      <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.6, whiteSpace: asMd ? "normal" : "pre-wrap", fontFamily: mono ? "var(--mono)" : undefined, background: "var(--panel-3)", borderRadius: 6, padding: "6px 8px" }}>{asMd ? <Markdown>{text}</Markdown> : text}</div>
    </div>
  );
}

export function CodeBox({ code }: { code: string }) {
  return <pre style={{ fontSize: 11.5, fontFamily: "var(--mono)", color: "var(--text-2)", background: "var(--panel-3)", borderRadius: 8, padding: 12, overflow: "auto", lineHeight: 1.6, whiteSpace: "pre" }}>{code}</pre>;
}

export function FullModal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.55)", zIndex: "var(--z-modal)" as unknown as number, display: "flex", alignItems: "center", justifyContent: "center", padding: 32 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 12, width: "min(1000px,92vw)", maxHeight: "88vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
          <b style={{ fontSize: 13, color: "var(--text)" }}>{title}</b>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 18 }}>✕</button>
        </div>
        <div style={{ overflow: "auto", padding: 16 }}>{children}</div>
      </div>
    </div>
  );
}

export function EvalLine({ ok, label }: { ok: boolean | undefined; label: string }) {
  const color = ok === undefined ? "var(--text-3)" : ok ? "var(--green)" : "var(--red)";
  return <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "5px 0", fontSize: 12.5, color: "var(--text)" }}><span style={{ color }}>{ok === undefined ? "○" : ok ? "✓" : "✗"}</span>{label}</div>;
}

export function Ledger({ title, items, empty, markdown }: { title: string; items: string[]; empty: string; markdown?: boolean }) {
  return (
    <Panel title={title} padded={false}>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {items.length === 0 && <div style={{ padding: 12, fontSize: 11.5, color: "var(--text-4)" }}>{empty}</div>}
        {items.map((it, i) => <div key={i} style={{ padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : "none", fontSize: 12, color: "var(--text-2)", lineHeight: 1.5 }}>{markdown ? <Markdown>{it}</Markdown> : it}</div>)}
      </div>
    </Panel>
  );
}
