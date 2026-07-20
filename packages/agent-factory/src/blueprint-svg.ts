// blueprint-svg — PURE, dependency-free deterministic SVG renderers for a
// grounded BlueprintModel (see ./blueprint). Two diagram kinds:
//   • phase-flow  — phases top→down, each a card listing its grounded steps +
//                   ontology anchors, arrowed phase→phase.
//   • sequence    — actors as lifelines, steps as ordered messages banded by phase.
// Same model in → byte-identical SVG out. No Date, no Math.random, no I/O — so
// the bytes embed verbatim into the inline event AND the HTML/PDF report.

import type { BlueprintModel, BlueprintPhase, BlueprintStep, OntologyAnchor } from "./blueprint";

// ------------------------------------------------------------ primitives
function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
const ELLIPSIS = "…";
function midClip(s: string, max: number): string {
  const str = String(s);
  if (max <= 1) return str.slice(0, Math.max(0, max));
  if (str.length <= max) return str;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return str.slice(0, head) + ELLIPSIS + (tail > 0 ? str.slice(str.length - tail) : "");
}
function fitChars(w: number, fontSize: number, factor = 0.6): number {
  return Math.max(4, Math.floor((w - 8) / (fontSize * factor)));
}
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

const THEME = {
  bg: "#0f141b",
  card: "#171d26",
  cardStroke: "#2a323f",
  ink: "#e6e9ef",
  ink2: "#98a2b3",
  ink3: "#69727f",
  phase: { fill: "#152238", stroke: "#5b8def", text: "#a6c0f5" },
  step: { fill: "#142a20", stroke: "#4fbf87", text: "#8adcb0" },
  actor: { fill: "#2e2113", stroke: "#e0863f", text: "#f0b978" },
  anchor: { entity: "#5b8def", action: "#4fbf87", rule: "#e0863f", event: "#9b51e0" } as Record<OntologyAnchor["kind"], string>,
  link: "#7c8aa0",
};
const FONT = `font-family="system-ui,-apple-system,'PingFang SC','Segoe UI',sans-serif"`;
const MONO = `font-family="'SFMono-Regular',ui-monospace,Menlo,Consolas,monospace"`;

function box(x: number, y: number, w: number, h: number, fill: string, stroke: string, rx = 10): string {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${rx}" fill="${fill}" stroke="${stroke}" stroke-width="1.2"/>`;
}
function text(x: number, y: number, raw: string, size: number, fill: string, anchor: "start" | "middle" | "end", font: string, weight?: number): string {
  const w = weight ? ` font-weight="${weight}"` : "";
  return `<text x="${num(x)}" y="${num(y)}" text-anchor="${anchor}" ${font} font-size="${size}" fill="${fill}"${w}>${escapeXml(raw)}</text>`;
}

/** Compact "读 X · 写 Y · 发 Z" data-flow line for a step (ontology-grounded ids only). */
function ioLine(step: BlueprintStep): string | null {
  const parts: string[] = [];
  if (step.reads?.length) parts.push(`读 ${step.reads.slice(0, 3).join(",")}`);
  if (step.writes?.length) parts.push(`写 ${step.writes.slice(0, 3).join(",")}`);
  if (step.emits?.length) parts.push(`发 ${step.emits.slice(0, 3).join(",")}`);
  return parts.length ? parts.join("  ·  ") : null;
}

/** Deterministic char-count wrap (Chinese has no word breaks); caps at maxLines with an ellipsis. */
function wrapByChars(s: string, perLine: number, maxLines: number): string[] {
  const str = String(s).replace(/\s+/g, " ").trim();
  if (!str || perLine < 2 || maxLines < 1) return [];
  const lines: string[] = [];
  for (let i = 0; i < str.length && lines.length < maxLines; i += perLine) lines.push(str.slice(i, i + perLine));
  if (str.length > maxLines * perLine) {
    const last = lines[maxLines - 1] ?? "";
    lines[maxLines - 1] = last.slice(0, Math.max(0, perLine - 1)) + ELLIPSIS;
  }
  return lines;
}

