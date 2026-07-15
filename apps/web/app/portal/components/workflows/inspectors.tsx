"use client";

import type { ReactNode } from "react";
import {
  ActorTag,
  Badge,
  Button,
  Icon,
  eventTone,
} from "@/app/portal/components";
import { fmtAgo } from "@/lib/format";
import { useDag, useAgent, type DagAgent } from "@/lib/hooks/useAgents";
import { useEvents, type EventRow } from "@/lib/hooks/useEvents";

/**
 * Catalog row built from the live `/v1/events` stream so the inspectors can
 * surface color + category metadata without the bootstrap snapshot.
 */
export interface EventCatalogItem {
  name: string;
  color: string;
  category: string;
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div
      style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}
    >
      <div
        style={{
          fontSize: 10.5,
          fontFamily: "var(--mono)",
          textTransform: "uppercase",
          color: "var(--text-3)",
          letterSpacing: "0.08em",
          marginBottom: 8,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function LegendRow({
  color,
  label,
  sub,
}: {
  color: string;
  label: string;
  sub: string;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div
        style={{ width: 10, height: 10, background: color, borderRadius: 2 }}
      />
      <span style={{ color: "var(--text)" }}>{label}</span>
      <span
        style={{
          marginLeft: "auto",
          color: "var(--text-3)",
          fontSize: 11,
          fontFamily: "var(--mono)",
        }}
      >
        {sub}
      </span>
    </div>
  );
}

export function DefaultInspector({
  events,
  agents,
  onPick,
}: {
  events: EventCatalogItem[];
  agents: DagAgent[];
  onPick: (name: string) => void;
}) {
  const grouped: Record<string, EventCatalogItem[]> = {
    agent: [],
    human: [],
    data: [],
    external: [],
    alert: [],
    system: [],
  };
  events.forEach((e) => {
    const bucket = grouped[e.category];
    if (bucket) bucket.push(e);
  });
  const labels: Record<string, string> = {
    agent: "From agents",
    human: "From humans",
    data: "Data",
    external: "External",
    alert: "Alerts",
    system: "System",
  };

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
          }}
        >
          Legend
        </div>
        <div
          style={{
            marginTop: 8,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            fontSize: 12,
          }}
        >
          <LegendRow
            color="var(--signal)"
            label="Agent node"
            sub={`${agents.filter((a) => a.actor === "Agent").length} in workflow`}
          />
          <LegendRow
            color="var(--violet)"
            label="Human node"
            sub={`${agents.filter((a) => a.actor === "Human").length} in workflow`}
          />
        </div>
      </div>
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          Events · click to trace
        </div>
        {Object.entries(grouped).map(([cat, items]) =>
          items.length > 0 ? (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 10.5,
                  fontFamily: "var(--mono)",
                  color: "var(--text-3)",
                  marginBottom: 5,
                }}
              >
                {labels[cat]}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {items.map((e) => (
                  <button
                    key={e.name}
                    onClick={() => onPick(e.name)}
                    style={{ display: "inline-block" }}
                  >
                    <Badge
                      tone={eventTone(e.color)}
                      style={{ fontSize: 9.5, cursor: "pointer" }}
                    >
                      {e.name}
                    </Badge>
                  </button>
                ))}
              </div>
            </div>
          ) : null,
        )}
      </div>
      <div
        style={{
          padding: "14px 16px",
          fontSize: 11.5,
          color: "var(--text-3)",
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: "var(--text-2)", fontWeight: 500 }}>Tip</strong>
        <span>
          {" "}
          · Click any node to see what triggers and emits from it. Click any
          event to highlight every edge carrying it.
        </span>
      </div>
    </div>
  );
}

