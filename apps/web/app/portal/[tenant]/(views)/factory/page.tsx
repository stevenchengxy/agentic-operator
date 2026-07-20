"use client";

/**
 * Agent 工厂 — the autonomous Harness brain cockpit.
 *
 * Layout: a collapsible/searchable LEFT RAIL (本体连接 + 历史运行 w/ soft-delete + 草稿 + a pinned
 * 运行健康 strip), a CENTER that keeps the complete full-fidelity thinking transcript + composer
 * (with a filter strip salvaged from the old 轨迹 tab), and a RIGHT PANE consolidated from the
 * old six tabs into two standing surfaces — the LIVE CANVAS (stage rail + growing agent DAG,
 * the default) and a RUN SUMMARY — plus an on-demand agent inspector opened by clicking a node.
 * Everything is a pure projection of the same SSE BrainEvent stream, so a replayed historical
 * run renders the same canvas deterministically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ViewHeader, Badge, Button, FilterChip, Icon, HelpTip } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import {
  AGENT_FACTORY_DOMAIN_KEYS,
  type AgentFactoryDomainsResponse,
  type FactoryDomainBinding,
} from "@/lib/hooks/useAgentFactoryDomains";
import { FactoryRequestGate } from "@/lib/factory-request-gate";
import { useBrainStream, activeRunKey, type BrainEvent, type BrainStreamRequest } from "@/lib/hooks/useBrainStream";
import { AGENT_KEYS, COUNT_KEYS } from "@/lib/hooks/useStream";
import { isStopIntent } from "@/lib/factory-intent";
import { CodeBox, FullModal } from "./atoms";
import { TranscriptFeed, TRANSCRIPT_FILTERS, filterBlocks } from "./transcript";
import { InteractionDock } from "./interaction-dock"; // #W3-UI unified pending-interaction surface
import { EventGraph, FactorySpine } from "./canvas";
import { BrainFlow } from "./brain-flow";
import { ActivityLog } from "./activity-log";
import { AgentInspector } from "./inspector";
import { deriveSessionTasks } from "./workers";
import { AgentCardList, SandboxIOPanel } from "./agent-cards";
import { BusinessFlowPanel } from "./business-flow-panel"; // #BIZFLOW 业务流全景（推理生成）
import { BlueprintPanel } from "./blueprint-panel"; // #BLUEPRINT ontology-grounded 分阶段蓝图（build_blueprint 推理生成）
import { RunSummary } from "./run-summary";
import { CollapsibleSection, DomainList, HistoryList, DraftList } from "./left-rail";
import { BackgroundPanel } from "./background-panel";
import { DomainKnowledgePanel } from "./domain-knowledge-panel";
import { buildOntologyBundle, classifyAttachment } from "./ontology-upload";
import { SystemMap } from "./system-map";
import { buildHumanInteractionSubmission, decodeFactoryResponse, factoryNetworkFailure, type FactoryApiResult } from "./factory-api";
import { composeFactoryGoal, isFactoryRunStartReceipt, replayModeForStart, type FactoryRunStartReceipt } from "./factory-run-start";
import { buildFactoryGoalSuggestions } from "./factory-goals";
import {
  buildCasePayloadDecision,
  uploadBinaryFixtureAndInject,
  type BinaryFixtureFile,
  type BinaryFixturePlacement,
  type FixtureAssetReceipt,
} from "./test-fixtures";
import {
  PromotionReviewModal,
  isPromotionPreviewData,
  type PromotionApprovalResult,
  type PromotionCodeArtifact,
  type PromotionPreviewData,
} from "./promotion-review";
import { DraftEditorModal } from "./draft-editor-modal";
import { DraftSandboxModal } from "./draft-sandbox-modal";
import {
  humanDraftEditFailure,
  readDraftEditorContract,
  readPatchedDraftVersionReceipt,
  type DraftEditorContract,
  type StructuredDraftPatch,
} from "./draft-editor";
import {
  readDraftSandboxFinishReceipt,
  readDraftSandboxInputContract,
  readDraftSandboxReview,
  sandboxChallengeRef,
  type DraftSandboxFinishReceipt,
  type DraftSandboxInputContract,
  type DraftSandboxReview,
} from "./draft-sandbox";
import { toBlocks, deriveAgents, deriveScores, deriveStages, deriveBrainFlow, deriveAgentVersions, sandboxEvidenceStatus, isAnswerCompletion, type DomainRow, type RunRow, type DraftRow, type AgentIO, type AgentCardData, type Block } from "./model";

const EMPTY_RUNS: RunRow[] = [];
const EMPTY_DRAFTS: DraftRow[] = [];
const EMPTY_UPLOAD_IDS = new Set<string>();

function tenantHeaders(tenant: string): Record<string, string> {
  return { ...tenantHeader(), "x-agentic-tenant": tenant };
}

function isViewedTenant(tenant: string): boolean {
  return tenantHeader()["x-agentic-tenant"] === tenant;
}

async function apiGet<T>(tenant: string, path: string): Promise<FactoryApiResult<T>> {
  try {
    const r = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json", ...tenantHeaders(tenant) } });
    return await decodeFactoryResponse<T>(r);
  } catch (error) {
    return factoryNetworkFailure(error);
  }
}

async function apiSend<T = unknown>(tenant: string, path: string, method: "POST" | "PUT" | "PATCH" | "DELETE", body?: unknown): Promise<FactoryApiResult<T>> {
  // Only attach a JSON content-type when there's a body — Fastify 400s on an empty body with
  // `content-type: application/json` (FST_ERR_CTP_EMPTY_JSON_BODY). Matches useMe/useAccess.
  const headers: Record<string, string> = { Accept: "application/json", ...tenantHeaders(tenant) };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  try {
    const response = await fetch(path, { method, credentials: "same-origin", headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    return await decodeFactoryResponse<T>(response);
  } catch (error) {
    return factoryNetworkFailure(error);
  }
}

// #4/#2 — durable per-(tenant,bound-ontology) conversation id, so a follow-up message
// after a page reload / finished run RESUMES the thread (brain reloads prior context) instead of
// silently starting a fresh conversation that ignores history.
const convStoreKey = (tn: string, dm: string) => `ao:factory:conv:${tn}:${dm}`;

interface FactoryDomainsSnapshot {
  tenant: string;
  domains: DomainRow[];
  binding: FactoryDomainBinding | null;
  boundDomain: DomainRow | null;
  boundActions: AgentFactoryDomainsResponse["boundActions"];
  gatewayConfigured?: boolean;
}

interface ScopedRows<T> {
  tenant: string;
  domain: string;
  rows: T[];
}

type FactoryReadSurface = "domains" | "uploads" | "runs" | "deletedRuns" | "drafts";
type FactoryStartUiResult = { ok: true } | { ok: false; message: string | null };

export default function FactoryPage() {
  const { t } = useI18n();
  const tenant = useTenant();
  const queryClient = useQueryClient();
  const [requestGate] = useState(() => new FactoryRequestGate());
  const [domainsSnapshot, setDomainsSnapshot] = useState<FactoryDomainsSnapshot | null>(null);
  // A snapshot is renderable only for the URL tenant that produced it. This
  // prevents even a single paint of tenant A's binding after navigation to B.
  const currentDomains = domainsSnapshot?.tenant === tenant ? domainsSnapshot : null;
  const domains = currentDomains?.domains ?? [];
  const binding = currentDomains?.binding ?? null;
  const boundDomain = currentDomains?.boundDomain ?? null;
  const boundActions = currentDomains?.boundActions ?? [];
  const domain = boundDomain?.id ?? "";
  const gatewayOk = currentDomains?.gatewayConfigured !== false;
  const goalSuggestions = useMemo(
    () => buildFactoryGoalSuggestions(boundDomain, boundActions),
    [boundActions, boundDomain],
  );
  const [showDomainCatalog, setShowDomainCatalog] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [bindingErr, setBindingErr] = useState("");
  const [readErrors, setReadErrors] = useState<Partial<Record<FactoryReadSurface, string>>>({});
  const [actionErr, setActionErr] = useState("");
  const [runsSnapshot, setRunsSnapshot] = useState<ScopedRows<RunRow> | null>(null);
  const [deletedRunsSnapshot, setDeletedRunsSnapshot] = useState<ScopedRows<RunRow> | null>(null);
  const runs = runsSnapshot?.tenant === tenant && runsSnapshot.domain === domain ? runsSnapshot.rows : EMPTY_RUNS;
  const deletedRuns = deletedRunsSnapshot?.tenant === tenant && deletedRunsSnapshot.domain === domain ? deletedRunsSnapshot.rows : EMPTY_RUNS;
  const [showTrash, setShowTrash] = useState(false);
  const [draftsSnapshot, setDraftsSnapshot] = useState<ScopedRows<DraftRow> | null>(null);
  const drafts = draftsSnapshot?.tenant === tenant && draftsSnapshot.domain === domain ? draftsSnapshot.rows : EMPTY_DRAFTS;
  const [promoting, setPromoting] = useState(false);
  const [promoteMsg, setPromoteMsg] = useState("");
  const [promotionReview, setPromotionReview] = useState<{
    tenant: string;
    domain: string;
    preview: PromotionPreviewData;
    codeArtifacts: PromotionCodeArtifact[];
  } | null>(null);
  const [draftEditor, setDraftEditor] = useState<{ tenant: string; domain: string; contract: DraftEditorContract } | null>(null);
  const [editingDraftSlug, setEditingDraftSlug] = useState<string | null>(null);
  const [draftEditMsg, setDraftEditMsg] = useState("");
  const [draftSandbox, setDraftSandbox] = useState<{ tenant: string; domain: string; contract: DraftSandboxInputContract } | null>(null);
  const [sandboxingDraftSlug, setSandboxingDraftSlug] = useState<string | null>(null);
  const [draftSandboxMsg, setDraftSandboxMsg] = useState("");
  const [domainQuery, setDomainQuery] = useState("");
  const [goal, setGoal] = useState("");
  const [injectText, setInjectText] = useState("");
  // composer attachments: tool/reference docs the brain reads → create_tool. Ontology JSON dropped on
  // the SAME 📎 uploads and binds ontology JSON immediately (not a chip) — one entry, no separate modal.
  const [attached, setAttached] = useState<Array<{ name: string; text: string; kind: "tooldoc" }>>([]);
  const [composerErr, setComposerErr] = useState("");
  const [composerOk, setComposerOk] = useState(""); // green success note (e.g. 本体上传成功)
  const [uploadedSnapshot, setUploadedSnapshot] = useState<{ tenant: string; ids: Set<string> } | null>(null);
  const uploadedIds = uploadedSnapshot?.tenant === tenant ? uploadedSnapshot.ids : EMPTY_UPLOAD_IDS;
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [injectNote, setInjectNote] = useState("");
  const [injectFailed, setInjectFailed] = useState(false);
  const [injectBusy, setInjectBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [starting, setStarting] = useState(false);
  const startBusyRef = useRef(false);
  const [req, setReq] = useState<BrainStreamRequest | null>(null);
  const [viewingRun, setViewingRun] = useState<{ id: string; transcript: BrainEvent[] } | null>(null);
  // 右栏是常驻的「后台任务」sidebar（Claude-Desktop 式）——bg 是默认主视图；智能体/大脑/测试/总结按需切换。
  const [tab, setTab] = useState<"flow" | "brain" | "test" | "summary" | "bg">("bg");
  const [deliverView, setDeliverView] = useState<"cards" | "graph" | "biz" | "blueprint">("cards"); // #F — agent card list default; biz = #BIZFLOW 业务流全景; blueprint = #BLUEPRINT 分阶段蓝图
  const [brainView, setBrainView] = useState<"flow" | "log" | "map">("flow");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [transcriptFilter, setTranscriptFilter] = useState("all");
  const [filtersOpen, setFiltersOpen] = useState(false); // 筛选 chips revealed on demand (declutter)
  const [density, setDensity] = useState<"brief" | "full">("brief"); // 精简(里程碑分组+折叠) / 详尽(逐条+思考全文)
  const [routeOpen, setRouteOpen] = useState(false); // 决策路线 lens (BrainFlow pinned at transcript top)
  const [leftOpen, setLeftOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState<null | "flow" | "brain" | "test" | "summary" | "bg">(null);
  const [rightOpen, setRightOpen] = useState(true);
  // #RESIZE — manual sidebar widths (drag the rail edge), persisted per tenant.
  const [leftW, setLeftW] = useState(238);
  const [rightW, setRightW] = useState(440);
  const [resizing, setResizing] = useState<null | "left" | "right">(null);
  const [analysis, setAnalysis] = useState<Record<string, unknown> | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [modal, setModal] = useState<{ title: string; body: React.ReactNode } | null>(null);
  const convRef = useRef<string>("");
  // convId mirrors convRef for rendering (placeholder/button label); convRef is the stable value
  // async callbacks read at call time. setConv keeps both in sync.
  const [convId, setConvId] = useState("");
  const setConv = useCallback((id: string) => { convRef.current = id; setConvId(id); }, []);
  const setReadError = useCallback((surface: FactoryReadSurface, message?: string) => {
    setReadErrors((previous) => {
      if (message) return { ...previous, [surface]: message };
      if (!(surface in previous)) return previous;
      const next = { ...previous };
      delete next[surface];
      return next;
    });
  }, []);

  const refreshRuns = useCallback(() => {
    const scope = { tenant, domain };
    const ticket = requestGate.begin("runs", scope);
    if (!domain) {
      setRunsSnapshot(null);
      setReadError("runs");
      return;
    }
    void apiGet<{ runs: RunRow[] }>(tenant, `/v1/agent-factory/runs?domain=${encodeURIComponent(domain)}`).then((result) => {
      if (!requestGate.isCurrent(ticket, scope)) return;
      if (!result.ok) {
        setReadError("runs", `运行历史读取失败：${result.message}`);
        return;
      }
      if (!result.data || !Array.isArray(result.data.runs)) {
        setReadError("runs", "运行历史读取失败：接口响应结构无效");
        return;
      }
      setReadError("runs");
      setRunsSnapshot({ ...scope, rows: result.data.runs });
    });
  }, [domain, requestGate, setReadError, tenant]);
  // #5: recycle bin — list + restore soft-deleted runs (the delete button promised "可在回收站恢复").
  const refreshDeletedRuns = useCallback(() => {
    const scope = { tenant, domain };
    const ticket = requestGate.begin("deleted-runs", scope);
    if (!domain) {
      setDeletedRunsSnapshot(null);
      setReadError("deletedRuns");
      return;
    }
    void apiGet<{ runs: RunRow[] }>(tenant, `/v1/agent-factory/runs?domain=${encodeURIComponent(domain)}&deleted=true`).then((result) => {
      if (!requestGate.isCurrent(ticket, scope)) return;
      if (!result.ok) {
        setReadError("deletedRuns", `回收站读取失败：${result.message}`);
        return;
      }
      if (!result.data || !Array.isArray(result.data.runs)) {
        setReadError("deletedRuns", "回收站读取失败：接口响应结构无效");
        return;
      }
      setReadError("deletedRuns");
      setDeletedRunsSnapshot({ ...scope, rows: result.data.runs });
    });
  }, [domain, requestGate, setReadError, tenant]);
  const toggleTrash = useCallback(() => { setShowTrash((v) => { const next = !v; if (next) refreshDeletedRuns(); return next; }); }, [refreshDeletedRuns]);
  const restoreRunUi = async (id: string) => {
    const scope = { tenant, domain };
    const ticket = requestGate.begin("run-mutation", scope);
    setActionErr("");
    const result = await apiSend<{ restored: boolean }>(tenant, `/v1/agent-factory/runs/${encodeURIComponent(id)}/restore`, "POST");
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
    if (!result.ok || result.data.restored !== true) {
      setActionErr(`恢复运行失败：${result.ok ? "服务端未确认恢复" : result.message}`);
      return;
    }
    refreshDeletedRuns();
    refreshRuns();
  };
  const refreshDrafts = useCallback(() => {
    const scope = { tenant, domain };
    const ticket = requestGate.begin("drafts", scope);
    if (!domain) {
      setDraftsSnapshot(null);
      setReadError("drafts");
      return;
    }
    void apiGet<{ drafts: DraftRow[] }>(tenant, `/v1/agent-factory/drafts?domain=${encodeURIComponent(domain)}`).then((result) => {
      if (!requestGate.isCurrent(ticket, scope)) return;
      if (!result.ok) {
        setReadError("drafts", `草稿读取失败：${result.message}`);
        return;
      }
      if (!result.data || !Array.isArray(result.data.drafts)) {
        setReadError("drafts", "草稿读取失败：接口响应结构无效");
        return;
      }
      setReadError("drafts");
      setDraftsSnapshot({ ...scope, rows: result.data.drafts });
    });
  }, [domain, requestGate, setReadError, tenant]);
  const refreshDomains = useCallback(async () => {
    const scope = { tenant };
    const ticket = requestGate.begin("domains", scope);
    const result = await apiGet<{
      domains: DomainRow[];
      binding: FactoryDomainBinding | null;
      boundDomain: DomainRow | null;
      boundActions: AgentFactoryDomainsResponse["boundActions"];
      gatewayConfigured?: boolean;
    }>(tenant, "/v1/agent-factory/domains");
    if (!requestGate.isCurrent(ticket, scope)) return;
    if (!result.ok) {
      setReadError("domains", `本体连接读取失败：${result.message}`);
      return;
    }
    if (
      !result.data ||
      !Array.isArray(result.data.domains) ||
      !Array.isArray(result.data.boundActions) ||
      !result.data.boundActions.every(
        (action) => typeof action?.name === "string",
      )
    ) {
      setReadError("domains", "本体连接读取失败：接口响应结构无效");
      return;
    }
    setReadError("domains");
    // The executable ontology always comes from this persisted binding.
    // Catalog order, URL params, and browser storage never select it.
    setDomainsSnapshot({ tenant, ...result.data });
  }, [requestGate, setReadError, tenant]);
  // Which domains came from a 📎 upload — so the left rail can offer an inline 🗑 on exactly those
  // rows (built-in / Allmeta domains stay undeletable). Kept as a Set of domainId.
  const refreshUploaded = useCallback(async () => {
    const scope = { tenant };
    const ticket = requestGate.begin("uploads", scope);
    const result = await apiGet<{ uploads: Array<{ id: string }> }>(tenant, "/v1/agent-factory/ontology-uploads");
    if (!requestGate.isCurrent(ticket, scope)) return;
    if (!result.ok) {
      setReadError("uploads", `上传本体目录读取失败：${result.message}`);
      return;
    }
    if (!result.data || !Array.isArray(result.data.uploads)) {
      setReadError("uploads", "上传本体目录读取失败：接口响应结构无效");
      return;
    }
    setReadError("uploads");
    setUploadedSnapshot({ tenant, ids: new Set(result.data.uploads.map((u) => u.id)) });
  }, [requestGate, setReadError, tenant]);
  useEffect(() => {
    // Dynamic-route navigation may reuse the component. Clear the previous
    // tenant's identity before loading the new tenant-scoped binding/catalog.
    setDomainsSnapshot(null);
    setRunsSnapshot(null);
    setDeletedRunsSnapshot(null);
    setDraftsSnapshot(null);
    setUploadedSnapshot(null);
    setConv("");
    setReq(null);
    setViewingRun(null);
    setGoal("");
    setAttached([]);
    setComposerErr("");
    setComposerOk("");
    setInjectText("");
    setInjectNote("");
    setInjectFailed(false);
    setInjectBusy(false);
    setStopping(false);
    setStarting(false);
    startBusyRef.current = false;
    setReadErrors({});
    setActionErr("");
    setAnalysis(null);
    setAnalyzing(false);
    setPromoteMsg("");
    setPromoting(false);
    setPromotionReview(null);
    setDraftEditor(null);
    setEditingDraftSlug(null);
    setDraftEditMsg("");
    setDraftSandbox(null);
    setSandboxingDraftSlug(null);
    setDraftSandboxMsg("");
    setSelectedSlug(null);
    setShowTrash(false);
    setModal(null);
    setDomainQuery("");
    if (fileRef.current) fileRef.current.value = "";
    setBindingBusy(false);
    setShowDomainCatalog(false);
    setBindingErr("");
    // Cancel slow actions/reads started by the component instance before
    // Next reused it for this new dynamic-route tenant.
    requestGate.begin("domain-mutation", { tenant });
    requestGate.invalidate("open-run");
    requestGate.invalidate("analyze-run");
    requestGate.invalidate("promote");
    requestGate.invalidate("draft-editor");
    requestGate.invalidate("draft-sandbox");
    requestGate.invalidate("start-run");
    void refreshDomains();
    void refreshUploaded();
  }, [tenant, refreshDomains, refreshUploaded, requestGate, setConv]);
  useEffect(() => { refreshRuns(); }, [refreshRuns]);
  useEffect(() => { refreshDrafts(); }, [refreshDrafts, runs]);
  useEffect(() => {
    // A rebind within the same tenant is also a hard data-scope change.
    requestGate.invalidate("open-run");
    requestGate.invalidate("run-mutation");
    requestGate.invalidate("draft-mutation");
    requestGate.invalidate("analyze-run");
    requestGate.invalidate("promote");
    requestGate.invalidate("draft-editor");
    requestGate.invalidate("draft-sandbox");
    requestGate.invalidate("start-run");
    startBusyRef.current = false;
    setStarting(false);
    setViewingRun(null);
    setAnalysis(null);
    setAnalyzing(false);
    setPromoting(false);
    setPromotionReview(null);
    setDraftEditor(null);
    setEditingDraftSlug(null);
    setDraftEditMsg("");
    setDraftSandbox(null);
    setSandboxingDraftSlug(null);
    setDraftSandboxMsg("");
  }, [domain, requestGate, tenant]);
  useEffect(() => { try { const v = localStorage.getItem(`ao:factory:leftOpen:${tenant}`); if (v != null) setLeftOpen(v === "1"); } catch { /* ignore */ } }, [tenant]);
  const toggleLeft = () => setLeftOpen((o) => { const n = !o; try { localStorage.setItem(`ao:factory:leftOpen:${tenant}`, n ? "1" : "0"); } catch { /* ignore */ } return n; });
  useEffect(() => { try { const v = localStorage.getItem(`ao:factory:rightOpen:${tenant}`); if (v != null) setRightOpen(v === "1"); } catch { /* ignore */ } }, [tenant]);
  const toggleRight = () => setRightOpen((o) => { const n = !o; try { localStorage.setItem(`ao:factory:rightOpen:${tenant}`, n ? "1" : "0"); } catch { /* ignore */ } return n; });
  // #RESIZE — restore persisted sidebar widths + density; clamp so a bad stored value can't wedge the layout.
  const clampLeft = (v: number) => Math.min(420, Math.max(180, Math.round(v)));
  const clampRight = (v: number) => Math.min(760, Math.max(320, Math.round(v)));
  useEffect(() => {
    try {
      const l = Number(localStorage.getItem(`ao:factory:leftW:${tenant}`)); if (Number.isFinite(l) && l > 0) setLeftW(clampLeft(l));
      const r = Number(localStorage.getItem(`ao:factory:rightW:${tenant}`)); if (Number.isFinite(r) && r > 0) setRightW(clampRight(r));
      const d = localStorage.getItem(`ao:factory:density:${tenant}`); if (d === "brief" || d === "full") setDensity(d);
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);
  const pickDensity = (d: "brief" | "full") => { setDensity(d); try { localStorage.setItem(`ao:factory:density:${tenant}`, d); } catch { /* ignore */ } };
  // Drag a rail edge: pointer-move updates the width live; release persists it. Bound to window so
  // the drag survives leaving the handle; `resizing` also disables the grid transition (no lag).
  const beginResize = (side: "left" | "right") => (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftW : rightW;
    setResizing(side);
    const move = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      if (side === "left") setLeftW(clampLeft(startW + delta));
      else setRightW(clampRight(startW - delta));
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      setResizing(null);
      const finalW = side === "left" ? clampLeft(startW + (ev.clientX - startX)) : clampRight(startW - (ev.clientX - startX));
      try { localStorage.setItem(`ao:factory:${side}W:${tenant}`, String(finalW)); } catch { /* ignore */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const { events: liveEvents, running, runId, error: streamError } = useBrainStream(req);
  useEffect(() => { if (!running && req) refreshRuns(); }, [running, req, refreshRuns]);
  useEffect(() => {
    try {
      // Reconnect to a still-live background run by its id (SSE replays its full buffer).
      // The durable conversation id is restored separately below for the next JSON start.
      const active = localStorage.getItem(activeRunKey(tenant));
      if (active) setReq({ tenant, reconnectRunId: active, nonce: Date.now() });
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant]);
  // #4/#2 — restore the durable conversation id for the active (tenant, domain) so the NEXT
  // message continues the thread (the brain reloads prior messages + ctx) rather than starting
  // over. Skips when already in a conversation or replaying a historical run.
  useEffect(() => {
    if (!domain || convRef.current || viewingRun) return;
    try { const stored = localStorage.getItem(convStoreKey(tenant, domain)); if (stored) setConv(stored); } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenant, domain]);

  const stop = async () => {
    if (stopping) return;
    if (!runId) {
      setInjectFailed(true);
      setInjectNote("停止失败：当前没有可定位的运行 ID。");
      return;
    }
    setInjectNote("正在停止运行…");
    setInjectFailed(false);
    setStopping(true);
    try {
      const result = await apiSend<{ aborted: boolean; finalized: boolean }>(tenant, "/v1/agent-factory/stop", "POST", { runId });
      if (!isViewedTenant(tenant)) return;
      if (!result.ok || (!result.data.aborted && !result.data.finalized)) {
        setInjectFailed(true);
        setInjectNote(`停止失败：${result.ok ? "服务端未确认运行已中止" : result.message}`);
        return;
      }
      setInjectNote("✓ 已提交停止请求，等待运行结束事件。");
    } finally {
      if (isViewedTenant(tenant)) setStopping(false);
    }
  };

  const events = viewingRun ? viewingRun.transcript : liveEvents;
  const blocks = useMemo(() => toBlocks(events), [events]);
  const agents = useMemo(() => deriveAgents(events), [events]);
  const scores = useMemo(() => deriveScores(events), [events]);
  const { stages, current } = useMemo(() => deriveStages(events), [events]);
  const brainSteps = useMemo(() => deriveBrainFlow(events), [events]);
  const agentVersions = useMemo(() => deriveAgentVersions(events), [events]);
  const degraded = useMemo(() => new Set(events.filter((e) => e.t === "inspect" && (e as Record<string, unknown>).degraded).map((e) => String((e as Record<string, unknown>).agentSlug ?? ""))), [events]);
  const refineCount = useMemo(() => events.filter((e) => e.t === "refine").length, [events]);
  const lastValidation = useMemo(() => [...events].reverse().find((e) => e.t === "validation") as { ok: boolean; issues: string[] } | undefined, [events]);
  const evidenceStatus = useMemo(() => sandboxEvidenceStatus(events), [events]);
  const lastSandbox = useMemo(
    () =>
      [...events]
        .reverse()
        .find((e) => e.t === "sandbox" && !e.simulated) as
        | Record<string, unknown>
        | undefined,
    [events],
  );
  // #F — panel data: per-agent real I/O (keyed by short), the fired test cases (with input payload).
  const sandboxRuns = useMemo<AgentIO[]>(() => (lastSandbox?.agentRuns as AgentIO[] | undefined) ?? [], [lastSandbox]);
  const ioByShort = useMemo(() => { const m = new Map<string, AgentIO>(); for (const r of sandboxRuns) m.set(r.agentShort, r); return m; }, [sandboxRuns]);
  const testCaseList = useMemo(() => { const tc = [...blocks].reverse().find((b) => b.kind === "testcases") as Extract<Block, { kind: "testcases" }> | undefined; return tc?.cases ?? []; }, [blocks]);
  const lastBudget = useMemo(() => [...events].reverse().find((e) => e.t === "budget") as Record<string, unknown> | undefined, [events]);
  const awaitingHint = useMemo(() => {
    if ([...blocks].reverse().find((b) => b.kind === "clarify" && b.awaiting)) return "回答大脑的提问";
    if ([...blocks].reverse().find((b) => b.kind === "boundarycases" && b.awaiting)) return "边界事件分类";
    if ([...blocks].reverse().find((b) => b.kind === "testcases" && b.awaiting)) return "测试用例确认";
    return null;
  }, [blocks]);
  const waitingHuman = useMemo(() => {
    const done = [...events].reverse().find((event) => event.t === "done");
    return done?.status === "waiting_human";
  }, [events]);
  const answerCompleted = useMemo(() => {
    const done = [...blocks].reverse().find((block) => block.kind === "done") as Extract<Block, { kind: "done" }> | undefined;
    return Boolean(done && isAnswerCompletion(done.status, done.completionKind));
  }, [blocks]);

  const healthChecks = useMemo(() => answerCompleted ? [
    { ok: true, label: "回答已完成（未产生交付或沙箱证据）" },
  ] : [
    { ok: agents.length > 0, label: `已设计 ${agents.length} 个智能体` },
    { ok: agents.length ? agents.every((a) => a.tools.length > 0) : undefined, label: "工具全绑定" },
    { ok: agents.length ? agents.every((a) => !!a.code) : undefined, label: "代码齐全" },
    { ok: lastValidation ? lastValidation.ok : undefined, label: "事件图闭合" },
    {
      ok: lastSandbox
        ? Boolean(lastSandbox.fullChainRan || lastSandbox.reachedSuccessTerminal)
        : evidenceStatus === "simulated_only"
          ? false
          : undefined,
      label:
        evidenceStatus === "simulated_only"
          ? "沙箱证据无效（历史模拟，未真实执行）"
          : "沙箱端到端真实跑通",
    },
  ], [agents, answerCompleted, evidenceStatus, lastValidation, lastSandbox]);

  const filteredBlocks = useMemo(() => filterBlocks(blocks, transcriptFilter), [blocks, transcriptFilter]);
  const feedRef = useRef<HTMLDivElement>(null);
  // Follow the LIVE stream: events.length ticks on every frame (each streamed think delta is its
  // own event), so the transcript tracks reasoning as it's written — block.length alone misses
  // in-place updates (a growing think buffer, a tool.result summary). Filter changes don't scroll.
  useEffect(() => { feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight }); }, [events.length]);

  const selectedAgent = useMemo<AgentCardData | null>(() => agents.find((a) => a.slug === selectedSlug) ?? null, [agents, selectedSlug]);
  const selectedIo = useMemo<AgentIO | undefined>(() => {
    if (!selectedAgent) return undefined;
    const runsIo = (lastSandbox?.agentRuns as AgentIO[] | undefined) ?? [];
    return runsIo.find((r) => r.agentShort === selectedAgent.short);
  }, [selectedAgent, lastSandbox]);
  const selectedScore = selectedAgent ? scores.get(selectedAgent.actionName) : undefined;
  // #per-agent-think — the selected agent's process task (its own reasoning stream). Derived only
  // while an inspector is open; skips the projection entirely on the common no-selection path.
  const selectedTask = useMemo(() => {
    if (!selectedAgent) return undefined;
    return deriveSessionTasks(events, running).find((t) => t.agentSlug === selectedAgent.slug);
  }, [selectedAgent, events, running]);

  // ── actions ──
  // Reset the in-memory conversation view WITHOUT touching durable storage (so switching domains
  // keeps each domain's saved thread). 新会话 additionally drops the current domain's saved thread.
  const resetConversation = () => {
    requestGate.invalidate("start-run");
    startBusyRef.current = false;
    setStarting(false);
    setConv("");
    setReq(null);
    setViewingRun(null);
    setSelectedSlug(null);
    setTab("bg");
    setAnalysis(null);
  };
  const newConversation = () => {
    // Drop this domain's saved thread AND the reconnect handle, so a fresh start isn't hijacked by
    // the on-mount reconnect effect resurrecting the previous run.
    try { localStorage.removeItem(convStoreKey(tenant, domain)); localStorage.removeItem(activeRunKey(tenant)); } catch { /* ignore */ }
    resetConversation();
  };

  const connectOntology = async (ontologyDomainId: string) => {
    if (bindingBusy || running || starting) return;
    if (binding?.ontologyDomainId === ontologyDomainId && boundDomain) {
      setShowDomainCatalog(false);
      return;
    }
    const changing = Boolean(binding && binding.ontologyDomainId !== ontologyDomainId);
    if (
      changing &&
      !window.confirm(
        `确认把运行领域「${tenant}」从本体「${binding?.ontologyDomainName ?? binding?.ontologyDomainId}」切换到「${domains.find((d) => d.id === ontologyDomainId)?.name ?? ontologyDomainId}」？\n\n旧本体的历史运行和草稿不会被当作新本体的内容。`,
      )
    ) return;

    const mutationTicket = requestGate.begin("domain-mutation", { tenant });
    setBindingBusy(true);
    setBindingErr("");
    try {
      const result = await apiSend<{ binding: FactoryDomainBinding; boundDomain: DomainRow }>(
        tenant,
        "/v1/agent-factory/domain-binding",
        "PUT",
        { ontologyDomainId, confirmRebind: changing },
      );
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(mutationTicket, { tenant })) return;
      if (!result.ok) {
        setBindingErr(`连接失败：${result.message}`);
        return;
      }
      if (!result.data?.binding?.ontologyDomainId || !result.data.boundDomain?.id || result.data.binding.ontologyDomainId !== result.data.boundDomain.id) {
        setBindingErr("连接失败：服务端未返回一致的本体连接凭据");
        return;
      }
      resetConversation();
      setDomainsSnapshot({
        tenant,
        domains,
        binding: result.data.binding,
        boundDomain: result.data.boundDomain,
        boundActions: [],
        gatewayConfigured: currentDomains?.gatewayConfigured,
      });
      setShowDomainCatalog(false);
      await refreshDomains();
      await queryClient.invalidateQueries({ queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant) });
    } catch (e) {
      if (isViewedTenant(tenant) && requestGate.isCurrent(mutationTicket, { tenant })) {
        setBindingErr(`连接失败：${(e as Error).message}`);
      }
    } finally {
      if (isViewedTenant(tenant) && requestGate.isCurrent(mutationTicket, { tenant })) {
        setBindingBusy(false);
      }
    }
  };

  // 📎 is the SINGLE upload entry (no separate 本地本体 modal). Read every File into a plain
  // {name,text} SNAPSHOT FIRST, then clear the input — never read from the live input.files after
  // clearing it (doing so emptied the same live FileList and crashed on undefined.name). Then split
  // by CONTENT: ontology-shaped JSON → merged into ONE uploaded ontology (then explicitly bound); everything else
  // (tool/API doc, OpenAPI, prose) → a composer chip the brain reads + turns into tools via create_tool.
  const onAttachFiles = async (files: FileList | null) => {
    if (!files) return;
    setComposerErr(""); setComposerOk("");
    const snaps: Array<{ name: string; text: string }> = [];
    const readFailures: string[] = [];
    const emptyFiles: string[] = [];
    for (const f of Array.from(files)) {
      try {
        const text = await f.text();
        if (text.length > 0) snaps.push({ name: f.name, text });
        else emptyFiles.push(f.name);
      } catch {
        readFailures.push(f.name);
      }
    }
    if (fileRef.current) fileRef.current.value = ""; // safe now — we hold snapshots, not the FileList.
    if (!isViewedTenant(tenant)) return;
    const ontologyFiles: Array<{ name: string; text: string }> = [];
    const docFiles: Array<{ name: string; text: string }> = [];
    const malformed: string[] = []; // {/[-leading but unparseable → a BROKEN ontology fragment; must NOT be
    for (const s of snaps) {         // silently swallowed into a tool-doc chip (invariant: 坏文件绝不被成功提示吞掉).
      if (classifyAttachment(s.name, s.text) === "ontology") { ontologyFiles.push(s); continue; }
      const head = s.text.trim()[0];
      const parses = (() => { try { JSON.parse(s.text.trim()); return true; } catch { return false; } })();
      if ((head === "{" || head === "[") && !parses) { malformed.push(s.name); continue; }
      docFiles.push(s);
    }
    const readIssue = [
      readFailures.length ? `无法读取：${readFailures.map((name) => `「${name}」`).join("、")}` : "",
      emptyFiles.length ? `空文件：${emptyFiles.map((name) => `「${name}」`).join("、")}` : "",
    ].filter(Boolean).join("；");
    if (readIssue) setComposerErr(`${readIssue}。这些文件未被加入，请修复后重试。`);
    if (docFiles.length) setAttached((prev) => [...prev, ...docFiles.map((d) => ({ ...d, kind: "tooldoc" as const }))]);
    if (ontologyFiles.length) await uploadOntology(ontologyFiles, malformed);
    else if (malformed.length) setComposerErr((previous) => `${previous ? `${previous} ` : ""}${malformed.map((n) => `「${n}」`).join("、")} 不是合法 JSON，已跳过——请修正后重新上传。`);
  };

  // Merge ontology fragments into ONE bundle. If the tenant is already bound, this is an overlay
  // for that exact ontology id. If it is unbound, uploading creates and explicitly binds a new
  // tenant-scoped ontology; no catalog item is chosen implicitly.
  const uploadOntology = async (files: Array<{ name: string; text: string }>, malformed: string[] = []) => {
    // File.text() above is async; the operator may have navigated to another
    // tenant while it was reading. Never let that old attachment start a
    // mutation (or supersede the new tenant's mutation token).
    if (!isViewedTenant(tenant)) return;
    const { bundle, skipped, actionCount, eventCount, ruleCount } = buildOntologyBundle(files);
    const skipList = [...skipped, ...malformed];
    const skipNote = skipList.length ? ` 已跳过非法 JSON：${skipList.map((n) => `「${n}」`).join("、")}。` : "";
    if (!actionCount) { setComposerErr(`上传内容里没有任何 action，无法作为本体使用。${skipNote}`); return; }
    const fallbackName = files.length === 1
      ? files[0]!.name.replace(/\.[^.]+$/, "") || `${tenant} 本体`
      : `${tenant} 本体`;
    const targetName = boundDomain?.name ?? boundDomain?.id ?? fallbackName;
    const mutationTicket = requestGate.begin("domain-mutation", { tenant });
    try {
      const result = await apiSend<{ uploaded?: { id?: string; name?: string } }>(tenant, "/v1/agent-factory/ontology-upload", "POST", { name: targetName, ontology: bundle, ...(domain ? { domainId: domain } : {}) });
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(mutationTicket, { tenant })) return;
      if (!result.ok) { setComposerErr(`本体上传失败：${result.message}${skipNote}`); return; }
      if (!result.data?.uploaded?.id) { setComposerErr(`本体上传失败：服务端未返回上传 ID${skipNote}`); return; }
      const nm: string = result.data.uploaded.name ?? targetName;
      resetConversation();
      await refreshDomains(); await refreshUploaded();
      await queryClient.invalidateQueries({ queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant) });
      const mergedNote = files.length > 1 ? `${files.length} 个文件合并 → ` : "";
      setComposerOk(`✓ ${mergedNote}已上传并连接本体「${nm}」（${actionCount} 动作 · ${eventCount} 事件 · ${ruleCount} 规则），可直接在下方描述目标开始。${skipNote}`);
    } catch (e) {
      if (isViewedTenant(tenant) && requestGate.isCurrent(mutationTicket, { tenant })) {
        setComposerErr(`本体上传失败：${(e as Error).message}${skipNote}`);
      }
    }
  };

  // Inline delete for a tenant upload. The server re-evaluates the persisted binding; this page
  // never replaces it with the first remaining catalog item.
  const deleteUploadedDomain = async (id: string, nm: string) => {
    if (running || starting) {
      setBindingErr(starting ? "运行启动请求正在提交，暂时不能删除本体。" : "运行进行中，不能删除当前租户的本体上传；请先停止运行。");
      return;
    }
    if (!window.confirm(`删除「${nm}」这份上传的本体？若连接因此失效，Agent 工厂会停止执行，直到你显式连接另一个本体。`)) return;
    const mutationTicket = requestGate.begin("domain-mutation", { tenant });
    const result = await apiSend<{ deleted: boolean }>(tenant, `/v1/agent-factory/ontology-uploads/${encodeURIComponent(id)}`, "DELETE");
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(mutationTicket, { tenant })) return;
    if (!result.ok || result.data.deleted !== true) {
      setBindingErr(`删除本体失败：${result.ok ? "服务端未确认删除" : result.message}`);
      return;
    }
    await refreshDomains(); await refreshUploaded();
    await queryClient.invalidateQueries({ queryKey: AGENT_FACTORY_DOMAIN_KEYS.tenant(tenant) });
    if (domain === id) resetConversation();
  };

  const startFactoryRun = async (runDomain: string, finalGoal: string, conversation?: string): Promise<FactoryStartUiResult> => {
    if (startBusyRef.current) return { ok: false, message: "已有启动请求正在提交，请等待服务端确认。" };
    const scope = { tenant, domain: runDomain };
    const ticket = requestGate.begin("start-run", scope);
    const priorConversation = conversation?.trim() || undefined;
    startBusyRef.current = true;
    setStarting(true);
    try {
      const result = await apiSend<FactoryRunStartReceipt>(tenant, "/v1/agent-factory/runs/start", "POST", {
        domain: runDomain,
        goal: finalGoal,
        ...(priorConversation ? { conversation: priorConversation } : {}),
      });
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return { ok: false, message: null };
      if (!result.ok) {
        const message = result.status === 413
          ? `附件或目标内容超过服务端允许的请求大小：${result.message}${result.code ? `（${result.code}）` : ""}`
          : result.message;
        return { ok: false, message };
      }
      if (result.status !== 202) return { ok: false, message: `服务端返回 HTTP ${result.status}，未确认运行已异步启动。` };
      if (!isFactoryRunStartReceipt(result.data)) return { ok: false, message: "服务端启动回执结构无效。" };
      if (result.data.mode === "attached" && !priorConversation) {
        return { ok: false, message: "服务端返回 attached，但请求没有可附着的会话。" };
      }

      const conversationId = priorConversation ?? result.data.runId;
      setConv(conversationId);
      try {
        localStorage.setItem(convStoreKey(tenant, runDomain), conversationId);
      } catch {
        setActionErr("运行已启动，但浏览器无法保存会话标识；刷新后可能需要从历史运行重新打开。");
      }
      setViewingRun(null);
      setSelectedSlug(null);
      setReq({
        tenant,
        reconnectRunId: result.data.runId,
        conversation: conversationId,
        replayMode: replayModeForStart(result.data, Boolean(priorConversation)),
        nonce: Date.now(),
      });
      return { ok: true };
    } finally {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) {
        startBusyRef.current = false;
        setStarting(false);
      }
    }
  };

  const submit = async () => {
    if (running || starting) return;
    setComposerErr(""); setComposerOk("");
    const docs = attached; // 工具/参考文档随 goal 发送；本体已在上传时持久化并建立连接
    const runDomain = domain;
    if (!runDomain) { setComposerErr("请先把当前运行领域连接到一个本体，或点 📎 上传本体 JSON 并建立连接。"); return; }
    if (!goal.trim() && !docs.length) return;
    // Preserve every attachment byte in the JSON body. The API owns the configurable
    // size limit and returns an explicit 413 instead of this client silently truncating.
    const finalGoal = composeFactoryGoal(goal, docs);
    const started = await startFactoryRun(runDomain, finalGoal, convRef.current || undefined);
    if (!started.ok) {
      if (started.message) setComposerErr(`启动失败：${started.message}`);
      return;
    }
    setGoal(""); setAttached([]);
  };
  const inject = async () => {
    if (injectBusy) return;
    const text = injectText.trim();
    if (!text) return;
    if (isStopIntent(text)) { setInjectText(""); await stop(); return; }
    if (!convRef.current) {
      setInjectFailed(true);
      setInjectNote("发送失败：当前运行没有可定位的会话 ID。");
      return;
    }
    setInjectText("");
    setInjectFailed(false);
    setInjectNote("发送中…");
    setInjectBusy(true);
    // #4: read back whether a live brain will drain this NOW vs save it for the next continue, so
    // the user gets honest feedback instead of an inject silently vanishing into an idle mailbox.
    const result = await apiSend<{ queued: boolean; active: boolean }>(tenant, "/v1/agent-factory/inject", "POST", { conversation: convRef.current, text });
    if (!isViewedTenant(tenant)) return;
    setInjectBusy(false);
    if (!result.ok || result.data.queued !== true) {
      setInjectFailed(true);
      setInjectNote(`发送失败：${result.ok ? "服务端未确认消息已入队" : result.message}`);
      setInjectText((current) => current || text);
      return;
    }
    if (result.data.active === false) setInjectNote("已持久化——当前没有正在运行的任务，下次继续这个对话时会自动带上你的补充。");
    else setInjectNote("✓ 已发送，将在下一步纳入");
  };
  const sendInteraction = async (
    interactionId: string,
    kind: "clarify" | "test_approval" | "boundary",
    text: string,
  ) => {
    if (!convRef.current) throw new Error("当前运行没有可定位的会话 ID");
    const conversationId = convRef.current;
    const result = await apiSend<{ queued: boolean; active: boolean; resumed?: boolean; runId?: string }>(tenant, "/v1/agent-factory/inject", "POST", buildHumanInteractionSubmission({ conversation: conversationId, interactionId, kind, text }));
    if (!result.ok || result.data.queued !== true) throw new Error(result.ok ? "服务端未确认决策已入队" : result.message);
    if (result.data.resumed && result.data.runId) {
      setViewingRun(null);
      setReq({
        tenant,
        reconnectRunId: result.data.runId,
        conversation: conversationId,
        replayMode: "append",
        nonce: Date.now(),
      });
    }
  };
  const replaceTestPayload = async (interactionId: string, caseId: string, payload: Record<string, unknown>) => {
    await sendInteraction(interactionId, "test_approval", buildCasePayloadDecision(caseId, payload));
  };
  const uploadTestBinary = async (interactionId: string, input: {
    caseId: string;
    path: string;
    placement: BinaryFixturePlacement;
    file: BinaryFixtureFile;
  }): Promise<FixtureAssetReceipt> => {
    if (!runId) throw new Error("当前运行没有可定位的 run id，无法创建隔离文件资产");
    return uploadBinaryFixtureAndInject({
      runId,
      ...input,
      upload: (path, body) => apiSend<FixtureAssetReceipt>(tenant, path, "POST", body),
      inject: (text) => sendInteraction(interactionId, "test_approval", text),
    });
  };
  const decideBoundary = async (interactionId: string, evs: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => {
    await sendInteraction(interactionId, "boundary", `[边界事件决策] ${JSON.stringify(evs)}`);
  };
  const decideTestCases = async (interactionId: string, decision: "approve" | "regenerate", note?: string) => {
    await sendInteraction(interactionId, "test_approval", `[测试用例决策: ${decision === "approve" ? "执行" : "重新生成"}] ${note ?? ""}`.trim());
  };
  const decideClarify = async (interactionId: string, answer: string) => {
    await sendInteraction(interactionId, "clarify", `[澄清回答] ${answer}`);
  };
  // R12: supplement + regenerate ONE agent. Inject while a run is live; otherwise resume the
  // conversation with a scoped directive so the brain re-designs only this agent.
  const regenerateAgent = async (actionName: string, supplement: string) => {
    if (!domain) {
      setComposerErr("当前运行领域没有可用的本体连接，无法重新生成智能体。");
      throw new Error("当前运行领域没有可用的本体连接，无法重新生成智能体。");
    }
    const directive = `请只重新设计 agent「${actionName}」${supplement ? `，补充信息：${supplement}` : ""}，别动其它已采纳的 agent。`;
    if (running && convRef.current) {
      const result = await apiSend<{ queued: boolean; active: boolean }>(tenant, "/v1/agent-factory/inject", "POST", { conversation: convRef.current, text: directive });
      if (!result.ok || result.data.queued !== true) throw new Error(`重新生成请求失败：${result.ok ? "服务端未确认请求已入队" : result.message}`);
      return;
    }
    const started = await startFactoryRun(domain, directive, convRef.current || undefined);
    if (!started.ok && started.message) throw new Error(`重新生成请求失败：${started.message}`);
  };
  const openRun = async (id: string) => {
    const scope = { tenant, domain };
    const ticket = requestGate.begin("open-run", scope);
    setActionErr("");
    const result = await apiGet<{ run: { transcript: BrainEvent[]; status?: string; domain?: string } }>(tenant, `/v1/agent-factory/runs/${encodeURIComponent(id)}`);
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
    if (!result.ok) {
      setActionErr(`运行详情读取失败：${result.message}`);
      return;
    }
    if (!result.data?.run || !Array.isArray(result.data.run.transcript)) {
      setActionErr("运行详情读取失败：接口响应结构无效");
      return;
    }
    if (result.data.run.status === "waiting_human") {
      setConv(id);
      try { localStorage.setItem(convStoreKey(tenant, result.data.run.domain ?? domain), id); } catch { /* replay remains usable in this tab */ }
      setViewingRun(null);
      setReq({ tenant, reconnectRunId: id, conversation: id, replayMode: "replace", nonce: Date.now() });
    } else {
      setViewingRun({ id, transcript: result.data.run.transcript });
      setReq(null);
    }
    setSelectedSlug(null); setTab("flow");
  };
  const deleteRunUi = async (id: string) => {
    if (!window.confirm("删除该运行？(软删除，可在「回收站」恢复)")) return;
    const scope = { tenant, domain };
    const ticket = requestGate.begin("run-mutation", scope);
    setActionErr("");
    const result = await apiSend<{ deleted: boolean }>(tenant, `/v1/agent-factory/runs/${encodeURIComponent(id)}`, "DELETE");
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
    if (!result.ok || result.data.deleted !== true) {
      setActionErr(`删除运行失败：${result.ok ? "服务端未确认删除" : result.message}`);
      return;
    }
    if (viewingRun?.id === id) setViewingRun(null);
    refreshRuns();
    if (showTrash) refreshDeletedRuns();
  };
  const clearRunsUi = async () => {
    if (!domain || !window.confirm("清空当前本体连接下所有已完成的运行？(软删除)")) return;
    const scope = { tenant, domain };
    const ticket = requestGate.begin("run-mutation", scope);
    setActionErr("");
    const result = await apiSend<{ cleared: number }>(tenant, `/v1/agent-factory/runs?domain=${encodeURIComponent(domain)}`, "DELETE");
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
    if (!result.ok || typeof result.data.cleared !== "number") {
      setActionErr(`清空运行失败：${result.ok ? "服务端未返回清空数量" : result.message}`);
      return;
    }
    refreshRuns();
  };
  const showCode = (a: AgentCardData) => setModal({ title: `${a.nameZh} · 代码`, body: <CodeBox code={a.code ?? ""} /> });
  // #6: AI run review of the current/viewed run (needs a saved transcript → a finished run).
  const analyzeRunUi = async () => {
    const id = viewingRun?.id ?? runId;
    if (!id || analyzing) return;
    const scope = { tenant, domain };
    const ticket = requestGate.begin("analyze-run", scope);
    setAnalyzing(true); setAnalysis(null);
    try {
      const result = await apiSend<{ review: Record<string, unknown> }>(tenant, `/v1/agent-factory/runs/${encodeURIComponent(id)}/analyze`, "POST");
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
      setAnalysis(result.ok && result.data?.review && typeof result.data.review === "object"
        ? result.data.review
        : { error: `分析失败：${result.ok ? "服务端未返回分析结果" : result.message}` });
    } catch (e) {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) setAnalysis({ error: (e as Error).message });
    }
    finally {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) setAnalyzing(false);
    }
  };
  const openDraftEditor = async (draft: DraftRow) => {
    if (!domain || editingDraftSlug) return;
    if (!draft.versionId) {
      setActionErr("这个旧草稿没有不可变版本号，不能安全编辑；请重新生成后再修改。");
      return;
    }
    const scope = { tenant, domain };
    const expected = { tenantSlug: tenant, domain, slug: draft.slug, versionId: draft.versionId };
    const ticket = requestGate.begin("draft-editor", scope);
    setEditingDraftSlug(draft.slug);
    setDraftEditMsg("");
    setActionErr("");
    setPromotionReview(null);
    requestGate.invalidate("promote");
    try {
      const result = await apiGet<unknown>(
        tenant,
        `/v1/agent-factory/drafts/${encodeURIComponent(draft.slug)}/editor?domain=${encodeURIComponent(domain)}&versionId=${encodeURIComponent(draft.versionId)}`,
      );
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
      if (!result.ok) {
        setActionErr(`打开草稿编辑器失败：${result.message}`);
        return;
      }
      const checked = readDraftEditorContract(result.data, expected);
      if (!checked.ok) {
        setActionErr(`打开草稿编辑器失败：${checked.message}`);
        return;
      }
      setDraftEditor({ tenant, domain, contract: checked.data });
    } catch (cause) {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) {
        setActionErr(`打开草稿编辑器失败：${cause instanceof Error ? cause.message : "网络暂时不可用，请重试。"}`);
      }
    } finally {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) setEditingDraftSlug(null);
    }
  };
  const saveDraftEdit = async (patch: StructuredDraftPatch): Promise<{ ok: boolean; message?: string }> => {
    const pending = draftEditor;
    if (!pending || pending.tenant !== tenant || pending.domain !== domain) {
      return { ok: false, message: "租户或领域已经变化，请关闭后重新打开草稿。" };
    }
    const { contract } = pending;
    const scope = { tenant, domain };
    const ticket = requestGate.begin("draft-mutation", scope);
    const expected = {
      tenantSlug: tenant,
      domain,
      slug: contract.scope.slug,
      baseVersionId: contract.scope.versionId,
    };
    try {
      const result = await apiSend<unknown>(
        tenant,
        `/v1/agent-factory/drafts/${encodeURIComponent(contract.scope.slug)}`,
        "PATCH",
        { domain, baseVersionId: contract.scope.versionId, patch },
      );
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) {
        return { ok: false, message: "租户或领域已经变化，已丢弃这次修改结果。" };
      }
      if (!result.ok) return { ok: false, message: `保存失败：${humanDraftEditFailure(result.message)}` };
      const checked = readPatchedDraftVersionReceipt(result.data, expected);
      if (!checked.ok) return { ok: false, message: `保存失败：${checked.message}` };
      setDraftEditMsg(`已创建新版本 ${checked.data.versionId}。旧版本仍保留；新版本的审查、沙箱、回归和晋升证据均未继承，请重新审查并跑沙箱。`);
      setPromoteMsg("");
      setPromotionReview(null);
      requestGate.invalidate("promote");
      refreshDrafts();
      return { ok: true };
    } catch (cause) {
      return { ok: false, message: `保存失败：${humanDraftEditFailure(cause instanceof Error ? cause.message : "网络暂时不可用，请重试。")}` };
    }
  };
  const openDraftSandbox = async (draft: DraftRow) => {
    if (!domain || sandboxingDraftSlug || !draft.versionId) return;
    const scope = { tenant, domain };
    const expected = { tenantSlug: tenant, domain, slug: draft.slug, versionId: draft.versionId };
    const ticket = requestGate.begin("draft-sandbox", scope);
    setSandboxingDraftSlug(draft.slug);
    setDraftSandboxMsg("");
    setActionErr("");
    setPromotionReview(null);
    setDraftEditor(null);
    requestGate.invalidate("promote");
    requestGate.invalidate("draft-editor");
    try {
      const result = await apiGet<unknown>(
        tenant,
        `/v1/agent-factory/drafts/${encodeURIComponent(draft.slug)}/sandbox-input?domain=${encodeURIComponent(domain)}&versionId=${encodeURIComponent(draft.versionId)}`,
      );
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
      if (!result.ok) {
        setActionErr(`打开沙箱测试失败：${result.message}`);
        return;
      }
      const checked = readDraftSandboxInputContract(result.data, expected);
      if (!checked.ok) {
        setActionErr(`打开沙箱测试失败：${checked.message}`);
        return;
      }
      setDraftSandbox({ tenant, domain, contract: checked.data });
    } catch (cause) {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) {
        setActionErr(`打开沙箱测试失败：${cause instanceof Error ? cause.message : "网络暂时不可用，请重试。"}`);
      }
    } finally {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) setSandboxingDraftSlug(null);
    }
  };
  const prepareDraftSandbox = async (
    input: { testCases: unknown[]; boundaryEvents: unknown[] },
  ): Promise<{ ok: true; review: DraftSandboxReview } | { ok: false; message: string }> => {
    const pending = draftSandbox;
    if (!pending || pending.tenant !== tenant || pending.domain !== domain) {
      return { ok: false, message: "租户或领域已经变化，请关闭后重新打开沙箱测试。" };
    }
    const { contract } = pending;
    const scope = { tenant, domain };
    const ticket = requestGate.begin("draft-sandbox-review", scope);
    const result = await apiSend<unknown>(
      tenant,
      `/v1/agent-factory/drafts/${encodeURIComponent(contract.scope.slug)}/sandbox-review`,
      "POST",
      {
        domain,
        versionId: contract.scope.versionId,
        testCases: input.testCases,
        boundaryEvents: input.boundaryEvents,
      },
    );
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) {
      return { ok: false, message: "租户或领域已经变化，已丢弃这次审查结果。" };
    }
    if (!result.ok) return { ok: false, message: result.message };
    const checked = readDraftSandboxReview(result.data, {
      tenantSlug: tenant,
      domain,
      slug: contract.scope.slug,
      versionId: contract.scope.versionId,
    });
    return checked.ok ? { ok: true, review: checked.data } : { ok: false, message: checked.message };
  };
  const finishDraftSandboxUi = async (
    review: DraftSandboxReview,
  ): Promise<{ ok: true; receipt: DraftSandboxFinishReceipt } | { ok: false; message: string }> => {
    const pending = draftSandbox;
    if (!pending || pending.tenant !== tenant || pending.domain !== domain) {
      return { ok: false, message: "租户或领域已经变化，没有创建沙箱。" };
    }
    const { contract } = pending;
    if (
      review.scope.tenantSlug !== tenant
      || review.scope.domain !== domain
      || review.scope.slug !== contract.scope.slug
      || review.scope.versionId !== contract.scope.versionId
    ) {
      return { ok: false, message: "沙箱审查不属于当前不可变版本，请重新准备。" };
    }
    const scope = { tenant, domain };
    const ticket = requestGate.begin("draft-sandbox-finish", scope);
    const result = await apiSend<unknown>(
      tenant,
      `/v1/agent-factory/drafts/${encodeURIComponent(contract.scope.slug)}/sandbox-finish`,
      "POST",
      {
        domain,
        versionId: contract.scope.versionId,
        testCases: review.testCases,
        boundaryEvents: review.boundaryEvents,
        challengeRef: sandboxChallengeRef(review.challenge),
        answer: review.challenge.token,
      },
    );
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) {
      return { ok: false, message: "租户或领域已经变化，已丢弃页面结果；服务端仍会完成临时 App 清理。" };
    }
    if (!result.ok) return { ok: false, message: result.message };
    const checked = readDraftSandboxFinishReceipt(result.data, {
      tenantSlug: tenant,
      domain,
      slug: contract.scope.slug,
      baseVersionId: contract.scope.versionId,
    });
    return checked.ok ? { ok: true, receipt: checked.data } : { ok: false, message: checked.message };
  };
  const completeDraftSandbox = (receipt: DraftSandboxFinishReceipt) => {
    setDraftSandbox(null);
    setDraftSandboxMsg(`临时 App 已运行并确认删除；新版本 ${receipt.versionId} 的回归工件已重新回放通过。现在可以对这个新版本做人工审查和晋升预览。`);
    setDraftEditMsg("");
    setPromoteMsg("");
    setPromotionReview(null);
    requestGate.invalidate("promote");
    refreshDrafts();
  };
  const deleteDraftUi = async (slug: string) => {
    if (!domain || !window.confirm("删除这个生成的草稿？（不影响已晋升上线的 agent）")) return;
    const scope = { tenant, domain };
    const ticket = requestGate.begin("draft-mutation", scope);
    setActionErr("");
    const result = await apiSend<{ deleted: boolean }>(tenant, `/v1/agent-factory/drafts/${encodeURIComponent(slug)}?domain=${encodeURIComponent(domain)}`, "DELETE");
    if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
    if (!result.ok || result.data.deleted !== true) {
      setActionErr(`删除草稿失败：${result.ok ? "服务端未确认删除" : result.message}`);
      return;
    }
    refreshDrafts();
  };
  const promote = async (slugs?: string[]) => {
    if (!domain || promoting || !drafts.length) return;
    const scope = { tenant, domain };
    const ticket = requestGate.begin("promote", scope);
    setPromoting(true); setPromoteMsg("");
    try {
      const requestedSlugs = slugs && slugs.length ? slugs : drafts.map((draft) => draft.slug);
      const selected = drafts.filter((draft) => requestedSlugs.includes(draft.slug));
      if (selected.length !== requestedSlugs.length) {
        setPromoteMsg("晋升失败：选中的草稿已变化，请刷新后重新选择。");
        return;
      }
      if (selected.some((draft) => draft.replayReady !== true || draft.regressionReady !== true)) {
        setPromoteMsg("晋升失败：所选版本尚未完成服务端回归重放校验。");
        return;
      }
      if (selected.some((draft) => draft.promotionGateAdmission !== true || draft.promotionEligible !== true || draft.promotionEvidenceReady !== true || draft.evidenceQualification?.promotion !== "candidate")) {
        setPromoteMsg("晋升已阻止：沙箱编排已验证，当前不能上线。signed fixture/回放不能替代生产 live probe；请先补齐真实集成证据。");
        return;
      }
      const versionIds = [...new Set(selected.map((draft) => draft.versionId).filter((value): value is string => Boolean(value)))];
      if (versionIds.length !== 1 || selected.some((draft) => !draft.versionId)) {
        setPromoteMsg("晋升失败：请选择同一个不可变版本的草稿；旧版无 versionId 草稿需重新生成。");
        return;
      }
      const versionId = versionIds[0]!;
      const preview = await apiSend<PromotionPreviewData>(tenant, "/v1/agent-factory/drafts/promotion-preview", "POST", { domain, versionId, slugs: requestedSlugs });
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
      if (!preview.ok) {
        setPromoteMsg(`晋升预览失败：${preview.message}`);
        return;
      }
      if (!isPromotionPreviewData(preview.data)
        || preview.data.versionId !== versionId
        || [...preview.data.slugs].sort().join("\0") !== [...requestedSlugs].sort().join("\0")) {
        setPromoteMsg("晋升预览失败：接口响应缺少完整差异、哈希或所选版本不一致。");
        return;
      }

      const codeResponses = await Promise.all(requestedSlugs.map(async (slug) => ({
        slug,
        result: await apiGet<{ domain: string; slug: string; code: string; filename: string }>(
          tenant,
          `/v1/agent-factory/drafts/code?domain=${encodeURIComponent(domain)}&slug=${encodeURIComponent(slug)}&versionId=${encodeURIComponent(versionId)}`,
        ),
      })));
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) return;
      const codeError = codeResponses.find(({ slug, result }) => !result.ok
        || result.data.domain !== domain
        || result.data.slug !== slug
        || typeof result.data.filename !== "string"
        || typeof result.data.code !== "string"
        || !result.data.code.trim());
      if (codeError) {
        setPromoteMsg(`晋升预览失败：无法读取不可变版本的完整代码（${codeError.slug}）${codeError.result.ok ? "" : `：${codeError.result.message}`}`);
        return;
      }
      setPromotionReview({
        tenant,
        domain,
        preview: preview.data,
        codeArtifacts: codeResponses.map(({ result }) => {
          if (!result.ok) throw new Error(result.message);
          return { slug: result.data.slug, filename: result.data.filename, code: result.data.code };
        }),
      });
      setPromoteMsg("晋升预览已生成；请在审阅窗口逐项检查代码与设计差异。");
    } catch (e) {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) setPromoteMsg(`晋升预览失败：${(e as Error).message}`);
    }
    finally {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) setPromoting(false);
    }
  };

  const approvePromotion = async (): Promise<PromotionApprovalResult> => {
    const pending = promotionReview;
    if (!pending || pending.tenant !== tenant || pending.domain !== domain || promoting) {
      return { ok: false, message: "审阅上下文已变化，请重新生成晋升预览。" };
    }
    const scope = { tenant, domain };
    const ticket = requestGate.begin("promote", scope);
    setPromoting(true);
    setPromoteMsg("");
    try {
      const { preview } = pending;
      const review = await apiSend<{ receipt: { receiptId: string } }>(tenant, "/v1/agent-factory/drafts/reviews", "POST", {
        domain,
        versionId: preview.versionId,
        slugs: preview.slugs,
        reviewChallenge: preview.reviewChallenge,
        decision: "approve_code_and_design",
        codeReviewed: true,
        designReviewed: true,
      });
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) {
        return { ok: false, message: "业务领域已切换，签核结果已丢弃。" };
      }
      if (!review.ok || typeof review.data.receipt?.receiptId !== "string" || !review.data.receipt.receiptId) {
        const message = `人工签核失败：${review.ok ? "服务端未签发凭据" : review.message}`;
        setPromoteMsg(message);
        return { ok: false, message };
      }

      const result = await apiSend<{ promoted: string[]; functionsRegistered: number; liveAgents: number }>(tenant, "/v1/agent-factory/drafts/promote", "POST", {
        domain,
        versionId: preview.versionId,
        receiptId: review.data.receipt.receiptId,
        slugs: preview.slugs,
      });
      if (!isViewedTenant(tenant) || !requestGate.isCurrent(ticket, scope)) {
        return { ok: false, message: "业务领域已切换，晋升结果已丢弃。" };
      }
      const promotionConfirmed = result.ok
        && Array.isArray(result.data?.promoted)
        && result.data.promoted.length === preview.slugs.length
        && preview.slugs.every((slug) => result.data.promoted.includes(slug))
        && typeof result.data.functionsRegistered === "number"
        && result.data.functionsRegistered > 0
        && typeof result.data.liveAgents === "number"
        && result.data.liveAgents >= result.data.promoted.length;
      if (!promotionConfirmed || !result.ok) {
        const message = `晋升失败：${result.ok ? "服务端未确认草稿已全部上线并注册真实函数" : result.message}`;
        setPromoteMsg(message);
        return { ok: false, message };
      }
      setPromoteMsg(`已晋升 ${result.data.promoted.length} 个 · 注册 ${result.data.functionsRegistered} 个函数 · 工作流现 ${result.data.liveAgents} 个 agent`);
      setPromotionReview(null);
      void queryClient.invalidateQueries({ queryKey: AGENT_KEYS.all });
      void queryClient.invalidateQueries({ queryKey: COUNT_KEYS.tenant });
      refreshDrafts();
      refreshRuns();
      return { ok: true };
    } catch (cause) {
      const message = `晋升失败：${cause instanceof Error ? cause.message : String(cause)}`;
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) setPromoteMsg(message);
      return { ok: false, message };
    } finally {
      if (isViewedTenant(tenant) && requestGate.isCurrent(ticket, scope)) setPromoting(false);
    }
  };

  const isHero = blocks.length === 0 && !viewingRun;

  // Claude-style working indicator: while the run is live, one pinned row under the feed tells
  // the user WHAT the brain is doing right now (thinking / which tool / sandbox), with breathing
  // dots — instead of the feed just going quiet between frames.
  const workingLabel = useMemo(() => {
    if (!running || viewingRun) return null;
    for (let i = events.length - 1; i >= 0 && i > events.length - 40; i--) {
      const e = events[i]!;
      if (e.t === "tool.result" || e.t === "message" || e.t === "done") break; // last act finished → generic label
      if (e.t === "tool.call") {
        const n = String(e.name ?? "");
        if (n === "sandbox_run") return "部署沙箱并试运行…";
        if (n === "generate_report") return "生成领域分析报告…";
        return `调用 ${n}…`;
      }
      if (e.t === "think") return "思考中…";
    }
    return "工作中…";
  }, [running, viewingRun, events]);

  // Right-pane tab body, extracted so the SAME content renders inline AND in the fullscreen modal
  // (every tab + its SVG graphs get 全屏, not just 交付图/大脑). `full` relaxes height caps so
  // graphs use the whole modal.
  const renderTabBody = (full: boolean) => {
    if (tab === "bg")
      return (
        <BackgroundPanel
          inline
          tenant={tenant}
          domain={domain}
          events={events}
          running={running}
          convId={convId}
          viewingRunId={viewingRun?.id ?? null}
          liveRunId={runId}
          awaitingHint={awaitingHint}
          onSelectAgent={(slug) => { setTab("flow"); setSelectedSlug(slug); }}
          onReconnectRun={(id) => {
            // runId === conversationId by design — sync the conversation too, else chat
            // interventions after 连接查看 silently target a stale (or empty) thread.
            setViewingRun(null); setSelectedSlug(null); setConv(id);
            setReq({ tenant, reconnectRunId: id, conversation: id, replayMode: "replace", nonce: Date.now() });
          }}
        />
      );
    if (tab === "summary") return <RunSummary blocks={blocks} lastBudget={lastBudget} analysis={analysis} analyzing={analyzing} canAnalyze={!!(viewingRun?.id || (runId && !running))} onAnalyze={analyzeRunUi} />;
    if (tab === "test") return <SandboxIOPanel testCases={testCaseList} agentRuns={sandboxRuns} />;
    if (tab === "brain") {
      return (
        <div>
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {([["flow", "决策流"], ["map", "系统全景"], ["log", "活动日志"]] as Array<["flow" | "log" | "map", string]>).map(([k, label]) => (
              <button key={k} onClick={() => setBrainView(k)} style={{ fontSize: 11.5, padding: "3px 12px", borderRadius: 20, cursor: "pointer", border: `1px solid ${brainView === k ? "var(--signal)" : "var(--border)"}`, background: brainView === k ? "var(--panel-2)" : "transparent", color: brainView === k ? "var(--text)" : "var(--text-3)" }}>{label}</button>
            ))}
          </div>
          {brainView === "log" ? <ActivityLog blocks={blocks} />
            : brainView === "map" ? <SystemMap events={events} agents={agents} running={running} onSelectAgent={(slug) => { setTab("flow"); setSelectedSlug(slug); }} />
            : <BrainFlow steps={brainSteps} running={running} />}
        </div>
      );
    }
    if (selectedAgent) return <AgentInspector agent={selectedAgent} io={selectedIo} score={selectedScore} versions={agentVersions.get(selectedAgent.slug) ?? []} task={selectedTask} onBack={() => setSelectedSlug(null)} onShowCode={showCode} onRegenerate={regenerateAgent} />;
    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {([["cards", "卡片列表"], ["graph", "事件图"], ["biz", "业务流全景"], ["blueprint", "蓝图"]] as Array<["cards" | "graph" | "biz" | "blueprint", string]>).map(([k, label]) => (
            <button key={k} onClick={() => setDeliverView(k)} style={{ fontSize: 11.5, padding: "3px 12px", borderRadius: 20, cursor: "pointer", border: `1px solid ${deliverView === k ? "var(--signal)" : "var(--border)"}`, background: deliverView === k ? "var(--panel-2)" : "transparent", color: deliverView === k ? "var(--text)" : "var(--text-3)" }}>{label}</button>
          ))}
        </div>
        {deliverView === "cards"
          ? <AgentCardList agents={agents} degraded={degraded} ioByShort={ioByShort} onShowCode={showCode} onRegenerate={regenerateAgent} onSelect={setSelectedSlug} />
          : deliverView === "biz"
            ? <BusinessFlowPanel events={events} onSelect={setSelectedSlug} />
            : deliverView === "blueprint"
              ? <BlueprintPanel events={events} />
              : <div style={full ? { height: "78vh" } : undefined}><EventGraph agents={agents} scores={scores} degraded={degraded} selectedSlug={selectedSlug} onSelect={setSelectedSlug} /></div>}
      </div>
    );
  };
  const TAB_TITLE: Record<string, string> = { flow: "智能体 · 交付", brain: "大脑", test: "测试 · 沙箱 I/O", summary: "总结", bg: "后台任务" };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={<span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>{t("nav.factory")}<HelpTip>{t("factory.subtitle")}</HelpTip></span>}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Badge tone="muted">运行领域 · {tenant}</Badge>
            {boundDomain
              ? <Badge tone="green">本体 · {boundDomain.name ?? boundDomain.id}</Badge>
              : <Badge tone="amber">本体未连接</Badge>}
            {running && <Badge tone="signal">运行中</Badge>}
            {viewingRun && <Badge tone="muted">查看历史</Badge>}
            <Button icon="plus" onClick={newConversation} disabled={starting}>新会话</Button>
          </div>
        }
      />
      {(actionErr || Object.values(readErrors).some(Boolean)) && (
        <div role="alert" style={{ margin: "10px 12px 0", padding: "9px 11px", border: "1px solid var(--red)", borderRadius: 8, background: "var(--panel-2)", color: "var(--red)", fontSize: 11.5, lineHeight: 1.55, display: "flex", gap: 10, alignItems: "flex-start" }}>
          <div style={{ flex: 1 }}>
            {actionErr && <div>{actionErr}</div>}
            {Object.entries(readErrors).map(([surface, message]) => message ? <div key={surface}>{message}</div> : null)}
          </div>
          {actionErr && <button onClick={() => setActionErr("")} aria-label="关闭操作错误" style={{ border: "none", background: "none", color: "var(--red)", cursor: "pointer", padding: 0 }}>✕</button>}
        </div>
      )}
      {promotionReview && promotionReview.tenant === tenant && promotionReview.domain === domain && (
        <PromotionReviewModal
          key={promotionReview.preview.previewHash}
          preview={promotionReview.preview}
          codeArtifacts={promotionReview.codeArtifacts}
          onClose={() => { if (!promoting) setPromotionReview(null); }}
          onApprove={approvePromotion}
        />
      )}
      {draftEditor && draftEditor.tenant === tenant && draftEditor.domain === domain && (
        <DraftEditorModal
          key={`${draftEditor.contract.scope.slug}:${draftEditor.contract.scope.versionId}`}
          contract={draftEditor.contract}
          onClose={() => setDraftEditor(null)}
          onSave={saveDraftEdit}
        />
      )}
      {draftSandbox && draftSandbox.tenant === tenant && draftSandbox.domain === domain && (
        <DraftSandboxModal
          key={`${draftSandbox.contract.scope.slug}:${draftSandbox.contract.scope.versionId}`}
          contract={draftSandbox.contract}
          onClose={() => setDraftSandbox(null)}
          onPrepare={prepareDraftSandbox}
          onFinish={finishDraftSandboxUi}
          onComplete={completeDraftSandbox}
        />
      )}
      {modal && <FullModal title={modal.title} onClose={() => setModal(null)}>{modal.body}</FullModal>}
      {fullscreen && (
        <FullModal title={`${TAB_TITLE[fullscreen] ?? "全屏"} · 全屏`} onClose={() => setFullscreen(null)}>
          {renderTabBody(true)}
        </FullModal>
      )}

      {/* Merged progress SPINE (阶段 + 健康 + 成本 + 后台) — the single standing status band.
          Only appears once a run is active/being viewed; the hero stays calm. Owns stage progress
          now, so the right pane's duplicate StageRail is hidden below. */}
      {!isHero && (
        <FactorySpine
          stages={stages}
          current={current}
          running={running}
          refineCount={refineCount}
          domainName={domains.find((d) => d.id === domain)?.name ?? domain}
          healthChecks={healthChecks}
          budgetTokens={
            lastBudget && Number.isFinite(Number(lastBudget.tokens))
              ? Number(lastBudget.tokens)
              : null
          }
          awaitingHint={awaitingHint}
          onOpenBg={() => { setRightOpen(true); setTab("bg"); }}
        />
      )}

      <div style={{ flex: 1, position: "relative", display: "grid", gridTemplateColumns: `${leftOpen ? `${leftW}px` : "48px"} 1fr ${rightOpen ? `${rightW}px` : "0px"}`, minHeight: 0, transition: resizing ? "none" : "grid-template-columns 0.2s ease" }}>
        {/* #RESIZE — drag rails on the two dividers (full height, 6px hit area). The collapse
            chevrons render AFTER so they stay clickable where they overlap. Double-click resets. */}
        {leftOpen && (
          <div
            role="separator" aria-orientation="vertical" title="拖拽调节左栏宽度（双击复位）"
            onPointerDown={beginResize("left")}
            onDoubleClick={() => { setLeftW(238); try { localStorage.setItem(`ao:factory:leftW:${tenant}`, "238"); } catch { /* ignore */ } }}
            style={{ position: "absolute", left: leftW - 3, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: "var(--z-overlay)" as unknown as number, background: resizing === "left" ? "var(--signal)" : "transparent", opacity: resizing === "left" ? 0.35 : 1 }}
          />
        )}
        {rightOpen && (
          <div
            role="separator" aria-orientation="vertical" title="拖拽调节右栏宽度（双击复位）"
            onPointerDown={beginResize("right")}
            onDoubleClick={() => { setRightW(440); try { localStorage.setItem(`ao:factory:rightW:${tenant}`, "440"); } catch { /* ignore */ } }}
            style={{ position: "absolute", right: rightW - 3, top: 0, bottom: 0, width: 6, cursor: "col-resize", zIndex: "var(--z-overlay)" as unknown as number, background: resizing === "right" ? "var(--signal)" : "transparent", opacity: resizing === "right" ? 0.35 : 1 }}
          />
        )}
        {/* 栏收起/展开：手柄贴在各自分隔线上（不再挤在页头，方向不再歧义）。 */}
        <button
          title={leftOpen ? "收起左栏" : "展开左栏"}
          onClick={toggleLeft}
          style={{ position: "absolute", left: leftOpen ? leftW : 48, top: "50%", transform: leftOpen ? "translate(-50%, -50%)" : "translateY(-50%)", zIndex: "var(--z-overlay)" as unknown as number, width: 18, height: 48, borderRadius: leftOpen ? 9 : "0 9px 9px 0", border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text-3)", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0, transition: resizing ? "none" : "left 0.2s ease" }}
        >{leftOpen ? "‹" : "›"}</button>
        <button
          title={rightOpen ? "收起右栏" : "展开右栏"}
          onClick={toggleRight}
          style={{ position: "absolute", right: rightOpen ? rightW : 0, top: "50%", transform: rightOpen ? "translate(50%, -50%)" : "translateY(-50%)", zIndex: "var(--z-overlay)" as unknown as number, width: 18, height: 48, borderRadius: rightOpen ? 9 : "9px 0 0 9px", border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text-3)", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0, transition: resizing ? "none" : "right 0.2s ease" }}
        >{rightOpen ? "›" : "‹"}</button>
        {/* ── left rail ── (pinned to gridColumn 1; a display:none rail is removed from the grid and
            back-fills the other panes into the wrong tracks, so the collapsed state is a 48px ICON
            mini-rail — always accessible, never fully gone. 运行健康 moved to the spine above.) */}
        {leftOpen ? (
          <div style={{ gridColumn: 1, minWidth: 0, borderRight: "1px solid var(--border)", overflow: "auto", padding: 12, display: "flex", flexDirection: "column", gap: 14 }}>
            <CollapsibleSection title={<span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>本体连接<HelpTip>运行领域是租户边界；本体是工厂的知识源。两者只通过这里保存的显式连接关联，不按名称或别名猜测。</HelpTip></span>} storageKey={`ao:factory:sec:domains:${tenant}`}>
              <div style={{ padding: "8px 9px", marginBottom: 7, borderRadius: 8, border: "1px solid var(--border)", background: "var(--panel-2)", fontSize: 10.5, lineHeight: 1.5 }}>
                <div style={{ color: "var(--text-3)" }}>生产目标（运行领域）</div>
                <div style={{ color: "var(--text)", fontFamily: "var(--mono)", fontWeight: 600 }}>{tenant}</div>
                <div style={{ color: "var(--text-3)", marginTop: 5 }}>知识源（本体）</div>
                {boundDomain ? (
                  <div style={{ color: "var(--green)" }}>✓ {boundDomain.name ?? boundDomain.id}<span style={{ color: "var(--text-3)", marginLeft: 5 }}>({boundDomain.id})</span></div>
                ) : binding ? (
                  <div style={{ color: "var(--red)" }}>连接不可用 · {binding.ontologyDomainId}</div>
                ) : (
                  <div style={{ color: "var(--amber)" }}>尚未连接，不允许运行</div>
                )}
                {boundDomain && (
                  <button onClick={() => { setBindingErr(""); setShowDomainCatalog((v) => !v); }} disabled={running || starting || bindingBusy} style={{ marginTop: 6, padding: 0, border: "none", background: "none", color: "var(--signal)", fontSize: 10.5, cursor: running || starting ? "default" : "pointer" }}>
                    {showDomainCatalog ? "取消更换" : "更换本体连接"}
                  </button>
                )}
              </div>
              {bindingErr && <div role="alert" style={{ marginBottom: 6, color: "var(--red)", fontSize: 10.5, lineHeight: 1.45 }}>{bindingErr}</div>}
              <DomainList
                domains={showDomainCatalog || !boundDomain ? domains : [boundDomain]}
                domain={domain}
                query={domainQuery}
                setQuery={setDomainQuery}
                onSelect={(showDomainCatalog || !boundDomain) && !running && !starting && !bindingBusy ? (id) => void connectOntology(id) : undefined}
                actionLabel={showDomainCatalog || !boundDomain ? (bindingBusy ? "连接中…" : boundDomain ? "切换" : "连接") : undefined}
                uploadedIds={uploadedIds}
                onDeleteUpload={!running && !starting && !bindingBusy ? deleteUploadedDomain : undefined}
              />
              {!boundDomain && domains.length === 0 && <div style={{ color: "var(--text-3)", fontSize: 10.5, lineHeight: 1.5 }}>目录为空。可在下方点 📎 上传本体 JSON；上传成功后会建立连接。</div>}
            </CollapsibleSection>
            <CollapsibleSection title="历史运行" defaultOpen={false} badge={<span style={{ fontSize: 10, color: "var(--text-3)" }}>{runs.length}</span>} storageKey={`ao:factory:sec:runs:${tenant}`}>
              <HistoryList runs={runs} viewingRunId={viewingRun?.id ?? null} onOpen={openRun} onDelete={deleteRunUi} onClear={clearRunsUi} deletedRuns={deletedRuns} showTrash={showTrash} onToggleTrash={toggleTrash} onRestore={restoreRunUi} />
            </CollapsibleSection>
            {domain && (
              <CollapsibleSection title="领域知识" defaultOpen={false} storageKey={`ao:factory:sec:knowledge:${tenant}:${domain}`}>
                <DomainKnowledgePanel key={`${tenant}:${domain}`} tenant={tenant} domain={domain} />
              </CollapsibleSection>
            )}
            <CollapsibleSection title="已生成 · 草稿" defaultOpen={false} badge={<span style={{ fontSize: 10, color: "var(--text-3)" }}>{drafts.length}</span>} storageKey={`ao:factory:sec:drafts:${tenant}`}>
              <DraftList
                drafts={drafts}
                promoting={promoting}
                promoteMsg={promoteMsg}
                editMsg={draftEditMsg}
                sandboxMsg={draftSandboxMsg}
                editingSlug={editingDraftSlug}
                sandboxingSlug={sandboxingDraftSlug}
                onPromote={promote}
                onEdit={(draft) => void openDraftEditor(draft)}
                onSandbox={(draft) => void openDraftSandbox(draft)}
                onDelete={deleteDraftUi}
              />
            </CollapsibleSection>
          </div>
        ) : (
          <div style={{ gridColumn: 1, minWidth: 0, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "12px 0" }}>
            {([["🗂", "本体连接"], ["🕘", "历史运行"], ["🧠", "领域知识"], ["📄", "已生成 · 草稿"]] as Array<[string, string]>).map(([g, label]) => (
              <button key={label} title={`${label}（点击展开左栏）`} onClick={toggleLeft} className="factory-cta" style={{ width: 34, height: 34, borderRadius: 9, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: "var(--text-3)", background: "none", border: "none", cursor: "pointer" }}>{g}</button>
            ))}
          </div>
        )}

        {/* ── center: hero / transcript + composer ── */}
        <div style={{ gridColumn: 2, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--border)" }}>
          {!gatewayOk && (
            <div style={{ margin: 12, marginBottom: 0, padding: "10px 12px", border: "1px solid var(--amber)", borderRadius: 8, background: "var(--panel-2)", fontSize: 12.5, color: "var(--amber)", lineHeight: 1.6 }}>
              ⚠ LLM 网关未配置 —— 大脑无法运行。请在 <code style={{ fontFamily: "var(--mono)" }}>.env</code> 设置 <code style={{ fontFamily: "var(--mono)" }}>CUSTOM_LLM_BASE_URL</code> + <code style={{ fontFamily: "var(--mono)" }}>CUSTOM_LLM_API_KEY</code>（或 <code style={{ fontFamily: "var(--mono)" }}>OPENAI_API_KEY</code>），重启 API 后生效。
            </div>
          )}
          {!boundDomain && (
            <div style={{ margin: 12, marginBottom: 0, padding: "10px 12px", border: "1px solid var(--amber)", borderRadius: 8, background: "var(--panel-2)", fontSize: 12.5, color: "var(--amber)", lineHeight: 1.6 }}>
              当前运行领域 <code style={{ fontFamily: "var(--mono)" }}>{tenant}</code> 尚未连接可用本体。请在左侧显式连接目录中的本体，或点下方 📎 上传一份本体；连接前不会启动 Agent 工厂。
            </div>
          )}
          {streamError && (
            <div role="alert" style={{ margin: 12, marginBottom: 0, padding: "10px 12px", border: "1px solid var(--red)", borderRadius: 10, background: "var(--panel-2)", fontSize: 12.5, color: "var(--red)", lineHeight: 1.6 }}>⚠ {streamError}</div>
          )}
          {!isHero && (
            <div style={{ display: "flex", gap: 6, alignItems: "center", padding: "8px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
              {/* 筛选 collapses to one control (chips revealed on demand); 精简/详尽 toggles 里程碑分组 vs 逐条. */}
              <button onClick={() => setFiltersOpen((v) => !v)} className="factory-cta" style={{ fontSize: 11, color: filtersOpen || transcriptFilter !== "all" ? "var(--text)" : "var(--text-3)", border: "1px solid var(--border)", borderRadius: 7, padding: "3px 10px", background: filtersOpen ? "var(--panel-2)" : "transparent", cursor: "pointer" }}>⚲ 筛选{transcriptFilter !== "all" ? ` · ${TRANSCRIPT_FILTERS.find((f) => f.key === transcriptFilter)?.label ?? ""}` : ""}</button>
              {filtersOpen && TRANSCRIPT_FILTERS.map((f) => <FilterChip key={f.key} active={transcriptFilter === f.key} onClick={() => setTranscriptFilter(f.key)}>{f.label}</FilterChip>)}
              <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 10, color: "var(--text-4)" }}>{density === "brief" ? "对话视图 · 过程折叠成簇" : "全过程视图 · 逐条 + 思考全文"}</span>
                <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden", fontSize: 11 }}>
                  {(["brief", "full"] as const).map((d) => (
                    <button key={d} onClick={() => pickDensity(d)} title={d === "brief" ? "精简：像聊天一样只看结论与里程碑，思考/工具折叠成可展开的簇" : "详尽：完整过程流水，逐条平铺且长思考默认展开全文"} style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "4px 11px", background: density === d ? "var(--signal)" : "transparent", color: density === d ? "var(--on-accent, #fff)" : "var(--text-3)", fontWeight: density === d ? 700 : 400, border: "none", cursor: "pointer" }}>
                      <span aria-hidden style={{ fontSize: 10 }}>{d === "brief" ? "💬" : "☰"}</span>{d === "brief" ? "精简" : "详尽"}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div ref={feedRef} style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 7 }}>
            {/* 决策路线 lens — the 大脑 decision path (BrainFlow) pinned at the transcript top,
                collapsed by default. The chat IS the brain's thinking, so this lives here. */}
            {!isHero && brainSteps.length > 0 && (
              <div style={{ flexShrink: 0 }}>
                <button onClick={() => setRouteOpen((v) => !v)} style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", fontSize: 11.5, color: "var(--text-3)", border: "1px dashed var(--border-2)", borderRadius: 8, padding: "6px 11px", background: "none", cursor: "pointer" }}>
                  <span style={{ display: "inline-block", transform: routeOpen ? "rotate(90deg)" : "none", transition: "transform 0.15s" }}>▸</span>
                  🧭 决策路线 · {brainSteps.length} 步
                  <span style={{ marginLeft: "auto", color: "var(--text-4)" }}>{routeOpen ? "收起" : "展开"}</span>
                </button>
                {routeOpen && <div style={{ marginTop: 6 }}><BrainFlow steps={brainSteps} running={running} /></div>}
              </div>
            )}
            {isHero ? (
              <div className="rise" style={{ margin: "auto", maxWidth: 580, textAlign: "center" }}>
                <div style={{ fontSize: 30, marginBottom: 10 }}>⚡</div>
                <h2 style={{ fontSize: 21, fontWeight: 700, color: "var(--text)", margin: "0 0 22px", letterSpacing: "-0.01em", display: "inline-flex", alignItems: "center", gap: 8 }}>自主智能体工厂<HelpTip>描述目标或上传本体，自动生成、验证并交付可运行的智能体。</HelpTip></h2>
                {goalSuggestions.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: "var(--text-3)", textAlign: "left", marginBottom: 8 }}>基于当前本体的目标建议</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      {goalSuggestions.map((suggestion) => <button key={suggestion} className="factory-cta" onClick={() => setGoal(suggestion)} style={{ textAlign: "left", padding: "11px 13px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text-2)", cursor: "pointer", fontSize: 12.5, lineHeight: 1.5 }}>{suggestion}</button>)}
                    </div>
                  </>
                )}
              </div>
            ) : filteredBlocks.length === 0 ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--text-4)" }}>该筛选下暂无内容</div>
            ) : (
              <TranscriptFeed blocks={filteredBlocks} grouped={transcriptFilter === "all" && density === "brief"} expandAll={density === "full"} />
            )}
            {workingLabel && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 2px 0", flexShrink: 0 }}>
                <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
                  <span className="chat-typing-dot" /><span className="chat-typing-dot" /><span className="chat-typing-dot" />
                </span>
                <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>{workingLabel}</span>
              </div>
            )}
          </div>

          {/* #W3-UI — unified InteractionDock: the ONE pinned action surface for any pending
              clarify / test-case approval / boundary decision. The transcript renders the same
              blocks as PASSIVE history (no callbacks → no duplicate input), so a question is
              answerable in exactly one place. Matches the backend's #W2-HITL tag routing. */}
          {!viewingRun && (running || waitingHuman) && (
            <InteractionDock
              blocks={blocks}
              runId={runId}
              onClarify={decideClarify}
              onDecide={decideTestCases}
              onBoundary={decideBoundary}
              onReplaceTestPayload={replaceTestPayload}
              onUploadTestBinary={uploadTestBinary}
            />
          )}

          {/* The composer has no ontology selector: it can only use the persisted binding. */}
          <div style={{ borderTop: "1px solid var(--border)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {viewingRun ? (
              <Button onClick={newConversation}>← 返回，开始新会话</Button>
            ) : running ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input disabled={Boolean(awaitingHint) || injectBusy} value={injectText} onChange={(e) => setInjectText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !injectBusy && !awaitingHint) void inject(); }} placeholder={awaitingHint ? "请在上方交互卡提交；普通消息不能代替当前回答" : "运行中，可随时打字介入（输入「停止」中止）"} style={{ flex: 1, fontSize: 13, padding: "8px 10px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8 }} />
                  <Button onClick={() => void inject()} disabled={Boolean(awaitingHint) || !injectText.trim() || injectBusy}>{injectBusy ? "发送中…" : "介入 ↵"}</Button>
                  <Button icon="pause" tone="danger" onClick={() => void stop()} disabled={stopping}>{stopping ? "停止中…" : "停止"}</Button>
                </div>
                {injectNote && <div role={injectFailed ? "alert" : "status"} style={{ fontSize: 11.5, color: injectFailed ? "var(--red)" : "var(--text-3)" }}>{injectNote}</div>}
              </div>
            ) : waitingHuman ? (
              <div role="status" style={{ fontSize: 12, color: "var(--amber)", lineHeight: 1.5, padding: "4px 2px" }}>
                当前运行正在等你的明确回复。请使用上方交互卡回答；提交后会自动从检查点继续。
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* 本体 JSON → 覆盖已连接本体，或在未连接时创建并绑定上传本体；工具/参考文档 → 交给大脑 create_tool。 */}
                {attached.length > 0 && (() => {
                  const clip = (s: string) => (s.length > 22 ? s.slice(0, 21) + "…" : s);
                  return (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      {attached.map((a, idx) => (
                        <span key={idx} className="factory-cta" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "3px 9px", borderRadius: 12, border: "1px solid var(--violet)", color: "var(--text-2)" }}>
                          <span style={{ color: "var(--violet)", fontWeight: 600 }}>📄 文档</span>
                          ·{clip(a.name)}
                          <button onClick={() => setAttached(attached.filter((_, j) => j !== idx))} title="移除" style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 12, padding: 0 }}>✕</button>
                        </span>
                      ))}
                    </div>
                  );
                })()}
                {composerErr && <div role="alert" style={{ fontSize: 11.5, color: "var(--red)" }}>{composerErr}</div>}
                {composerOk && <div style={{ fontSize: 11.5, color: "var(--green)", lineHeight: 1.5 }}>{composerOk}</div>}
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <input ref={fileRef} type="file" multiple disabled={starting} accept=".json,.txt,.md,.markdown,.html,.htm,.csv,application/json,text/*" style={{ display: "none" }} onChange={(e) => void onAttachFiles(e.target.files)} />
                  <button className="factory-cta" disabled={starting} onClick={() => fileRef.current?.click()} title="上传本体 JSON（覆盖已连接本体；未连接时创建连接）或工具/参考文档" style={{ fontSize: 16, lineHeight: 1, padding: "8px 10px", background: "var(--panel-2)", color: "var(--text-2)", border: "1px solid var(--border)", borderRadius: 8, cursor: starting ? "wait" : "pointer", opacity: starting ? 0.6 : 1 }}>📎</button>
                  <textarea value={goal} disabled={starting} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !starting) void submit(); }} placeholder={!boundDomain ? "请先连接本体，或点 📎 上传本体 JSON…" : convId ? "继续对话…  ⌘/Ctrl+Enter 发送" : attached.length ? "可补充目标（可留空）…  ⌘/Ctrl+Enter 发送" : "描述你要做什么，或点 📎 上传本体 JSON / 附工具文档 …  ⌘/Ctrl+Enter 发送"} rows={2} style={{ flex: 1, resize: "none", fontSize: 13, padding: "8px 10px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "var(--sans)" }} />
                  <Button icon="spark" tone="primary" onClick={() => void submit()} disabled={running || starting || !domain || (!goal.trim() && attached.length === 0)}>{starting ? "启动中…" : convId ? "发送" : "开始"}</Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── right pane: 常驻「后台任务」sidebar（默认主视图，Claude-Desktop 式）+ 智能体/大脑/测试/总结
            分段切换, 可收起 + 每视图全屏。后台任务视图里点 agent 卡 → 右侧详情抽屉看 view transcript。 ── */}
        {rightOpen && (
        <div style={{ gridColumn: 3, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* Stage rail moved to the top progress SPINE (阶段+健康+成本 merged). The pending-interaction
              cue is surfaced by the spine's 后台 badge + the center InteractionDock, so it's not duplicated here. */}
          {/* 紧凑分段控件：后台任务(默认) | 智能体 | 大脑 | 测试 | 总结。后台任务是常驻主视图。 */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", borderBottom: "1px solid var(--border)" }}>
            <div style={{ display: "flex", gap: 5, flex: 1, minWidth: 0, overflowX: "auto" }}>
              {([["bg", `${awaitingHint ? "● " : ""}后台任务`], ["flow", `智能体${agents.length ? ` · ${agents.length}` : ""}`], ["brain", "大脑"], ["test", `测试${testCaseList.length || sandboxRuns.length ? ` · ${testCaseList.length || sandboxRuns.length}` : ""}`], ["summary", "总结"]] as Array<["flow" | "brain" | "test" | "summary" | "bg", string]>).map(([k, label]) => (
                <button key={k} onClick={() => { setTab(k); setSelectedSlug(null); }} style={{ flex: "0 0 auto", padding: "5px 10px", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", borderRadius: 20, cursor: "pointer", border: `1px solid ${tab === k ? "var(--signal)" : "var(--border)"}`, background: tab === k ? "var(--panel-2)" : "transparent", color: tab === k ? "var(--text)" : "var(--text-3)", transition: "color 0.15s ease, border-color 0.15s ease" }}>{label}</button>
              ))}
            </div>
            <button title="全屏查看当前标签" onClick={() => setFullscreen(tab)} style={{ padding: "0 4px", background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", display: "inline-flex", alignItems: "center", flexShrink: 0 }}>
              <Icon name="external" size={14} />
            </button>
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 12 }}>{renderTabBody(false)}</div>
        </div>
        )}
      </div>
    </div>
  );
}