/** Compact ontology-anchor chips: a colored dot per kind + the id. */
function anchorChips(x: number, y: number, anchors: OntologyAnchor[], maxWidth: number): string {
  let out = "";
  let cx = x;
  const shown = anchors.slice(0, 4);
  for (const a of shown) {
    const label = midClip(a.id, 16);
    const chipW = 14 + label.length * 6.6;
    if (cx + chipW > x + maxWidth) break;
    out += `<circle cx="${num(cx + 5)}" cy="${num(y - 3)}" r="3.5" fill="${THEME.anchor[a.kind] ?? THEME.ink2}"/>`;
    out += text(cx + 12, y, label, 10.5, THEME.ink2, "start", MONO);
    cx += chipW + 8;
  }
  if (anchors.length > shown.length) out += text(cx, y, `+${anchors.length - shown.length}`, 10.5, THEME.ink3, "start", FONT);
  return out;
}

// ------------------------------------------------------------ phase-flow
function renderPhaseFlow(model: BlueprintModel, width: number): string {
  const M = 20;
  const innerW = width - 2 * M;
  const cardX = M;
  const cardW = innerW;
  const HEADER_H = 64;
  const STEP_H = 22;
  const STEP_SUB_H = 15; // the "读/写/发" data-flow sub-line under a step
  const STEP_GAP = 4;
  const CARD_PAD = 14;
  const PHASE_GAP = 30;
  const DELIB_LH = 14; // deliberation line-height
  const DELIB_MAX_LINES = 3;
  const delibPerLine = Math.max(8, fitChars(cardW - 44, 11.5, 0.55));

  const stepIO = (step: BlueprintStep): string | null => ioLine(step);
  const delibLinesFor = (phase: BlueprintPhase): string[] =>
    phase.deliberation ? wrapByChars(phase.deliberation, delibPerLine, DELIB_MAX_LINES) : [];

  type Placed = { phase: BlueprintPhase; top: number; h: number; delib: string[] };
  const placed: Placed[] = [];
  let cursor = HEADER_H;
  for (const phase of model.phases) {
    const steps = phase.steps ?? [];
    const stepsH = steps.reduce((acc, s) => acc + STEP_H + (stepIO(s) ? STEP_SUB_H : 0) + STEP_GAP, 0);
    const delib = delibLinesFor(phase);
    const delibH = delib.length ? delib.length * DELIB_LH + 12 : 0;
    const bodyH = 30 /* title+intent */ + stepsH + 18 /* anchors row */ + delibH;
    const h = Math.max(72, bodyH + CARD_PAD);
    placed.push({ phase, top: cursor, h, delib });
    cursor += h + PHASE_GAP;
  }
  const height = Math.round((placed.length ? cursor - PHASE_GAP : HEADER_H + 40) + 44);

  let body = "";
  placed.forEach((p, i) => {
    const { phase, top, h, delib } = p;
    body += box(cardX, top, cardW, h, THEME.card, THEME.cardStroke, 14);
    // phase header
    body += `<rect x="${num(cardX)}" y="${num(top)}" width="6" height="${num(h)}" rx="3" fill="${THEME.phase.stroke}"/>`;
    body += text(cardX + 18, top + 24, `${i + 1}. ${midClip(phase.title, fitChars(cardW * 0.6, 15, 0.6))}`, 15, THEME.phase.text, "start", FONT, 600);
    if (phase.intent) body += text(cardX + 18, top + 42, midClip(phase.intent, fitChars(cardW - 40, 12, 0.6)), 12, THEME.ink2, "start", FONT);
    // steps (each optionally followed by a 读/写/发 data-flow sub-line)
    let sy = top + (phase.intent ? 58 : 44);
    for (const step of phase.steps ?? []) {
      body += box(cardX + 18, sy, cardW - 36, STEP_H, THEME.step.fill, THEME.step.stroke, 6);
      const label = [step.agent ? `[${step.agent}]` : "", step.label].filter(Boolean).join(" ");
      body += text(cardX + 26, sy + STEP_H / 2 + 4, midClip(label, fitChars(cardW - 200, 11.5, 0.58)), 11.5, THEME.step.text, "start", FONT);
      // per-step anchors on the right
      body += anchorChips(cardX + cardW - 220, sy + STEP_H / 2 + 4, step.anchors ?? [], 200);
      sy += STEP_H;
      const io = stepIO(step);
      if (io) {
        body += text(cardX + 30, sy + 11, midClip(io, fitChars(cardW - 52, 10.5, 0.55)), 10.5, THEME.ink3, "start", MONO);
        sy += STEP_SUB_H;
      }
      sy += STEP_GAP;
    }
    // phase-level anchors footer
    body += anchorChips(cardX + 18, sy + 12, phase.anchors ?? [], cardW - 40);
    // per-phase deliberation (the visible step-by-step reasoning conclusion)
    if (delib.length) {
      let dy = sy + 30;
      body += text(cardX + 18, dy, "推理细化", 10.5, THEME.phase.text, "start", FONT, 600);
      dy += 14;
      for (const line of delib) {
        body += text(cardX + 18, dy, line, 11.5, THEME.ink2, "start", FONT);
        dy += DELIB_LH;
      }
    }
    // arrow to next phase
    if (i < placed.length - 1) {
      const ax = cardX + cardW / 2;
      body += `<line x1="${num(ax)}" y1="${num(top + h)}" x2="${num(ax)}" y2="${num(top + h + PHASE_GAP)}" stroke="${THEME.link}" stroke-width="1.6" marker-end="url(#bp-arrow)"/>`;
    }
  });

  const titleEl = text(M, 34, midClip(`蓝图 · ${model.domain}`, fitChars(innerW * 0.7, 19, 0.62)), 19, THEME.ink, "start", FONT, 700);
  const unresolvedNote = (model.unresolved ?? []).length
    ? text(width - M, 34, `未接地 ${model.unresolved.length} 项（缺本体证据）`, 12, "#eb5757", "end", FONT)
    : "";
  const emptyNote = model.phases.length ? "" : text(width / 2, HEADER_H + 24, "（无可接地的阶段——所有元素缺本体证据）", 13, THEME.ink2, "middle", FONT);
  return svgDoc(width, height, titleEl + unresolvedNote + emptyNote + body);
}

