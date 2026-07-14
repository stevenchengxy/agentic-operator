"use client";

/**
 * Agent detail view — header + 4-stat strip + 5 tabs (config|io|code|versions|runs).
 *
 * Live data via canonical TanStack hooks:
 *   - useAgents() — list aside (left)
 *   - useAgent(kebabId) — selected agent's manifest detail
 *   - useRuns({ limit: 200 }) — recent runs for stats + RunsTab
 *
 * Manifest fields (description, steps, typescript_code, ontology_instructions,
 * tool_use, model, tools, emits) are NOT yet surfaced by /v1/agents/:kebab —
 * the AgentDetail contract only ships id/name/title/actor/triggers/
 * triggeredEvents/actions/workflowSlug/workflowVersion. The detail tabs render
 * what's available and leave the rest blank rather than substitute mock data
 * (2026-05-26 product rule: production mode = zero mock).
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
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import {
  useAgent,
  useAgents,
  useInvokeAgent,
  type AgentDetail,
  type AgentListRow,
} from "@/lib/hooks/useAgents";
import { useRuns, type RunListRow } from "@/lib/hooks/useRuns";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { AgentCodeTab } from "@/app/portal/components/agent-code/AgentCodeTab";
import { AgentCodeEdit } from "@/app/portal/components/agent-code/edit-code";
import {
  ConfigTab,
  EditConfigTab,
  IOConfigTab,
  RunsTab,
  VersionsTab,
  type ViewAgent as AgentTabsViewAgent,
} from "@/app/portal/components/agents/AgentTabs";
import { DeployAgentModal } from "@/app/portal/components/agents/DeployAgentModal";
import { RunWithInputModal } from "@/app/portal/components/agents/RunWithInputModal";
import { PublishEventModal } from "@/app/portal/components/events/PublishEventModal";
import { ImportManifestModal } from "@/app/portal/components/import-manifest/ImportManifestModal";

interface AgentStats {
  runs: number;
  errors: number;
  lastRun: number;
  tests: number;
  lastTestRunId: string | null;
  lastTestAt: number;
}

function emptyStats(): AgentStats {
  return {
    runs: 0,
    errors: 0,
    lastRun: 0,
    tests: 0,
    lastTestRunId: null,
    lastTestAt: 0,
  };
}

/**
 * AgentTabs was written against the SpaAgent shape — a denormalized object
 * with every manifest field (description, steps, tool_use, ...). The live
 * `/v1/agents/:kebab` (AgentDetail) is leaner: id/name/title/actor/
 * triggers/triggeredEvents/actions/workflowSlug/workflowVersion. This
 * adapter materializes a `ViewAgent` (the shape AgentTabs now expects) so
 * the read-only and edit tabs keep rendering; fields the api doesn't yet
 * surface come back empty rather than a synthetic placeholder.
 */
type ViewAgent = AgentTabsViewAgent;

function detailToViewAgent(
  detail: AgentDetail,
  list?: AgentListRow,
): ViewAgent {
  return {
    id: detail.kebabId,
    name: detail.name,
    title: detail.title ?? detail.name,
    description: list?.description ?? "",
    actor: detail.actor,
    stage: 0,
    triggers: detail.triggers,
    emits: detail.triggeredEvents,
    steps: detail.actions.map((a) => a.name),
    tools: [],
    model: "",
    input_data: {},
    ontology_instructions: "",
    tool_use: [],
    typescript_code: "",
  };
}

