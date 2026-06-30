"use client";

/**
 * Agent 工厂 — the LEFT RAIL. Collapsible + searchable 业务域 (was a flat wall of every domain),
 * 历史运行 with per-row soft-delete + restore + 清空已完成 + status filter (was view-only), the
 * 已生成·草稿 promote flow, and a PINNED 运行健康 strip (the old 验证 tab, promoted to always-on
 * so you never tab-hunt to see if the run is green). The whole rail hides via the page's toggle.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Icon, StatusDot, SearchInput, FilterChip } from "@/app/portal/components";
import { EvalLine } from "./atoms";
import type { DomainRow, RunRow, DraftRow } from "./model";

const SECTION_LABEL: React.CSSProperties = { fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase", letterSpacing: "0.04em" };

export function CollapsibleSection({ title, badge, storageKey, defaultOpen = true, children }: { title: string; badge?: ReactNode; storageKey: string; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => { try { const v = localStorage.getItem(storageKey); if (v != null) setOpen(v === "1"); } catch { /* ignore */ } }, [storageKey]);
  const toggle = () => setOpen((o) => { const n = !o; try { localStorage.setItem(storageKey, n ? "1" : "0"); } catch { /* ignore */ } return n; });
  return (
    <div>
      <button onClick={toggle} style={{ display: "flex", alignItems: "center", gap: 5, width: "100%", padding: "2px 0", marginBottom: 6, background: "none", border: "none", cursor: "pointer", ...SECTION_LABEL }}>
        <span style={{ display: "inline-flex", transform: open ? "none" : "rotate(-90deg)", transition: "transform 0.15s" }}><Icon name="chevron-down" size={12} /></span>
        <span>{title}</span>
        {badge != null && <span style={{ marginLeft: "auto" }}>{badge}</span>}
      </button>
      {open && children}
    </div>
  );
}

