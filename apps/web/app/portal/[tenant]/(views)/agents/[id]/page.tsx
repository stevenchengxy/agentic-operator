"use client";

/**
 * Agent detail view — header + 4-stat strip + 5 tabs (config|io|code|versions|runs).
 *
 * Live data via canonical TanStack hooks:
 *   - useAgents() — list aside (left)
 *   - useAgent(kebabId) — selected agent's manifest detail
 *   - useRuns({ limit: 200 }) — recent runs for stats + RunsTab
 *
 * Every manifest/source field comes from the exact agent version referenced by
 * a live deployment. The API marks identities without a live source via
 * `sourceUnavailable`; the UI surfaces that state instead of manufacturing an
 * empty manifest.
 */

import { useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  ActorTag,
  Badge,
  Button,
  Empty,
  FilterChip,
  SearchInput,
  Splitter,
  StatusDot,
  ViewHeader,
  useToast,
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import {
  useAgent,
  useAgents,
  useInvokeAgent,
  useSetAgentEnabled,
  useRenameAgent,
  useDeleteAgent,
  type AgentDetail,
  type AgentListRow,
} from "@/lib/hooks/useAgents";
import { useRuns, type RunListRow } from "@/lib/hooks/useRuns";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { AgentCodeTab } from "@/app/portal/components/agent-code/AgentCodeTab";
import {
  ConfigTab,
  IOConfigTab,
  RunsTab,
  VersionsTab,
  type ViewAgent as AgentTabsViewAgent,
} from "@/app/portal/components/agents/AgentTabs";
import { RunWithInputModal } from "@/app/portal/components/agents/RunWithInputModal";
import { ImportManifestModal } from "@/app/portal/components/import-manifest/ImportManifestModal";
import {
  buildAgentStats,
  type AgentStatsSnapshot,
} from "@/lib/agent-stats";

/**
 * Normalize the deployed AgentDetail response for the shared tab components.
 * Nullable source fields remain nullable all the way to the renderer.
 */
type ViewAgent = AgentTabsViewAgent;

function detailToViewAgent(detail: AgentDetail): ViewAgent {
  return {
    id: detail.kebabId,
    name: detail.name,
    title: detail.title ?? detail.name,
    description: detail.description,
    actor: detail.actor,
    triggers: detail.triggers,
    emits: detail.triggeredEvents,
    steps: detail.actions.map((a) => a.name),
    input_data: detail.input_data,
    ontology_instructions: detail.ontology_instructions,
    tool_use: detail.tool_use,
    typescript_code: detail.typescript_code,
    workflowVersion: detail.workflowVersion,
    sourceUnavailable: detail.sourceUnavailable,
    deployedSource: detail.deployedSource,
  };
}

export default function AgentDetailPage() {
  const { t } = useI18n();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const tenant = useTenant();
  const selectedKebab = params?.id ?? "";
  const agentsQuery = useAgents();
  const runsQuery = useRuns({ limit: 200 });
  const detailQuery = useAgent(selectedKebab);
  const agents = agentsQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const [query, setQuery] = useState("");
  const [actorFilter, setActorFilter] = useState<"all" | "Agent" | "Human">("all");
  const [listW, setListW] = useState(440);
  const [importOpen, setImportOpen] = useState(false);

  const stats = useMemo(() => {
    return buildAgentStats(agents, runs);
  }, [agents, runs]);

  const filtered = agents.filter((a) => {
    if (actorFilter !== "all" && a.actor !== actorFilter) return false;
    if (
      query &&
      !(a.title ?? a.name).toLowerCase().includes(query.toLowerCase()) &&
      !a.name.toLowerCase().includes(query.toLowerCase())
    ) {
      return false;
    }
    return true;
  });

  function openAgent(kebabId: string) {
    router.push(`/portal/${tenant}/agents/${kebabId}` as never);
  }
  function openRun(id: string) {
    router.push(`/portal/${tenant}/runs/${id}` as never);
  }

  const agent = detailQuery.data
    ? detailToViewAgent(detailQuery.data)
    : null;
  const countsReady = agentsQuery.data !== undefined && !agentsQuery.isError;
  const countValue: string | number = countsReady
    ? agents.length
    : agentsQuery.isLoading
      ? "…"
      : "—";
  const automatedValue: string | number = countsReady
    ? agents.filter((item) => item.actor === "Agent").length
    : countValue;
  const humanValue: string | number = countsReady
    ? agents.filter((item) => item.actor === "Human").length
    : countValue;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.agents")}
        subtitle={t("agentDetail.subtitle", {
          count: countValue,
          automated: automatedValue,
          human: humanValue,
        })}
        action={
          <Button icon="upload" small onClick={() => setImportOpen(true)}>
            {t("agentDetail.importManifest")}
          </Button>
        }
      />

      {runsQuery.isError && (
        <div
          role="alert"
          style={{
            margin: "12px 16px 0",
            padding: "9px 11px",
            border: "1px solid color-mix(in srgb, var(--red) 45%, var(--border))",
            borderRadius: 6,
            color: "var(--red)",
            background: "color-mix(in srgb, var(--red) 7%, transparent)",
            fontSize: 12,
          }}
        >
          {t("agents.statsUnavailable")}: {runsQuery.error.message}
        </div>
      )}

      <div style={{ flex: 1, display: "flex", flexDirection: "row", minHeight: 0 }}>
        {/* List aside */}
        <aside
          style={{
            width: listW,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            overflow: "auto",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)", display: "flex", gap: 8 }}>
            <SearchInput value={query} onChange={setQuery} placeholder={t("agentDetail.searchPlaceholder")} />
          </div>
          <div
            style={{
              padding: "8px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 6,
            }}
          >
            <FilterChip active={actorFilter === "all"} onClick={() => setActorFilter("all")}>
              {t("agentDetail.filterAll")}
            </FilterChip>
            <FilterChip active={actorFilter === "Agent"} onClick={() => setActorFilter("Agent")}>
              {t("agentDetail.filterAgents")}
            </FilterChip>
            <FilterChip active={actorFilter === "Human"} onClick={() => setActorFilter("Human")}>
              {t("agentDetail.filterHuman")}
            </FilterChip>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {agentsQuery.isError ? (
              <Empty
                title={t("agentDetail.loadAgentsFailed")}
                hint={agentsQuery.error?.message ?? t("agentDetail.apiUnreachable")}
              />
            ) : agentsQuery.isLoading && agents.length === 0 ? (
              <Empty title={t("agentDetail.loadingAgents")} hint="" />
            ) : (
              <AgentsListCompact
                agents={filtered}
                stats={stats}
                statsReady={agentsQuery.data !== undefined && !agentsQuery.isError}
                selectedKebab={selectedKebab}
                onPick={openAgent}
              />
            )}
          </div>
        </aside>

        <Splitter axis="x" getValue={() => listW} setValue={setListW} min={260} max={720} />

        <div style={{ flex: 1, minWidth: 0, overflow: "auto", minHeight: 0 }}>
          {detailQuery.isError ? (
            <Empty
              title={t("agentDetail.loadAgentFailed")}
              hint={detailQuery.error?.message ?? t("agentDetail.apiUnreachable")}
            />
          ) : detailQuery.isLoading && !agent ? (
            <Empty title={t("agentDetail.loadingAgent")} hint={selectedKebab} />
          ) : (
            <AgentDetail
              agent={agent}
              enabled={detailQuery.data?.enabled ?? null}
              agentKind={detailQuery.data?.kind ?? null}
              stats={stats.get(selectedKebab) ?? stats.get(agent?.name ?? "")}
              statsReady={agentsQuery.data !== undefined && !agentsQuery.isError}
              runSampleReady={runsQuery.data !== undefined && !runsQuery.isError}
              tenant={tenant}
              onOpenWorkflow={() => router.push(`/portal/${tenant}/workflows` as never)}
              onOpenRun={openRun}
              allRuns={runs}
            />
          )}
        </div>
      </div>

      {importOpen && <ImportManifestModal onClose={() => setImportOpen(false)} mode="agent" />}
    </div>
  );
}

function AgentsListCompact({
  agents,
  stats,
  statsReady,
  selectedKebab,
  onPick,
}: {
  agents: AgentListRow[];
  stats: Map<string, AgentStatsSnapshot>;
  statsReady: boolean;
  selectedKebab: string;
  onPick: (kebabId: string) => void;
}) {
  return (
    <div>
      {agents.map((a) => {
        const s = stats.get(a.kebabId) ?? stats.get(a.name);
        const active = a.kebabId === selectedKebab;
        return (
          <button
            key={a.id}
            onClick={() => onPick(a.kebabId)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
              background: active ? "var(--panel-2)" : "transparent",
              borderLeft: active ? "2px solid var(--signal)" : "2px solid transparent",
              transition: "background 0.1s",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
              <ActorTag actor={a.actor} />
              <span className="mono" style={{ fontSize: 10.5, color: "var(--text-3)" }}>{a.kebabId}</span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 10.5,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                }}
              >
                {statsReady ? (
                  <>{s?.runs ?? 0}r{(s?.errors ?? 0) > 0 && <span style={{ color: "var(--red)" }}> · {s?.errors ?? 0}e</span>}</>
                ) : "—"}
              </span>
            </div>
            <div style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500 }}>
              {a.title ?? a.name}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function AgentDetail({
  agent,
  enabled,
  agentKind,
  stats,
  statsReady,
  runSampleReady,
  tenant,
  onOpenWorkflow,
  onOpenRun,
  allRuns,
}: {
  agent: ViewAgent | null;
  enabled: boolean | null;
  agentKind: "code" | "manifest" | null;
  stats: AgentStatsSnapshot | undefined;
  statsReady: boolean;
  runSampleReady: boolean;
  tenant: string;
  onOpenWorkflow: () => void;
  onOpenRun: (id: string) => void;
  allRuns: RunListRow[];
}) {
  const { t } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const invoke = useInvokeAgent();
  const setEnabled = useSetAgentEnabled();
  const rename = useRenameAgent();
  const del = useDeleteAgent();
  const [tab, setTab] = useState<"config" | "io" | "code" | "versions" | "runs">("config");
  // "Run with input…" dialog. Decoupled from the default "Test run" path
  // so the operator can drop a real payload (resume + jd, candidate id,
  // etc.) without having to author it into the manifest's input_data
  // declaration.
  const [runInputOpen, setRunInputOpen] = useState(false);
  // 2-second cooldown after Test run settles. Prevents a rapid double-click
  // (or stuck enter-key) from creating duplicate runs — earlier we saw
  // ~7 TEST-* events fire from accidental repeats. `invoke.isPending`
  // covers the in-flight window; this covers the brief gap between
  // mutation success and a possible second click.
  const [testCooldown, setTestCooldown] = useState(false);

  if (!agent) return <Empty title={t("agentDetail.notFound")} />;

  // Runs are keyed by name in the live api payload.
  const recentRuns = allRuns
    .filter((r) => r.agentName === agent.name)
    .slice(0, 10);
  const testRuns = recentRuns.filter((r) => r.testRun);
  const lastTest = testRuns[0];
  const lastTestAt = lastTest?.startedAt ? Date.parse(lastTest.startedAt) : 0;

  async function handleTestRun() {
    if (invoke.isPending || testCooldown) return;
    try {
      const data = await invoke.mutateAsync({
        name: agent!.name,
        testRun: true,
        input: agent!.input_data ?? undefined,
      });
      const id = data.runId ?? data.run_id;
      if (!id) {
        throw new Error(t("agentDetail.invokeMissingRun"));
      }
      onOpenRun(id);
    } catch (err) {
      toast({
        tone: "red",
        title: t("agentDetail.testRunFailed"),
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setTestCooldown(true);
      setTimeout(() => setTestCooldown(false), 2000);
    }
  }

  return (
    <div
      style={{
        padding: 24,
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <header style={{ marginBottom: 16, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <ActorTag actor={agent.actor} />
          <Badge tone="muted">{agent.id}</Badge>
          <span className="mono" style={{ fontSize: 11.5, color: "var(--text-3)" }}>{agent.name}</span>
          {enabled === false && <Badge tone="amber">{t("agentDetail.disabledBadge")}</Badge>}
          {enabled == null && <Badge tone="amber">{t("agentDetail.stateUnavailable")}</Badge>}
          {agent.sourceUnavailable ? (
            <Badge tone="red">{t("agentDetail.sourceUnavailableBadge")}</Badge>
          ) : agent.workflowVersion ? (
            <Badge tone="signal">
              {t("agentDetail.deployedVersion", { version: agent.workflowVersion })}
            </Badge>
          ) : null}
          {lastTest && (
            <button
              onClick={() => onOpenRun(lastTest.id)}
              title={t("agentDetail.latestTestRun", { id: lastTest.id })}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 7px",
                fontSize: 10.5,
                fontFamily: "var(--mono)",
                color: "var(--accent-text)",
                background: "color-mix(in srgb, var(--signal) 6%, transparent)",
                border: "1px solid color-mix(in srgb, var(--signal) 32%, transparent)",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              <StatusDot status={(lastTest.status as never) ?? "idle"} size={6} />
              {t("agentDetail.testBadge")} · {Number.isFinite(lastTestAt) && lastTestAt > 0 ? fmtAgo(lastTestAt) : "—"}
            </button>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button small icon="external" tone="ghost" onClick={onOpenWorkflow}>
              {t("agentDetail.viewInGraph")}
            </Button>
            <Button
              small
              tone={enabled === false ? "primary" : "ghost"}
              icon={enabled === false ? "play" : "pause"}
              disabled={
                setEnabled.isPending || enabled == null || agent.sourceUnavailable
              }
              onClick={() =>
                setEnabled.mutate(
                  { kebabId: agent.id, enabled: !enabled },
                  {
                    onError: (error) =>
                      toast({
                        tone: "red",
                        title: t("agentDetail.stateUpdateFailed"),
                        description: error.message,
                      }),
                  },
                )
              }
              title={
                agent.sourceUnavailable
                  ? t("agentDetail.sourceUnavailableHint")
                  : enabled == null
                  ? t("agentDetail.stateUnavailable")
                  : enabled
                    ? t("agentDetail.disableHint")
                    : t("agentDetail.enableHint")
              }
            >
              {setEnabled.isPending
                ? t("agentDetail.savingState")
                : agent.sourceUnavailable
                  ? t("agentDetail.sourceUnavailableBadge")
                  : enabled == null
                  ? t("agentDetail.stateUnavailable")
                  : enabled
                    ? t("agentDetail.disable")
                    : t("agentDetail.enable")}
            </Button>
            <Button
              small
              disabled={rename.isPending}
              onClick={() => {
                const next = window.prompt(t("agentDetail.renamePrompt"), agent.title);
                if (next && next.trim() && next.trim() !== agent.title) {
                  rename.mutate(
                    { kebabId: agent.id, title: next.trim() },
                    {
                      onError: (error) =>
                        toast({
                          tone: "red",
                          title: t("agentDetail.renameFailed"),
                          description: error.message,
                        }),
                    },
                  );
                }
              }}
              title={t("agentDetail.renameHint")}
            >
              {t("agentDetail.rename")}
            </Button>
            <Button
              small
              icon="trash"
              tone="danger"
              disabled={del.isPending}
              onClick={() => {
                if (!window.confirm(t("agentDetail.deleteConfirm", { title: agent.title }))) return;
                del.mutate(
                  { kebabId: agent.id },
                  {
                    onSuccess: (result) => {
                      if (result.deleted) {
                        router.push(`/portal/${tenant}/agents` as never);
                        return;
                      }
                      toast({
                        tone: "amber",
                        title: t("agentDetail.takenOffline"),
                        description: result.note ?? t("agentDetail.takenOfflineHint"),
                      });
                    },
                    onError: (error) =>
                      toast({
                        tone: "red",
                        title: t("agentDetail.deleteFailed"),
                        description: error.message,
                      }),
                  },
                );
              }}
              title={t("agentDetail.deleteHint")}
            >
              {del.isPending ? "…" : t("agentDetail.delete")}
            </Button>
            <Button
              small
              onClick={() => setRunInputOpen(true)}
              disabled={agent.sourceUnavailable}
              title={t("agentDetail.runWithInputHint")}
            >
              {t("agentDetail.runWithInput")}
            </Button>
            {agentKind === "code" ? (
                <Button
                  small
                  icon="run"
                  tone="primary"
                  onClick={handleTestRun}
                  disabled={invoke.isPending || testCooldown || agent.sourceUnavailable}
                  title={
                    agent.sourceUnavailable
                      ? t("agentDetail.sourceUnavailableHint")
                      : invoke.isPending
                      ? t("agentDetail.running")
                      : testCooldown
                        ? t("agentDetail.cooldownHint")
                        : t("agentDetail.testRunHint")
                  }
                >
                  {invoke.isPending ? t("agentDetail.running") : t("agentDetail.testRun")}
                </Button>
            ) : null}
          </div>
        </div>
        <h2
          style={{
            margin: "4px 0 6px 0",
            fontSize: 26,
            fontFamily: "var(--display)",
            fontWeight: 400,
          }}
        >
          {agent.title}
        </h2>
        <p
          style={{
            margin: 0,
            fontSize: 13,
            color: "var(--text-2)",
            maxWidth: 720,
            lineHeight: 1.55,
          }}
        >
          {agent.description ?? t("agentDetail.noDescription")}
        </p>
      </header>

      {agent.sourceUnavailable && (
        <div
          role="alert"
          style={{
            marginBottom: 16,
            padding: "10px 12px",
            border: "1px solid color-mix(in srgb, var(--red) 45%, var(--border))",
            borderRadius: 6,
            color: "var(--red)",
            background: "color-mix(in srgb, var(--red) 7%, transparent)",
            fontSize: 12,
          }}
        >
          {t("agentDetail.sourceUnavailableHint")}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 0,
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--panel)",
          marginBottom: 16,
          flexShrink: 0,
        }}
      >
        <StatCellA label={t("agentDetail.statRuns24h")} value={statsReady ? (stats?.runs ?? 0) : "—"} />
        <StatCellA
          label={t("agentDetail.statErrors")}
          value={statsReady ? (stats?.errors ?? 0) : "—"}
          accent={statsReady && (stats?.errors ?? 0) > 0 ? "var(--red)" : undefined}
        />
        <StatCellA
          label={t("agentDetail.statP50Latency")}
          value={(() => {
            // Compute P50 from real durationMs across this agent's runs
            // — replaces the hardcoded "2.4s" mock so every agent shows
            // its actual median duration (or "—" when no completed runs).
            if (!runSampleReady) return "—";
            const durations = recentRuns
              .map((r) => r.durationMs ?? 0)
              .filter((d) => d > 0)
              .sort((a, b) => a - b);
            if (durations.length === 0) return "—";
            const p50 = durations[Math.floor(durations.length / 2)] ?? 0;
            return p50 >= 1000
              ? `${(p50 / 1000).toFixed(1)}s`
              : `${Math.round(p50)}ms`;
          })()}
        />
        <StatCellA
          label={t("agentDetail.statLastRun")}
          value={statsReady && stats?.lastRun && stats.lastRun > 0 ? fmtAgo(stats.lastRun) : "—"}
        />
      </div>

      <div
        style={{
          display: "flex",
          gap: 0,
          borderBottom: "1px solid var(--border)",
          marginBottom: 16,
          flexShrink: 0,
        }}
      >
        {(["config", "io", "code", "versions", "runs"] as const).map((tabId) => (
          <button
            key={tabId}
            onClick={() => setTab(tabId)}
            style={{
              padding: "8px 14px",
              fontSize: 12,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: tab === tabId ? "var(--text)" : "var(--text-3)",
              borderBottom: `2px solid ${tab === tabId ? "var(--signal)" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {t(`agentDetail.tab_${tabId}`)}
          </button>
        ))}
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: tab === "code" ? "hidden" : "auto",
        }}
      >
        {tab === "config" && <ConfigTab agent={agent} />}
        {tab === "io" && <IOConfigTab agent={agent} />}
        {tab === "code" && <AgentCodeTab agent={agent} />}
        {tab === "versions" && <VersionsTab agent={agent} />}
        {tab === "runs" && <RunsTab runs={recentRuns} onOpenRun={onOpenRun} />}
      </div>
      {runInputOpen && (
        <RunWithInputModal
          agentName={agent.name}
          agentTitle={agent.title ?? agent.name}
          defaultInput={agent.input_data ?? undefined}
          onClose={() => setRunInputOpen(false)}
          onSubmitted={(runId) => {
            // Fire-and-jump — keep the modal open so the operator can copy
            // the runId / run again, but also surface a deep-link to the
            // new run via the router.
            void runId;
          }}
        />
      )}
    </div>
  );
}

function StatCellA({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div style={{ padding: "12px 16px", borderRight: "1px solid var(--border)" }}>
      <div
        style={{
          fontSize: 10,
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
          marginTop: 4,
          fontSize: 18,
          fontFamily: "var(--mono)",
          color: accent ?? "var(--text)",
        }}
      >
        {value}
      </div>
    </div>
  );
}