// ------------------------------------------------------------ sequence
function renderSequence(model: BlueprintModel, width: number): string {
  const M = 20;
  const HEADER_H = 64;
  // actors = distinct step.agent (fallback to a single "Agent" lane)
  const actorSet: string[] = [];
  for (const phase of model.phases) for (const step of phase.steps ?? []) {
    const a = step.agent || phase.title;
    if (!actorSet.includes(a)) actorSet.push(a);
  }
  const actors = actorSet.length ? actorSet : ["Agent"];
  const laneW = Math.max(120, Math.min(220, (width - 2 * M) / actors.length));
  const usableW = laneW * actors.length;
  const startX = M + ((width - 2 * M) - usableW) / 2;
  const laneX = (i: number) => startX + i * laneW + laneW / 2;
  const actorIndex = (a: string) => Math.max(0, actors.indexOf(a));

  const MSG_TOP = HEADER_H + 40;
  const MSG_H = 30;
  type Msg = { phaseIdx: number; from: number; to: number; label: string };
  const msgs: Msg[] = [];
  model.phases.forEach((phase, pi) => {
    const steps = phase.steps ?? [];
    steps.forEach((step, si) => {
      const from = actorIndex(step.agent || phase.title);
      // target = next step's actor, else the emit/downstream (kept same lane if none)
      const next = steps[si + 1];
      const to = next ? actorIndex(next.agent || phase.title) : from;
      msgs.push({ phaseIdx: pi, from, to: to === from ? Math.min(actors.length - 1, from + (from < actors.length - 1 ? 1 : 0)) : to, label: step.label });
    });
  });

  const height = Math.round(MSG_TOP + Math.max(1, msgs.length) * MSG_H + 60);

  // lifelines + actor heads
  let body = "";
  actors.forEach((a, i) => {
    const x = laneX(i);
    body += `<line x1="${num(x)}" y1="${num(HEADER_H + 34)}" x2="${num(x)}" y2="${num(height - 40)}" stroke="${THEME.cardStroke}" stroke-width="1"/>`;
    body += box(x - laneW / 2 + 6, HEADER_H, laneW - 12, 30, THEME.actor.fill, THEME.actor.stroke, 8);
    body += text(x, HEADER_H + 20, midClip(a, fitChars(laneW - 12, 11.5, 0.58)), 11.5, THEME.actor.text, "middle", FONT, 600);
  });

  // phase bands (subtle background per phase run) + messages
  let y = MSG_TOP;
  let prevPhase = -1;
  msgs.forEach((m) => {
    if (m.phaseIdx !== prevPhase) {
      const phase = model.phases[m.phaseIdx];
      body += text(M, y - 8, `▸ ${midClip(phase?.title ?? "", 30)}`, 11, THEME.phase.text, "start", FONT, 600);
      prevPhase = m.phaseIdx;
    }
    const x1 = laneX(m.from);
    const x2 = laneX(m.to);
    const my = y + MSG_H / 2;
    if (x1 === x2) {
      // self-message loop
      body += `<path d="M ${num(x1)} ${num(my - 6)} h 26 v 14 h -26" fill="none" stroke="${THEME.link}" stroke-width="1.4" marker-end="url(#bp-arrow)"/>`;
      body += text(x1 + 32, my, midClip(m.label, 26), 11, THEME.ink2, "start", FONT);
    } else {
      const dir = x2 > x1 ? 1 : -1;
      body += `<line x1="${num(x1 + dir * 4)}" y1="${num(my)}" x2="${num(x2 - dir * 8)}" y2="${num(my)}" stroke="${THEME.link}" stroke-width="1.5" marker-end="url(#bp-arrow)"/>`;
      body += text((x1 + x2) / 2, my - 5, midClip(m.label, fitChars(Math.abs(x2 - x1), 11, 0.55)), 11, THEME.ink2, "middle", FONT);
    }
    y += MSG_H;
  });

  const titleEl = text(M, 34, midClip(`时序 · ${model.domain}`, fitChars((width - 2 * M) * 0.7, 19, 0.62)), 19, THEME.ink, "start", FONT, 700);
  const emptyNote = msgs.length ? "" : text(width / 2, MSG_TOP + 20, "（无可接地的步骤）", 13, THEME.ink2, "middle", FONT);
  return svgDoc(width, height, titleEl + emptyNote + body);
}

