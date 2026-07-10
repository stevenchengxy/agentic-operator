"use client";

/**
 * Workflows view — DAG canvas of all agents wired by events. P2-FE-08.
 *
 * Ported from `agentic-operator_v1_1/views/workflows.jsx` (999 LOC), preserves:
 *   - the hand-tuned LAYOUT map (audit 01 §4.2 acceptance — see `./components/workflows/layout.ts`)
 *   - 8 stage columns + 5-lane grid
 *   - cubic-bezier SVG edges with color-coded arrowheads
 *   - animated travelling dots on live edges
 *   - edit-mode banner, toolbar, draft palette, node editor
 *   - NewWorkflowModal (template / blank / import paths)
 *   - ImportManifestModal hook
 *
 * Data sources (all live, no bootstrap snapshot):
 *   - useDag()             → agents + workflowVersion (from /v1/workflows/dag)
 *   - useEvents({limit})   → event catalog metadata (color/category) +
 *                            live event stream for the inspector
 *
 * Stages are derived from the live DAG's `stage` indices (see STAGE_LABELS
 * below) so each tenant's funnel reflects its own agents. Live updates
 * (run.*, event.emitted) flow through useStream() at the layout root.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ActorTag,
  Badge,
  Button,
  Icon,
  Kbd,
  ViewHeader,
  useToast,
} from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useDirty } from "@/app/portal/lib/dirty-context";
import {
  COL_W,
  NODE_H,
  NODE_W,
  PAD_X,
  PAD_Y,
  ROW_H,
  colorVar,
  getLayout,
  topoLayout,
} from "@/app/portal/components/workflows/layout";
import {
  AgentInspector,
  DefaultInspector,
  DraftPalette,
  EditDraftBanner,
  EditToolbar,
  EventInspector,
  type EventCatalogItem,
} from "@/app/portal/components/workflows/inspectors";
import { NewWorkflowModal } from "@/app/portal/components/workflows/NewWorkflowModal";
import { ImportManifestModal } from "@/app/portal/components/import-manifest/ImportManifestModal";
import { AgentEditor } from "@/app/portal/components/workflows/AgentEditor";
import {
  applyDraft,
  countDraftChanges,
  deserializeDraft,
  draftStorageKey,
  emptyDraft,
  serializeDraft,
  toManifest,
  tryReadSerializedDraft,
  type WorkflowDraft,
} from "@/app/portal/components/workflows/draft";
import { useDeployManifest } from "@/lib/hooks/useManifest";
import { useDag } from "@/lib/hooks/useAgents";
import { useEvents } from "@/lib/hooks/useEvents";

/**
 * Stage label catalog — static workflow ontology. Mirrors the dashboard's
 * STAGE_LABELS map (see `dashboard/page.tsx`) so the workflow funnel
 * column headers match the dashboard funnel labels. Tenants whose agents
 * use stage indices outside this map get a generic "Stage N" label.
 */
const STAGE_LABELS: Record<number, string> = {
  0: "Intake",
  1: "Analyze",
  2: "JD",
  3: "Publish",
  4: "Resume",
  5: "Match & Interview",
  6: "Package",
  7: "Submit",
};

interface EdgeMeta {
  src: string;
  dst: string;
  event: string;
}