export function AgentInspector({
  agent,
  onClose,
  onOpenFull,
}: {
  agent: DagAgent | null | undefined;
  onClose: () => void;
  onOpenFull: () => void;
}) {
  // Fetch the rich AgentDetail (actions, workflowSlug, workflowVersion,
  // recentRuns) when an agent is selected. Falls back gracefully when the
  // detail call is still loading — the inspector renders triggers/emits
  // from the canvas-side DagAgent immediately.
  const detailQuery = useAgent(agent?.kebabId ?? null);
  const detail = detailQuery.data;
  if (!agent) return null;

  // Prefer the live AgentDetail fields when available so we always show
  // the canonical manifest values; fall back to the DAG snapshot otherwise.
  const triggers = detail?.triggers ?? agent.triggers;
  const emits = detail?.triggeredEvents ?? agent.emits;
  const actionNames = (detail?.actions ?? []).map((a) => a.name);

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 6 }}>
            <ActorTag actor={agent.actor} />
            <Badge tone="muted">{agent.kebabId}</Badge>
          </div>
          <div
            style={{
              fontSize: 15,
              color: "var(--text)",
              fontWeight: 500,
              lineHeight: 1.3,
            }}
          >
            {agent.title}
          </div>
        </div>
        <Button small icon="x" tone="ghost" onClick={onClose} />
      </header>
      {actionNames.length > 0 && (
        <Section title="Steps">
          <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {actionNames.map((s, i) => (
              <li
                key={`${s}-${i}`}
                style={{
                  display: "flex",
                  gap: 8,
                  padding: "4px 0",
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    color: "var(--text-3)",
                    fontFamily: "var(--mono)",
                    width: 18,
                  }}
                >
                  {i + 1}.
                </span>
                <span className="mono" style={{ color: "var(--text)" }}>
                  {s}
                </span>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section title="Triggers">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {triggers.length > 0 ? (
            triggers.map((t) => (
              <Badge key={t} tone="blue">
                {t}
              </Badge>
            ))
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>
              None (manual)
            </span>
          )}
        </div>
      </Section>
      <Section title="Emits">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {emits.map((e) => (
            <Badge key={e} tone="green">
              {e}
            </Badge>
          ))}
        </div>
      </Section>
      {detail?.workflowSlug && (
        <Section title="Workflow">
          <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>
            {detail.workflowSlug}
            {detail.workflowVersion ? ` · ${detail.workflowVersion}` : ""}
          </span>
        </Section>
      )}
      <div
        style={{
          padding: 14,
          marginTop: "auto",
          display: "flex",
          gap: 8,
          borderTop: "1px solid var(--border)",
        }}
      >
        <Button icon="external" onClick={onOpenFull} style={{ flex: 1 }}>
          Open agent
        </Button>
        <Button icon="run" tone="primary">
          Test run
        </Button>
      </div>
    </div>
  );
}

export function EventInspector({
  eventName,
  onClose,
  onNavigateAgent,
  onNavigateEvents,
}: {
  eventName: string;
  onClose: () => void;
  onNavigateAgent: (id: string) => void;
  onNavigateEvents: (eventName: string) => void;
}) {
  // Live event-name filter — bounded to 8 so the "recent" panel only shows
  // the most useful entries even if the tenant's event history is large.
  const eventsQuery = useEvents({ name: eventName, limit: 8 });
  const catalogQuery = useEvents({ limit: 200 });
  const dagQuery = useDag();

  const agents = dagQuery.data?.agents ?? [];
  const recent = eventsQuery.data ?? [];
  const catalog = catalogQuery.data ?? [];
  const catalogRow = catalog.find((c) => c.name === eventName);

  const emitters = agents.filter((a) => a.emits.includes(eventName));
  const listeners = agents.filter((a) => a.triggers.includes(eventName));

  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "flex-start",
          justifyContent: "space-between",
        }}
      >
        <div>
          <Badge
            tone={eventTone(catalogRow?.color ?? "")}
            style={{ marginBottom: 8 }}
          >
            {eventName}
          </Badge>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>
            category · {catalogRow?.category ?? "—"}
          </div>
        </div>
        <Button small icon="x" tone="ghost" onClick={onClose} />
      </header>
      <Section title={`Emitted by · ${emitters.length}`}>
        <NodeList agents={emitters} onPick={onNavigateAgent} />
      </Section>
      <Section title={`Listened by · ${listeners.length}`}>
        <NodeList agents={listeners} onPick={onNavigateAgent} />
      </Section>
      <Section title={`Recent · ${recent.length}`}>
        {recent.map((row: EventRow) => {
          const at = row.receivedAt ? Date.parse(row.receivedAt) : null;
          return (
            <div
              key={row.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                padding: "4px 0",
                fontSize: 11.5,
              }}
            >
              <span className="mono" style={{ color: "var(--text-2)" }}>
                {row.id}
              </span>
              <span style={{ color: "var(--text-3)" }}>
                {at != null && Number.isFinite(at) ? fmtAgo(at) : "—"}
              </span>
            </div>
          );
        })}
      </Section>
      <div
        style={{
          padding: 14,
          marginTop: "auto",
          borderTop: "1px solid var(--border)",
        }}
      >
        <Button
          icon="external"
          onClick={() => onNavigateEvents(eventName)}
          style={{ width: "100%" }}
        >
          View in event stream
        </Button>
      </div>
    </div>
  );
}

