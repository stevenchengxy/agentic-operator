"use client";

/**
 * Agent 工厂 — the 交付图 (delivered agents' EVENT FLOW) + the StageRail.
 *
 * EventGraph is a bipartite agent↔event DAG, rebuilt to match the old AO's clarity: events are
 * their OWN nodes between agents (so what flows is explicit, not an unlabelled edge), laid out
 * vertically by longest-path depth + barycenter crossing-reduction, with roomy spacing. Agent
 * nodes show the concise actionName (long Chinese nameZh on hover). score.delta floats on the
 * refined node. Clicking an agent opens its inspector. Scales to fit; fullscreen gives it room.
 */

import { Fragment, useMemo } from "react";
import { Empty, HelpTip } from "@/app/portal/components";
import type { AgentCardData, FactoryStageId, StageState } from "./model";

// ── stage rail (compact, always-pinned progress) ──────────────────────────────────
const STATUS_COLOR: Record<string, string> = { idle: "var(--text-3)", active: "var(--signal)", ok: "var(--green)", error: "var(--red)", warn: "var(--amber)" };

export function StageRail({ stages, current, running, refineCount }: { stages: StageState[]; current: FactoryStageId | null; running: boolean; refineCount: number }) {
  const reached = stages.reduce((mx, s, i) => (s.status !== "idle" ? i : mx), -1);
  const pct = Math.round(((reached + 1) / stages.length) * 100);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        {stages.map((s, i) => {
          const isActive = s.id === current && running && s.status !== "ok";
          const col = STATUS_COLOR[s.status] ?? "var(--text-3)";
          const on = s.status !== "idle";
          return (
            <Fragment key={s.id}>
              {i > 0 && <span style={{ color: "var(--border-2)", fontSize: 10 }}>›</span>}
              <span className={isActive ? "fct-stage-active" : undefined} title={s.label} style={{ flex: "1 1 0", textAlign: "center", fontSize: 11, whiteSpace: "nowrap", padding: "3px 4px", borderRadius: 20, border: `1px solid ${on ? col : "var(--border)"}`, background: s.status === "active" || isActive ? "var(--panel-2)" : "transparent", color: on ? col : "var(--text-3)", transition: "color 0.3s ease, border-color 0.3s ease, background 0.3s ease" }}>
                {s.status === "ok" ? "✓ " : s.status === "error" ? "✗ " : ""}{s.label}
              </span>
            </Fragment>
          );
        })}
      </div>
      <div style={{ position: "relative", height: 3, borderRadius: 2, background: "var(--border)", marginTop: 7 }}>
        <div style={{ position: "absolute", left: 0, top: 0, height: 3, borderRadius: 2, width: `${pct}%`, background: "var(--signal)", transition: "width 0.4s ease" }} />
      </div>
      {refineCount > 0 && <div style={{ fontSize: 10.5, color: "var(--amber)", marginTop: 5 }}>↺ 修订回环 ×{refineCount}</div>}
    </div>
  );
}

// ── progress SPINE (full-width status band: 业务域 · 阶段+健康 · 成本 · 后台) ──────────────
// One merged band that replaces the old right-pane StageRail + left-rail HealthStrip + budget
// figure. Health checks fold onto their owning stage segment as colored pips (green=ok,
// amber=待办/未过, dim=未开始); hover a pip for its label. Pure projection — same stages/checks
// the rest of the cockpit derives, just consolidated into one row.
const HEALTH_BY_STAGE: Partial<Record<FactoryStageId, number[]>> = { design: [0, 1, 2], validate: [3], sandbox: [4] };

