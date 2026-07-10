// business-flow-svg — PURE, dependency-free swimlane renderer for the BusinessFlowModel
// (Agent Factory 融合蓝图 P1.5). Turns the derived business-flow (deriveBusinessFlow in
// ./business-flow) into a self-contained, dark-friendly SVG string that the UI / report
// pipeline embeds verbatim. Mirrors the hand-drawn 6-agent swimlane: one horizontal lane
// per agent, left→right segments (external trigger source · trigger event · agent card ·
// external reads/calls/writes/notifies · produced events), with cross-lane arrows wired
// emit→trigger.
//
// HARD CONTRACT: same model in → byte-identical SVG out. No Date, no Math.random, no I/O.
// Every text run is escaped. park branches are NOT rendered (the model carries no `parks`
// field) — we only draw what the model actually contains.

import type { BusinessFlowModel, FlowAgent, FlowEmitSemantic } from "./business-flow";

// ---------------------------------------------------------------- text helpers

/** Local escapeXml — & < > " ' → entities. ALL text passes through this. */
function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const ELLIPSIS = "…"; // single code point → counts as length 1

/** Middle ellipsis: keep head + tail, drop the middle. Preserves the distinguishing
 *  head/tail of long event/tool names (MATCH_…_INTERVIEW) instead of chopping the tail. */
function midClip(s: string, max: number): string {
  const str = String(s);
  if (max <= 1) return str.slice(0, Math.max(0, max));
  if (str.length <= max) return str;
  const head = Math.ceil((max - 1) / 2);
  const tail = max - 1 - head;
  return str.slice(0, head) + ELLIPSIS + (tail > 0 ? str.slice(str.length - tail) : "");
}

/** Deterministic char budget for a box of pixel width `w` at `fontSize`. */
function fitChars(w: number, fontSize: number, factor = 0.6): number {
  return Math.max(4, Math.floor((w - 8) / (fontSize * factor)));
}

/** Coordinate → stable 2-decimal string (kills float dust like 176.80000000002). */
function num(v: number): string {
  return String(Math.round(v * 100) / 100);
}

// ---------------------------------------------------------------- theme

const THEME = {
  bg: "#0f141b",
  laneFill: "#171d26",
  laneStroke: "#2a323f",
  ink: "#e6e9ef",
  ink2: "#98a2b3",
  ink3: "#69727f",
};

type Fam = { fill: string; stroke: string; text: string };

const FAM = {
  source: { fill: "#2e2113", stroke: "#e0863f", text: "#f0b978" }, // orange — external trigger source
  event: { fill: "#122a33", stroke: "#3fb6c9", text: "#7fd4e0" }, // cyan — events (trigger + neutral emit)
  agent: { fill: "#152238", stroke: "#5b8def", text: "#a6c0f5" }, // blue — agent card
  io: { fill: "#142a20", stroke: "#4fbf87", text: "#8adcb0" }, // green — reads/calls/writes/notifies
  failure: { fill: "#331619", stroke: "#eb5757", text: "#f4a3a3" }, // red — failure emit
  external: { fill: "#241531", stroke: "#9b51e0", text: "#c79cec" }, // purple — external / handoff emit
} satisfies Record<string, Fam>;

const LINK = "#7c8aa0";
const LINK_FAIL = "#eb5757";

const FONT = `font-family="system-ui,-apple-system,'PingFang SC','Segoe UI',sans-serif"`;
const MONO = `font-family="'SFMono-Regular',ui-monospace,Menlo,Consolas,monospace"`;

/** Emit box palette keyed by semantic (failure=red, external=purple, everything else=cyan). */
function emitFam(sem: FlowEmitSemantic): Fam {
  if (sem === "failure") return FAM.failure;
  if (sem === "external") return FAM.external;
  return FAM.event;
}

// ---------------------------------------------------------------- primitives

