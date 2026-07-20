"use client";

/**
 * Agent 工厂 — the LEFT RAIL. Collapsible ontology binding/catalog,
 * 历史运行 with per-row soft-delete + restore + 清空已完成 + status filter (was view-only), the
 * 已生成·草稿 promote flow, and a PINNED 运行健康 strip (the old 验证 tab, promoted to always-on
 * so you never tab-hunt to see if the run is green). The whole rail hides via the page's toggle.
 */

import { useEffect, useState, type ReactNode } from "react";
import { Icon, StatusDot, SearchInput, FilterChip } from "@/app/portal/components";
import { EvalLine } from "./atoms";
import { factoryRunDisplayStatus, type DomainRow, type RunRow, type DraftRow } from "./model";

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

export function DomainList({ domains, domain, query, setQuery, onSelect, actionLabel, uploadedIds, onDeleteUpload }: { domains: DomainRow[]; domain: string; query: string; setQuery: (v: string) => void; onSelect?: (id: string) => void; actionLabel?: string; uploadedIds?: Set<string>; onDeleteUpload?: (id: string, name: string) => void }) {
  const q = query.trim().toLowerCase();
  const shown = q ? domains.filter((d) => (d.name ?? d.id).toLowerCase().includes(q) || d.id.toLowerCase().includes(q)) : domains;
  return (
    <div>
      {domains.length > 1 && <div style={{ marginBottom: 6 }}><SearchInput value={query} onChange={setQuery} placeholder="搜索本体目录…" ariaLabel="搜索本体目录" /></div>}
      {shown.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)", padding: "4px 2px" }}>没有匹配的本体</div>}
      {shown.map((d) => {
        const active = d.id === domain;
        // Tenant uploads can be deleted in place; built-in/live ontology rows cannot.
        const deletable = Boolean(uploadedIds?.has(d.id) && onDeleteUpload);
        return (
          <div key={d.id} style={{ display: "flex", alignItems: "stretch", gap: 2, marginBottom: 3 }}>
            <button className="factory-cta" onClick={() => onSelect?.(d.id)} disabled={!onSelect} style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0, textAlign: "left", padding: "8px 10px", borderRadius: 8, border: "1px solid " + (active ? "var(--signal)" : "transparent"), background: active ? "var(--panel-2)" : "transparent", color: "var(--text)", cursor: onSelect ? "pointer" : "default", fontSize: 12.5 }}>
              <span style={{ width: 3, alignSelf: "stretch", borderRadius: 2, background: active ? "var(--signal)" : "transparent", flexShrink: 0 }} />
              <span style={{ minWidth: 0, flex: 1 }}>
                <span style={{ display: "block", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name ?? d.id}</span>
                {d.counts ? <span style={{ display: "block", fontSize: 10, color: "var(--text-3)", marginTop: 1 }}>{d.counts.actions} 动作 · {d.counts.events} 事件</span> : null}
              </span>
              {actionLabel && <span style={{ flexShrink: 0, color: active ? "var(--green)" : "var(--signal)", fontSize: 10.5 }}>{active ? "已连接" : actionLabel}</span>}
            </button>
            {deletable && (
              <button onClick={() => onDeleteUpload!(d.id, d.name ?? d.id)} title="删除租户上传的本体" aria-label={`删除本地本体 ${d.name ?? d.id}`} className="factory-cta" style={{ flexShrink: 0, background: "none", border: "1px solid transparent", borderRadius: 8, color: "var(--text-4)", cursor: "pointer", fontSize: 12, padding: "0 6px" }}>🗑</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

const STATUS_FILTERS: Array<{ key: string; label: string; match: (s: string) => boolean }> = [
  { key: "all", label: "全部", match: () => true },
  { key: "done", label: "完成", match: (s) => s === "finished" || s === "done" || s === "answer_completed" },
  { key: "waiting", label: "等你回复", match: (s) => s === "waiting_human" },
  { key: "failed", label: "失败 / 证据无效", match: (s) => /error|failed|aborted|incomplete|exhausted|invalid|unverified|legacy_unknown/.test(s) },
  { key: "running", label: "运行中", match: (s) => s === "running" },
];

const statusColor = (s: string) => (s === "finished" || s === "done" || s === "answer_completed" ? "var(--green)" : /error|failed|aborted|invalid/.test(s) ? "var(--red)" : s === "running" ? "var(--signal)" : "var(--amber)");
const statusDotKind = (s: string): "ok" | "failed" | "running" | "idle" => (s === "finished" || s === "done" || s === "answer_completed" ? "ok" : /error|failed|aborted|invalid/.test(s) ? "failed" : s === "running" ? "running" : "idle");
// Human-readable status (was the raw "finished"/"error"/"exhausted" dev string in mono).
const humanStatus = (s: string): string => (s === "answer_completed" ? "回答完成（不代表交付或沙箱证据）" : s === "finished" || s === "done" ? "已完成（真实执行成功）" : s === "waiting_human" ? "等待你的回复 · 点击继续" : s === "failed_real_execution" ? "完成状态异常 · 最后一次真实执行失败" : s === "invalid_evidence" ? "历史模拟 · 证据无效" : s === "unverified_evidence" ? "完成状态 · 无真实执行证据" : s === "legacy_unknown" ? "历史结束 · 完成类型未知" : /error|aborted/.test(s) ? "失败" : s === "running" ? "运行中" : /incomplete|exhausted/.test(s) ? "未完成" : s);
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
  const shown = runs.filter((r) => f.match(factoryRunDisplayStatus(r)));
  return (
    <div>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 6 }}>
        {STATUS_FILTERS.map((s) => <FilterChip key={s.key} active={filter === s.key} onClick={() => setFilter(s.key)}>{s.label}</FilterChip>)}
      </div>
      {shown.length === 0 && <div style={{ fontSize: 11, color: "var(--text-4)" }}>{runs.length ? "没有匹配的运行" : "跑过的会出现在这里"}</div>}
      {shown.map((r) => {
        const title = r.goal?.trim() || `${r.agentsCount} 个智能体的运行`;
        const active = viewingRunId === r.id;
        const displayStatus = factoryRunDisplayStatus(r);
        return (
          <div key={r.id} className="hover-row" style={{ display: "flex", gap: 6, alignItems: "center", padding: "7px 9px", marginBottom: 2, borderRadius: 7, border: "1px solid " + (active ? "var(--signal)" : "transparent"), background: active ? "var(--panel-2)" : "transparent" }}>
            <button onClick={() => onOpen(r.id)} style={{ display: "flex", flexDirection: "column", gap: 2, flex: 1, minWidth: 0, textAlign: "left", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
              <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
                <StatusDot status={statusDotKind(displayStatus)} size={6} />
                <span style={{ minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
              </span>
              <span style={{ fontSize: 10, color: "var(--text-3)", paddingLeft: 12 }}>
                <span style={{ color: statusColor(displayStatus) }}>{humanStatus(displayStatus)}</span>
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
        {shown.some((r) => r.status !== "running" && r.status !== "waiting_human") && (
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
                <span style={{ display: "block", fontSize: 10, color: "var(--text-4)" }}>{humanStatus(factoryRunDisplayStatus(r))} · 已删除{r.createdAt && relTime(r.createdAt) ? ` · ${relTime(r.createdAt)}` : ""}</span>
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

export function DraftList({
  drafts,
  promoting,
  promoteMsg,
  editMsg,
  sandboxMsg,
  editingSlug,
  sandboxingSlug,
  onPromote,
  onEdit,
  onSandbox,
  onDelete,
}: {
  drafts: DraftRow[];
  promoting: boolean;
  promoteMsg: string;
  editMsg?: string;
  sandboxMsg?: string;
  editingSlug?: string | null;
  sandboxingSlug?: string | null;
  onPromote: (slugs?: string[]) => void;
  onEdit?: (draft: DraftRow) => void;
  onSandbox?: (draft: DraftRow) => void;
  onDelete?: (slug: string) => void;
}) {
  // R4: per-draft selection (track EXCLUDED so it survives draft-list updates); default all in.
  // Historical/test sandbox stand-ins can still exist on disk, but they are never
  // promotable. Render their checkbox disabled instead of offering a dead toggle.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  if (drafts.length === 0) return <div style={{ fontSize: 11, color: "var(--text-4)" }}>跑通后生成的 agent 会出现在这里，勾选后可晋升上线或删除</div>;
  const ineligibleReason = draftPromotionIneligibleReason;
  const isOn = (draft: DraftRow) => !excluded.has(draft.slug) && !ineligibleReason(draft);
  const toggle = (slug: string) => setExcluded((prev) => { const n = new Set(prev); if (n.has(slug)) n.delete(slug); else n.add(slug); return n; });
  const selected = drafts.filter(isOn).map((d) => d.slug);
  return (
    <>
      {drafts.map((d) => {
        const reason = ineligibleReason(d);
        return (
          <div key={d.slug} style={{ display: "flex", gap: 7, alignItems: "flex-start", padding: "6px 8px", marginBottom: 3, borderRadius: 6, border: "1px solid var(--border)", background: "var(--panel-2)" }}>
            <label title={reason ?? undefined} style={{ display: "flex", gap: 7, alignItems: "flex-start", flex: 1, minWidth: 0, cursor: reason ? "not-allowed" : "pointer", opacity: reason ? 0.7 : 1 }}>
              <input type="checkbox" checked={isOn(d)} disabled={Boolean(reason)} onChange={() => toggle(d.slug)} style={{ marginTop: 2 }} />
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 11.5, color: "var(--text)" }}>{d.spec?.nameZh ?? d.spec?.short ?? d.slug}{reason ? " · 不可晋升" : ""}</span>
                <span style={{ display: "block", fontSize: 10, color: reason ? "var(--red)" : "var(--text-3)", fontFamily: "var(--mono)" }}>
                  {reason ?? `${(d.spec?.tools ?? []).length} 工具${d.spec?.actionName ? ` · ${d.spec.actionName}` : ""} · ${d.versionId}`}
                </span>
                {d.replayReady === true && d.promotionEligible !== true && (
                  <span role="status" style={{ display: "block", marginTop: 2, fontSize: 10, color: "var(--amber)", lineHeight: 1.4 }}>
                    ✓ 沙箱编排已验证 · ⛔ 当前不能上线
                  </span>
                )}
                {d.replayReady === true && d.promotionEligible === true && (
                  <span role="status" style={{ display: "block", marginTop: 2, fontSize: 10, color: "var(--green)", lineHeight: 1.4 }}>
                    ✓ 回归可重放 · ✓ 当前 production 证据就绪
                  </span>
                )}
              </span>
            </label>
            {onEdit && (
              <button
                title={d.versionId ? "按字段修改，并派生一个需要重新审查和沙箱测试的新版本" : "旧草稿没有不可变 versionId，不能安全编辑"}
                aria-label={`修改草稿 ${d.spec?.nameZh ?? d.slug}`}
                disabled={!d.versionId || Boolean(editingSlug)}
                onClick={() => onEdit(d)}
                style={{ flexShrink: 0, padding: 3, borderRadius: 5, background: "none", border: "none", cursor: !d.versionId || editingSlug ? "default" : "pointer", color: "var(--text-3)", fontSize: 12, opacity: !d.versionId || editingSlug ? 0.45 : 1 }}
              >{editingSlug === d.slug ? "…" : "✎"}</button>
            )}
            {onSandbox && d.versionId && (
              <button
                title={d.regression ? "用一套新测试输入重新创建独立沙箱，并派生新的回归版本" : "为这个无证据版本创建独立沙箱；跑通并清理后生成新的回归版本"}
                aria-label={`重新沙箱测试 ${d.spec?.nameZh ?? d.slug}`}
                disabled={Boolean(sandboxingSlug || editingSlug)}
                onClick={() => onSandbox(d)}
                style={{ flexShrink: 0, padding: 3, borderRadius: 5, background: "none", border: "none", cursor: sandboxingSlug || editingSlug ? "default" : "pointer", color: d.regression ? "var(--text-3)" : "var(--amber)", fontSize: 12, opacity: sandboxingSlug || editingSlug ? 0.45 : 1 }}
              >{sandboxingSlug === d.slug ? "…" : "🧪"}</button>
            )}
            {onDelete && (
              <button title="删除该草稿（不影响已上线的 agent）" onClick={() => onDelete(d.slug)} style={{ flexShrink: 0, padding: 3, borderRadius: 5, background: "none", border: "none", cursor: "pointer", color: "var(--text-4)", fontSize: 12 }}>🗑</button>
            )}
          </div>
        );
      })}
      <button onClick={() => onPromote(selected)} disabled={promoting || selected.length === 0} title="把勾选的草稿合并进本租户的工作流并注册为真实运行的 agent（不会覆盖已有 agent）" style={{ width: "100%", marginTop: 6, padding: "7px 9px", borderRadius: 7, border: "1px solid var(--green)", background: "transparent", color: "var(--green)", cursor: promoting || selected.length === 0 ? "default" : "pointer", fontSize: 12, opacity: promoting || selected.length === 0 ? 0.5 : 1 }}>
        {promoting ? "晋升中…" : `↑ 晋升选中上线（${selected.length}）`}
      </button>
      {editMsg && <div role="status" style={{ fontSize: 10.5, color: "var(--green)", marginTop: 5, lineHeight: 1.5 }}>{editMsg}</div>}
      {sandboxMsg && <div role="status" style={{ fontSize: 10.5, color: "var(--green)", marginTop: 5, lineHeight: 1.5 }}>{sandboxMsg}</div>}
      {promoteMsg && <div role={promoteMsg.startsWith("晋升失败") ? "alert" : "status"} style={{ fontSize: 10.5, color: promoteMsg.startsWith("晋升失败") ? "var(--red)" : "var(--text-3)", marginTop: 5, lineHeight: 1.5 }}>{promoteMsg}</div>}
    </>
  );
}

export function draftPromotionIneligibleReason(draft: DraftRow): string | null {
    const sandboxScaffold = /-mock-ext-|(^|[-_])mock([-_]|$)|(^|[-_])simulate([-_]|$)|mock_/i.test(draft.slug)
      || draft.spec?.isMock === true
      || draft.spec?.mock === true;
    if (sandboxScaffold) return "沙箱平台替身仅用于隔离测试，不能晋升到真实运行";
    if (!draft.versionId) return "旧草稿没有不可变 versionId，必须重新生成";
    if (!draft.regression?.artifact || !draft.regression.evidenceFingerprint || !draft.regression.suiteFingerprint) {
      return "草稿缺少可重放回归证据，必须重新运行真实沙箱并完成交付";
    }
    if (draft.replayReady !== true || draft.regressionReady !== true) {
      if (draft.regressionStatus === "pending_replay") return "回归工件仍在校验，完成前不能晋升";
      if (draft.regressionStatus === "invalid") return "回归工件校验失败，请修正后重新创建沙箱";
      if (draft.regressionStatus === "missing") return "当前版本没有有效的回归校验状态";
      return "服务端尚未确认这个版本可晋升，请刷新或重新运行沙箱";
    }
    if (
      draft.promotionGateAdmission !== true
      ||
      draft.promotionEligible !== true
      || draft.promotionEvidenceReady !== true
      || draft.evidenceQualification?.promotion !== "candidate"
    ) {
      return `沙箱编排已验证，当前不能上线；signed fixture/回放不能代替当前 production profile 的 live probe${draft.promotionBlockers?.length ? `：${draft.promotionBlockers.slice(0, 2).join("；")}` : ""}`;
    }
    return null;
}
