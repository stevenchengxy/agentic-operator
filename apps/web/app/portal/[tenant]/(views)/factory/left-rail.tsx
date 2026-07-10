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

export function CollapsibleSection({ title, badge, storageKey, defaultOpen = true, children }: { title: ReactNode; badge?: ReactNode; storageKey: string; defaultOpen?: boolean; children: ReactNode }) {
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

export function DomainList({ domains, domain, query, setQuery, onSelect, uploadedIds, onDeleteUpload }: { domains: DomainRow[]; domain: string; query: string; setQuery: (v: string) => void; onSelect: (id: string) => void; uploadedIds?: Set<string>; onDeleteUpload?: (id: string, name: string) => void }) {
  const q = query.trim().toLowerCase();
  const shown = q ? domains.filter((d) => (d.name ?? d.id).toLowerCase().includes(q) || d.id.toLowerCase().includes(q)) : domains;
  return (
    <div>
      <div style={{ marginBottom: 6 }}><SearchInput value={query} onChange={setQuery} placeholder="搜索业务域…" ariaLabel="搜索业务域" /></div>
      {shown.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)", padding: "4px 2px" }}>没有匹配的业务域</div>}
      {shown.map((d) => {
        const active = d.id === domain;
        // 上传本体产生的业务域可就地删除（🗑）；内置/在线本体没有 onDeleteUpload → 不可删。
        const deletable = Boolean(uploadedIds?.has(d.id) && onDeleteUpload);
        return (
          <div key={d.id} style={{ display: "flex", alignItems: "stretch", gap: 2, marginBottom: 3 }}>
            <button className="factory-cta" onClick={() => onSelect(d.id)} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, textAlign: "left", padding: "8px 10px", borderRadius: 8, border: "1px solid " + (active ? "var(--signal)" : "transparent"), background: active ? "var(--panel-2)" : "transparent", color: "var(--text)", cursor: "pointer", fontSize: 12.5 }}>
              <span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: active ? "var(--signal)" : "transparent", flexShrink: 0 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name ?? d.id}</span>
                {d.counts ? <span style={{ display: "block", fontSize: 10, color: "var(--text-3)", marginTop: 1 }}>{d.counts.actions} 动作 · {d.counts.events} 事件</span> : null}
              </span>
            </button>
            {deletable && (
              <button onClick={() => onDeleteUpload!(d.id, d.name ?? d.id)} title="删除本地本体（业务域将从列表消失）" aria-label={`删除本地本体 ${d.name ?? d.id}`} className="factory-cta" style={{ flexShrink: 0, background: "none", border: "1px solid transparent", borderRadius: 8, color: "var(--text-4)", cursor: "pointer", fontSize: 12, padding: "0 6px" }}>🗑</button>
            )}
          </div>
        );
      })}
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
const statusDotKind = (s: string): "ok" | "failed" | "running" | "idle" => (s === "finished" || s === "done" ? "ok" : /error|aborted/.test(s) ? "failed" : s === "running" ? "running" : "idle");
// Human-readable status (was the raw "finished"/"error"/"exhausted" dev string in mono).
const humanStatus = (s: string): string => (s === "finished" || s === "done" ? "已完成" : /error|aborted/.test(s) ? "失败" : s === "running" ? "运行中" : /incomplete|exhausted/.test(s) ? "未完成" : s);
// Compact relative time so a run reads "3 分钟前", not a raw ISO / nothing.
const relTime = (iso: string): string => {
  const t = new Date(iso).getTime();
  if (!t || Number.isNaN(t)) return "";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  if (s < 604800) return `${Math.floor(s / 86400)} 天前`;
  return new Date(t).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
};

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
      {shown.map((r) => {
        const title = r.goal?.trim() || `${r.agentsCount} 个智能体的运行`;
        const active = viewingRunId === r.id;
        return (
          <div key={r.id} className="hover-row" style={{ display: "flex", gap: 6, alignItems: "center", padding: "7px 9px", marginBottom: 2, borderRadius: 7, border: "1px solid " + (active ? "var(--signal)" : "transparent"), background: active ? "var(--panel-2)" : "transparent" }}>
            <button onClick={() => onOpen(r.id)} style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                <StatusDot status={statusDotKind(r.status)} size={6} />
                <span style={{ minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
              </span>
              <span style={{ fontSize: 10, color: "var(--text-3)", paddingLeft: 12 }}>
                <span style={{ color: statusColor(r.status) }}>{humanStatus(r.status)}</span>
                {r.createdAt && relTime(r.createdAt) ? ` · ${relTime(r.createdAt)}` : ""}
                {r.agentsCount ? ` · ${r.agentsCount} 智能体` : ""}
              </span>
            </button>
            {r.status !== "running" && (
              <button title="删除该运行（可在回收站恢复）" onClick={(e) => { e.stopPropagation(); onDelete(r.id); }} style={{ flexShrink: 0, display: "inline-flex", padding: 4, borderRadius: 5, background: "none", border: "none", cursor: "pointer", color: "var(--text-4)" }}>
                <Icon name="trash" size={12} />
              </button>
            )}
          </div>
        );
      })}
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
            <div key={r.id} className="hover-row" style={{ display: "flex", gap: 7, alignItems: "center", padding: "6px 8px", marginBottom: 2, borderRadius: 6, opacity: 0.8 }}>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--text-2)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.goal?.trim() || `${r.agentsCount} 个智能体的运行`}</span>
                <span style={{ display: "block", fontSize: 10, color: "var(--text-4)" }}>{humanStatus(r.status)} · 已删除{r.createdAt && relTime(r.createdAt) ? ` · ${relTime(r.createdAt)}` : ""}</span>
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