function box(x: number, y: number, w: number, h: number, fam: Fam): string {
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="8" fill="${fam.fill}" stroke="${fam.stroke}" stroke-width="1.2"/>`;
}

function text(
  x: number,
  y: number,
  raw: string,
  size: number,
  fill: string,
  anchor: "start" | "middle" | "end",
  font: string,
  weight?: number,
): string {
  const w = weight ? ` font-weight="${weight}"` : "";
  return `<text x="${num(x)}" y="${num(y)}" text-anchor="${anchor}" ${font} font-size="${size}" fill="${fill}"${w}>${escapeXml(raw)}</text>`;
}

/** Cross-lane emit→trigger connector: cubic-bezier S-curve, arrowhead at the trigger box. */
function linkPath(from: { x: number; y: number }, to: { x: number; y: number }, fail: boolean): string {
  const dx = Math.max(50, Math.abs(from.x - to.x) * 0.28);
  const c1x = from.x - dx;
  const c2x = to.x + dx;
  const d = `M ${num(from.x)} ${num(from.y)} C ${num(c1x)} ${num(from.y)} ${num(c2x)} ${num(to.y)} ${num(to.x)} ${num(to.y)}`;
  const color = fail ? LINK_FAIL : LINK;
  const marker = fail ? "wf-arrow-fail" : "wf-arrow";
  return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.6" stroke-opacity="0.8" marker-end="url(#${marker})"/>`;
}

// ---------------------------------------------------------------- per-agent extraction