export function DomainList({ domains, domain, query, setQuery, onSelect }: { domains: DomainRow[]; domain: string; query: string; setQuery: (v: string) => void; onSelect: (id: string) => void }) {
  const q = query.trim().toLowerCase();
  const shown = q ? domains.filter((d) => (d.name ?? d.id).toLowerCase().includes(q) || d.id.toLowerCase().includes(q)) : domains;
  return (
    <div>
      <div style={{ marginBottom: 6 }}><SearchInput value={query} onChange={setQuery} placeholder="搜索业务域…" ariaLabel="搜索业务域" /></div>
      {shown.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)", padding: "4px 2px" }}>没有匹配的业务域</div>}
      {shown.map((d) => (
        <button key={d.id} onClick={() => onSelect(d.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 9px", marginBottom: 3, borderRadius: 7, border: "1px solid " + (d.id === domain ? "var(--signal)" : "transparent"), background: d.id === domain ? "var(--panel-2)" : "transparent", color: "var(--text)", cursor: "pointer", fontSize: 12.5 }}>
          <div style={{ fontWeight: 600 }}>{d.name ?? d.id}</div>
          {d.counts ? <div style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{d.counts.actions} 动作 · {d.counts.events} 事件</div> : null}
        </button>
      ))}
    </div>
  );
}

const STATUS_FILTERS: Array<{ key: string; label: string; match: (s: string) => boolean }> = [
  { key: "all", label: "全部", match: () => true },
  { key: "done", label: "完成", match: (s) => s === "finished" || s === "done" },
  { key: "failed", label: "失败", match: (s) => /error|aborted|incomplete|exhausted/.test(s) },
  { key: "running", label: "运行中", match: (s) => s === "running" },
];

const statusColor = (s: string) => (s === "finished" || s === "done" ? "var(--green)" : /error|aborted/.test(s) ? "var(--red)" : s === "running" ? "var(--signal)" : "var(--amber)");

export function HistoryList({ runs, viewingRunId, onOpen, onDelete, onClear, deletedRuns = [], showTrash = false, onToggleTrash, onRestore }: { runs: RunRow[]; viewingRunId: string | null; onOpen: (id: string) => void; onDelete: (id: string) => void; onClear: () => void; deletedRuns?: RunRow[]; showTrash?: boolean; onToggleTrash?: () => void; onRestore?: (id: string) => void }) {
  const [filter, setFilter] = useState("all");
  const f = STATUS_FILTERS.find((x) => x.key === filter)!;
  const shown = runs.filter((r) => f.match(r.status));
  return (
    <div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
        {STATUS_FILTERS.map((s) => <FilterChip key={s.key} active={filter === s.key} onClick={() => setFilter(s.key)}>{s.label}</FilterChip>)}
      </div>
      {shown.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)" }}>{runs.length ? "没有匹配的运行" : "跑过的会出现在这里"}</div>}
      {shown.map((r) => (
        <div key={r.id} className="hover-row" style={{ display: "flex", gap: 7, alignItems: "center", padding: "6px 8px", marginBottom: 2, borderRadius: 6, border: "1px solid " + (viewingRunId === r.id ? "var(--signal)" : "transparent") }}>
          <button onClick={() => onOpen(r.id)} style={{ display: "flex", gap: 7, alignItems: "center", flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", color: "var(--text-2)", padding: 0 }}>
            <StatusDot status={r.status === "finished" || r.status === "done" ? "ok" : /error|aborted/.test(r.status) ? "failed" : r.status === "running" ? "running" : "idle"} size={6} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 11.5, color: "var(--text)" }}>{r.agentsCount} agent · {r.turns} 轮 · {Math.round(r.tokensUsed / 1000)}k</span>
              <span style={{ display: "block", fontSize: 10, color: statusColor(r.status), fontFamily: "var(--mono)" }}>{r.status}</span>
            </span>
          </button>
          {r.status !== "running" && (
            <button title="删除该运行（可在回收站恢复）" onClick={(e) => { e.stopPropagation(); onDelete(r.id); }} style={{ flexShrink: 0, display: "inline-flex", padding: 4, borderRadius: 5, background: "none", border: "none", cursor: "pointer", color: "var(--text-3)" }}>
              <Icon name="trash" size={13} />
            </button>
          )}
        </div>
      ))}
      <div style={{ display: "flex", gap: 12, marginTop: 4, alignItems: "center" }}>
        {shown.some((r) => r.status !== "running") && (
          <button onClick={onClear} style={{ fontSize: 11, color: "var(--text-3)", background: "none", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Icon name="trash" size={11} /> 清空已完成
          </button>
        )}
        {onToggleTrash && (
          <button onClick={onToggleTrash} style={{ fontSize: 11, color: showTrash ? "var(--signal)" : "var(--text-3)", background: "none", border: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }}>
            <Icon name="trash" size={11} /> 回收站{showTrash ? " ▾" : " ▸"}{deletedRuns.length ? ` (${deletedRuns.length})` : ""}
          </button>
        )}
      </div>
      {/* #5: recycle bin — list soft-deleted runs with a restore action. */}
      {showTrash && (
        <div style={{ marginTop: 6, borderTop: "1px dashed var(--border)", paddingTop: 6 }}>
          {deletedRuns.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)" }}>回收站是空的</div>}
          {deletedRuns.map((r) => (
            <div key={r.id} className="hover-row" style={{ display: "flex", gap: 7, alignItems: "center", padding: "6px 8px", marginBottom: 2, borderRadius: 6, opacity: 0.85 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--text-2)" }}>{r.agentsCount} agent · {r.turns} 轮 · {Math.round(r.tokensUsed / 1000)}k</span>
                <span style={{ display: "block", fontSize: 10, color: "var(--text-4)", fontFamily: "var(--mono)" }}>{r.status} · 已删除</span>
              </span>
              <button title="恢复该运行" onClick={(e) => { e.stopPropagation(); onRestore?.(r.id); }} style={{ flexShrink: 0, fontSize: 11, color: "var(--signal)", background: "none", border: "1px solid var(--border)", borderRadius: 5, padding: "2px 8px", cursor: "pointer" }}>恢复</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function HealthStrip({ checks }: { checks: Array<{ ok: boolean | undefined; label: string }> }) {
  return (
    <div style={{ border: "1px solid var(--border-2)", borderRadius: 8, padding: "8px 10px", background: "var(--panel-2)" }}>
      <div style={{ ...SECTION_LABEL, marginBottom: 4 }}>运行健康</div>
      {checks.map((c, i) => <EvalLine key={i} ok={c.ok} label={c.label} />)}
    </div>
  );
}

export function DraftList({ drafts, promoting, promoteMsg, onPromote }: { drafts: DraftRow[]; promoting: boolean; promoteMsg: string; onPromote: (slugs?: string[]) => void }) {
  // R4: per-draft selection (track EXCLUDED so it survives draft-list updates); default all in.
  // Mock-platform drafts (slug contains "-mock-") default OUT — they're sandbox stand-ins.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  if (drafts.length === 0) return <div style={{ fontSize: 11, color: "var(--text-4)" }}>跑通后生成的 agent 会出现在这里，勾选后可晋升上线</div>;
  const isMock = (slug: string) => /-mock-/.test(slug);
  const isOn = (slug: string) => !excluded.has(slug) && !isMock(slug);
  const toggle = (slug: string) => setExcluded((prev) => { const n = new Set(prev); if (n.has(slug)) n.delete(slug); else n.add(slug); return n; });
  const selected = drafts.filter((d) => isOn(d.slug)).map((d) => d.slug);
  return (
    <>
      {drafts.map((d) => (
        <label key={d.slug} style={{ display: "flex", gap: 7, alignItems: "flex-start", padding: "6px 8px", marginBottom: 3, borderRadius: 6, border: "1px solid var(--border)", background: "var(--panel-2)", cursor: "pointer" }}>
          <input type="checkbox" checked={isOn(d.slug)} onChange={() => toggle(d.slug)} style={{ marginTop: 2 }} />
          <span style={{ minWidth: 0 }}>
            <span style={{ display: "block", fontSize: 11.5, color: "var(--text)" }}>{d.spec?.nameZh ?? d.spec?.short ?? d.slug}{isMock(d.slug) ? " · 模拟桩" : ""}</span>
            <span style={{ display: "block", fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{(d.spec?.tools ?? []).length} 工具{d.spec?.actionName ? ` · ${d.spec.actionName}` : ""}</span>
          </span>
        </label>
      ))}
      <button onClick={() => onPromote(selected)} disabled={promoting || selected.length === 0} title="把勾选的草稿合并进本租户的工作流并注册为真实运行的 agent（不会覆盖已有 agent）" style={{ width: "100%", marginTop: 6, padding: "7px 9px", borderRadius: 7, border: "1px solid var(--green)", background: "transparent", color: "var(--green)", cursor: promoting || selected.length === 0 ? "default" : "pointer", fontSize: 12, opacity: promoting || selected.length === 0 ? 0.5 : 1 }}>
        {promoting ? "晋升中…" : `↑ 晋升选中上线（${selected.length}）`}
      </button>
      {promoteMsg && <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 5, lineHeight: 1.5 }}>{promoteMsg}</div>}
    </>
  );
}
