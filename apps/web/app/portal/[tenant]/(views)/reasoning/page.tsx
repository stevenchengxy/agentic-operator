"use client";

/**
 * AI 洞察 / 推理审计 (W3) — a live, cross-run surface for the LLM responses that
 * production agents produce.
 *
 * Two lenses:
 *   - 推理流: the newest captured LLM turns across all runs — the model's
 *     reasoning (💭), its response (🗣), and the tools it called — rendered
 *     through the shared <Markdown>, deep-linking to each run.
 *   - 规则审计: recent rule-check / gate decisions with a PASS / 拦截 verdict and
 *     the decision payload.
 *
 * Both poll (react-query refetchInterval) so the page stays live as runs land.
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Empty,
  Markdown,
  StatusDot,
  ViewHeader,
  SearchInput,
  FilterChip,
  type StatusName,
} from "@/app/portal/components";
import { fmtAgo } from "@/app/portal/lib/format";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import {
  useReasoning,
  useRuleAudit,
  type ReasoningTurn,
  type RuleAuditRow,
} from "@/lib/hooks/useReasoning";

const STATUS_TO_DOT: Record<string, StatusName> = {
  running: "running",
  queued: "waiting",
  waiting: "waiting",
  ok: "ok",
  failed: "failed",
  cancelled: "cancelled",
};

export default function ReasoningPage() {
  const tenant = useTenant();
  const { t } = useI18n();
  const [lens, setLens] = useState<"reasoning" | "audit">("reasoning");
  const [query, setQuery] = useState("");
  const reasoningQuery = useReasoning({ limit: 80 });
  const auditQuery = useRuleAudit({ limit: 80 });
  const activeQuery = lens === "reasoning" ? reasoningQuery : auditQuery;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("reasoning.title")}
        subtitle={t("reasoning.subtitle")}
        action={
          <LivePill
            label={
              activeQuery.isError
                ? t("reasoning.offline")
                : activeQuery.isLoading
                  ? t("reasoning.loading")
                  : t("reasoning.live")
            }
            status={activeQuery.isError ? "offline" : activeQuery.isLoading ? "loading" : "live"}
          />
        }
      />

      <div
        style={{
          padding: "8px 14px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        <FilterChip active={lens === "reasoning"} onClick={() => setLens("reasoning")}>
          {t("reasoning.lensReasoning")}
        </FilterChip>
        <FilterChip active={lens === "audit"} onClick={() => setLens("audit")}>
          {t("reasoning.lensAudit")}
        </FilterChip>
        {lens === "reasoning" && (
          <div style={{ marginLeft: "auto", width: 280 }}>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={t("reasoning.searchPlaceholder")}
            />
          </div>
        )}
      </div>

      <div style={{ flex: 1, overflow: "auto", minHeight: 0, padding: "12px 14px" }}>
        {lens === "reasoning" ? (
          <ReasoningFeed
            query={query}
            tenant={tenant}
            data={reasoningQuery.data ?? []}
            isLoading={reasoningQuery.isLoading}
            error={reasoningQuery.error}
          />
        ) : (
          <AuditFeed
            tenant={tenant}
            data={auditQuery.data ?? []}
            isLoading={auditQuery.isLoading}
            error={auditQuery.error}
          />
        )}
      </div>
    </div>
  );
}

function LivePill({
  label,
  status,
}: {
  label: string;
  status: "live" | "loading" | "offline";
}) {
  const color = status === "offline" ? "var(--red)" : status === "loading" ? "var(--amber)" : "var(--signal)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: "50%",
          background: color,
          boxShadow: status === "live" ? `0 0 0 0 ${color}` : "none",
          animation: status === "live" ? "pulse 1.8s infinite" : "none",
        }}
      />
      <span style={{ fontSize: 11, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
        {label}
      </span>
    </span>
  );
}

function ReasoningFeed({
  query,
  tenant,
  data,
  isLoading,
  error,
}: {
  query: string;
  tenant: string;
  data: ReasoningTurn[];
  isLoading: boolean;
  error: Error | null;
}) {
  const { t } = useI18n();

  const filtered = useMemo(() => {
    if (!query) return data;
    const q = query.toLowerCase();
    return data.filter((r) =>
      [r.agentName, r.agentTitle, r.subject, r.responseText, r.reasoning]
        .some((s) => (s ?? "").toLowerCase().includes(q)),
    );
  }, [data, query]);

  if (error)
    return <Empty title={t("reasoning.loadFailed")} hint={error.message} />;
  if (!isLoading && filtered.length === 0)
    return <Empty title={t("reasoning.empty")} hint={t("reasoning.emptyHint")} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {filtered.map((turn) => (
        <ReasoningCard key={turn.id} turn={turn} tenant={tenant} />
      ))}
    </div>
  );
}

function ReasoningCard({ turn, tenant }: { turn: ReasoningTurn; tenant: string }) {
  const { t } = useI18n();
  const [showReasoning, setShowReasoning] = useState(false);
  const longReasoning = (turn.reasoning?.length ?? 0) > 360;

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderRadius: 8,
        background: "var(--panel)",
        padding: "10px 12px",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <StatusDot status={STATUS_TO_DOT[turn.runStatus] ?? "idle"} />
        <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text)" }}>
          {turn.agentTitle ?? turn.agentName ?? "—"}
        </span>
        {turn.subject && (
          <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
            {turn.subject}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {turn.model && (
            <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
              {turn.model}
            </span>
          )}
          {turn.createdAt && (
            <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
              {fmtAgo(Date.parse(turn.createdAt))}
            </span>
          )}
          <Link
            href={`/portal/${tenant}/runs/${turn.runId}` as never}
            style={{ fontSize: 11, color: "var(--signal)", textDecoration: "none" }}
          >
            {t("reasoning.viewRun")} →
          </Link>
        </span>
      </div>

      {/* Reasoning */}
      {turn.reasoning && (
        <div style={{ marginBottom: turn.responseText ? 8 : 0 }}>
          <div style={{ fontSize: 10.5, color: "var(--text-3)", marginBottom: 2 }}>
            💭 {t("reasoning.think")}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--text-2)", lineHeight: 1.55 }}>
            {longReasoning && !showReasoning ? (
              <>
                {turn.reasoning.slice(0, 360)}…{" "}
                <button
                  type="button"
                  onClick={() => setShowReasoning(true)}
                  style={{ color: "var(--signal)", background: "none", border: "none", cursor: "pointer", fontSize: 11, padding: 0 }}
                >
                  {t("reasoning.expand")}
                </button>
              </>
            ) : (
              <Markdown>{turn.reasoning}</Markdown>
            )}
          </div>
        </div>
      )}

      {/* Response */}
      {turn.responseText && (
        <div>
          <div style={{ fontSize: 10.5, color: "var(--text-3)", marginBottom: 2 }}>
            🗣 {t("reasoning.response")}
          </div>
          <Markdown>{turn.responseText}</Markdown>
        </div>
      )}

      {/* Tool calls */}
      {turn.toolCalls.length > 0 && (
        <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {turn.toolCalls.map((c, i) => (
            <Badge key={i} tone="blue" style={{ fontSize: 9.5 }}>
              🔧 {c.name}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditFeed({
  tenant,
  data,
  isLoading,
  error,
}: {
  tenant: string;
  data: RuleAuditRow[];
  isLoading: boolean;
  error: Error | null;
}) {
  const { t } = useI18n();

  if (error)
    return <Empty title={t("reasoning.loadFailed")} hint={error.message} />;
  if (!isLoading && data.length === 0)
    return <Empty title={t("reasoning.auditEmpty")} hint={t("reasoning.auditEmptyHint")} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {data.map((row) => (
        <AuditCard key={row.id} row={row} tenant={tenant} />
      ))}
    </div>
  );
}

function AuditCard({ row, tenant }: { row: RuleAuditRow; tenant: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const verdict =
    row.verdict === "pass"
      ? { tone: "green" as const, label: t("reasoning.verdictPass") }
      : row.verdict === "fail"
        ? { tone: "red" as const, label: t("reasoning.verdictFail") }
        : { tone: "muted" as const, label: t("reasoning.verdictNeutral") };

  return (
    <div
      style={{
        border: "1px solid var(--border)",
        borderLeft: `3px solid ${row.verdict === "fail" ? "var(--red)" : row.verdict === "pass" ? "var(--signal)" : "var(--border-2)"}`,
        borderRadius: 8,
        background: "var(--panel)",
        padding: "9px 12px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Badge tone={verdict.tone} style={{ fontSize: 9.5 }}>
          {verdict.label}
        </Badge>
        <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>
          {row.name}
        </span>
        {row.subject && (
          <span className="mono" style={{ fontSize: 11, color: "var(--text-3)" }}>
            {row.subject}
          </span>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {row.sourceAgentName && (
            <span style={{ fontSize: 10.5, color: "var(--text-3)" }}>
              {row.sourceAgentTitle ?? row.sourceAgentName}
            </span>
          )}
          {row.receivedAt && (
            <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)" }}>
              {fmtAgo(Date.parse(row.receivedAt))}
            </span>
          )}
          {row.consumerRunId && (
            <Link
              href={`/portal/${tenant}/runs/${row.consumerRunId}` as never}
              style={{ fontSize: 11, color: "var(--signal)", textDecoration: "none" }}
            >
              {t("reasoning.viewRun")} →
            </Link>
          )}
        </span>
      </div>
      {row.payload != null && (
        <div style={{ marginTop: 6 }}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
          >
            {open ? "▾" : "▸"} {t("reasoning.payload")}
          </button>
          {open && (
            <pre
              style={{
                marginTop: 4,
                fontSize: 11,
                fontFamily: "var(--mono)",
                color: "var(--text-2)",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: 240,
                overflow: "auto",
                background: "var(--panel-2)",
                border: "1px solid var(--border)",
                borderRadius: 6,
                padding: 8,
              }}
            >
              {JSON.stringify(row.payload, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