// ------------------------------------------------------------ doc wrapper
function svgDoc(width: number, height: number, inner: string): string {
  const defs =
    `<defs><marker id="bp-arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="4" orient="auto"><path d="M0,0 L9,4 L0,8 z" fill="${THEME.link}"/></marker></defs>`;
  const bg = `<rect x="0" y="0" width="${num(width)}" height="${num(height)}" fill="${THEME.bg}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}" width="${num(width)}" height="${num(height)}" role="img" aria-label="ontology blueprint">` +
    defs + bg + inner + `</svg>`
  );
}

export type BlueprintSvgKind = "phase-flow" | "sequence";

/** Render a grounded blueprint to deterministic SVG for the given diagram kind. */
export function renderBlueprintSvg(model: BlueprintModel, kind: BlueprintSvgKind = "phase-flow", opts?: { width?: number }): string {
  const width = Math.max(720, Math.round(opts?.width ?? 1200));
  return kind === "sequence" ? renderSequence(model, width) : renderPhaseFlow(model, width);
}

/** A self-contained HTML <section> embedding the blueprint's pre-rendered SVG
 * diagrams + phase/anchor structure + unresolved list — appended into the
 * ontology-analysis report (report-jobs) so a blueprint ships as HTML/PDF too.
 * Diagram SVGs are our own escaped, deterministic output; embedded verbatim. */