function NodeList({
  agents,
  onPick,
}: {
  agents: DagAgent[];
  onPick: (id: string) => void;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {agents.map((a) => (
        <button
          key={a.kebabId}
          onClick={() => onPick(a.kebabId)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 8px",
            background: "var(--panel-2)",
            border: "1px solid var(--border)",
            borderRadius: 4,
            textAlign: "left",
            fontSize: 12,
            color: "var(--text)",
          }}
        >
          <ActorTag actor={a.actor} />
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {a.title}
          </span>
        </button>
      ))}
    </div>
  );
}

export function EditDraftBanner({
  counts,
}: {
  counts: { added: number; modified: number; removed: number };
}) {
  return (
    <div
      style={{
        padding: "10px 24px",
        background: "rgba(255,181,71,0.06)",
        borderBottom: "1px solid rgba(255,181,71,0.25)",
        display: "flex",
        alignItems: "center",
        gap: 14,
        flexShrink: 0,
      }}
    >
      <Icon name="alert" size={12} style={{ color: "var(--amber)" }} />
      <div style={{ fontSize: 12, color: "var(--text)" }}>
        <span
          style={{
            color: "var(--amber)",
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            fontSize: 10.5,
          }}
        >
          EDITING DRAFT
        </span>
        <span style={{ marginLeft: 12, color: "var(--text-2)" }}>
          {counts.added} added · {counts.modified} modified · {counts.removed}{" "}
          removed
        </span>
        <span
          style={{
            marginLeft: 12,
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
          }}
        >
          saved in this browser as you edit
        </span>
      </div>
    </div>
  );
}

export function EditToolbar({
  tool,
  setTool,
}: {
  tool: string;
  setTool: (t: string) => void;
}) {
  const tools = [
    { id: "select", icon: "filter" as const, label: "Select" },
    { id: "connect", icon: "git" as const, label: "Connect" },
    { id: "add", icon: "plus" as const, label: "Add" },
  ];
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        left: 12,
        zIndex: "var(--z-overlay)" as unknown as number,
        display: "flex",
        gap: 1,
        background: "var(--panel)",
        border: "1px solid var(--border-2)",
        borderRadius: 6,
        padding: 2,
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
      }}
    >
      {tools.map((t) => (
        <button
          key={t.id}
          onClick={() => setTool(t.id)}
          title={t.label}
          aria-label={t.label}
          aria-pressed={tool === t.id}
          style={{
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: tool === t.id ? "var(--signal)" : "transparent",
            color: tool === t.id ? "#000" : "var(--text-2)",
            borderRadius: 4,
          }}
        >
          <Icon name={t.icon} size={13} />
        </button>
      ))}
      <div
        style={{ width: 1, background: "var(--border)", margin: "4px 4px" }}
      />
      <button
        title="Auto-layout"
        aria-label="Auto-layout"
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-2)",
        }}
      >
        <Icon name="dashboard" size={13} />
      </button>
      <button
        title="Zoom to fit"
        aria-label="Zoom to fit"
        style={{
          width: 32,
          height: 32,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-2)",
        }}
      >
        <Icon name="external" size={13} />
      </button>
    </div>
  );
}