export function FactorySpine({
  stages, current, running, refineCount, domainName, healthChecks, budgetTokens, awaitingHint, onOpenBg,
}: {
  stages: StageState[];
  current: FactoryStageId | null;
  running: boolean;
  refineCount: number;
  domainName: string;
  healthChecks: Array<{ ok: boolean | undefined; label: string }>;
  budgetTokens: number;
  awaitingHint: string | null;
  onOpenBg: () => void;
}) {
  const pipColor = (ok: boolean | undefined) => (ok === true ? "var(--green)" : ok === false ? "var(--amber)" : "var(--text-4)");
  return (
    <div style={{ display: "flex", alignItems: "stretch", gap: 12, minHeight: 46, padding: "0 14px", borderBottom: "1px solid var(--border)", background: "var(--panel-3)", flexShrink: 0 }}>
      <div title={domainName} style={{ display: "flex", alignItems: "center", gap: 7, alignSelf: "center", background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, padding: "5px 10px", fontSize: 12, color: "var(--text-2)", whiteSpace: "nowrap", maxWidth: 210, minWidth: 0 }}>
        🗂 <b style={{ color: "var(--text)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>{domainName || "未选业务域"}</b>
      </div>
      <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 2, minWidth: 0, overflow: "hidden" }}>
        {stages.map((s, i) => {
          const isActive = s.id === current && running && s.status !== "ok";
          const on = s.status !== "idle";
          const pips = HEALTH_BY_STAGE[s.id];
          return (
            <Fragment key={s.id}>
              {i > 0 && <span style={{ color: "var(--text-4)", fontSize: 10 }}>›</span>}
              <div className={isActive ? "fct-stage-active" : undefined} title={s.label} style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: 3, padding: "5px 9px", borderRadius: 8, background: isActive ? "linear-gradient(180deg, rgba(208,255,0,0.10), transparent)" : "transparent", minWidth: 0 }}>
                <span style={{ fontSize: 11.5, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5, color: on ? (s.status === "ok" ? "var(--text-2)" : s.status === "error" ? "var(--red)" : "var(--text)") : "var(--text-3)", fontWeight: isActive ? 600 : 400 }}>
                  {s.status === "ok" && <span style={{ color: "var(--green)", fontSize: 10 }}>✓</span>}
                  {isActive && <span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--signal)", boxShadow: "0 0 0 3px rgba(208,255,0,0.18)" }} />}
                  {s.label}
                </span>
                {pips && <span style={{ display: "flex", gap: 3 }}>{pips.map((ci) => <span key={ci} title={healthChecks[ci]?.label} style={{ width: 5, height: 5, borderRadius: "50%", background: pipColor(healthChecks[ci]?.ok) }} />)}</span>}
              </div>
            </Fragment>
          );
        })}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 9, alignSelf: "center", flexShrink: 0 }}>
        {refineCount > 0 && <span title="修订回环" style={{ fontSize: 10.5, color: "var(--amber)", fontFamily: "var(--mono)" }}>↺ ×{refineCount}</span>}
        {budgetTokens > 0 && <span title="本次运行的累计 token" style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-3)" }}>◷ {Math.round(budgetTokens / 1000)}k</span>}
        <button onClick={onOpenBg} title="后台任务" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--text-2)", background: "var(--panel)", border: `1px solid ${awaitingHint ? "var(--amber)" : "var(--border)"}`, borderRadius: 20, padding: "4px 10px", cursor: "pointer" }}>
          后台{awaitingHint && <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--amber)" }} />}
        </button>
      </div>
    </div>
  );
}

