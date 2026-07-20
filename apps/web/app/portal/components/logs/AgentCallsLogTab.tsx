"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Badge,
  Empty,
  FilterChip,
  Panel,
  StatusDot,
  type StatusName,
} from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { fmtDur, fmtNum } from "@/app/portal/lib/format";
import { useRuns } from "@/lib/hooks/useRuns";
import { useObservabilityInvocations } from "@/lib/hooks/useObservability";
import {
  LogPane,
  LogSearch,
  MetaPill,
  TimeCell,
  monoStyle,
  tdStyle,
  thStyle,
} from "./shared";
import {
  buildAgentCallStats,
  runStartedMs,
  type AgentCallEdge,
} from "./observability";

type TraceWindow = "24h" | "7d" | "30d" | "all";

const WINDOWS: Array<{ id: TraceWindow; ms: number | null }> = [
  { id: "24h", ms: 24 * 60 * 60 * 1000 },
  { id: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { id: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { id: "all", ms: null },
];

const STATUS_SET = new Set<StatusName>([
  "running",
  "ok",
  "failed",
  "waiting",
  "cancelled",
  "paused",
  "idle",
]);

function statusName(status: string): StatusName {
  if (status === "queued") return "waiting";
  return STATUS_SET.has(status as StatusName) ? (status as StatusName) : "idle";
}

function filterCallEdges(
  items: AgentCallEdge[],
  needle: string,
): AgentCallEdge[] {
  if (!needle) return items;
  return items.filter((edge) =>
    [edge.callerAgent, edge.calleeAgent, edge.viaEvent, edge.correlationId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle)),
  );
}

export function AgentCallsLogTab() {
  const { t } = useI18n();
  const tenant = useTenant();
  const router = useRouter();
  const [windowId, setWindowId] = useState<TraceWindow>("7d");
  const [q, setQ] = useState("");
  const query = useRuns({ limit: 500 });
  const selectedWindow =
    WINDOWS.find((item) => item.id === windowId) ?? WINDOWS[1]!;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, [selectedWindow.ms]);
  const since = selectedWindow.ms == null ? 0 : now - selectedWindow.ms;
  const invocations = useObservabilityInvocations({
    since,
    until: now,
    limit: 500,
  });
  const runs = useMemo(
    () => (query.data ?? []).filter((run) => runStartedMs(run) >= since),
    [query.data, since],
  );
  const provenEdges = useMemo(() => {
    if (!invocations.data) return [];
    return invocations.data.items.flatMap((edge) => {
      if (!edge.callerAgent || edge.callType === "external") return [];
      return [
        {
          id: edge.id,
          callerRunId: edge.callerRunId,
          callerAgent: edge.callerAgentTitle || edge.callerAgent,
          calleeRunId: edge.calleeRunId,
          calleeAgent: edge.calleeAgentTitle || edge.calleeAgent,
          viaEvent: edge.viaEvent,
          correlationId: edge.correlationId,
          at: edge.startedAt,
          durationMs: edge.durationMs,
          status: edge.status,
          tokens:
            Math.max(0, edge.tokensIn ?? 0) + Math.max(0, edge.tokensOut ?? 0),
          relation:
            edge.callType === "parent"
              ? ("parent" as const)
              : ("event" as const),
        },
      ];
    });
  }, [invocations.data]);
  const stats = useMemo(
    () => buildAgentCallStats(runs, provenEdges),
    [runs, provenEdges],
  );
  const needle = q.trim().toLowerCase();
  const filteredProvenEdges = useMemo(
    () => filterCallEdges(provenEdges, needle),
    [provenEdges, needle],
  );
  const filteredStats = useMemo(
    () =>
      needle
        ? stats.filter((item) =>
            [item.agent, ...item.callers, ...item.callees].some((value) =>
              value.toLowerCase().includes(needle),
            ),
          )
        : stats,
    [stats, needle],
  );

  if (invocations.isLoading && !invocations.data) {
    return (
      <LogPane>
        <Empty
          title={t("logsExplorer.loading")}
          hint={t("logsExplorer.callsLoadingHint")}
        />
      </LogPane>
    );
  }
  if (invocations.isError && !invocations.data) {
    return (
      <LogPane>
        <Empty
          title={t("logsExplorer.callsLoadFailed")}
          hint={invocations.error?.message ?? ""}
        />
      </LogPane>
    );
  }

  const roots = invocations.data
    ? invocations.data.items.filter((edge) => edge.callType === "external")
        .length
    : null;
  const activeAgents = invocations.data
    ? stats.filter((item) => item.incoming + item.outgoing > 0).length
    : null;
  const testRuns = runs.filter((run) => run.testRun).length;

  return (
    <LogPane
      toolbar={
        <>
          <LogSearch
            value={q}
            onChange={setQ}
            placeholder={t("logsExplorer.callsSearch")}
          />
          <div style={{ display: "flex", gap: 6 }}>
            {WINDOWS.map((item) => (
              <FilterChip
                key={item.id}
                active={windowId === item.id}
                onClick={() => setWindowId(item.id)}
              >
                {item.id === "all" ? t("logsExplorer.allTime") : item.id}
              </FilterChip>
            ))}
          </div>
          {invocations.data && (
            <MetaPill>
              {t("logsExplorer.callCount", { n: filteredProvenEdges.length })}
            </MetaPill>
          )}
          {testRuns > 0 && (
            <MetaPill>
              {t("logsExplorer.testRunsCount", { n: testRuns })}
            </MetaPill>
          )}
          <Badge
            tone={
              invocations.isError ? "red" : invocations.data ? "green" : "amber"
            }
            style={{ marginLeft: "auto" }}
          >
            {invocations.isError
              ? t("logsExplorer.callsApiFailedBadge")
              : invocations.data
                ? t("logsExplorer.callsApiProvenBadge")
                : t("logsExplorer.callsApiLoadingBadge")}
          </Badge>
        </>
      }
    >
      <div
        style={{
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <SourceNotice
          tone={
            invocations.isError
              ? "error"
              : invocations.isLoading
                ? "loading"
                : "ok"
          }
        >
          {invocations.isError
            ? t("logsExplorer.callsApiError", {
                detail:
                  invocations.error instanceof Error
                    ? invocations.error.message
                    : String(invocations.error),
              })
            : invocations.isLoading
              ? t("logsExplorer.callsApiLoading")
              : provenEdges.length === 0
                ? t("logsExplorer.callsApiEmpty")
                : t("logsExplorer.callsApiReady", {
                    n: provenEdges.length,
                  })}
        </SourceNotice>
        {query.isError && (
          <SourceNotice tone="error">
            {t("logsExplorer.runsApiError", {
              detail:
                query.error instanceof Error
                  ? query.error.message
                  : String(query.error),
            })}
          </SourceNotice>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            border: "1px solid var(--border)",
            borderRadius: 7,
            background: "var(--panel)",
            overflow: "hidden",
          }}
        >
          <Metric
            label={t("logsExplorer.provenApiCalls")}
            value={invocations.data ? fmtNum(provenEdges.length) : "—"}
            accent="var(--signal)"
          />
          <Metric
            label={t("logsExplorer.provenApiActiveAgents")}
            value={activeAgents == null ? "—" : fmtNum(activeAgents)}
          />
          <Metric
            label={t("logsExplorer.provenExternalRoots")}
            value={roots == null ? "—" : fmtNum(roots)}
          />
        </div>

        {((query.data?.length ?? 0) >= 500 ||
          Boolean(invocations.data?.nextCursor)) && (
          <div
            role="note"
            style={{
              padding: "8px 11px",
              border:
                "1px solid color-mix(in srgb, var(--amber) 35%, var(--border))",
              borderRadius: 6,
              color: "var(--amber)",
              background: "color-mix(in srgb, var(--amber) 7%, transparent)",
              fontSize: 11.5,
            }}
          >
            {t("logsExplorer.traceCoverageLimit")}
          </div>
        )}

        <Panel
          title={t("logsExplorer.callFlow")}
          subtitle={t("logsExplorer.callFlowHint")}
          padded={false}
        >
          {filteredProvenEdges.length === 0 ? (
            <Empty
              title={t("logsExplorer.noProvenCalls")}
              hint={t("logsExplorer.noProvenCallsHint")}
            />
          ) : (
            <CallEdgeList
              edges={filteredProvenEdges}
              onOpen={(runId) =>
                router.push(`/portal/${tenant}/runs/${runId}` as never)
              }
            />
          )}
        </Panel>

        <Panel
          title={t("logsExplorer.agentSupervisionMatrix")}
          subtitle={t("logsExplorer.agentSupervisionHint")}
          padded={false}
        >
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                minWidth: 900,
                borderCollapse: "collapse",
              }}
            >
              <thead>
                <tr>
                  <th style={thStyle}>{t("logsExplorer.colAgent")}</th>
                  <th style={thStyle}>{t("logsExplorer.calledBy")}</th>
                  <th style={thStyle}>{t("logsExplorer.incomingCalls")}</th>
                  <th style={thStyle}>{t("logsExplorer.outgoingCalls")}</th>
                  <th style={thStyle}>{t("logsExplorer.trackedRuns")}</th>
                  <th style={thStyle}>{t("logsExplorer.failures")}</th>
                  <th style={thStyle}>{t("logsExplorer.totalTokens")}</th>
                </tr>
              </thead>
              <tbody>
                {filteredStats.map((item) => (
                  <tr key={item.agent} className="hover-row">
                    <td style={{ ...tdStyle, color: "var(--text)" }}>
                      {item.agent}
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          ...monoStyle,
                          display: "block",
                          maxWidth: 360,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                        title={item.callers.join(", ")}
                      >
                        {item.callers.length > 0
                          ? item.callers.join(" · ")
                          : t("logsExplorer.rootOrExternal")}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={monoStyle}>{fmtNum(item.incoming)}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={monoStyle}>{fmtNum(item.outgoing)}</span>
                    </td>
                    <td style={tdStyle}>
                      <span style={monoStyle}>{fmtNum(item.runs)}</span>
                    </td>
                    <td style={tdStyle}>
                      <span
                        style={{
                          ...monoStyle,
                          color:
                            item.failures > 0 ? "var(--red)" : "var(--text-3)",
                        }}
                      >
                        {fmtNum(item.failures)}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      <span style={monoStyle}>{fmtNum(item.tokens)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </LogPane>
  );
}

function CallEdgeList({
  edges,
  onOpen,
}: {
  edges: AgentCallEdge[];
  onOpen: (runId: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        overflowX: "auto",
      }}
    >
      {edges.slice(0, 100).map((edge) => (
        <button
          key={edge.id}
          type="button"
          onClick={() => onOpen(edge.calleeRunId)}
          className="hover-row"
          style={{
            display: "grid",
            gridTemplateColumns:
              "86px minmax(130px, 1fr) 34px minmax(150px, 1fr) minmax(150px, 1.2fr) 90px 72px",
            alignItems: "center",
            gap: 8,
            width: "100%",
            padding: "8px 13px",
            textAlign: "left",
            color: "var(--text-2)",
            background: "transparent",
            border: 0,
            borderBottom: "1px solid var(--border)",
            cursor: "pointer",
            minWidth: 900,
          }}
        >
          <TimeCell ms={edge.at} />
          <span style={{ fontSize: 12, color: "var(--text)" }}>
            {edge.callerAgent}
          </span>
          <span
            aria-hidden="true"
            style={{
              color: "var(--signal)",
              fontFamily: "var(--mono)",
              textAlign: "center",
            }}
          >
            →
          </span>
          <span style={{ fontSize: 12, color: "var(--text)" }}>
            {edge.calleeAgent}
          </span>
          <span
            style={{
              ...monoStyle,
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
            title={edge.viaEvent ?? undefined}
          >
            {edge.viaEvent ?? t("logsExplorer.directChild")}
          </span>
          <span style={monoStyle}>{fmtDur(edge.durationMs)}</span>
          <span
            style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
          >
            <StatusDot status={statusName(edge.status)} size={6} />
            <span style={monoStyle}>{edge.status}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function SourceNotice({
  tone,
  children,
}: {
  tone: "ok" | "loading" | "error";
  children: React.ReactNode;
}) {
  const color =
    tone === "error"
      ? "var(--red)"
      : tone === "loading"
        ? "var(--amber)"
        : "var(--green)";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      style={{
        padding: "8px 11px",
        border: `1px solid color-mix(in srgb, ${color} 35%, var(--border))`,
        borderRadius: 6,
        color,
        background: `color-mix(in srgb, ${color} 7%, transparent)`,
        fontSize: 11.5,
      }}
    >
      {children}
    </div>
  );
}

function Metric({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      style={{ padding: "13px 16px", borderRight: "1px solid var(--border)" }}
    >
      <div
        style={{
          fontSize: 9.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          color: "var(--text-3)",
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 6,
          fontSize: 21,
          fontFamily: "var(--mono)",
          color: accent ?? "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