export function renderBlueprintReportSection(model: BlueprintModel): string {
  const diagrams = (model.diagrams ?? [])
    .filter((d) => d.svg)
    .map((d) => `<figure style="margin:14px 0"><figcaption style="font-size:12.5px;color:#666;margin-bottom:6px">${escapeXml(d.title)} <span style="color:#999">· ${escapeXml(d.kind)}</span></figcaption><div style="overflow-x:auto">${d.svg}</div></figure>`)
    .join("");
  const ioHtml = (s: BlueprintStep): string => {
    const bits: string[] = [];
    if (s.reads?.length) bits.push(`读 ${s.reads.map((r) => escapeXml(r)).join(", ")}`);
    if (s.writes?.length) bits.push(`写 ${s.writes.map((w) => escapeXml(w)).join(", ")}`);
    if (s.emits?.length) bits.push(`发 ${s.emits.map((e) => escapeXml(e)).join(", ")}`);
    return bits.length ? `<div style="font-family:monospace;font-size:10.5px;color:#7a8595;margin-top:2px">${bits.join("  ·  ")}</div>` : "";
  };
  const phases = (model.phases ?? [])
    .map((p, i) => {
      const steps = (p.steps ?? [])
        .map((s) => `<li>${s.agent ? `<code style="color:#888">[${escapeXml(s.agent)}]</code> ` : ""}${escapeXml(s.label)} ${(s.anchors ?? []).map((a) => `<span style="font-family:monospace;font-size:11px;color:#3b6e9e">${escapeXml(a.id)}</span>`).join(" ")}${ioHtml(s)}</li>`)
        .join("");
      const anchors = (p.anchors ?? []).map((a) => `<span style="font-family:monospace;font-size:11px;color:#3b6e9e">${escapeXml(a.id)}</span>`).join(" ");
      const delib = p.deliberation
        ? `<div style="margin:6px 0 0;padding:6px 10px;border-left:2px solid #9b51e0;background:#faf7fe;font-size:12px;color:#555"><b style="color:#7a3fb0;font-size:11px">推理细化</b><div style="margin-top:2px;white-space:pre-wrap">${escapeXml(p.deliberation)}</div></div>`
        : "";
      return `<div style="margin:10px 0;padding:8px 12px;border-left:3px solid #5b8def;background:#f6f8fc"><b style="font-size:13px">${i + 1}. ${escapeXml(p.title)}</b> ${anchors}${p.intent ? `<div style="font-size:12px;color:#666">${escapeXml(p.intent)}</div>` : ""}<ul style="font-size:12.5px;margin:6px 0 0;padding-left:18px">${steps}</ul>${delib}</div>`;
    })
    .join("");
  const unresolved = (model.unresolved ?? []).length
    ? `<div style="margin-top:12px;padding:8px 12px;border:1px solid #e0a4a4;border-radius:8px;background:#fdf3f3;font-size:12px;color:#a33"><b>缺本体证据 · 未接地（${model.unresolved.length}）</b>——已如实标注，未编造：<ul style="margin:6px 0 0;padding-left:18px">${model.unresolved.slice(0, 12).map((u) => `<li>${escapeXml(u.scope)} · ${escapeXml(u.ref)} — ${escapeXml(u.reason)}</li>`).join("")}</ul></div>`
    : "";
  return `<section style="max-width:1000px;margin:28px auto 8px;padding:16px 20px;border:1px solid #ddd;border-radius:10px;background:#fff"><h2 style="font-size:18px;margin:0 0 4px">Ontology-grounded 蓝图 · ${escapeXml(model.domain)}</h2><div style="font-size:12px;color:#888;margin-bottom:10px">${model.phases.length} 个阶段 · ${diagrams ? (model.diagrams ?? []).filter((d) => d.svg).length : 0} 张图 · 每个节点锚定本体实体/动作/规则/事件</div>${diagrams}${phases}${unresolved}</section>`;
}