// ── bipartite agent↔event graph ───────────────────────────────────────────────────
interface GNode { id: string; kind: "agent" | "event"; label: string; sub?: string; title: string; slug?: string; actionName?: string }
const AW = 162, AH = 48, EH = 28, COLW = 196, ROWH = 72, PADX = 16, PADTOP = 18, PADBOT = 18;
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function EventGraph({
  agents, scores, degraded, selectedSlug, onSelect,
}: {
  agents: AgentCardData[];
  scores: Map<string, { delta: number; next: number; regression: boolean }>;
  degraded: Set<string>;
  selectedSlug: string | null;
  onSelect: (slug: string) => void;
}) {
  const g = useMemo(() => {
    const nodeMap = new Map<string, GNode>();
    const producers = new Map<string, number>();
    const consumers = new Map<string, number>();
    const edges: Array<{ from: string; to: string }> = [];
    for (const a of agents) {
      const aid = `a:${a.slug}`;
      nodeMap.set(aid, { id: aid, kind: "agent", label: a.actionName || a.short || a.slug, sub: a.nameZh, title: a.nameZh || a.short || a.slug, slug: a.slug, actionName: a.actionName });
      for (const ev of a.emit) { const eid = `e:${ev}`; if (!nodeMap.has(eid)) nodeMap.set(eid, { id: eid, kind: "event", label: ev, title: ev }); edges.push({ from: aid, to: eid }); producers.set(ev, (producers.get(ev) ?? 0) + 1); }
      for (const ev of a.trigger) { const eid = `e:${ev}`; if (!nodeMap.has(eid)) nodeMap.set(eid, { id: eid, kind: "event", label: ev, title: ev }); edges.push({ from: eid, to: aid }); consumers.set(ev, (consumers.get(ev) ?? 0) + 1); }
    }
    const nodes = [...nodeMap.values()];
    // longest-path depth (iteration-capped so an emit→trigger cycle can't loop forever)
    const depth = new Map(nodes.map((n) => [n.id, 0]));
    for (let it = 0; it <= nodes.length * 2; it++) {
      let changed = false;
      for (const e of edges) { const d = (depth.get(e.from) ?? 0) + 1; if (d > (depth.get(e.to) ?? 0)) { depth.set(e.to, d); changed = true; } }
      if (!changed) break;
    }
    const layers = new Map<number, GNode[]>();
    for (const n of nodes) { const d = depth.get(n.id) ?? 0; (layers.get(d) ?? layers.set(d, []).get(d)!).push(n); }
    const normX = new Map<string, number>();
    [...layers.entries()].sort((a, b) => a[0] - b[0]).forEach(([d, layer]) => {
      if (d > 0) {
        const bary = (n: GNode) => { const preds = edges.filter((e) => e.to === n.id).map((e) => normX.get(e.from)).filter((x): x is number => x != null); return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : 0.5; };
        layer.sort((a, b) => bary(a) - bary(b));
      }
      layer.forEach((n, i) => normX.set(n.id, (i + 0.5) / layer.length));
    });
    const maxLayer = Math.max(0, ...[...layers.keys()]);
    const maxPer = Math.max(1, ...[...layers.values()].map((l) => l.length));
    const Wd = Math.max(320, maxPer * COLW + PADX * 2);
    const Hd = PADTOP + (maxLayer + 1) * ROWH + PADBOT;
    const pos = new Map<string, { x: number; y: number }>();
    layers.forEach((layer, d) => layer.forEach((n, i) => pos.set(n.id, { x: PADX + ((i + 0.5) / layer.length) * (Wd - PADX * 2), y: PADTOP + d * ROWH + AH / 2 })));
    return { nodes, edges, pos, Wd, Hd, producers, consumers };
  }, [agents]);

  if (!agents.length) return <Empty title={<>还没有智能体 <HelpTip>大脑进入「设计」阶段后，事件流图会随生成逐个长出来</HelpTip></>} />;

  const curve = (x1: number, y1: number, x2: number, y2: number) => `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`;
  return (
    <div style={{ overflow: "auto", maxWidth: "100%" }}>
      <svg viewBox={`0 0 ${g.Wd} ${g.Hd}`} width="100%" style={{ display: "block" }}>
        <defs>
          <marker id="eg-ar" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--border-2)" /></marker>
        </defs>
        {g.edges.map((e, i) => {
          const a = g.pos.get(e.from)!, b = g.pos.get(e.to)!;
          if (!a || !b) return null;
          const fromH = e.from.startsWith("a:") ? AH / 2 : EH / 2;
          const toH = e.to.startsWith("a:") ? AH / 2 : EH / 2;
          return <path key={i} d={curve(a.x, a.y + fromH, b.x, b.y - toH)} fill="none" stroke="var(--border-2)" strokeWidth={1.3} markerEnd="url(#eg-ar)" />;
        })}
        {g.nodes.map((n) => {
          const p = g.pos.get(n.id)!;
          if (!p) return null;
          if (n.kind === "agent") {
            const sc = n.actionName ? scores.get(n.actionName) : undefined;
            const deg = n.slug ? degraded.has(n.slug) : false;
            const sel = n.slug === selectedSlug;
            const stroke = sel ? "var(--signal)" : deg ? "var(--amber)" : "var(--signal)";
            return (
              <g key={n.id} className="fct-in" style={{ cursor: "pointer" }} onClick={() => n.slug && onSelect(n.slug)}>
                <rect x={p.x - AW / 2} y={p.y - AH / 2} width={AW} height={AH} rx={11} fill="var(--panel-2)" stroke={stroke} strokeWidth={sel ? 2 : 1.2} opacity={deg ? 0.92 : 1} />
                <circle cx={p.x - AW / 2 + 13} cy={p.y} r={4} fill={deg ? "var(--amber)" : "var(--green)"} />
                <text x={p.x - AW / 2 + 24} y={p.y - 3} fontSize={12} fontWeight={700} fill="var(--text)">{trunc(n.label, 17)}</text>
                {n.sub && <text x={p.x - AW / 2 + 24} y={p.y + 12} fontSize={9.5} fill="var(--text-3)">{trunc(n.sub, 13)}</text>}
                {sc && (
                  <g transform={`translate(${p.x + AW / 2 - 34},${-AH / 2 + p.y - 8})`}>
                    <rect width={40} height={16} rx={8} fill={sc.regression ? "var(--red)" : "var(--green)"} />
                    <text x={20} y={11} textAnchor="middle" fontSize={9} fontWeight={700} fill="var(--on-accent)">{sc.delta >= 0 ? "▲" : "▼"}{Math.abs(sc.delta)}</text>
                  </g>
                )}
                <title>{n.title}{sc ? ` · 评分 ${sc.next}（${sc.delta >= 0 ? "+" : ""}${sc.delta}）` : ""}</title>
              </g>
            );
          }
          const ev = n.label;
          const entry = !(g.producers.get(ev) ?? 0);
          const terminal = !(g.consumers.get(ev) ?? 0);
          const ew = Math.min(220, 28 + trunc(ev, 24).length * 7);
          const col = terminal ? "var(--green)" : entry ? "var(--text-3)" : "var(--border-2)";
          return (
            <g key={n.id} className="fct-in">
              <rect x={p.x - ew / 2} y={p.y - EH / 2} width={ew} height={EH} rx={14} fill="var(--panel)" stroke={col} strokeWidth={1.2} strokeDasharray={entry ? "4 3" : undefined} />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize={10.5} fill={terminal ? "var(--green)" : "var(--text-2)"} fontFamily="var(--mono)">{trunc(ev, 24)}</text>
              <title>{ev}{entry ? " · 入口事件" : terminal ? " · 终态/外部交接" : ""}</title>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
