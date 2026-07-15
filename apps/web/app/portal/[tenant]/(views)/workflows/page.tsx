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
import type {
  WorkflowDetail,
  WorkflowValidationResponse,
} from "@agentic/contracts";
import { useRouter } from "next/navigation";
import {
  ActorTag,
  Badge,
  Button,
  Icon,
  ViewHeader,
  useToast,
} from "@/app/portal/components";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { useDirty } from "@/app/portal/lib/dirty-context";
import {
  COL_W,
  MAX_CANVAS_H,
  MAX_CANVAS_W,
  NODE_H,
  NODE_W,
  PAD_X,
  ROW_H,
  autoPackLayout,
  clampCanvasPosition,
  colorVar,
  dynamicCanvasSize,
  nodePos,
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
import { WorkflowHelp } from "@/app/portal/components/workflows/WorkflowHelp";
import {
  applyDraft,
  addAgentToDraft,
  connectAgents,
  countDraftChanges,
  createAutomatedAgentDefinition,
  createHumanAgentDefinition,
  deserializeDraft,
  draftStorageKey,
  emptyDraft,
  moveAgent,
  serializeDraft,
  toManifest,
  tryReadSerializedDraft,
  type WorkflowDraft,
} from "@/app/portal/components/workflows/draft";
import { useDag } from "@/lib/hooks/useAgents";
import { useEvents } from "@/lib/hooks/useEvents";
import {
  useDeleteWorkflow,
  usePublishWorkflow,
  useSaveWorkflow,
  useValidateWorkflow,
  useWorkflowCatalog,
} from "@/lib/hooks/useWorkflowAuthoring";

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
  const toast = useToast();
  const catalogQuery = useWorkflowCatalog();
  const workflows = useMemo(
    () => catalogQuery.data?.workflows ?? [],
    [catalogQuery.data?.workflows],
  );
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null);
  const editAfterSelectionRef = useRef<string | null>(null);

  // Pick the live workflow first, then the most recently updated draft. A
  // selection made by New Workflow is retained while the catalog refetches.
  useEffect(() => {
    if (catalogQuery.isLoading || workflows.length === 0) return;
    if (
      selectedWorkflow &&
      workflows.some((row) => row.slug === selectedWorkflow)
    ) {
      return;
    }
    const preferred =
      workflows.find((row) => row.liveVersionId !== null) ?? workflows[0];
    setSelectedWorkflow(preferred?.slug ?? null);
  }, [catalogQuery.isLoading, selectedWorkflow, workflows]);

  const selectedSummary = useMemo(
    () => workflows.find((row) => row.slug === selectedWorkflow) ?? null,
    [selectedWorkflow, workflows],
  );
  const dagQuery = useDag(selectedWorkflow);
  const saveWorkflow = useSaveWorkflow(selectedWorkflow);
  const validateWorkflow = useValidateWorkflow(selectedWorkflow);
  const publishWorkflow = usePublishWorkflow(selectedWorkflow);
  const deleteWorkflow = useDeleteWorkflow();
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

  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WorkflowDraft>(emptyDraft);
  const [tool, setTool] = useState<"select" | "connect" | "add">("select");
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [validation, setValidation] =
    useState<WorkflowValidationResponse | null>(null);
  const [editorErrors, setEditorErrors] = useState<Record<string, string[]>>(
    {},
  );
  const hasEditorErrors = Object.values(editorErrors).some(
    (errors) => errors.length > 0,
  );
  const reportEditorValidity = useCallback(
    (agentId: string, errors: string[]) => {
      setEditorErrors((current) => {
        const next = { ...current };
        if (errors.length) next[agentId] = errors;
        else delete next[agentId];
        return next;
      });
    },
    [],
  );
  const [zoom, setZoom] = useState(1);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importTarget, setImportTarget] = useState<{
    slug: string;
    name: string;
  } | null>(null);
  const publishInFlight = useRef(false);
  const [publishing, setPublishing] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
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
  const selectedAgentRecord = useMemo(
    () =>
      selectedAgent
        ? agents.find((agent) => agent.kebabId === selectedAgent)
        : undefined,
    [agents, selectedAgent],
  );
  useEffect(() => {
    // A workflow switch can render once with the previous node selection
    // while the new DAG is loading. Never pass an undefined agent to the
    // inspector/editor during that transition.
    if (selectedAgent && !selectedAgentRecord) setSelectedAgent(null);
  }, [selectedAgent, selectedAgentRecord]);
  const draftCounts = countDraftChanges(draft);
  const dirty =
    draftCounts.added + draftCounts.modified + draftCounts.removed > 0;
  const dirtyApi = useDirty();
  // UC-V11-15: register the draft with the global Dirty context so
  // useTenantNavigate() and other guards can prompt before navigating away.
  useEffect(() => {
    const label = dirty
      ? `${selectedWorkflow ?? "workflow"} draft · +${draftCounts.added} ~${draftCounts.modified} −${draftCounts.removed}`
      : null;
    dirtyApi.setDirty("workflow-draft", label);
    return () => dirtyApi.setDirty("workflow-draft", null);
  }, [
    dirty,
    draftCounts.added,
    draftCounts.modified,
    draftCounts.removed,
    dirtyApi,
    selectedWorkflow,
  ]);

  // Persist each workflow's browser edits independently. Switching the
  // catalog selector never leaks one manifest patch into another workflow.
  const storageKey = useMemo(
    () => draftStorageKey(tenant, selectedWorkflow ?? "__none__"),
    [selectedWorkflow, tenant],
  );
  // `restoredAt` non-null means we restored a saved draft on mount; show
  // a small banner with a Discard action so the operator can opt out.
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [draftBaseVersionId, setDraftBaseVersionId] = useState<string | null>(
    null,
  );
  const [hydratedKey, setHydratedKey] = useState<string | null>(null);
  useEffect(() => {
    const shouldOpenEditor = editAfterSelectionRef.current === selectedWorkflow;
    setDraft(emptyDraft());
    setEditing(false);
    setSelectedAgent(null);
    setSelectedEvent(null);
    setConnectFrom(null);
    setValidation(null);
    setEditorErrors({});
    setRestoredAt(null);
    setDraftBaseVersionId(null);
    if (typeof window === "undefined" || !selectedWorkflow) {
      setHydratedKey(storageKey);
      return;
    }
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = tryReadSerializedDraft(raw);
        if (!parsed) {
          window.localStorage.removeItem(storageKey);
        } else {
          setDraft(deserializeDraft(parsed));
          setDraftBaseVersionId(parsed.baseVersionId);
          setEditing(true);
          setRestoredAt(parsed.savedAt);
        }
      }
    } catch {
      // localStorage unavailable (private mode, quota) — silently skip.
    } finally {
      if (shouldOpenEditor) {
        editAfterSelectionRef.current = null;
        setEditing(true);
      }
      setHydratedKey(storageKey);
    }
  }, [selectedWorkflow, storageKey]);
  useEffect(() => {
    if (
      editing &&
      draftBaseVersionId === null &&
      dagQuery.data?.workflowVersionId &&
      hydratedKey === storageKey
    ) {
      setDraftBaseVersionId(dagQuery.data.workflowVersionId);
    }
  }, [
    dagQuery.data?.workflowVersionId,
    draftBaseVersionId,
    editing,
    hydratedKey,
    storageKey,
  ]);
  // Save on every change while dirty; clear on clean state.
  useEffect(() => {
    if (hydratedKey !== storageKey || typeof window === "undefined") return;
    try {
      if (dirty) {
        window.localStorage.setItem(
          storageKey,
          JSON.stringify(
            serializeDraft(
              draft,
              draftBaseVersionId ?? dagQuery.data?.workflowVersionId ?? null,
            ),
          ),
        );
      } else {
        window.localStorage.removeItem(storageKey);
      }
    } catch {
      // Persistence failure is best-effort; don't break the UI.
    }
  }, [
    dagQuery.data?.workflowVersionId,
    draftBaseVersionId,
    hydratedKey,
    dirty,
    draft,
    storageKey,
  ]);
  function discardRestored() {
    setDraft(emptyDraft());
    setEditing(false);
    setRestoredAt(null);
    setDraftBaseVersionId(null);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        // ignore
      }
    }
  }

  // Auto-pack any agents whose kebab-id isn't in the hand-tuned LAYOUT map
  // (the LAYOUT only covers RAAS). Pure derived state — same `agents` ->
  // same fallback positions; existing LAYOUT entries always win in
  // `getLayout` so RAAS visual fidelity is unaffected. We key entirely on
  // `kebabId` so the LAYOUT map (whose keys are kebab slugs like "1-1" or
  // "matcher-agent") and the auto-packed fallback share the same id space.
  const autoFallback = useMemo(
    () =>
      autoPackLayout(
        agents.map((a) => ({
          id: a.kebabId,
          stage: a.stage ?? 0,
          triggers: a.triggers ?? [],
          emits: a.emits ?? [],
        })),
      ),
    [agents],
  );

  const positions = useMemo(() => {
    const out = new Map<string, { x: number; y: number }>();
    for (const agent of agents) {
      out.set(
        agent.kebabId,
        clampCanvasPosition(
          agent.position ?? nodePos(agent.kebabId, autoFallback),
        ),
      );
    }
    return out;
  }, [agents, autoFallback]);

  const canvasSize = useMemo(
    () => dynamicCanvasSize(positions.values()),
    [positions],
  );

  // Derive headers from rendered columns rather than only declared stages.
  // This keeps topology-packed stage-99 workflows and local draft additions
  // aligned with their actual nodes.
  const stages = useMemo(() => {
    const byColumn = new Map<number, Set<number>>();
    for (const agent of agents) {
      const position = positions.get(agent.kebabId);
      if (!position) continue;
      const column = Math.max(0, Math.round((position.x - PAD_X) / COL_W));
      const declared = byColumn.get(column) ?? new Set<number>();
      declared.add(agent.stage);
      byColumn.set(column, declared);
    }
    return Array.from(byColumn.entries())
      .sort(([left], [right]) => left - right)
      .map(([column, declared]) => {
        const usable = Array.from(declared).filter((stage) => stage !== 99);
        const stage = usable.length === 1 ? (usable[0] ?? column) : column;
        return {
          id: column,
          column,
          label: STAGE_LABELS[stage] ?? `Stage ${stage}`,
        };
      });
  }, [agents, positions]);

  // Build edges: for each agent's emitted event, find listeners.
  const edges = useMemo<EdgeMeta[]>(() => {
    const out: EdgeMeta[] = [];
    agents.forEach((src) => {
      (src.emits || []).forEach((evName) => {
        const listeners = agents.filter((a) => a.triggers.includes(evName));
        listeners.forEach((dst) => {
          if (positions.has(src.kebabId) && positions.has(dst.kebabId)) {
            out.push({ src: src.kebabId, dst: dst.kebabId, event: evName });
          }
        });
      });
    });
    return out;
  }, [agents, positions]);

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

  // After data loads, scroll the canvas so the leftmost node is visible.
  // The canvas reserves room for all RAAS stages (0..7) at fixed COL_W;
  // a small workflow with only stage-5 nodes would otherwise render past
  // the viewport's right edge and look empty. Only nudges scroll when the
  // canvas is still at the leftmost position so we don't clobber a
  // user-initiated scroll on subsequent data updates.
  useEffect(() => {
    const el = canvasScrollRef.current;
    if (!el || el.scrollLeft !== 0) return;
    const positioned = Array.from(positions.values());
    if (positioned.length === 0) return;
    const minX = positioned.reduce(
      (acc, position) => Math.min(acc, position.x),
      Number.POSITIVE_INFINITY,
    );
    const targetX = Math.max(0, minX * zoom - 40);
    if (targetX > 0) el.scrollLeft = targetX;
  }, [positions, zoom]);

  function navAgent(id: string) {
    router.push(`/portal/${tenant}/agents/${id}` as never);
  }
  function navEvents(eventName: string) {
    router.push(
      `/portal/${tenant}/events?name=${encodeURIComponent(eventName)}` as never,
    );
  }

  function discardDraft() {
    setDraft(emptyDraft());
    setEditing(false);
    setConnectFrom(null);
    setValidation(null);
    setRestoredAt(null);
    setDraftBaseVersionId(null);
    setEditorErrors({});
  }

  function closeEditor() {
    if (
      dirty &&
      !window.confirm(
        "Close the editor and discard these unsaved browser changes? The last server-saved draft will be kept.",
      )
    ) {
      return;
    }
    discardDraft();
  }

  function editableManifest() {
    return toManifest(agents).map((definition) => {
      const position = positions.get(definition.id);
      if (!position) return definition;
      const extensions =
        definition.extensions && typeof definition.extensions === "object"
          ? definition.extensions
          : {};
      const priorCanvas =
        extensions.canvas &&
        typeof extensions.canvas === "object" &&
        !Array.isArray(extensions.canvas)
          ? extensions.canvas
          : {};
      return {
        ...definition,
        extensions: {
          ...extensions,
          canvas: { ...priorCanvas, position },
        },
      };
    });
  }

  async function saveDraft(): Promise<WorkflowDetail | null> {
    if (hasEditorErrors) {
      toast({
        tone: "red",
        title: "Fix editor errors before saving",
        description:
          Object.values(editorErrors).flat()[0] ?? "A field is invalid.",
      });
      return null;
    }
    const baseVersionId =
      draftBaseVersionId ?? dagQuery.data?.workflowVersionId ?? null;
    if (!selectedWorkflow || !baseVersionId) {
      toast({
        tone: "red",
        title: "Draft cannot be saved",
        description: "The selected workflow version has not finished loading.",
      });
      return null;
    }
    try {
      const detail = await saveWorkflow.mutateAsync({
        baseVersionId,
        manifest: editableManifest(),
      });
      toast({
        tone: "signal",
        title: "Draft saved",
        description: `${detail.latestVersion} is stored on the server. Live runs are unchanged.`,
      });
      setDraft(emptyDraft());
      setDraftBaseVersionId(detail.latestVersionId);
      setRestoredAt(null);
      setValidation(null);
      return detail;
    } catch (err) {
      toast({
        tone: "red",
        title: "Draft save failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
      return null;
    }
  }

  async function validateCurrent(): Promise<WorkflowValidationResponse | null> {
    if (hasEditorErrors) {
      toast({
        tone: "red",
        title: "Fix editor errors before validating",
        description:
          Object.values(editorErrors).flat()[0] ?? "A field is invalid.",
      });
      return null;
    }
    if (!selectedWorkflow) return null;
    try {
      const result = await validateWorkflow.mutateAsync({
        manifest: editableManifest(),
      });
      setValidation(result);
      toast({
        tone: result.valid ? "green" : "amber",
        title: result.valid ? "Workflow is valid" : "Workflow needs changes",
        description: result.valid
          ? `${result.promptScores.length} agent prompts checked.`
          : `${result.issues.filter((issue) => issue.severity === "error").length} blocking issue(s).`,
      });
      return result;
    } catch (err) {
      toast({
        tone: "red",
        title: "Validation failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
      return null;
    }
  }

  async function publishCurrent() {
    if (!selectedWorkflow || publishInFlight.current) return;
    publishInFlight.current = true;
    setPublishing(true);
    try {
      const checked = await validateCurrent();
      if (!checked?.valid) return;
      let versionId = dagQuery.data?.workflowVersionId ?? undefined;
      if (dirty) {
        const saved = await saveDraft();
        if (!saved) return;
        versionId = saved.latestVersionId;
      }
      if (!versionId) {
        toast({
          tone: "red",
          title: "Workflow cannot be published",
          description: "No immutable workflow version is available.",
        });
        return;
      }
      const result = await publishWorkflow.mutateAsync({
        versionId,
        note: `Published from the workflow canvas (${selectedWorkflow}).`,
      });
      toast({
        tone: "green",
        title: "Workflow is live",
        description: `${result.version} was published to production.`,
      });
      setDraft(emptyDraft());
      setEditing(false);
      setConnectFrom(null);
      setRestoredAt(null);
    } catch (err) {
      toast({
        tone: "red",
        title: "Publish failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      publishInFlight.current = false;
      setPublishing(false);
    }
  }

  function nextAgentId(actor: "Agent" | "Human"): string {
    const prefix = actor === "Human" ? "human-review" : "automated-step";
    const taken = new Set(agents.map((agent) => agent.kebabId));
    let index = 1;
    while (taken.has(`${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
  }

  function viewportPosition(): { x: number; y: number } {
    const canvas = canvasScrollRef.current;
    if (!canvas) return { x: PAD_X, y: 90 };
    return {
      x: Math.max(
        0,
        Math.min(
          Math.min(MAX_CANVAS_W - NODE_W, canvasSize.width + COL_W - NODE_W),
          (canvas.scrollLeft + canvas.clientWidth * 0.45) / zoom,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          Math.min(MAX_CANVAS_H - NODE_H, canvasSize.height + ROW_H - NODE_H),
          (canvas.scrollTop + canvas.clientHeight * 0.4) / zoom,
        ),
      ),
    };
  }

  function addAgent(
    actor: "Agent" | "Human",
    requestedPosition = viewportPosition(),
  ) {
    const id = nextAgentId(actor);
    const position = clampCanvasPosition(requestedPosition);
    const options = {
      id,
      position,
      stage: Math.max(0, Math.round((position.x - PAD_X) / COL_W)),
    };
    const definition =
      actor === "Human"
        ? createHumanAgentDefinition(options)
        : createAutomatedAgentDefinition(options);
    setDraft((current) => addAgentToDraft(current, definition));
    setSelectedAgent(id);
    setSelectedEvent(null);
    setTool("select");
    setValidation(null);
  }

  function connectNode(targetId: string) {
    if (!connectFrom) {
      setConnectFrom(targetId);
      setSelectedAgent(targetId);
      return;
    }
    if (connectFrom === targetId) {
      setConnectFrom(null);
      return;
    }
    const eventPart = (value: string) =>
      value
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .replace(/[^A-Za-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .toUpperCase();
    const eventName =
      `${eventPart(connectFrom)}_TO_${eventPart(targetId)}`.slice(0, 160);
    try {
      setDraft((current) =>
        connectAgents(current, agents, connectFrom, targetId, eventName),
      );
      setSelectedAgent(targetId);
      setSelectedEvent(eventName);
      setConnectFrom(null);
      setTool("select");
      setValidation(null);
      toast({
        tone: "signal",
        title: "Agents connected",
        description: `${eventName} is emitted by ${connectFrom} and consumed by ${targetId}.`,
      });
    } catch (err) {
      toast({
        tone: "red",
        title: "Connection failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  function moveNode(id: string, clientX: number, clientY: number) {
    const canvas = canvasScrollRef.current;
    if (!canvas || clientX === 0 || clientY === 0) return;
    const rect = canvas.getBoundingClientRect();
    const position = {
      x: Math.max(
        0,
        Math.min(
          Math.min(MAX_CANVAS_W - NODE_W, canvasSize.width + COL_W - NODE_W),
          (canvas.scrollLeft + clientX - rect.left) / zoom - NODE_W / 2,
        ),
      ),
      y: Math.max(
        0,
        Math.min(
          Math.min(MAX_CANVAS_H - NODE_H, canvasSize.height + ROW_H - NODE_H),
          (canvas.scrollTop + clientY - rect.top) / zoom - NODE_H / 2 - 30,
        ),
      ),
    };
    setDraft((current) => moveAgent(current, id, position));
    setValidation(null);
  }

  function autoLayout() {
    const byStage = new Map<number, typeof agents>();
    for (const agent of agents) {
      const bucket = byStage.get(agent.stage) ?? [];
      bucket.push(agent);
      byStage.set(agent.stage, bucket);
    }
    const orderedStages = Array.from(byStage.keys()).sort((a, b) => a - b);
    setDraft((current) => {
      let next = current;
      orderedStages.forEach((stage, column) => {
        const rows = [...(byStage.get(stage) ?? [])].sort((a, b) =>
          a.kebabId.localeCompare(b.kebabId),
        );
        rows.forEach((agent, lane) => {
          next = moveAgent(next, agent.kebabId, {
            x: PAD_X + column * COL_W,
            y: 30 + lane * 90,
          });
        });
      });
      return next;
    });
    setValidation(null);
    toast({
      tone: "signal",
      title: "Canvas arranged",
      description:
        "Agent positions were packed by stage and saved in the draft.",
    });
  }

  function zoomToFit() {
    const canvas = canvasScrollRef.current;
    const all = Array.from(positions.values());
    if (!canvas || all.length === 0) return;
    const minX = Math.min(...all.map((position) => position.x));
    const minY = Math.min(...all.map((position) => position.y));
    const maxX = Math.max(...all.map((position) => position.x + NODE_W));
    const maxY = Math.max(...all.map((position) => position.y + NODE_H));
    const nextZoom = Math.max(
      0.35,
      Math.min(
        1,
        (canvas.clientWidth - 48) / Math.max(1, maxX - minX),
        (canvas.clientHeight - 72) / Math.max(1, maxY - minY),
      ),
    );
    setZoom(nextZoom);
    requestAnimationFrame(() => {
      canvas.scrollTo({
        left: Math.max(0, minX * nextZoom - 24),
        top: Math.max(0, minY * nextZoom - 24),
        behavior: "smooth",
      });
    });
  }

  async function deleteSelectedWorkflow() {
    if (!selectedWorkflow || selectedSummary?.liveVersionId) return;
    const confirmed = window.confirm(
      `Delete the draft workflow "${selectedSummary?.name ?? selectedWorkflow}"? This cannot be undone.`,
    );
    if (!confirmed) return;
    try {
      await deleteWorkflow.mutateAsync(selectedWorkflow);
      const next = workflows.find((row) => row.slug !== selectedWorkflow);
      setSelectedWorkflow(next?.slug ?? null);
      toast({ tone: "green", title: "Draft workflow deleted" });
    } catch (err) {
      toast({
        tone: "red",
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  function selectCreatedWorkflow(workflow: WorkflowDetail) {
    editAfterSelectionRef.current = workflow.slug;
    setSelectedWorkflow(workflow.slug);
    setDraft(emptyDraft());
    setRestoredAt(null);
    setDraftBaseVersionId(workflow.latestVersionId);
    setEditing(true);
    setShowNewModal(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title="Workflows"
        subtitle={
          editing ? (
            <>
              Editing an unpublished draft of{" "}
              <span className="mono" style={{ color: "var(--text)" }}>
                {selectedWorkflow ?? "workflow"}
              </span>{" "}
              · Save creates an immutable draft version; Publish explicitly
              promotes it to live.
            </>
          ) : (
            "Select a tenant workflow, inspect its immutable version, or open the full draft editor."
          )
        }
        badge={
          editing ? (
            <Badge tone="amber">
              <Icon name="alert" size={9} /> LOCAL DRAFT
            </Badge>
          ) : dagQuery.data?.workflowIsLive ? (
            <Badge tone="green">
              <Icon name="check" size={9} /> LIVE
            </Badge>
          ) : (
            <Badge tone="amber">DRAFT</Badge>
          )
        }
        action={
          editing
            ? [
                <Button
                  key="help"
                  small
                  icon="task"
                  onClick={() => setShowHelp(true)}
                >
                  Help
                </Button>,
                <Button key="discard" small tone="ghost" onClick={closeEditor}>
                  Close editor
                </Button>,
                <Button
                  key="val"
                  small
                  icon="check"
                  tone="ghost"
                  onClick={() => void validateCurrent()}
                  disabled={
                    validateWorkflow.isPending ||
                    dagQuery.isLoading ||
                    !dagQuery.data?.workflowVersionId ||
                    !selectedWorkflow ||
                    hasEditorErrors
                  }
                >
                  {validateWorkflow.isPending ? "Validating…" : "Validate"}
                </Button>,
                <Button
                  key="save"
                  small
                  icon="code"
                  onClick={() => void saveDraft()}
                  disabled={!dirty || saveWorkflow.isPending || hasEditorErrors}
                >
                  {saveWorkflow.isPending
                    ? "Saving…"
                    : `Save draft${dirty ? ` (${draftCounts.added + draftCounts.modified + draftCounts.removed})` : ""}`}
                </Button>,
                <Button
                  key="publish"
                  small
                  icon="deploy"
                  tone="primary"
                  onClick={() => void publishCurrent()}
                  disabled={
                    publishing ||
                    publishWorkflow.isPending ||
                    saveWorkflow.isPending ||
                    validateWorkflow.isPending ||
                    dagQuery.isLoading ||
                    !dagQuery.data?.workflowVersionId ||
                    !selectedWorkflow ||
                    hasEditorErrors
                  }
                >
                  {publishing ? "Publishing…" : "Publish"}
                </Button>,
              ]
            : [
                <Button
                  key="help"
                  small
                  icon="task"
                  onClick={() => setShowHelp(true)}
                >
                  Help
                </Button>,
                <Button
                  key="edit"
                  icon="code"
                  small
                  onClick={() => {
                    setDraftBaseVersionId(
                      dagQuery.data?.workflowVersionId ?? null,
                    );
                    setEditing(true);
                  }}
                  disabled={!selectedWorkflow || dagQuery.isLoading}
                >
                  Edit workflow
                </Button>,
                ...(selectedSummary?.hasUnpublishedChanges
                  ? [
                      <Button
                        key="publish"
                        icon="deploy"
                        small
                        tone="primary"
                        onClick={() => void publishCurrent()}
                        disabled={
                          publishing ||
                          publishWorkflow.isPending ||
                          validateWorkflow.isPending ||
                          saveWorkflow.isPending ||
                          dagQuery.isLoading ||
                          !dagQuery.data?.workflowVersionId
                        }
                      >
                        {publishing ? "Publishing…" : "Publish draft"}
                      </Button>,
                    ]
                  : []),
                ...(selectedSummary?.status === "draft" && selectedWorkflow
                  ? [
                      <Button
                        key="delete"
                        icon="x"
                        tone="danger"
                        small
                        onClick={() => void deleteSelectedWorkflow()}
                        disabled={deleteWorkflow.isPending}
                      >
                        Delete draft
                      </Button>,
                    ]
                  : []),
                <Button
                  key="new"
                  icon="plus"
                  tone="primary"
                  small
                  onClick={() => setShowNewModal(true)}
                >
                  New workflow
                </Button>,
                <Button
                  key="upload"
                  icon="upload"
                  small
                  onClick={() => setShowImport(true)}
                >
                  Import manifest
                </Button>,
              ]
        }
      />

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "9px 24px",
          background: "var(--panel-2)",
          borderBottom: "1px solid var(--border)",
          minHeight: 42,
        }}
      >
        <span
          style={{
            color: "var(--text-3)",
            fontFamily: "var(--mono)",
            fontSize: 10.5,
            textTransform: "uppercase",
            letterSpacing: "0.07em",
          }}
        >
          Workflow
        </span>
        <select
          aria-label="Selected workflow"
          value={selectedWorkflow ?? ""}
          onChange={(event) => setSelectedWorkflow(event.target.value || null)}
          disabled={catalogQuery.isLoading || workflows.length === 0}
          style={{
            minWidth: 260,
            maxWidth: 420,
            background: "var(--panel)",
            border: "1px solid var(--border-2)",
            borderRadius: 4,
            color: "var(--text)",
            padding: "6px 8px",
            fontSize: 12,
          }}
        >
          {workflows.length === 0 && <option value="">No workflows yet</option>}
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.slug}>
              {workflow.name} ·{" "}
              {workflow.liveVersionId
                ? workflow.hasUnpublishedChanges
                  ? "LIVE + DRAFT"
                  : "LIVE"
                : "DRAFT"}{" "}
              · {workflow.latestVersion}
            </option>
          ))}
        </select>
        {selectedSummary && (
          <>
            <Badge tone={dagQuery.data?.workflowIsLive ? "green" : "amber"}>
              {dagQuery.data?.workflowIsLive ? "LIVE VERSION" : "DRAFT VERSION"}
            </Badge>
            {selectedSummary.hasUnpublishedChanges && (
              <Badge tone="amber">UNPUBLISHED CHANGES</Badge>
            )}
            <span
              className="mono"
              style={{ color: "var(--text-3)", fontSize: 10.5 }}
            >
              {workflowVersion || selectedSummary.latestVersion} ·{" "}
              {selectedSummary.agentCount} agents
            </span>
          </>
        )}
        {catalogQuery.isError && (
          <span role="alert" style={{ color: "var(--red)", fontSize: 11.5 }}>
            {catalogQuery.error instanceof Error
              ? catalogQuery.error.message
              : "Workflow catalog unavailable"}
          </span>
        )}
        {!catalogQuery.isLoading && workflows.length === 0 && (
          <span style={{ color: "var(--text-3)", fontSize: 11.5 }}>
            Create a workflow to begin.
          </span>
        )}
      </div>

      {editing && <EditDraftBanner counts={draftCounts} />}

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
            Restored unsaved draft from{" "}
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
            Discard
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
          onClick={(event) => {
            if (!editing || tool !== "add") return;
            const target = event.target as HTMLElement;
            if (target.closest("button,[role='button']")) return;
            const canvas = canvasScrollRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            addAgent("Agent", {
              x:
                (canvas.scrollLeft + event.clientX - rect.left) / zoom -
                NODE_W / 2,
              y:
                (canvas.scrollTop + event.clientY - rect.top) / zoom -
                NODE_H / 2 -
                30,
            });
          }}
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
          {editing && (
            <EditToolbar
              tool={tool}
              setTool={(t) => {
                setTool(t as typeof tool);
                if (t !== "connect") setConnectFrom(null);
              }}
              onAutoLayout={autoLayout}
              onZoomToFit={zoomToFit}
            />
          )}

          {/* Stage headers row */}
          <div
            style={{
              position: "absolute",
              left: 0,
              width: canvasSize.width,
              top: 0,
              height: 28,
              pointerEvents: "none",
              zoom,
            }}
          >
            {stages.map((s) => (
              <div
                key={s.id}
                style={{
                  position: "absolute",
                  left: PAD_X + s.column * COL_W,
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
                {String(s.column).padStart(2, "0")} · {s.label}
              </div>
            ))}
          </div>

          <div
            style={{
              width: canvasSize.width,
              height: canvasSize.height + 30,
              position: "relative",
              paddingTop: 30,
              zoom,
            }}
          >
            {/* Stage column dividers */}
            <div
              style={{
                position: "absolute",
                inset: "30px 0 0 0",
                pointerEvents: "none",
              }}
            >
              {stages.map((s) =>
                s.column > 0 ? (
                  <div
                    key={s.id}
                    style={{
                      position: "absolute",
                      top: 0,
                      bottom: 0,
                      left: PAD_X + s.column * COL_W - 8,
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
              width={canvasSize.width}
              height={canvasSize.height}
              role="img"
              aria-label={`Workflow DAG: ${agents.length} agents wired by ${edges.length} event edges`}
              style={{
                position: "absolute",
                top: 30,
                left: 0,
                pointerEvents: "none",
              }}
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
                const s = positions.get(e.src) ?? { x: 0, y: 0 };
                const d = positions.get(e.dst) ?? { x: 0, y: 0 };
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
                    aria-label={`Event edge: ${e.event} from ${e.src} to ${e.dst}`}
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
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedEvent(e.event);
                      }}
                    />
                    {liveStream &&
                      (isHi || (!dim && Math.abs((i * 37) % 7) === 0)) && (
                        <circle
                          r="3"
                          fill={color}
                          opacity={isHi ? 1 : 0.85}
                          aria-hidden="true"
                        >
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
            <div
              style={{
                position: "absolute",
                top: 30,
                left: 0,
                width: canvasSize.width,
                height: canvasSize.height,
              }}
            >
              {agents.map((a) => {
                const p = positions.get(a.kebabId) ?? { x: 0, y: 0 };
                const isSel = selectedAgent === a.kebabId;
                const isConnectSource = connectFrom === a.kebabId;
                const isHi = highlighted.nodes.has(a.kebabId);
                const showDim = dim && !isHi;
                const isAdded = editing && draft.added.has(a.kebabId);
                const isModified = Boolean(
                  editing &&
                  draft.agents[a.kebabId] &&
                  !draft.added.has(a.kebabId) &&
                  !draft.removed.has(a.kebabId),
                );
                const borderColor = isSel
                  ? "var(--signal)"
                  : isConnectSource
                    ? "var(--blue)"
                    : isAdded
                      ? "var(--green)"
                      : isModified
                        ? "var(--amber)"
                        : isHi
                          ? "var(--border-3)"
                          : "var(--border-2)";
                const dashed = editing ? "dashed" : "solid";
                const stateSuffix = isAdded
                  ? ", draft addition"
                  : isModified
                    ? ", draft modification"
                    : "";
                const nodeLabel = `${a.actor} node: ${a.title}, id ${a.kebabId}${stateSuffix}`;
                return (
                  <button
                    key={a.kebabId}
                    aria-label={nodeLabel}
                    aria-pressed={isSel}
                    draggable={editing && tool === "select"}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", a.kebabId);
                    }}
                    onDragEnd={(event) =>
                      moveNode(a.kebabId, event.clientX, event.clientY)
                    }
                    onClick={(e) => {
                      e.stopPropagation();
                      if (editing && tool === "connect") {
                        connectNode(a.kebabId);
                        return;
                      }
                      setSelectedAgent(isSel ? null : a.kebabId);
                      setSelectedEvent(null);
                    }}
                    style={{
                      position: "absolute",
                      left: p.x,
                      top: p.y,
                      width: NODE_W,
                      height: NODE_H,
                      background:
                        a.actor === "Agent" ? "var(--panel)" : "var(--panel-2)",
                      borderTop: `1px ${dashed} ${borderColor}`,
                      borderRight: `1px ${dashed} ${borderColor}`,
                      borderBottom: `1px ${dashed} ${borderColor}`,
                      borderLeft: `3px solid ${a.actor === "Agent" ? "var(--signal)" : "var(--violet)"}`,
                      borderRadius: 5,
                      padding: "8px 10px",
                      textAlign: "left",
                      cursor:
                        editing && tool === "connect"
                          ? "crosshair"
                          : editing && tool === "select"
                            ? "move"
                            : "pointer",
                      opacity: showDim ? 0.3 : 1,
                      transition:
                        "opacity 0.15s, border-color 0.12s, box-shadow 0.12s",
                      boxShadow: isSel
                        ? "0 0 0 3px rgba(208,255,0,0.12)"
                        : "none",
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        marginBottom: 4,
                      }}
                    >
                      <ActorTag actor={a.actor} />
                      {isAdded && <Badge tone="green">NEW</Badge>}
                      {isModified && <Badge tone="amber">MOD</Badge>}
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
                        {(["top", "right", "bottom", "left"] as const).map(
                          (s) => (
                            <span
                              key={s}
                              style={{
                                position: "absolute",
                                width: 8,
                                height: 8,
                                background: "var(--signal)",
                                border: "1px solid var(--bg)",
                                borderRadius: 1,
                                top:
                                  s === "top"
                                    ? -4
                                    : s === "bottom"
                                      ? "calc(100% - 4px)"
                                      : "calc(50% - 4px)",
                                left:
                                  s === "left"
                                    ? -4
                                    : s === "right"
                                      ? "calc(100% - 4px)"
                                      : "calc(50% - 4px)",
                              }}
                            />
                          ),
                        )}
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
          {selectedAgent && editing && selectedAgentRecord ? (
            <AgentEditor
              agent={selectedAgentRecord}
              events={events}
              draft={draft.agents[selectedAgent]}
              onChange={(next) => {
                setDraft((prev) => ({
                  ...prev,
                  agents: { ...prev.agents, [selectedAgent]: next },
                }));
                setValidation(null);
              }}
              onValidityChange={reportEditorValidity}
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
                setValidation(null);
                setEditorErrors((current) => {
                  const next = { ...current };
                  delete next[selectedAgent];
                  return next;
                });
                setSelectedAgent(null);
              }}
              onClose={() => setSelectedAgent(null)}
            />
          ) : selectedAgent && selectedAgentRecord ? (
            <AgentInspector
              agent={selectedAgentRecord}
              onClose={() => setSelectedAgent(null)}
              onOpenFull={() => navAgent(selectedAgent)}
              canOpenFull={Boolean(
                dagQuery.data?.workflowIsLive &&
                selectedAgentRecord.id !== selectedAgent,
              )}
              workflowLabel={`${selectedWorkflow ?? "workflow"}${workflowVersion ? ` · ${workflowVersion}` : ""}`}
            />
          ) : selectedEvent ? (
            <EventInspector
              eventName={selectedEvent}
              agents={agents}
              onClose={() => setSelectedEvent(null)}
              onNavigateAgent={(id) => {
                setSelectedAgent(id);
                setSelectedEvent(null);
              }}
              onNavigateEvents={navEvents}
            />
          ) : editing ? (
            <DraftPalette
              workflowName={
                selectedSummary?.name ?? selectedWorkflow ?? "Workflow"
              }
              draft={draft}
              connectFrom={connectFrom}
              validation={validation}
              onAddAutomated={() => addAgent("Agent")}
              onAddHuman={() => addAgent("Human")}
            />
          ) : (
            <DefaultInspector
              events={events}
              agents={agents}
              onPick={setSelectedEvent}
            />
          )}
        </aside>
      </div>
      {showNewModal && (
        <NewWorkflowModal
          onClose={() => setShowNewModal(false)}
          onCreated={selectCreatedWorkflow}
          onImport={(target) => {
            setImportTarget(target);
            setShowImport(true);
          }}
        />
      )}
      {showImport && (
        <ImportManifestModal
          onClose={() => {
            setShowImport(false);
            setImportTarget(null);
            void catalogQuery.refetch();
            void dagQuery.refetch();
          }}
          mode="workflow"
          draftTarget={importTarget ?? undefined}
          onDraftCreated={selectCreatedWorkflow}
        />
      )}
      <WorkflowHelp open={showHelp} onClose={() => setShowHelp(false)} />
    </div>
  );
}
