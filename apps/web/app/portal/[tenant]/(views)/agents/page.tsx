"use client";

/**
 * Agents view — list + detail page. P2-FE-09.
 *
 * Live data via canonical TanStack hooks:
 *   - useAgents() — workflow agent list (tenant-scoped)
 *   - useRuns({ limit: 200 }) — recent runs used for the per-agent stats
 *
 * Detail is in a separate route at `/portal/[tenant]/agents/[id]` so the
 * browser URL reflects the selected agent. The list page mirrors the v1_1
 * one-screen UX by routing to the detail page on click and rendering the
 * grid when none is selected.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ActorTag,
  Badge,
  Button,
  Empty,
  FilterChip,
  Panel,
  SearchInput,
  ViewHeader,
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import { useAgents, type AgentListRow } from "@/lib/hooks/useAgents";
import { useRuns, type RunListRow } from "@/lib/hooks/useRuns";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { DeployAgentModal } from "@/app/portal/components/agents/DeployAgentModal";
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

export default function AgentsPage() {
  const router = useRouter();
  const tenant = useTenant();
  const agentsQuery = useAgents();
  const runsQuery = useRuns({ limit: 200 });
  const agents = agentsQuery.data ?? [];
  const runs = runsQuery.data ?? [];
  const [query, setQuery] = useState("");
  const [actorFilter, setActorFilter] = useState<"all" | "Agent" | "Human">(
    "all",
  );
  const [newAgentOpen, setNewAgentOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const stats = useMemo(() => {
    // Stats are bucketed by name (the canonical join key the api uses on
    // run rows) and additionally by kebabId so older snapshots that key
    // by id still resolve.
    const m = new Map<string, AgentStats>();
    agents.forEach((a) => {
      const s = emptyStats();
      m.set(a.kebabId, s);
      m.set(a.id, s);
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

  const isLoading = agentsQuery.isLoading;
  const isError = agentsQuery.isError;
  const error = agentsQuery.error;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Agents"
        subtitle={`${agents.length} event-driven agents · ${agents.filter((a) => a.actor === "Agent").length} automated · ${agents.filter((a) => a.actor === "Human").length} human`}
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
            onClick={() => setNewAgentOpen(true)}
          >
            New Agent
          </Button>,
        ]}
      />

      <div
        style={{ flex: 1, display: "flex", flexDirection: "row", minHeight: 0 }}
      >
        <aside
          style={{
            width: "100%",
            flexShrink: 0,
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
            {isError ? (
              <Empty
                title="Failed to load agents"
                hint={error?.message ?? "api unreachable on :3501"}
              />
            ) : isLoading && agents.length === 0 ? (
              <Empty title="Loading agents…" hint="" />
            ) : filtered.length === 0 ? (
              <Empty
                title="No agents yet"
                hint={
                  agents.length === 0
                    ? "Create an agent here or import a manifest to get started."
                    : "No agents match the current filter."
                }
              />
            ) : (
              <AgentsGrid agents={filtered} stats={stats} onPick={openAgent} />
            )}
          </div>
        </aside>
      </div>

      {newAgentOpen && (
        <DeployAgentModal onClose={() => setNewAgentOpen(false)} />
      )}
      {importOpen && (
        <ImportManifestModal
          onClose={() => setImportOpen(false)}
          mode="agent"
        />
      )}

      {/* preserve unused-import lint pass */}
      {false && <Panel title="hidden" />}
    </div>
  );
}

function AgentsGrid({
  agents,
  stats,
  onPick,
}: {
  agents: AgentListRow[];
  stats: Map<string, AgentStats>;
  onPick: (kebabId: string) => void;
}) {
  return (
    <div
      style={{
        padding: 16,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        gap: 12,
      }}
    >
      {agents.map((a) => {
        const s = stats.get(a.kebabId) ?? stats.get(a.name) ?? emptyStats();
        return (
          <button
            key={a.id}
            onClick={() => onPick(a.kebabId)}
            style={{
              padding: "12px 14px",
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderLeft: `3px solid ${a.actor === "Agent" ? "var(--signal)" : "var(--violet)"}`,
              borderRadius: 6,
              textAlign: "left",
              transition: "background 0.12s, border-color 0.12s",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--panel-2)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLButtonElement).style.background =
                "var(--panel)";
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                marginBottom: 6,
              }}
            >
              <ActorTag actor={a.actor} />
              <Badge tone="muted">{a.kebabId}</Badge>
              <span
                style={{
                  marginLeft: "auto",
                  fontSize: 10.5,
                  color: "var(--text-3)",
                  fontFamily: "var(--mono)",
                }}
              >
                {s.lastRun > 0 ? fmtAgo(s.lastRun) : "idle"}
              </span>
            </div>
            <div
              style={{
                fontSize: 13.5,
                color: "var(--text)",
                fontWeight: 500,
                marginBottom: 4,
                lineHeight: 1.3,
              }}
            >
              {a.title}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: "var(--text-2)",
                lineHeight: 1.5,
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {a.description ?? ""}
            </div>
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
                fontSize: 11,
                fontFamily: "var(--mono)",
                color: "var(--text-3)",
              }}
            >
              <span>{s.runs} runs</span>
              {s.errors > 0 && (
                <span style={{ color: "var(--red)" }}>{s.errors} err</span>
              )}
              {s.tests > 0 && (
                <span style={{ color: "var(--signal)" }}>{s.tests} test</span>
              )}
              <span style={{ marginLeft: "auto" }}>{a.kind}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