export default function AgentDetailPage() {
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
  const [actorFilter, setActorFilter] = useState<"all" | "Agent" | "Human">(
    "all",
  );
  const [listW, setListW] = useState(440);
  const [deployOpen, setDeployOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const stats = useMemo(() => {
    // Bucket by name (the canonical join key the api uses on run rows) so
    // the per-agent stats correctly aggregate the live `/v1/runs` payload.
    const m = new Map<string, AgentStats>();
    agents.forEach((a) => {
      const s = emptyStats();
      m.set(a.kebabId, s);
      if (a.name) m.set(a.name, s);
    });
    runs.forEach((r) => {
      const s = m.get(r.agentName ?? "");
      if (!s) return;
      const startedAt = r.startedAt ? Date.parse(r.startedAt) : 0;
      s.runs += 1;
      if (r.status === "failed") s.errors += 1;
      if (startedAt > s.lastRun) s.lastRun = startedAt;
      if (r.testRun) {
        s.tests += 1;
        if (startedAt > s.lastTestAt) {
          s.lastTestAt = startedAt;
          s.lastTestRunId = r.id;
        }
      }
    });
    return m;
  }, [agents, runs]);

  const filtered = agents.filter((a) => {
    if (actorFilter !== "all" && a.actor !== actorFilter) return false;
    if (
      query &&
      !a.title.toLowerCase().includes(query.toLowerCase()) &&
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

  const listMatch = agents.find((a) => a.kebabId === selectedKebab);
  const agent = detailQuery.data
    ? detailToViewAgent(detailQuery.data, listMatch)
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Agents"
        subtitle={`${agents.length} agents in this workflow · ${agents.filter((a) => a.actor === "Agent").length} automated · ${agents.filter((a) => a.actor === "Human").length} human`}
        action={[
          <Button
            key="upload"
            icon="upload"
            small
            onClick={() => setImportOpen(true)}
          >
            Import manifest
          </Button>,
          <Button
            key="new"
            icon="plus"
            tone="primary"
            small
            onClick={() => setDeployOpen(true)}
          >
            Deploy agent
          </Button>,
        ]}
      />

      <div
        style={{ flex: 1, display: "flex", flexDirection: "row", minHeight: 0 }}
      >
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
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 8,
            }}
          >
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="agent name…"
            />
          </div>
          <div
            style={{
              padding: "8px 16px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              gap: 6,
            }}
          >
            <FilterChip
              active={actorFilter === "all"}
              onClick={() => setActorFilter("all")}
            >
              All
            </FilterChip>
            <FilterChip
              active={actorFilter === "Agent"}
              onClick={() => setActorFilter("Agent")}
            >
              Agents
            </FilterChip>
            <FilterChip
              active={actorFilter === "Human"}
              onClick={() => setActorFilter("Human")}
            >
              Human
            </FilterChip>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {agentsQuery.isError ? (
              <Empty
                title="Failed to load agents"
                hint={agentsQuery.error?.message ?? "api unreachable on :3501"}
              />
            ) : agentsQuery.isLoading && agents.length === 0 ? (
              <Empty title="Loading agents…" hint="" />
            ) : (
              <AgentsListCompact
                agents={filtered}
                stats={stats}
                selectedKebab={selectedKebab}
                onPick={openAgent}
              />
            )}
          </div>
        </aside>

        <Splitter
          axis="x"
          getValue={() => listW}
          setValue={setListW}
          min={260}
          max={720}
        />

        <div style={{ flex: 1, minWidth: 0, overflow: "auto", minHeight: 0 }}>
          {detailQuery.isError ? (
            <Empty
              title="Failed to load agent"
              hint={detailQuery.error?.message ?? "api unreachable on :3501"}
            />
          ) : detailQuery.isLoading && !agent ? (
            <Empty title="Loading agent…" hint={selectedKebab} />
          ) : (
            <AgentDetail
              agent={agent}
              stats={stats.get(selectedKebab) ?? stats.get(agent?.name ?? "")}
              tenant={tenant}
              agentKind={listMatch?.kind}
              agentEnabled={listMatch?.enabled ?? false}
              onOpenWorkflow={() =>
                router.push(`/portal/${tenant}/workflows` as never)
              }
              onOpenRun={openRun}
              allRuns={runs}
            />
          )}
        </div>
      </div>

      {deployOpen && <DeployAgentModal onClose={() => setDeployOpen(false)} />}
      {importOpen && (
        <ImportManifestModal
          onClose={() => setImportOpen(false)}
          mode="agent"
        />
      )}
    </div>
  );
}

function AgentsListCompact({
  agents,
  stats,
  selectedKebab,
  onPick,
}: {
  agents: AgentListRow[];
  stats: Map<string, AgentStats>;
  selectedKebab: string;
  onPick: (kebabId: string) => void;
}) {
  return (
    <div>
      {agents.map((a) => {
        const s = stats.get(a.kebabId) ?? stats.get(a.name) ?? emptyStats();
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
              borderLeft: active
                ? "2px solid var(--signal)"
                : "2px solid transparent",
              transition: "background 0.1s",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 3,
              }}
            >
              <ActorTag actor={a.actor} />
              <span
                className="mono"
                style={{ fontSize: 10.5, color: "var(--text-3)" }}
              >
                {a.kebabId}
              </span>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 10.5,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                }}
              >
                {s.runs}r
                {s.errors > 0 && (
                  <span style={{ color: "var(--red)" }}> · {s.errors}e</span>
                )}
              </span>
            </div>
            <div
              style={{ fontSize: 12.5, color: "var(--text)", fontWeight: 500 }}
            >
              {a.title}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function AgentDetail({
  agent,
  stats,
  tenant,
  agentKind,
  agentEnabled,
  onOpenWorkflow,
  onOpenRun,
  allRuns,
}: {
  agent: ViewAgent | null;
  stats: AgentStats | undefined;
  tenant: string;
  agentKind: "code" | "manifest" | undefined;
  agentEnabled: boolean;
  onOpenWorkflow: () => void;
  onOpenRun: (id: string) => void;
  allRuns: RunListRow[];
}) {
  const invoke = useInvokeAgent();
  const [tab, setTab] = useState<
    "config" | "io" | "code" | "versions" | "runs"
  >("config");
  const [editing, setEditing] = useState(false);
  // "Run with input…" dialog. Decoupled from the default "Test run" path
  // so the operator can drop a real payload (resume + jd, candidate id,
  // etc.) without having to author it into the manifest's input_data
  // declaration.
  const [runInputOpen, setRunInputOpen] = useState(false);
  const [sendEventOpen, setSendEventOpen] = useState(false);
  // 2-second cooldown after Test run settles. Prevents a rapid double-click
  // (or stuck enter-key) from creating duplicate runs — earlier we saw
  // ~7 TEST-* events fire from accidental repeats. `invoke.isPending`
  // covers the in-flight window; this covers the brief gap between
  // mutation success and a possible second click.
  const [testCooldown, setTestCooldown] = useState(false);
  if (!agent) return <Empty title="Agent not found" />;

  const canSendEvent =
    agentKind === "manifest" && agentEnabled && agent.triggers.length > 0;
  const sendEventTitle = !agentEnabled
    ? "This agent is disabled. Enable it before publishing a trigger event."
    : agentKind !== "manifest"
      ? "Code-defined agents run through direct invoke; event dispatch is available for manifest agents."
      : agent.triggers.length === 0
        ? "This agent has no declared trigger events."
        : `Publish one of ${agent.title}'s trigger events and follow the resulting run.`;

  // Runs are keyed by name in the live api payload.
  const recentRuns = allRuns
    .filter((r) => r.agentName === agent.name)
    .slice(0, 10);
  const testRuns = recentRuns.filter((r) => r.testRun);
  const lastTest = testRuns[0];

  async function handleTestRun() {
    if (invoke.isPending || testCooldown) return;
    try {
      const data = await invoke.mutateAsync({
        name: agent!.name,
        testRun: true,
        input: agent!.input_data ?? {},
      });
      const id = data.runId ?? data.run_id;
      if (id) onOpenRun(id);
    } catch (err) {
      // Toast wiring lands later — log to console for now.
      console.error("Test run failed", err);
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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 6,
          }}
        >
          <ActorTag actor={agent.actor} />
          <Badge tone="muted">{agent.id}</Badge>
          <span
            className="mono"
            style={{ fontSize: 11.5, color: "var(--text-3)" }}
          >
            {agent.name}
          </span>
          {lastTest && (
            <button
              onClick={() => onOpenRun(lastTest.id)}
              title={`Latest test run · ${lastTest.id}`}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                padding: "2px 7px",
                fontSize: 10.5,
                fontFamily: "var(--mono)",
                color: "var(--signal)",
                background: "rgba(208,255,0,0.06)",
                border: "1px solid rgba(208,255,0,0.32)",
                borderRadius: 3,
                cursor: "pointer",
              }}
            >
              <StatusDot
                status={(lastTest.status as never) ?? "idle"}
                size={6}
              />
              TEST ·{" "}
              {fmtAgo(lastTest.startedAt ? Date.parse(lastTest.startedAt) : 0)}
            </button>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 6 }}>
            <Button small icon="external" tone="ghost" onClick={onOpenWorkflow}>
              View in graph
            </Button>
            {editing ? (
              <>
                <Button small tone="ghost" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  small
                  icon="check"
                  tone="primary"
                  onClick={() => setEditing(false)}
                >
                  Save & deploy
                </Button>
              </>
            ) : (
              <>
                <Button small icon="code" onClick={() => setEditing(true)}>
                  Edit
                </Button>
                <Button
                  small
                  icon="event"
                  onClick={() => setSendEventOpen(true)}
                  disabled={!canSendEvent}
                  title={sendEventTitle}
                >
                  Send event
                </Button>
                <Button
                  small
                  onClick={() => setRunInputOpen(true)}
                  title="Open a JSON editor and run with a custom body.input — needed for manifest agents whose tool-use loop requires real payload fields (e.g. resume + jd)."
                >
                  Run with input…
                </Button>
                <Button
                  small
                  icon="run"
                  tone="primary"
                  onClick={handleTestRun}
                  disabled={invoke.isPending || testCooldown}
                  title={
                    invoke.isPending
                      ? "Running…"
                      : testCooldown
                        ? "Cooling down (2s) — prevents double-clicks from creating duplicate runs"
                        : "Run the agent with its declared default input"
                  }
                >
                  {invoke.isPending ? "Running…" : "Test run"}
                </Button>
              </>
            )}
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
          {agent.description}
        </p>
      </header>

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
        <StatCellA label="Runs 24h" value={stats?.runs ?? 0} />
        <StatCellA
          label="Errors"
          value={stats?.errors ?? 0}
          accent={(stats?.errors ?? 0) > 0 ? "var(--red)" : undefined}
        />
        <StatCellA
          label="P50 latency"
          value={(() => {
            // Compute P50 from real durationMs across this agent's runs
            // — replaces the hardcoded "2.4s" mock so every agent shows
            // its actual median duration (or "—" when no completed runs).
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
          label="Last run"
          value={
            stats?.lastRun && stats.lastRun > 0 ? fmtAgo(stats.lastRun) : "—"
          }
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
        {(["config", "io", "code", "versions", "runs"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              padding: "8px 14px",
              fontSize: 12,
              fontFamily: "var(--mono)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              color: tab === t ? "var(--text)" : "var(--text-3)",
              borderBottom: `2px solid ${tab === t ? "var(--signal)" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {t}
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
        {tab === "config" &&
          (editing ? (
            <EditConfigTab agent={agent} models={[]} />
          ) : (
            <ConfigTab agent={agent} />
          ))}
        {tab === "io" && <IOConfigTab agent={agent} />}
        {tab === "code" &&
          (editing ? (
            <AgentCodeEdit
              agent={{
                actor: agent.actor,
                name: agent.name,
                typescript_code: agent.typescript_code,
                input_data: agent.input_data,
                ontology_instructions: agent.ontology_instructions,
              }}
              onClose={() => setEditing(false)}
            />
          ) : (
            <AgentCodeTab agent={agent} />
          ))}
        {tab === "versions" && <VersionsTab agent={agent} />}
        {tab === "runs" && <RunsTab runs={recentRuns} onOpenRun={onOpenRun} />}
      </div>
      {runInputOpen && (
        <RunWithInputModal
          agentName={agent.name}
          agentTitle={agent.title ?? agent.name}
          defaultInput={agent.input_data}
          onClose={() => setRunInputOpen(false)}
          onSubmitted={(runId) => {
            // Fire-and-jump — keep the modal open so the operator can copy
            // the runId / run again, but also surface a deep-link to the
            // new run via the router.
            void runId;
          }}
        />
      )}
      {sendEventOpen && (
        <PublishEventModal
          initialName={agent.triggers[0]}
          allowedNames={agent.triggers}
          targetAgent={{ name: agent.name, title: agent.title ?? agent.name }}
          onClose={() => setSendEventOpen(false)}
          onOpenRun={(runId) => {
            setSendEventOpen(false);
            onOpenRun(runId);
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
    <div
      style={{ padding: "12px 16px", borderRight: "1px solid var(--border)" }}
    >
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