export function DraftPalette() {
  const presets = [
    {
      kind: "Agent",
      title: "New agent node",
      sub: "Code-backed step",
      color: "var(--signal)",
    },
    {
      kind: "Human",
      title: "Human task",
      sub: "Pause for approval",
      color: "var(--violet)",
    },
    {
      kind: "Agent",
      title: "From template…",
      sub: "matchResume, etc.",
      color: "var(--text-3)",
    },
  ];
  return (
    <div
      style={{
        flex: 1,
        overflow: "auto",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 4,
          }}
        >
          Editing
        </div>
        <div style={{ fontSize: 14, color: "var(--text)" }}>
          raas{" "}
          <span
            style={{
              color: "var(--amber)",
              fontFamily: "var(--mono)",
              fontSize: 11,
            }}
          >
            · DRAFT
          </span>
        </div>
      </div>

      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          Drag onto canvas
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {presets.map((p, i) => (
            <div
              key={i}
              draggable
              style={{
                padding: "8px 10px",
                background: "var(--panel-2)",
                border: "1px dashed var(--border-2)",
                borderLeft: `3px solid ${p.color}`,
                borderRadius: 4,
                cursor: "grab",
              }}
            >
              <div style={{ fontSize: 12, color: "var(--text)" }}>
                {p.title}
              </div>
              <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>
                {p.sub}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div
        style={{
          padding: "14px 16px",
          borderBottom: "1px solid var(--border)",
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            color: "var(--text-3)",
            letterSpacing: "0.08em",
            marginBottom: 8,
          }}
        >
          Pending changes
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 4,
            fontSize: 11.5,
          }}
        >
          <DiffRow kind="mod" name="matchResume" hint="Bonus weights for WXG" />
          <DiffRow
            kind="mod"
            name="analyzeRequirement"
            hint="Added market.lookup tool"
          />
          <DiffRow
            kind="add"
            name="enrichCandidateLinkedIn"
            hint="New agent · stage 4"
          />
          <DiffRow
            kind="add"
            name="generateRecommendationPackage"
            hint="Wired to evaluateInterview"
          />
        </div>
      </div>

      <div
        style={{
          padding: "14px 16px",
          marginTop: "auto",
          borderTop: "1px solid var(--border)",
          fontSize: 11.5,
          color: "var(--text-3)",
          lineHeight: 1.55,
        }}
      >
        <Icon name="check" size={11} style={{ color: "var(--green)" }} /> Graph
        valid · 0 cycles · 0 orphans
      </div>
    </div>
  );
}

function DiffRow({
  kind,
  name,
  hint,
}: {
  kind: "add" | "del" | "mod";
  name: string;
  hint: string;
}) {
  const tone =
    kind === "add"
      ? "var(--green)"
      : kind === "del"
        ? "var(--red)"
        : "var(--amber)";
  const sigil = kind === "add" ? "+" : kind === "del" ? "−" : "~";
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "5px 8px",
        background: "var(--bg-2)",
        border: "1px solid var(--border)",
        borderRadius: 3,
      }}
    >
      <span
        className="mono"
        style={{ color: tone, width: 12, fontWeight: 700 }}
      >
        {sigil}
      </span>
      <span className="mono" style={{ color: "var(--text-2)", fontSize: 11.5 }}>
        {name}
      </span>
      <span
        style={{ marginLeft: "auto", color: "var(--text-3)", fontSize: 10.5 }}
      >
        {hint}
      </span>
    </div>
  );
}