export function DraftList({ drafts, promoting, promoteMsg, onPromote, onDelete }: { drafts: DraftRow[]; promoting: boolean; promoteMsg: string; onPromote: (slugs?: string[]) => void; onDelete?: (slug: string) => void }) {
  // R4: per-draft selection (track EXCLUDED so it survives draft-list updates); default all in.
  // Mock-platform drafts (slug contains "-mock-") default OUT — they're sandbox stand-ins.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  if (drafts.length === 0) return <div style={{ fontSize: 11, color: "var(--text-4)" }}>跑通后生成的 agent 会出现在这里，勾选后可晋升上线或删除</div>;
  const isMock = (slug: string) => /-mock-/.test(slug);
  const isOn = (slug: string) => !excluded.has(slug) && !isMock(slug);
  const toggle = (slug: string) => setExcluded((prev) => { const n = new Set(prev); if (n.has(slug)) n.delete(slug); else n.add(slug); return n; });
  const selected = drafts.filter((d) => isOn(d.slug)).map((d) => d.slug);
  return (
    <>
      {drafts.map((d) => (
        <div key={d.slug} style={{ display: "flex", gap: 7, alignItems: "flex-start", padding: "6px 8px", marginBottom: 3, borderRadius: 6, border: "1px solid var(--border)", background: "var(--panel-2)" }}>
          <label style={{ display: "flex", gap: 7, alignItems: "flex-start", flex: 1, minWidth: 0, cursor: "pointer" }}>
            <input type="checkbox" checked={isOn(d.slug)} onChange={() => toggle(d.slug)} style={{ marginTop: 2 }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 11.5, color: "var(--text)" }}>{d.spec?.nameZh ?? d.spec?.short ?? d.slug}{isMock(d.slug) ? " · 模拟桩" : ""}</span>
              <span style={{ display: "block", fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{(d.spec?.tools ?? []).length} 工具{d.spec?.actionName ? ` · ${d.spec.actionName}` : ""}</span>
            </span>
          </label>
          {onDelete && (
            <button title="删除该草稿（不影响已上线的 agent）" onClick={() => onDelete(d.slug)} style={{ flexShrink: 0, padding: 3, borderRadius: 5, background: "none", border: "none", cursor: "pointer", color: "var(--text-4)", fontSize: 12 }}>🗑</button>
          )}
        </div>
      ))}
      <button onClick={() => onPromote(selected)} disabled={promoting || selected.length === 0} title="把勾选的草稿合并进本租户的工作流并注册为真实运行的 agent（不会覆盖已有 agent）" style={{ width: "100%", marginTop: 6, padding: "7px 9px", borderRadius: 7, border: "1px solid var(--green)", background: "transparent", color: "var(--green)", cursor: promoting || selected.length === 0 ? "default" : "pointer", fontSize: 12, opacity: promoting || selected.length === 0 ? 0.5 : 1 }}>
        {promoting ? "晋升中…" : `↑ 晋升选中上线（${selected.length}）`}
      </button>
      {promoteMsg && <div style={{ fontSize: 10.5, color: "var(--text-3)", marginTop: 5, lineHeight: 1.5 }}>{promoteMsg}</div>}
    </>
  );
}