/** Dedup'd external trigger sources for the orange col-1 box. */
function extSources(a: FlowAgent): string[] {
  const out: string[] = [];
  for (const t of a.triggers) {
    if (!t.external) continue;
    const s = (t.source && t.source.trim()) || "外部业务系统";
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const MAX_IO = 6;

/** Flatten reads/calls/writes/notifies into prefixed lines (读:/调:/写:/知:), capped +N. */
function ioLines(a: FlowAgent): string[] {
  const raw: string[] = [];
  for (const r of a.reads) raw.push(`读: ${r}`);
  for (const c of a.calls) raw.push(`调: ${c}`);
  for (const w of a.writes) raw.push(`写: ${[w.action, w.object].filter(Boolean).join(" ")}`);
  for (const n of a.notifies) raw.push(`知: ${n}`);
  if (raw.length <= MAX_IO) return raw;
  return [...raw.slice(0, MAX_IO), `+${raw.length - MAX_IO} 更多`];
}

// ---------------------------------------------------------------- layout constants

const HEADER_H = 96;
const FOOTER_H = 44;
const LANE_GAP = 16;
const LANE_PAD = 12;
const LINE_H = 17;
const MONO_LINE_H = 18;
const EMIT_H = 24;
const EMIT_GAP = 8;
const MIN_LANE_H = 78;

// ---------------------------------------------------------------- renderer

/**
 * Render a swimlane business-workflow SVG from a derived BusinessFlowModel.
 * @param opts.title  header title (defaults to `model.domain`)
 * @param opts.width  canvas width in px (default 1400, floored at 720)
 */
export function renderWorkflowSvg(model: BusinessFlowModel, opts?: { title?: string; width?: number }): string {
  const width = Math.max(720, Math.round(opts?.width ?? 1400));
  const M = 20;
  const innerX = M;
  const innerW = width - 2 * M;
  const colOf = (fx: number, fw: number) => ({ x: innerX + fx * innerW, w: fw * innerW });
  const COL = {
    source: colOf(0.0, 0.12),
    trigger: colOf(0.13, 0.15),
    agent: colOf(0.29, 0.17),
    io: colOf(0.47, 0.26),
    emit: colOf(0.74, 0.26),
  };

  const agents = model.agents ?? [];

  // ---- pass 1: lane geometry (heights depend on content-line counts) ----
  type Lane = {
    a: FlowAgent;
    top: number;
    h: number;
    io: string[];
    src: string[];
    triggerEntry: Map<string, { x: number; y: number }>;
    emitExit: Map<string, { x: number; y: number }>;
  };
  const lanes: Lane[] = [];
  let cursor = HEADER_H;
  for (const a of agents) {
    const io = ioLines(a);
    const src = extSources(a);
    const emitColH = a.emits.length ? a.emits.length * (EMIT_H + EMIT_GAP) - EMIT_GAP : 0;
    const ioColH = io.length * LINE_H;
    const trigColH = a.triggers.length * MONO_LINE_H;
    const srcColH = src.length * LINE_H;
    const agentColH = a.nameZh ? 48 : 34;
    const contentH = Math.max(emitColH, ioColH, trigColH, srcColH, agentColH);
    const h = Math.max(MIN_LANE_H, contentH + 2 * LANE_PAD);
    lanes.push({ a, top: cursor, h, io, src, triggerEntry: new Map(), emitExit: new Map() });
    cursor += h + LANE_GAP;
  }
  const lanesBottom = agents.length ? cursor - LANE_GAP : HEADER_H + 40;
  const height = Math.round(lanesBottom + FOOTER_H);

  // ---- pass 2: render lane bodies + record connector endpoints ----
  let body = "";
  for (const lane of lanes) {
    const { a, top, h } = lane;
    const cy = top + h / 2;

    body += `<rect x="${num(M)}" y="${num(top)}" width="${num(innerW)}" height="${num(h)}" rx="14" fill="${THEME.laneFill}" stroke="${THEME.laneStroke}"/>`;

    // col 1 — external trigger source (orange)
    if (lane.src.length) {
      const { x, w } = COL.source;
      const blockH = lane.src.length * LINE_H;
      const sy = top + (h - blockH) / 2;
      body += box(x, sy - 6, w, blockH + 12, FAM.source);
      lane.src.forEach((s, i) => {
        const ty = sy + i * LINE_H + LINE_H * 0.72;
        body += text(x + w / 2, ty, midClip(s, fitChars(w, 11.5, 0.62)), 11.5, FAM.source.text, "middle", FONT);
      });
    }

    // col 2 — trigger events (cyan, mono)
    if (a.triggers.length) {
      const { x, w } = COL.trigger;
      const blockH = a.triggers.length * MONO_LINE_H;
      const sy = top + (h - blockH) / 2;
      body += box(x, sy - 6, w, blockH + 12, FAM.event);
      a.triggers.forEach((t, i) => {
        const lineCy = sy + i * MONO_LINE_H + MONO_LINE_H / 2;
        body += text(x + w / 2, lineCy + 4, midClip(t.event, fitChars(w, 12, 0.6)), 12, FAM.event.text, "middle", MONO);
        lane.triggerEntry.set(t.event, { x: x + w, y: lineCy });
      });
    }

    // col 3 — agent card (blue): slug + optional nameZh
    {
      const { x, w } = COL.agent;
      const boxH = a.nameZh ? 48 : 34;
      const by = cy - boxH / 2;
      body += box(x, by, w, boxH, FAM.agent);
      const slugY = a.nameZh ? by + 20 : by + boxH / 2 + 4;
      body += text(x + w / 2, slugY, midClip(a.slug || a.actionName, fitChars(w, 13.5, 0.6)), 13.5, FAM.agent.text, "middle", FONT, 600);
      if (a.nameZh) {
        body += text(x + w / 2, by + 38, midClip(a.nameZh, fitChars(w, 11, 0.62)), 11, THEME.ink2, "middle", FONT);
      }
      if (a.isSubAgent) {
        body += text(x + w - 7, by + 13, "子", 9.5, THEME.ink3, "end", FONT);
      }
    }

    // col 4 — external reads/calls/writes/notifies (green)
    if (lane.io.length) {
      const { x, w } = COL.io;
      const blockH = lane.io.length * LINE_H;
      const sy = top + (h - blockH) / 2;
      body += box(x, sy - 6, w, blockH + 12, FAM.io);
      lane.io.forEach((s, i) => {
        const ty = sy + i * LINE_H + LINE_H * 0.72;
        const isMore = /^\+\d+ /.test(s);
        body += text(x + 8, ty, midClip(s, fitChars(w, 11.5, 0.62)), 11.5, isMore ? THEME.ink3 : FAM.io.text, "start", FONT);
      });
    }

    // col 5 — produced events (stacked, colored by semantic)
    if (a.emits.length) {
      const { x, w } = COL.emit;
      const blockH = a.emits.length * (EMIT_H + EMIT_GAP) - EMIT_GAP;
      const sy = top + (h - blockH) / 2;
      a.emits.forEach((e, i) => {
        const ey = sy + i * (EMIT_H + EMIT_GAP);
        const fam = emitFam(e.semantic);
        body += box(x, ey, w, EMIT_H, fam);
        body += text(x + w / 2, ey + EMIT_H / 2 + 4, midClip(e.event, fitChars(w, 11.5, 0.6)), 11.5, fam.text, "middle", MONO);
        lane.emitExit.set(e.event, { x, y: ey + EMIT_H / 2 });
      });
    }
  }

  // ---- pass 3: cross-lane connectors (emit.event === another lane's trigger.event) ----
  let links = "";
  lanes.forEach((src, i) => {
    src.a.emits.forEach((e) => {
      const from = src.emitExit.get(e.event);
      if (!from) return;
      const fail = e.semantic === "failure";
      lanes.forEach((tgt, j) => {
        if (j === i) return; // self-loops out of scope — "another agent"
        const to = tgt.triggerEntry.get(e.event);
        if (!to) return;
        links += linkPath(from, to, fail);
      });
    });
  });

  // ---- chrome: title · legend · column captions · footer · empty note · defs ----
  const titleRaw = String(opts?.title ?? model.domain ?? "业务工作流");
  const titleEl = text(M, 34, midClip(titleRaw, fitChars(innerW * 0.62, 19, 0.62)), 19, THEME.ink, "start", FONT, 700);

  const legendItems: Array<[string, string]> = [
    ["Agent", FAM.agent.stroke],
    ["Event", FAM.event.stroke],
    ["External", FAM.source.stroke],
    ["Write", FAM.io.stroke],
    ["Failure", FAM.failure.stroke],
  ];
  let lx = M;
  let legend = "";
  for (const [lbl, color] of legendItems) {
    legend += `<rect x="${num(lx)}" y="49" width="11" height="11" rx="2.5" fill="${color}"/>`;
    legend += text(lx + 17, 58, lbl, 11.5, THEME.ink2, "start", FONT);
    lx += 17 + lbl.length * 7.4 + 18;
  }

  const caps: Array<[{ x: number; w: number }, string]> = [
    [COL.source, "触发源"],
    [COL.trigger, "触发事件"],
    [COL.agent, "Agent"],
    [COL.io, "外部 读/调/写/知"],
    [COL.emit, "产出事件"],
  ];
  let captions = "";
  for (const [c, lbl] of caps) {
    captions += text(c.x + c.w / 2, HEADER_H - 12, midClip(lbl, fitChars(c.w, 10.5, 0.62)), 10.5, THEME.ink3, "middle", FONT);
  }

  const extNames = (model.externals ?? []).map((e) => e.name);
  const footRaw = extNames.length ? `外部系统 (${extNames.length})： ${extNames.join(", ")}` : "外部系统： —";
  const footer =
    `<line x1="${num(M)}" y1="${num(height - FOOTER_H + 10)}" x2="${num(width - M)}" y2="${num(height - FOOTER_H + 10)}" stroke="${THEME.laneStroke}" stroke-width="1"/>` +
    text(M, height - 15, midClip(footRaw, fitChars(innerW, 11, 0.6)), 11, THEME.ink2, "start", MONO);

  const emptyNote = agents.length ? "" : text(width / 2, HEADER_H + 24, "（本流程暂无 Agent）", 13, THEME.ink2, "middle", FONT);

  const defs =
    `<defs>` +
    `<marker id="wf-arrow" markerWidth="9" markerHeight="9" refX="7.5" refY="4" orient="auto"><path d="M0,0 L9,4 L0,8 z" fill="${LINK}"/></marker>` +
    `<marker id="wf-arrow-fail" markerWidth="9" markerHeight="9" refX="7.5" refY="4" orient="auto"><path d="M0,0 L9,4 L0,8 z" fill="${LINK_FAIL}"/></marker>` +
    `</defs>`;

  const bg = `<rect x="0" y="0" width="${num(width)}" height="${num(height)}" fill="${THEME.bg}"/>`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${num(width)} ${num(height)}" width="${num(width)}" height="${num(height)}" role="img" aria-label="business workflow">` +
    defs +
    bg +
    titleEl +
    legend +
    captions +
    emptyNote +
    body +
    links +
    footer +
    `</svg>`
  );
}
