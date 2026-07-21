"use client";

/**
 * Agent 工厂 — the 大脑 DECISION FLOW. A linearized picture of HOW the brain reasoned (distinct
 * from 交付图, which is WHAT it built): a timeline spine of decisions — validate pass/fail, refine
 * self-corrections + score moves, reverts, HITL gates (diamonds), sandbox, deliver — with dashed
 * loop-back arcs for the refine cycles. Pure projection of the event stream; steps fade in live.
 */

import { Empty, HelpTip } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import type { BrainStep, BrainStepStatus } from "./model";

const COLOR: Record<BrainStepStatus, string> = {
  ok: "var(--green)",
  fail: "var(--red)",
  warn: "var(--amber)",
  await: "var(--violet)",
  info: "var(--blue)",
  neutral: "var(--text-3)",
};
const GLYPH: Record<BrainStepStatus, string> = { ok: "✓", fail: "✗", warn: "↻", await: "◇", info: "•", neutral: "•" };

const W = 360;
const ROWH = 60;
const PADTOP = 16;
const SPINE_X = 52;
const CARD_X = 72;
const CARD_W = 270;
const CARD_H = 44;

export function BrainFlow({ steps, running }: { steps: BrainStep[]; running: boolean }) {
  const { t } = useI18n();
  if (!steps.length) return <Empty title={<>{t("factory.brainFlow.emptyTitle")} <HelpTip>{t("factory.brainFlow.emptyHelp")}</HelpTip></>} />;

  const cy = (i: number) => PADTOP + i * ROWH + CARD_H / 2;
  const H = PADTOP + steps.length * ROWH + 8;
  const refineCount = steps.filter((s) => s.kind === "refine" || s.kind === "revert").length;

  // Each refine/revert loops back to the most recent validate/sandbox above it — draw that arc.
  const arcs: Array<{ from: number; to: number }> = [];
  steps.forEach((s, i) => {
    if (s.kind !== "refine" && s.kind !== "revert") return;
    for (let j = i - 1; j >= 0; j--) {
      if (steps[j]!.kind === "validate" || steps[j]!.kind === "sandbox") { arcs.push({ from: i, to: j }); break; }
    }
  });

  const lastIdx = steps.length - 1;
  return (
    <div style={{ overflow: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block" }}>
        <defs>
          <marker id="bf-ar" markerWidth="7" markerHeight="7" refX="5.5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--amber)" /></marker>
        </defs>
        {/* spine */}
        <line x1={SPINE_X} y1={cy(0)} x2={SPINE_X} y2={cy(lastIdx)} stroke="var(--border-2)" strokeWidth={1.4} />
        {/* refine loop-back arcs (left of the spine) */}
        {arcs.map((a, k) => (
          <path key={k} d={`M ${SPINE_X - 6} ${cy(a.from)} C ${20} ${cy(a.from)}, ${20} ${cy(a.to)}, ${SPINE_X - 6} ${cy(a.to)}`} fill="none" stroke="var(--amber)" strokeWidth={1.3} strokeDasharray="4 3" markerEnd="url(#bf-ar)" />
        ))}
        {steps.map((s, i) => {
          const col = COLOR[s.status];
          const isGate = s.kind === "gate";
          const pulsing = running && i === lastIdx && (s.status === "await" || s.status === "neutral");
          return (
            <g key={s.id} className="fct-in">
              {/* spine marker */}
              {isGate ? (
                <g transform={`translate(${SPINE_X},${cy(i)})`}>
                  <polygon points="0,-7 7,0 0,7 -7,0" fill="var(--panel)" stroke={col} strokeWidth={1.6}>
                    {pulsing && <animate attributeName="opacity" values="1;0.4;1" dur="1.3s" repeatCount="indefinite" />}
                  </polygon>
                </g>
              ) : (
                <circle cx={SPINE_X} cy={cy(i)} r={5.5} fill="var(--panel)" stroke={col} strokeWidth={2}>
                  {pulsing && <animate attributeName="r" values="5;7;5" dur="1.3s" repeatCount="indefinite" />}
                </circle>
              )}
              {/* card */}
              <rect x={CARD_X} y={PADTOP + i * ROWH} width={CARD_W} height={CARD_H} rx={8} fill="var(--panel-2)" stroke={s.status === "await" ? col : "var(--border)"} strokeWidth={s.status === "await" ? 1.6 : 1} />
              <text x={CARD_X + 12} y={cy(i) - 3} fontSize={12} fontWeight={600} fill="var(--text)"><tspan fill={col} style={{ fontWeight: 700 }}>{GLYPH[s.status]} </tspan>{s.label}</text>
              {s.detail && <text x={CARD_X + 12} y={cy(i) + 12} fontSize={10} fill="var(--text-3)" fontFamily="var(--mono)">{s.detail.length > 40 ? s.detail.slice(0, 39) + "…" : s.detail}</text>}
              <title>{s.label}{s.detail ? ` — ${s.detail}` : ""}</title>
            </g>
          );
        })}
        {refineCount > 0 && (
          <text x={14} y={cy(0) - 14} fontSize={10} fill="var(--amber)" fontFamily="var(--mono)">{t("factory.brainFlow.selfReviseCount", { count: refineCount })}</text>
        )}
      </svg>
    </div>
  );
}
