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
import { useI18n } from "@/app/portal/lib/preferences-context";

/**
 * Catalog row built from the live `/v1/events` stream so the inspectors can
 * surface color + category metadata without the bootstrap snapshot.
 */
export interface EventCatalogItem {
  name: string;
  color: string;
  category: string;
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border)" }}>
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

function LegendRow({ color, label, sub }: { color: string; label: string; sub: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 10, height: 10, background: color, borderRadius: 2 }} />
      <span style={{ color: "var(--text)" }}>{label}</span>
      <span style={{ marginLeft: "auto", color: "var(--text-3)", fontSize: 11, fontFamily: "var(--mono)" }}>{sub}</span>
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
  const { t } = useI18n();
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
    agent: t("inspectors.catFromAgents"),
    human: t("inspectors.catFromHumans"),
    data: t("inspectors.catData"),
    external: t("inspectors.catExternal"),
    alert: t("inspectors.catAlerts"),
    system: t("inspectors.catSystem"),
  };

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
        <div style={{ fontSize: 11, fontFamily: "var(--mono)", textTransform: "uppercase", color: "var(--text-3)", letterSpacing: "0.08em" }}>{t("inspectors.legend")}</div>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8, fontSize: 12 }}>
          <LegendRow color="var(--signal)" label={t("inspectors.agentNode")} sub={t("inspectors.inWorkflow", { count: agents.filter((a) => a.actor === "Agent").length })} />
          <LegendRow color="var(--violet)" label={t("inspectors.humanNode")} sub={t("inspectors.inWorkflow", { count: agents.filter((a) => a.actor === "Human").length })} />
        </div>
      </div>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
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
          {t("inspectors.eventsClickToTrace")}
        </div>
        {Object.entries(grouped).map(([cat, items]) =>
          items.length > 0 ? (
            <div key={cat} style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10.5, fontFamily: "var(--mono)", color: "var(--text-3)", marginBottom: 5 }}>{labels[cat]}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {items.map((e) => (
                  <button key={e.name} onClick={() => onPick(e.name)} style={{ display: "inline-block" }}>
                    <Badge tone={eventTone(e.color)} style={{ fontSize: 9.5, cursor: "pointer" }}>{e.name}</Badge>
                  </button>
                ))}
              </div>
            </div>
          ) : null,
        )}
      </div>
      <div style={{ padding: "14px 16px", fontSize: 11.5, color: "var(--text-3)", lineHeight: 1.55 }}>
        <strong style={{ color: "var(--text-2)", fontWeight: 500 }}>{t("inspectors.tip")}</strong>
        <span> · {t("inspectors.tipBody")}</span>
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
  const { t } = useI18n();
  const detailQuery = useAgent(agent?.kebabId ?? null);
  const detail = detailQuery.data;
  if (!agent) return null;

  // Prefer the live AgentDetail fields when available so we always show
  // the canonical manifest values; fall back to the DAG snapshot otherwise.
  const triggers = detail?.triggers ?? agent.triggers;
  const emits = detail?.triggeredEvents ?? agent.emits;
  const actionNames = (detail?.actions ?? []).map((a) => a.name);

  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
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
          <div style={{ fontSize: 15, color: "var(--text)", fontWeight: 500, lineHeight: 1.3 }}>{agent.title}</div>
        </div>
        <Button small icon="x" tone="ghost" onClick={onClose} />
      </header>
      {actionNames.length > 0 && (
        <Section title={t("inspectors.steps")}>
          <ol style={{ margin: 0, padding: 0, listStyle: "none" }}>
            {actionNames.map((s, i) => (
              <li key={`${s}-${i}`} style={{ display: "flex", gap: 8, padding: "4px 0", fontSize: 12 }}>
                <span style={{ color: "var(--text-3)", fontFamily: "var(--mono)", width: 18 }}>{i + 1}.</span>
                <span className="mono" style={{ color: "var(--text)" }}>{s}</span>
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section title={t("inspectors.triggers")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {triggers.length > 0 ? (
            triggers.map((trig) => (
              <Badge key={trig} tone="blue">{trig}</Badge>
            ))
          ) : (
            <span style={{ fontSize: 11, color: "var(--text-3)" }}>{t("inspectors.noneManual")}</span>
          )}
        </div>
      </Section>
      <Section title={t("inspectors.emits")}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {emits.map((e) => (
            <Badge key={e} tone="green">{e}</Badge>
          ))}
        </div>
      </Section>
      {detail?.workflowSlug && (
        <Section title={t("inspectors.workflow")}>
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
          {t("inspectors.openAgent")}
        </Button>
        <Button icon="run" tone="primary">
          {t("inspectors.testRun")}
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
  const { t } = useI18n();
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
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
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
          <Badge tone={eventTone(catalogRow?.color ?? "")} style={{ marginBottom: 8 }}>{eventName}</Badge>
          <div style={{ fontSize: 11, color: "var(--text-3)" }}>{t("inspectors.categoryLabel")} · {catalogRow?.category ?? "—"}</div>
        </div>
        <Button small icon="x" tone="ghost" onClick={onClose} />
      </header>
      <Section title={t("inspectors.emittedBy", { count: emitters.length })}>
        <NodeList agents={emitters} onPick={onNavigateAgent} />
      </Section>
      <Section title={t("inspectors.listenedBy", { count: listeners.length })}>
        <NodeList agents={listeners} onPick={onNavigateAgent} />
      </Section>
      <Section title={t("inspectors.recent", { count: recent.length })}>
        {recent.map((row: EventRow) => {
          const at = row.receivedAt ? Date.parse(row.receivedAt) : null;
          return (
            <div key={row.id} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 11.5 }}>
              <span className="mono" style={{ color: "var(--text-2)" }}>{row.id}</span>
              <span style={{ color: "var(--text-3)" }}>{at != null && Number.isFinite(at) ? fmtAgo(at) : "—"}</span>
            </div>
          );
        })}
      </Section>
      <div style={{ padding: 14, marginTop: "auto", borderTop: "1px solid var(--border)" }}>
        <Button icon="external" onClick={() => onNavigateEvents(eventName)} style={{ width: "100%" }}>
          {t("inspectors.viewInEventStream")}
        </Button>
      </div>
    </div>
  );
}

function NodeList({ agents, onPick }: { agents: DagAgent[]; onPick: (id: string) => void }) {
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

export function EditDraftBanner() {
  const { t } = useI18n();
  return (
    <div
      style={{
        padding: "10px 24px",
        background: "color-mix(in srgb, var(--amber) 6%, transparent)",
        borderBottom: "1px solid color-mix(in srgb, var(--amber) 25%, transparent)",
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
          {t("inspectors.editingDraft")}
        </span>
        <span style={{ marginLeft: 12, color: "var(--text-2)" }}>{t("inspectors.draftDiffSummary", { added: 2, modified: 2, removed: 0 })}</span>
        <span style={{ marginLeft: 12, color: "var(--text-3)", fontFamily: "var(--mono)" }}>{t("inspectors.autoSavedAgo", { ago: "12s" })}</span>
      </div>
      <div
        style={{
          marginLeft: "auto",
          display: "flex",
          gap: 8,
          alignItems: "center",
          fontSize: 11,
          fontFamily: "var(--mono)",
          color: "var(--text-3)",
        }}
      >
        <KbdHint k="⌘" k2="Z" hint={t("inspectors.kbdUndo")} />
        <KbdHint k="V" hint={t("inspectors.kbdSelect")} />
        <KbdHint k="C" hint={t("inspectors.kbdConnect")} />
        <KbdHint k="N" hint={t("inspectors.kbdAddNode")} />
      </div>
    </div>
  );
}

function KbdHint({ k, k2, hint }: { k: string; k2?: string; hint: string }) {
  return (
    <span>
      <KKey>{k}</KKey>
      {k2 && (
        <>
          {" "}
          <KKey>{k2}</KKey>
        </>
      )}{" "}
      {hint}
    </span>
  );
}

function KKey({ children }: { children: ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-block",
        padding: "1px 5px",
        fontSize: 10,
        fontFamily: "var(--mono)",
        color: "var(--text-2)",
        background: "var(--panel-2)",
        border: "1px solid var(--border-2)",
        borderBottom: "2px solid var(--border-2)",
        borderRadius: 3,
        lineHeight: 1.2,
      }}
    >
      {children}
    </kbd>
  );
}

export function EditToolbar({ tool, setTool }: { tool: string; setTool: (t: string) => void }) {
  const { t } = useI18n();
  const tools = [
    { id: "select", icon: "filter" as const, label: t("inspectors.toolSelect") },
    { id: "connect", icon: "git" as const, label: t("inspectors.toolConnect") },
    { id: "add", icon: "plus" as const, label: t("inspectors.toolAdd") },
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
      {tools.map((tb) => (
        <button
          key={tb.id}
          onClick={() => setTool(tb.id)}
          title={tb.label}
          aria-label={tb.label}
          aria-pressed={tool === tb.id}
          style={{
            width: 32,
            height: 32,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: tool === tb.id ? "var(--signal)" : "transparent",
            color: tool === tb.id ? "var(--on-signal)" : "var(--text-2)",
            borderRadius: 4,
          }}
        >
          <Icon name={tb.icon} size={13} />
        </button>
      ))}
      <div style={{ width: 1, background: "var(--border)", margin: "4px 4px" }} />
      <button
        title={t("inspectors.autoLayout")}
        aria-label={t("inspectors.autoLayout")}
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
        title={t("inspectors.zoomToFit")}
        aria-label={t("inspectors.zoomToFit")}
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
  const { t } = useI18n();
  const presets = [
    { kind: "Agent", title: t("inspectors.presetNewAgentTitle"), sub: t("inspectors.presetNewAgentSub"), color: "var(--signal)" },
    { kind: "Human", title: t("inspectors.presetHumanTaskTitle"), sub: t("inspectors.presetHumanTaskSub"), color: "var(--violet)" },
    { kind: "Agent", title: t("inspectors.presetTemplateTitle"), sub: "matchResume, etc.", color: "var(--text-3)" },
  ];
  return (
    <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
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
          {t("inspectors.editing")}
        </div>
        <div style={{ fontSize: 14, color: "var(--text)" }}>
          raas <span style={{ color: "var(--amber)", fontFamily: "var(--mono)", fontSize: 11 }}>· {t("inspectors.draftUpper")}</span>
        </div>
      </div>

      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
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
          {t("inspectors.dragOntoCanvas")}
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
              <div style={{ fontSize: 12, color: "var(--text)" }}>{p.title}</div>
              <div style={{ fontSize: 10.5, color: "var(--text-3)" }}>{p.sub}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: "14px 16px", borderBottom: "1px solid var(--border)" }}>
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
          {t("inspectors.pendingChanges")}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11.5 }}>
          <DiffRow kind="mod" name="matchResume" hint="Bonus weights for WXG" />
          <DiffRow kind="mod" name="analyzeRequirement" hint="Added market.lookup tool" />
          <DiffRow kind="add" name="enrichCandidateLinkedIn" hint="New agent · stage 4" />
          <DiffRow kind="add" name="generateRecommendationPackage" hint="Wired to evaluateInterview" />
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
        <Icon name="check" size={11} style={{ color: "var(--green)" }} /> {t("inspectors.graphValid", { cycles: 0, orphans: 0 })}
      </div>
    </div>
  );
}

function DiffRow({ kind, name, hint }: { kind: "add" | "del" | "mod"; name: string; hint: string }) {
  const tone = kind === "add" ? "var(--green)" : kind === "del" ? "var(--red)" : "var(--amber)";
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
      <span className="mono" style={{ color: tone, width: 12, fontWeight: 700 }}>{sigil}</span>
      <span className="mono" style={{ color: "var(--text-2)", fontSize: 11.5 }}>{name}</span>
      <span style={{ marginLeft: "auto", color: "var(--text-3)", fontSize: 10.5 }}>{hint}</span>
    </div>
  );
}