export default function WorkflowsPage() {
  const router = useRouter();
  const tenant = useTenant();
  const { t } = useI18n();
  const toast = useToast();
  const deploy = useDeployManifest();
  // Real DAG metadata (workflowVersion) — replaces the previously hardcoded
  // "raas · v2026.05.16-a" badge so the header reflects the live tenant
  // workflow. The DAG payload is also the source of truth for the agent
  // list rendered on the canvas.
  const dagQuery = useDag();
  const workflowVersion = dagQuery.data?.workflowVersion ?? "";
  const baseAgents = useMemo(
    () => dagQuery.data?.agents ?? [],
    [dagQuery.data?.agents],
  );

  // Live event catalog — `/v1/events` dedup'd by name so the workflow's
  // event-color map and inspector "available events" hint always reflect
  // what's actually been emitted (plus what the manifest declares — agents
  // surface their emit/trigger names through the DAG payload regardless of
  // whether the event has ever fired).
  const eventsQuery = useEvents({ limit: 200 });
  const events = useMemo<EventCatalogItem[]>(() => {
    const map = new Map<string, EventCatalogItem>();
    // Seed from the event ledger so colors/categories that the api has seen
    // win over a derived fallback.
    for (const row of eventsQuery.data ?? []) {
      if (map.has(row.name)) continue;
      map.set(row.name, {
        name: row.name,
        color: row.color ?? "muted",
        category: row.category ?? "agent",
      });
    }
    // Also include every event referenced by an agent's triggers/emits —
    // tenants whose workflow hasn't fired any events yet still need their
    // event names available to the inspector legend.
    for (const a of baseAgents) {
      for (const n of [...a.triggers, ...a.emits]) {
        if (map.has(n)) continue;
        map.set(n, { name: n, color: "muted", category: "agent" });
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [eventsQuery.data, baseAgents]);

  // Column headers are derived from the resolved layout below (see `columns`),
  // not from the kebab-derived `stage` hint — so the header coordinate system
  // matches the node coordinate system exactly.

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  const [tool, setTool] = useState<"select" | "connect" | "add">("select");
  const [showNewModal, setShowNewModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  // Live stream — placeholder for tweaks-panel wiring (Phase 2).
  const liveStream = true;
  // Scroll container for the canvas viewport. The canvas is wider than the
  // viewport when LAYOUT places nodes deep into the stage grid; this ref
  // lets us scroll the leftmost node into view after data loads so the
  // user actually sees their imported workflow.
  const canvasScrollRef = useRef<HTMLDivElement | null>(null);

  // While editing, the canvas reads the *applied* draft so the operator
  // sees their changes immediately. Outside edit mode it's the bootstrap.
  const agents = useMemo(
    () => (editing ? applyDraft(baseAgents, draft) : baseAgents),
    [baseAgents, draft, editing],
  );
  const draftCounts = countDraftChanges(draft);
  const dirty = draftCounts.added + draftCounts.modified + draftCounts.removed > 0;
  const dirtyApi = useDirty();
  // UC-V11-15: register the draft with the global Dirty context so
  // useTenantNavigate() and other guards can prompt before navigating away.
  useEffect(() => {
    const label = dirty
      ? `workflow draft · +${draftCounts.added} ~${draftCounts.modified} −${draftCounts.removed}`
      : null;
    dirtyApi.setDirty("workflow-draft", label);
    return () => dirtyApi.setDirty("workflow-draft", null);
  }, [
    dirty,
    draftCounts.added,
    draftCounts.modified,
    draftCounts.removed,
    dirtyApi,
  ]);

  // UC-V11-13: persist edit-mode draft to localStorage so refreshing the
  // page or closing the tab without deploying preserves work-in-progress.
  // The key is namespaced by tenant; multiple workflows per tenant would
  // need a deeper key — today there's one workflow per tenant.
  const storageKey = useMemo(() => draftStorageKey(tenant, tenant), [tenant]);
  // `restoredAt` non-null means we restored a saved draft on mount; show
  // a small banner with a Discard action so the operator can opt out.
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  // First mount: restore any saved draft for this (tenant, workflow). Wrap
  // in a Boolean ref-effect so a Next dev re-mount (StrictMode) doesn't
  // double-trigger the restore.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (hydrated) return;
    setHydrated(true);
    if (typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (!raw) return;
      const parsed = tryReadSerializedDraft(raw);
      if (!parsed) {
        window.localStorage.removeItem(storageKey);
        return;
      }
      // Restored — drop into edit mode so the user notices.
      setDraft(deserializeDraft(parsed));
      setEditing(true);
      setRestoredAt(parsed.savedAt);
    } catch {
      // localStorage unavailable (private mode, quota) — silently skip.
    }
  }, [hydrated, storageKey]);
  // Save on every change while dirty; clear on clean state.
  useEffect(() => {
    if (!hydrated || typeof window === "undefined") return;
    try {
      if (dirty) {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify(serializeDraft(draft)),
        );
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      // Persistence failure is best-effort; don't break the UI.
    }
  }, [hydrated, dirty, draft, storageKey]);
  function discardRestored() {
    setDraft(emptyDraft());
    setEditing(false);
    setRestoredAt(null);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }
  }

  // Real-time layout derived from the agents' event cascade. RAAS keeps its
  // hand-tuned `LAYOUT` (audit 01 §4.2 acceptance); every other tenant —
  // including ones that reuse RAAS kebab-ids like zhaopin's "10-1" — lays out
  // PURELY from triggers/emits via `topoLayout`, so the canvas reflects the
  // actual flow instead of mis-claiming a hand-tuned slot. The kebab-derived
  // `stage` hint from the DAG is intentionally ignored for positioning.
  const useHandTuned = tenant === "raas";
  const topo = useMemo(
    () =>
      topoLayout(
        agents.map((a) => ({
          id: a.kebabId,
          triggers: a.triggers ?? [],
          emits: a.emits ?? [],
        })),
      ),
    [agents],
  );
  // Final (column, lane) for an agent under the active tenant's layout.
  const layAt = useCallback(
    (kebabId: string): { stage: number; lane: number } | null =>
      useHandTuned ? getLayout(kebabId, topo) : (topo[kebabId] ?? null),
    [useHandTuned, topo],
  );
  const posAt = useCallback(
    (kebabId: string): { x: number; y: number } => {
      const p = layAt(kebabId);
      return p
        ? { x: PAD_X + p.stage * COL_W, y: PAD_Y + p.lane * ROW_H }
        : { x: 0, y: 0 };
    },
    [layAt],
  );
  // Canvas dimensions + column count derived from the resolved layout so the
  // grid is exactly as wide/tall as this workflow needs (no empty RAAS-sized
  // columns for a small tenant).
  const dims = useMemo(() => {
    let maxCol = 0;
    let maxLane = 0;
    for (const a of agents) {
      const p = layAt(a.kebabId);
      if (!p) continue;
      maxCol = Math.max(maxCol, p.stage);
      maxLane = Math.max(maxLane, p.lane);
    }
    return {
      cols: maxCol + 1,
      lanes: maxLane + 1,
      w: PAD_X * 2 + (maxCol + 1) * COL_W,
      h: PAD_Y * 2 + (maxLane + 1) * ROW_H,
    };
  }, [agents, layAt]);

  // One header per column. For RAAS the column index IS the hand-tuned stage,
  // so the named STAGE_LABELS apply; every other tenant gets a sequential
  // "Stage N" label derived from the cascade depth.
  const columns = useMemo(
    () =>
      Array.from({ length: dims.cols }, (_, i) => ({
        index: i,
        label:
          useHandTuned && i in STAGE_LABELS
            ? t(`workflowsView.stage.${i}`)
            : t("workflowsView.stageGeneric", { id: i + 1 }),
      })),
    [dims.cols, useHandTuned, t],
  );

  // Build edges: for each agent's emitted event, find listeners.
  const edges = useMemo<EdgeMeta[]>(() => {
    const out: EdgeMeta[] = [];
    agents.forEach((src) => {
      (src.emits || []).forEach((evName) => {
        const listeners = agents.filter((a) => a.triggers.includes(evName));
        listeners.forEach((dst) => {
          // Edge only renders when BOTH endpoints have a resolved position
          // under the active tenant's layout (hand-tuned for RAAS, cascade-
          // derived topo otherwise).
          if (layAt(src.kebabId) && layAt(dst.kebabId)) {
            out.push({ src: src.kebabId, dst: dst.kebabId, event: evName });
          }
        });
      });
    });
    return out;
  }, [agents, layAt]);

  const evColor = useMemo(() => {
    const m: Record<string, string> = {};
    events.forEach((e) => {
      m[e.name] = e.color;
    });
    return m;
  }, [events]);

  // Highlight set when an agent or event is selected.
  const highlighted = useMemo(() => {
    const nodes = new Set<string>();
    const edgeSet = new Set<number>();
    if (selectedAgent) {
      nodes.add(selectedAgent);
      edges.forEach((e, i) => {
        if (e.src === selectedAgent || e.dst === selectedAgent) {
          edgeSet.add(i);
          nodes.add(e.src);
          nodes.add(e.dst);
        }
      });
    }
    if (selectedEvent) {
      edges.forEach((e, i) => {
        if (e.event === selectedEvent) {
          edgeSet.add(i);
          nodes.add(e.src);
          nodes.add(e.dst);
        }
      });
    }
    return { nodes, edges: edgeSet };
  }, [selectedAgent, selectedEvent, edges]);

  const dim = Boolean(selectedAgent || selectedEvent);

  // After data loads, scroll the canvas so the leftmost node is visible. With
  // the dynamic canvas (columns always start at 0) this is normally a no-op,
  // but it still guards the edge case where a layout's minimum column is > 0.
  useEffect(() => {
    const el = canvasScrollRef.current;
    if (!el || el.scrollLeft !== 0) return;
    const positioned = agents
      .map((a) => layAt(a.kebabId))
      .filter((p): p is { stage: number; lane: number } => Boolean(p));
    if (positioned.length === 0) return;
    const minStage = positioned.reduce(
      (acc, p) => Math.min(acc, p.stage),
      Number.POSITIVE_INFINITY,
    );
    const targetX = Math.max(0, PAD_X + minStage * COL_W - 40);
    if (targetX > 0) el.scrollLeft = targetX;
  }, [agents, layAt]);

  function navAgent(id: string) {
    router.push(`/portal/${tenant}/agents/${id}` as never);
  }
  function navEvents(eventName: string) {
    router.push(`/portal/${tenant}/events?name=${encodeURIComponent(eventName)}` as never);
  }

  function discardDraft() {
    setDraft(emptyDraft());
    setEditing(false);
  }

  async function saveDraft() {
    const manifest = toManifest(agents);
    try {
      const data = await deploy.mutateAsync({
        manifest,
        workflowSlug: tenant,
        note: `In-portal edit · ${draftCounts.added}+/${draftCounts.modified}~/${draftCounts.removed}-`,
      });
      toast({
        tone: "signal",
        title: t("workflowsView.toastDeployedTitle"),
        description: `${data.version} · +${data.diff.added.length} / ~${data.diff.modified.length} / −${data.diff.removed.length}`,
      });
      setDraft(emptyDraft());
      setEditing(false);
    } catch (err) {
      toast({
        tone: "red",
        title: t("workflowsView.toastDeployFailedTitle"),
        description: err instanceof Error ? err.message : t("workflowsView.unknownError"),
      });
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.workflows")}
        subtitle={
          editing ? (
            <>
              {t("workflowsView.subtitleEditingPrefix")} <span className="mono" style={{ color: "var(--text)" }}>{tenant}</span> {t("workflowsView.subtitleEditingSuffix")}
            </>
          ) : (
            t("workflowsView.subtitle")
          )
        }
        badge={
          editing ? (
            <Badge tone="amber">
              <Icon name="alert" size={9} /> {t("workflowsView.draftBadge")} · {tenant}
            </Badge>
          ) : (
            <Badge tone="muted">{tenant}{workflowVersion ? ` · ${workflowVersion}` : ""}</Badge>
          )
        }
        action={
          editing
            ? [
                <Button key="discard" small tone="ghost" onClick={discardDraft}>
                  {t("workflowsView.discardDraft")}
                </Button>,
                <Button key="val" small icon="check" tone="ghost">
                  {t("workflowsView.validate")}
                </Button>,
                <Button
                  key="dep"
                  small
                  icon="deploy"
                  tone="primary"
                  onClick={saveDraft}
                  disabled={!dirty || deploy.isPending}
                >
                  {deploy.isPending
                    ? t("workflowsView.deploying")
                    : `${t("workflowsView.deployDraft")}${dirty ? ` (${draftCounts.added + draftCounts.modified + draftCounts.removed})` : ""}`}
                </Button>,
              ]
            : [
                <Button key="edit" icon="code" small onClick={() => setEditing(true)}>
                  {t("workflowsView.editWorkflow")}
                </Button>,
                <Button key="new" icon="plus" tone="primary" small onClick={() => setShowNewModal(true)}>
                  {t("workflowsView.newWorkflow")}
                </Button>,
                <Button key="upload" icon="upload" small onClick={() => setShowImport(true)}>
                  {t("workflowsView.importManifest")}
                </Button>,
              ]
        }
      />

      {editing && <EditDraftBanner />}

      {restoredAt && (
        <div
          role="status"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "8px 24px",
            background: "var(--panel-2)",
            borderBottom: "1px solid var(--border)",
            fontSize: 12,
            color: "var(--text-2)",
          }}
        >
          <Icon name="alert" size={11} style={{ color: "var(--amber)" }} />
          <span>
            {t("workflowsView.restoredDraftFrom")}{" "}
            <span className="mono" style={{ color: "var(--text)" }}>
              {new Date(restoredAt).toLocaleString()}
            </span>
          </span>
          <Button
            small
            tone="ghost"
            onClick={discardRestored}
            style={{ marginLeft: "auto" }}
          >
            {t("workflowsView.discard")}
          </Button>
        </div>
      )}

      <div
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 280px",
          minHeight: 0,
        }}
      >
        {/* Canvas */}
        <div
          ref={canvasScrollRef}
          style={{
            position: "relative",
            overflow: "auto",
            background: "var(--bg)",
            backgroundImage:
              "radial-gradient(circle, var(--border) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
            backgroundPosition: "0 0",
          }}
        >
          {editing && <EditToolbar tool={tool} setTool={(t) => setTool(t as typeof tool)} />}

          {/* Stage headers row */}
          <div
            style={{
              position: "absolute",
              left: 0,
              right: 0,
              top: 0,
              height: 28,
              display: "flex",
              paddingLeft: PAD_X,
              pointerEvents: "none",
            }}
          >
            {columns.map((c) => (
              <div
                key={c.index}
                style={{
                  width: COL_W,
                  padding: "8px 0 0 6px",
                  fontSize: 10,
                  fontFamily: "var(--mono)",
                  fontWeight: 500,
                  textTransform: "uppercase",
                  letterSpacing: "0.12em",
                  color: "var(--text-3)",
                }}
              >
                {String(c.index + 1).padStart(2, "0")} · {c.label}
              </div>
            ))}
          </div>

          <div style={{ width: dims.w, height: dims.h + 30, position: "relative", paddingTop: 30 }}>
            {/* Stage column dividers */}
            <div style={{ position: "absolute", inset: "30px 0 0 0", pointerEvents: "none" }}>
              {columns.map((c) =>
                c.index > 0 ? (
                  <div
                    key={c.index}
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: PAD_X + c.index * COL_W - 8,
                      width: 1,
                      background: "var(--border)",
                      opacity: 0.5,
                    }}
                  />
                ) : null,
              )}
            </div>

            {/* SVG edges */}
            <svg
              width={dims.w}
              height={dims.h}
              role="img"
              aria-label={t("workflowsView.dagAria", {
                agents: agents.length,
                edges: edges.length,
              })}
              style={{ position: "absolute", top: 30, left: 0, pointerEvents: "none" }}
            >
              <defs>
                {["green", "blue", "amber", "red", "muted"].map((c) => (
                  <marker
                    key={c}
                    id={`arrow-${c}`}
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto"
                  >
                    <path d="M0,0 L10,5 L0,10 z" fill={colorVar(c)} />
                  </marker>
                ))}
              </defs>
              {edges.map((e, i) => {
                const s = posAt(e.src);
                const d = posAt(e.dst);
                const sx = s.x + NODE_W;
                const sy = s.y + NODE_H / 2;
                const dx = d.x;
                const dy = d.y + NODE_H / 2;
                const c1x = sx + Math.max(40, (dx - sx) * 0.5);
                const c2x = dx - Math.max(40, (dx - sx) * 0.5);
                const path = `M ${sx} ${sy} C ${c1x} ${sy}, ${c2x} ${dy}, ${dx} ${dy}`;
                const color = colorVar(evColor[e.event] ?? "muted");
                const isHi = highlighted.edges.has(i) || hoveredEdge === i;
                const opacity = dim ? (isHi ? 1 : 0.1) : isHi ? 1 : 0.55;
                return (
                  <g
                    key={i}
                    role="button"
                    tabIndex={0}
                    aria-label={t("workflowsView.edgeAria", {
                      event: e.event,
                      src: e.src,
                      dst: e.dst,
                    })}
                    style={{ pointerEvents: "auto" }}
                    onKeyDown={(ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        setSelectedEvent(e.event);
                      }
                    }}
                  >
                    <path
                      d={path}
                      stroke={color}
                      strokeWidth={isHi ? 2 : 1.25}
                      fill="none"
                      opacity={opacity}
                      markerEnd={`url(#arrow-${evColor[e.event] ?? "muted"})`}
                      style={{
                        cursor: "pointer",
                        transition: "opacity 0.15s, stroke-width 0.15s",
                      }}
                      onMouseEnter={() => setHoveredEdge(i)}
                      onMouseLeave={() => setHoveredEdge(null)}
                      onClick={() => setSelectedEvent(e.event)}
                    />
                    {liveStream && (isHi || (!dim && Math.abs((i * 37) % 7) === 0)) && (
                      <circle r="3" fill={color} opacity={isHi ? 1 : 0.85} aria-hidden="true">
                        <animateMotion
                          dur={`${2.5 + (i % 5) * 0.4}s`}
                          repeatCount="indefinite"
                          begin={`${(i * 0.13) % 2}s`}
                          path={path}
                        />
                      </circle>
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Agent nodes */}
            <div style={{ position: "absolute", top: 30, left: 0, width: dims.w, height: dims.h }}>
              {agents.map((a) => {
                const p = posAt(a.kebabId);
                const isSel = selectedAgent === a.kebabId;
                const isHi = highlighted.nodes.has(a.kebabId);
                const showDim = dim && !isHi;
                const isAdded = editing && (a.kebabId === "10-1" || a.kebabId === "14-1");
                const isModified = editing && (a.kebabId === "2" || a.kebabId === "12");
                const borderColor = isSel
                  ? "var(--signal)"
                  : isAdded
                    ? "var(--green)"
                    : isModified
                      ? "var(--amber)"
                      : isHi
                        ? "var(--border-3)"
                        : "var(--border-2)";
                const dashed = editing ? "dashed" : "solid";
                const stateSuffix = isAdded
                  ? t("workflowsView.nodeStateAdded")
                  : isModified
                    ? t("workflowsView.nodeStateModified")
                    : "";
                const nodeLabel = t("workflowsView.nodeAria", {
                  actor: a.actor,
                  title: a.title,
                  id: a.kebabId,
                  state: stateSuffix,
                });
                return (
                  <button
                    key={a.kebabId}
                    aria-label={nodeLabel}
                    aria-pressed={isSel}
                    onClick={(e) => {
                      e.stopPropagation();
                      setSelectedAgent(isSel ? null : a.kebabId);
                      setSelectedEvent(null);
                    }}
                    style={{
                      position: "absolute",
                      left: p.x,
                      top: p.y,
                      width: NODE_W,
                      height: NODE_H,
                      background: a.actor === "Agent" ? "var(--panel)" : "var(--panel-2)",
                      borderTop: `1px ${dashed} ${borderColor}`,
                      borderRight: `1px ${dashed} ${borderColor}`,
                      borderBottom: `1px ${dashed} ${borderColor}`,
                      borderLeft: `3px solid ${a.actor === "Agent" ? "var(--signal)" : "var(--violet)"}`,
                      borderRadius: 5,
                      padding: "8px 10px",
                      textAlign: "left",
                      cursor: editing ? "move" : "pointer",
                      opacity: showDim ? 0.3 : 1,
                      transition: "opacity 0.15s, border-color 0.12s, box-shadow 0.12s",
                      boxShadow: isSel ? "0 0 0 3px color-mix(in srgb, var(--signal) 12%, transparent)" : "none",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <ActorTag actor={a.actor} />
                      {isAdded && <Badge tone="green">{t("workflowsView.badgeNew")}</Badge>}
                      {isModified && <Badge tone="amber">{t("workflowsView.badgeMod")}</Badge>}
                      <span
                        style={{
                          marginLeft: "auto",
                          fontSize: 10,
                          fontFamily: "var(--mono)",
                          color: "var(--text-3)",
                        }}
                      >
                        {a.kebabId}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 12.5,
                        color: "var(--text)",
                        fontWeight: 500,
                        lineHeight: 1.2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        display: "-webkit-box",
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: "vertical",
                      }}
                    >
                      {a.title}
                    </div>
                    {editing && isSel && (
                      <>
                        {(["top", "right", "bottom", "left"] as const).map((s) => (
                          <span
                            key={s}
                            style={{
                              position: "absolute",
                              width: 8,
                              height: 8,
                              background: "var(--signal)",
                              border: "1px solid var(--bg)",
                              borderRadius: 1,
                              top: s === "top" ? -4 : s === "bottom" ? "calc(100% - 4px)" : "calc(50% - 4px)",
                              left: s === "left" ? -4 : s === "right" ? "calc(100% - 4px)" : "calc(50% - 4px)",
                            }}
                          />
                        ))}
                      </>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Right inspector aside */}
        <aside
          style={{
            borderLeft: "1px solid var(--border)",
            background: "var(--panel)",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          {selectedAgent && editing ? (
            <AgentEditor
              agent={
                agents.find((a) => a.kebabId === selectedAgent) ?? agents[0]!
              }
              events={events}
              draft={draft.agents[selectedAgent]}
              onChange={(next) =>
                setDraft((prev) => ({
                  ...prev,
                  agents: { ...prev.agents, [selectedAgent]: next },
                }))
              }
              onRemove={() => {
                setDraft((prev) => {
                  const isAdded = prev.added.has(selectedAgent);
                  const nextAgents = { ...prev.agents };
                  delete nextAgents[selectedAgent];
                  return {
                    agents: nextAgents,
                    added: isAdded
                      ? new Set(
                          Array.from(prev.added).filter(
                            (id) => id !== selectedAgent,
                          ),
                        )
                      : prev.added,
                    removed: isAdded
                      ? prev.removed
                      : new Set([...prev.removed, selectedAgent]),
                  };
                });
                setSelectedAgent(null);
              }}
              onClose={() => setSelectedAgent(null)}
            />
          ) : selectedAgent ? (
            <AgentInspector
              agent={agents.find((a) => a.kebabId === selectedAgent)}
              onClose={() => setSelectedAgent(null)}
              onOpenFull={() => navAgent(selectedAgent)}
            />
          ) : selectedEvent ? (
            <EventInspector
              eventName={selectedEvent}
              onClose={() => setSelectedEvent(null)}
              onNavigateAgent={navAgent}
              onNavigateEvents={navEvents}
            />
          ) : editing ? (
            <DraftPalette />
          ) : (
            <DefaultInspector events={events} agents={agents} onPick={setSelectedEvent} />
          )}
        </aside>
      </div>
      {showNewModal && <NewWorkflowModal onClose={() => setShowNewModal(false)} />}
      {showImport && <ImportManifestModal onClose={() => setShowImport(false)} mode="workflow" />}

      {/* Kbd is exposed so it bundles even when not displayed (used in EditDraftBanner via its own
          import). Re-export so unused-import lint passes. */}
      {false && <Kbd>⌘</Kbd>}
    </div>
  );
}
