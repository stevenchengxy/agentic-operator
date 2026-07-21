"use client";

/**
 * Settings → Audit log (P3-FE-05).
 *
 * Reads `GET /v1/audit?since&until&actor&action&limit&cursor`. Paginated
 * via opaque cursor (the API returns `nextCursor`). Each row carries
 * `meta` which often contains `before`/`after` blobs — those are rendered
 * as a compact JSON diff in an expanded panel.
 *
 * API failures remain visible and retryable; no local fixture is substituted.
 */

import { Fragment, useMemo, useState } from "react";
import {
  Badge,
  Button,
  Empty,
  FilterChip,
  Panel,
  SearchInput,
  Td,
  Th,
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useAuditPages, type AuditRow as AuditApiRow } from "@/lib/hooks/useAudit";

/**
 * Shape returned by `GET /v1/audit`. `at` is unix-ms.
 *
 * `meta` is a free-form record but tooling looks for the canonical
 * `before` / `after` keys when present (e.g. `settings.update`,
 * `deploy.rollback`).
 */
/** Internal row shape used by the table. */
interface AuditRow {
  id: string;
  at: number;
  actor: string;
  action: string;
  target: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

function normalizeApiRow(r: AuditApiRow): AuditRow {
  const meta = r.meta ?? {};
  const before =
    isRecord(meta.before) ? meta.before : null;
  const after =
    isRecord(meta.after) ? meta.after : null;
  const target =
    typeof r.targetId === "string" && r.targetId.length > 0
      ? `${r.targetType ?? "?"} · ${r.targetId}`
      : (r.targetType ?? "—");
  return {
    id: r.id,
    at: r.at,
    actor: r.actorUserId ?? "system",
    action: r.action,
    target,
    before,
    after,
  };
}

function actionColor(action: string): "signal" | "amber" | "red" | "muted" | "blue" {
  if (action.startsWith("deploy")) return "signal";
  if (action.startsWith("key") || action.startsWith("token")) return "amber";
  if (action.startsWith("member")) return "blue";
  if (action.startsWith("integration")) return "muted";
  if (action.startsWith("agent")) return "blue";
  if (action.includes("rollback")) return "red";
  return "muted";
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

export function AuditSection() {
  const { language, t } = useI18n();
  const audit = useAuditPages({ limit: 100 });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<
    "all" | "deploy" | "key" | "member" | "agent"
  >("all");
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(
    () => (audit.data?.pages ?? []).flatMap((page) => page.items).map(normalizeApiRow),
    [audit.data],
  );

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter !== "all" && !r.action.startsWith(filter)) return false;
      if (
        q &&
        !r.actor.toLowerCase().includes(q.toLowerCase()) &&
        !r.action.toLowerCase().includes(q.toLowerCase()) &&
        !r.target.toLowerCase().includes(q.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [rows, q, filter]);

  return (
    <Panel
      title={t("auditSection.panelTitle", { count: filtered.length })}
      subtitle={t("auditSection.subtitleLive")}
      padded={false}
    >
      <div
        style={{
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <SearchInput value={q} onChange={setQ} placeholder={t("auditSection.searchPlaceholder")} />
        <FilterChip active={filter === "all"} onClick={() => setFilter("all")}>
          {t("auditSection.filterAll")}
        </FilterChip>
        <FilterChip active={filter === "deploy"} onClick={() => setFilter("deploy")}>
          {t("auditSection.filterDeploys")}
        </FilterChip>
        <FilterChip active={filter === "key"} onClick={() => setFilter("key")}>
          {t("auditSection.filterKeys")}
        </FilterChip>
        <FilterChip active={filter === "agent"} onClick={() => setFilter("agent")}>
          {t("auditSection.filterAgents")}
        </FilterChip>
        <FilterChip active={filter === "member"} onClick={() => setFilter("member")}>
          {t("auditSection.filterMembers")}
        </FilterChip>
      </div>
      {audit.isError && rows.length === 0 ? (
        <div role="alert" style={{ padding: 18, color: "var(--red)", fontSize: 12.5 }}>
          <div>{t("auditSection.loadFailed")}</div>
          <div className="mono" style={{ marginTop: 6, color: "var(--text-3)", fontSize: 11 }}>
            {audit.error instanceof Error ? audit.error.message : String(audit.error)}
          </div>
          <Button small icon="replay" tone="ghost" onClick={() => void audit.refetch()} style={{ marginTop: 10 }}>
            {t("auditSection.retry")}
          </Button>
        </div>
      ) : audit.isLoading && rows.length === 0 ? (
        <Empty title={t("auditSection.loading")} />
      ) : filtered.length === 0 ? (
        <Empty title={t("auditSection.emptyTitle")} />
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <Th>{t("auditSection.colWhen")}</Th>
              <Th>{t("auditSection.colActor")}</Th>
              <Th>{t("auditSection.colAction")}</Th>
              <Th>{t("auditSection.colTarget")}</Th>
              <Th style={{ width: 40 }}>{""}</Th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((a) => {
              const hasDiff = Boolean(a.before || a.after);
              const isOpen = expanded === a.id;
              return (
                <Fragment key={a.id}>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    <Td>
                      <span style={{ color: "var(--text-3)" }}>{fmtAgo(a.at, language)}</span>
                    </Td>
                    <Td>
                      <span style={{ color: "var(--text-2)" }}>{a.actor}</span>
                    </Td>
                    <Td>
                      <Badge tone={actionColor(a.action)}>{a.action}</Badge>
                    </Td>
                    <Td>
                      <span className="mono" style={{ color: "var(--text-2)" }}>
                        {a.target}
                      </span>
                    </Td>
                    <Td>
                      {hasDiff && (
                        <button
                          onClick={() => setExpanded(isOpen ? null : a.id)}
                          aria-expanded={isOpen}
                          title={isOpen ? t("auditSection.hideDiff") : t("auditSection.showDiff")}
                          style={{
                            padding: "2px 6px",
                            fontSize: 10.5,
                            fontFamily: "var(--mono)",
                            color: "var(--text-2)",
                            background: "var(--panel-2)",
                            border: "1px solid var(--border-2)",
                            borderRadius: 3,
                            cursor: "pointer",
                          }}
                        >
                          {isOpen ? "−" : "+"} {t("auditSection.diffLabel")}
                        </button>
                      )}
                    </Td>
                  </tr>
                  {hasDiff && isOpen && (
                    <tr style={{ borderBottom: "1px solid var(--border)" }}>
                      <td colSpan={5} style={{ padding: 0, background: "var(--bg-2)" }}>
                        <AuditDiffPanel before={a.before} after={a.after} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
      {audit.hasNextPage && (
        <div
          style={{
            padding: "10px 14px",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "center",
          }}
        >
          <Button
            small
            icon="logs"
            onClick={() => void audit.fetchNextPage()}
            disabled={audit.isFetchingNextPage}
          >
            {audit.isFetchingNextPage ? t("auditSection.loading") : t("auditSection.loadOlder")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

/**
 * Renders a side-by-side `before` / `after` JSON view. Top-level keys
 * that differ are highlighted. Pure on-prop — testable.
 */
export function AuditDiffPanel({
  before,
  after,
}: {
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}) {
  const beforeRows = renderDiffRows(before, after, "before");
  const afterRows = renderDiffRows(after, before, "after");
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 0,
        padding: 0,
      }}
    >
      <DiffSide label="before" rows={beforeRows} tone="red" />
      <DiffSide label="after" rows={afterRows} tone="green" />
    </div>
  );
}

interface DiffRow {
  key: string;
  value: string;
  changed: boolean;
  missing: boolean;
}

export function renderDiffRows(
  self: Record<string, unknown> | null,
  other: Record<string, unknown> | null,
  side: "before" | "after",
): DiffRow[] {
  const out: DiffRow[] = [];
  const selfKeys = self ? Object.keys(self).sort() : [];
  const otherKeys = other ? Object.keys(other).sort() : [];
  const allKeys = Array.from(new Set([...selfKeys, ...otherKeys])).sort();
  for (const k of allKeys) {
    const sv = self?.[k];
    const ov = other?.[k];
    const inSelf = self ? k in self : false;
    const changed = JSON.stringify(sv) !== JSON.stringify(ov);
    out.push({
      key: k,
      value: inSelf ? toCompactJson(sv) : "—",
      changed: changed && inSelf,
      missing: !inSelf,
    });
    void side; // kept for future styling differentiation
  }
  return out;
}

function DiffSide({
  label,
  rows,
  tone,
}: {
  label: string;
  rows: DiffRow[];
  tone: "red" | "green";
}) {
  const { t } = useI18n();
  const color = tone === "red" ? "var(--red)" : "var(--green)";
  return (
    <div
      style={{
        borderRight: label === "before" ? "1px solid var(--border)" : "none",
      }}
    >
      <div
        style={{
          padding: "6px 14px",
          fontSize: 10,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          color: color,
          letterSpacing: "0.08em",
          borderBottom: "1px solid var(--border)",
        }}
      >
        {t(`auditSection.${label}`)}
      </div>
      {rows.length === 0 ? (
        <div
          style={{
            padding: "10px 14px",
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          {t("auditSection.noFields")}
        </div>
      ) : (
        <div style={{ padding: "8px 0" }}>
          {rows.map((r) => (
            <div
              key={r.key}
              style={{
                display: "grid",
                gridTemplateColumns: "120px 1fr",
                gap: 8,
                padding: "3px 14px",
                fontSize: 11,
                fontFamily: "var(--mono)",
                background: r.changed ? `${color}14` : "transparent",
              }}
            >
              <span style={{ color: "var(--text-3)" }}>{r.key}</span>
              <span
                style={{
                  color: r.changed ? color : "var(--text-2)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={r.value}
              >
                {r.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function toCompactJson(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch {
    return "[unrenderable]";
  }
}
