"use client";

/**
 * Agent 工厂 — the autonomous Harness brain cockpit.
 *
 * Layout: a collapsible/searchable LEFT RAIL (业务域 + 历史运行 w/ soft-delete + 草稿 + a pinned
 * 运行健康 strip), a CENTER that keeps the complete full-fidelity thinking transcript + composer
 * (with a filter strip salvaged from the old 轨迹 tab), and a RIGHT PANE consolidated from the
 * old six tabs into two standing surfaces — the LIVE CANVAS (stage rail + growing agent DAG,
 * the default) and a RUN SUMMARY — plus an on-demand agent inspector opened by clicking a node.
 * Everything is a pure projection of the same SSE BrainEvent stream, so a replayed historical
 * run renders the same canvas deterministically.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ViewHeader, Badge, Button, FilterChip, Icon } from "@/app/portal/components";
import { useI18n } from "@/app/portal/lib/preferences-context";
import { useTenant } from "@/app/portal/lib/use-tenant";
import { tenantHeader } from "@/lib/hooks/tenant-header";
import { useBrainStream, activeRunKey, type BrainEvent } from "@/lib/hooks/useBrainStream";
import { isStopIntent } from "@/lib/factory-intent";
import { CodeBox, FullModal } from "./atoms";
import { TranscriptFeed, TRANSCRIPT_FILTERS, filterBlocks } from "./transcript";
import { InteractionDock } from "./interaction-dock"; // #W3-UI unified pending-interaction surface
import { StageRail, EventGraph } from "./canvas";
import { BrainFlow } from "./brain-flow";
import { ActivityLog } from "./activity-log";
import { AgentInspector } from "./inspector";
import { AgentCardList, SandboxIOPanel } from "./agent-cards";
import { RunSummary } from "./run-summary";
import { CollapsibleSection, DomainList, HistoryList, DraftList, HealthStrip } from "./left-rail";
import { BackgroundPanel } from "./background-panel";
import { OntologyManager } from "./ontology-manager";
import { SystemMap } from "./system-map";
import { toBlocks, deriveAgents, deriveScores, deriveStages, deriveBrainFlow, deriveAgentVersions, type DomainRow, type RunRow, type DraftRow, type AgentIO, type AgentCardData, type Block } from "./model";

const SAMPLE_GOALS = [
  "为这个业务域生成能真正跑通的智能体，并试运行验证整条事件链。",
  "只生成「简历处理 → 规则校验 → 简历匹配」这条链路的智能体。",
  "生成全部智能体，重点把每个智能体的强制业务规则写进它的指令。",
];

async function apiGet<T>(path: string): Promise<T | null> {
  try {
    const r = await fetch(path, { credentials: "same-origin", headers: { Accept: "application/json", ...tenantHeader() } });
    const b = await r.json();
    return b?.ok ? (b.data as T) : null;
  } catch {
    return null;
  }
}
async function apiSend(path: string, method: "POST" | "DELETE", body?: unknown): Promise<void> {
  // Only attach a JSON content-type when there's a body — Fastify 400s on an empty body with
  // `content-type: application/json` (FST_ERR_CTP_EMPTY_JSON_BODY). Matches useMe/useAccess.
  const headers: Record<string, string> = { Accept: "application/json", ...tenantHeader() };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  await fetch(path, { method, credentials: "same-origin", headers, body: body !== undefined ? JSON.stringify(body) : undefined }).catch(() => {});
}

// #4/#2 — durable per-(tenant,domain) conversation id + last-used domain, so a follow-up message
// after a page reload / finished run RESUMES the thread (brain reloads prior context) instead of
// silently starting a fresh conversation that ignores history.
const convStoreKey = (tn: string, dm: string) => `ao:factory:conv:${tn}:${dm}`;
const lastDomainKey = (tn: string) => `ao:factory:lastDomain:${tn}`;

export default function FactoryPage() {
  const { t } = useI18n();
  const tenant = useTenant();
  const [domains, setDomains] = useState<DomainRow[]>([]);
  const [gatewayOk, setGatewayOk] = useState(true);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [deletedRuns, setDeletedRuns] = useState<RunRow[]>([]); // #5 recycle bin (soft-deleted runs)
  const [showTrash, setShowTrash] = useState(false);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [promoting, setPromoting] = useState(false);
  const [promoteMsg, setPromoteMsg] = useState("");
  const [domain, setDomain] = useState("");
  const [domainQuery, setDomainQuery] = useState("");
  const [goal, setGoal] = useState("");
  const [injectText, setInjectText] = useState("");
  // composer attachments: ontology JSON files (merged → a local domain) + tool docs (→ the brain builds tools).
  const [attached, setAttached] = useState<Array<{ name: string; text: string; kind: "tooldoc" }>>([]);
  const [composerErr, setComposerErr] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [injectNote, setInjectNote] = useState("");
  const [req, setReq] = useState<{ tenant: string; domain?: string; goal?: string; conversation?: string; reconnectRunId?: string; nonce: number } | null>(null);
  const [viewingRun, setViewingRun] = useState<{ id: string; transcript: BrainEvent[] } | null>(null);
  const [tab, setTab] = useState<"flow" | "brain" | "test" | "summary" | "bg">("flow");
  const [ontoMgrOpen, setOntoMgrOpen] = useState(false); // 本地本体管理 modal
  const [deliverView, setDeliverView] = useState<"cards" | "graph">("cards"); // #F — agent card list default
  const [brainView, setBrainView] = useState<"flow" | "log" | "map">("flow");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [transcriptFilter, setTranscriptFilter] = useState("all");
  const [leftOpen, setLeftOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState<null | "flow" | "brain" | "test" | "summary" | "bg">(null);
  const [rightOpen, setRightOpen] = useState(true);
  const [analysis, setAnalysis] = useState<Record<string, unknown> | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [modal, setModal] = useState<{ title: string; body: React.ReactNode } | null>(null);
  const convRef = useRef<string>("");
  // convId mirrors convRef for rendering (placeholder/button label); convRef is the stable value
  // async callbacks read at call time. setConv keeps both in sync.
  const [convId, setConvId] = useState("");
  const setConv = useCallback((id: string) => { convRef.current = id; setConvId(id); }, []);

  const refreshRuns = useCallback(() => { if (domain) apiGet<{ runs: RunRow[] }>(`/v1/agent-factory/runs?domain=${domain}`).then((d) => d && setRuns(d.runs)); }, [domain]);
  // #5: recycle bin — list + restore soft-deleted runs (the delete button promised "可在回收站恢复").
  const refreshDeletedRuns = useCallback(() => { if (domain) apiGet<{ runs: RunRow[] }>(`/v1/agent-factory/runs?domain=${domain}&deleted=true`).then((d) => setDeletedRuns(d?.runs ?? [])); else setDeletedRuns([]); }, [domain]);
  const toggleTrash = useCallback(() => { setShowTrash((v) => { const next = !v; if (next) refreshDeletedRuns(); return next; }); }, [refreshDeletedRuns]);
  const restoreRunUi = async (id: string) => { await apiSend(`/v1/agent-factory/runs/${id}/restore`, "POST"); refreshDeletedRuns(); refreshRuns(); };
  const refreshDrafts = useCallback(() => { if (domain) apiGet<{ drafts: DraftRow[] }>(`/v1/agent-factory/drafts?domain=${encodeURIComponent(domain)}`).then((d) => setDrafts(d?.drafts ?? [])); else setDrafts([]); setPromoteMsg(""); }, [domain]);
  const refreshDomains = useCallback(() => apiGet<{ domains: DomainRow[]; gatewayConfigured?: boolean }>("/v1/agent-factory/domains").then((d) => { if (!d) return; setDomains(d.domains); setGatewayOk(d.gatewayConfigured !== false); }), []);
  useEffect(() => { void refreshDomains(); }, [refreshDomains]);
  useEffect(() => {
    if (!domains.length) return;
    // Keep a VALID selection; re-pick if `domain` is empty OR stale (no longer in the list — e.g. a
    // previously-selected deployment artifact that's now hidden). Without this, a stale domain id
    // makes every send hit read_ontology on a non-existent domain → the brain dies with no output.
    if (domain && domains.some((d) => d.id === domain)) return;
    let pick = domains[0]!.id;
    try { const last = localStorage.getItem(lastDomainKey(tenant)); if (last && domains.some((d) => d.id === last)) pick = last; } catch { /* ignore */ }
    // 业务领域页「去工厂生成」直达：?domain=<id> 优先于 localStorage（一次性，读后即清）。
    try {
      const q = new URLSearchParams(window.location.search).get("domain");
      if (q && domains.some((d) => d.id === q)) {
        pick = q;
        window.history.replaceState(null, "", window.location.pathname);
      }
    } catch { /* ignore */ }
    setDomain(pick);
  }, [domains, domain, tenant]);
  useEffect(() => { refreshRuns(); }, [refreshRuns]);
  useEffect(() => { refreshDrafts(); }, [refreshDrafts, runs]);
  useEffect(() => { try { const v = localStorage.getItem(`ao:factory:leftOpen:${tenant}`); if (v != null) setLeftOpen(v === "1"); } catch { /* ignore */ } }, [tenant]);
  const toggleLeft = () => setLeftOpen((o) => { const n = !o; try { localStorage.setItem(`ao:factory:leftOpen:${tenant}`, n ? "1" : "0"); } catch { /* ignore */ } return n; });
  useEffect(() => { try { const v = localStorage.getItem(`ao:factory:rightOpen:${tenant}`); if (v != null) setRightOpen(v === "1"); } catch { /* ignore */ } }, [tenant]);
  const toggleRight = () => setRightOpen((o) => { const n = !o; try { localStorage.setItem(`ao:factory:rightOpen:${tenant}`, n ? "1" : "0"); } catch { /* ignore */ } return n; });

  const { events: liveEvents, running, runId, error: streamError } = useBrainStream(req);
  useEffect(() => { if (!running && req) refreshRuns(); }, [running, req, refreshRuns]);
  useEffect(() => {
    try {
      // Reconnect to a still-live background run by its id (SSE replays its buffer). The
      // conversation id is restored separately below (the run id is NOT the conversation id).
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

  const stop = async () => { if (!runId) return; await apiSend("/v1/agent-factory/stop", "POST", { runId }); };

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
  const lastSandbox = useMemo(() => [...events].reverse().find((e) => e.t === "sandbox") as Record<string, unknown> | undefined, [events]);
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

  const healthChecks = useMemo(() => [
    { ok: agents.length > 0, label: `已设计 ${agents.length} 个智能体` },
    { ok: agents.length ? agents.every((a) => a.tools.length > 0) : undefined, label: "工具全绑定" },
    { ok: agents.length ? agents.every((a) => !!a.code) : undefined, label: "代码齐全" },
    { ok: lastValidation ? lastValidation.ok : undefined, label: "事件图闭合" },
    { ok: lastSandbox ? Boolean(lastSandbox.fullChainRan) : undefined, label: "沙箱端到端跑通" },
  ], [agents, lastValidation, lastSandbox]);

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

  // ── actions ──
  // Reset the in-memory conversation view WITHOUT touching durable storage (so switching domains
  // keeps each domain's saved thread). 新会话 additionally drops the current domain's saved thread.
  const resetConversation = () => { setConv(""); setReq(null); setViewingRun(null); setSelectedSlug(null); setTab("flow"); setAnalysis(null); };
  const newConversation = () => {
    // Drop this domain's saved thread AND the reconnect handle, so a fresh start isn't hijacked by
    // the on-mount reconnect effect resurrecting the previous run.
    try { localStorage.removeItem(convStoreKey(tenant, domain)); localStorage.removeItem(activeRunKey(tenant)); } catch { /* ignore */ }
    resetConversation();
  };
  const pickDomain = (id: string) => { setDomain(id); resetConversation(); };

  // Classify an attachment by CONTENT: ontology-shaped JSON (actions/events/rules/dataObjects,
  // or an array of action-like objects) is routed to the left「本地本体」panel (single upload home,
  // no composer/left duplication); anything else (tool/API doc, OpenAPI, prose) is a TOOL DOC the
  // brain reads + turns into tools via create_tool.
  const classifyAttachment = (name: string, text: string): "ontology" | "tooldoc" => {
    const t = text.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        const j: unknown = JSON.parse(t);
        if (j && typeof j === "object" && !Array.isArray(j)) {
          const o = j as Record<string, unknown>;
          if (o.actions || o.action || o.events || o.event || o.rules || o.dataObjects || o.objects || o.entities) return "ontology";
        }
        if (Array.isArray(j) && j.length && j[0] && typeof j[0] === "object") {
          const first = j[0] as Record<string, unknown>;
          if (first.trigger || first.triggered_event || first.actor || first.target_objects || /action|event|rule|object|entit|ontolog/i.test(name)) return "ontology";
        }
      } catch { /* not JSON → a tool/prose doc */ }
    }
    return "tooldoc";
  };

  const onAttachFiles = async (files: FileList | null) => {
    if (!files) return;
    setComposerErr("");
    const next = [...attached];
    const rejected: string[] = [];
    for (const f of Array.from(files)) {
      const text = await f.text().catch(() => "");
      if (!text) continue;
      // 本体 JSON 归左侧「本地本体 · 上传/管理」统一处理——曲别针只收工具/参考文档，避免两处重复上传。
      if (classifyAttachment(f.name, text) === "ontology") { rejected.push(f.name); continue; }
      next.push({ name: f.name, text, kind: "tooldoc" });
    }
    setAttached(next);
    if (rejected.length) setComposerErr(`${rejected.map((n) => `「${n}」`).join("、")} 看起来是本体文件——请用左栏「📦 本地本体 · 上传/管理」上传（会成为可选业务域）。`);
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = async () => {
    if (running) return;
    setComposerErr("");
    const docs = attached; // 曲别针只收工具/参考文档；本体在左栏「本地本体」上传
    const runDomain = domain;
    if (!runDomain) { setComposerErr("请先在左侧选一个业务域，或在左栏「本地本体」上传一份本体。"); return; }
    if (!goal.trim() && !docs.length) return;
    // tool docs → a directive + the doc text composed into the goal, so the brain reads, reasons,
    // and uses create_tool to build the needed tools INTO this domain's tool library.
    let finalGoal = goal.trim();
    if (docs.length) {
      const block = docs.map((d, i) => `--- 文档 ${i + 1}：${d.name} ---\n${d.text.slice(0, 3000)}`).join("\n\n");
      finalGoal = `【附带 ${docs.length} 份文档：请先阅读、推理，用 create_tool 把其中可用的 API 整合成工具、存进本业务域的工具库，再继续生成/验证 agents】\n\n${block}\n\n${finalGoal || "据此为本业务域生成能真正跑通的智能体并验证整条事件链。"}`;
    }
    // start the run.
    setViewingRun(null); setSelectedSlug(null);
    let conv = convRef.current;
    if (!conv || runDomain !== domain) { conv = `factory-${tenant}-${runDomain}-${Date.now()}`; setConv(conv); }
    try { localStorage.setItem(convStoreKey(tenant, runDomain), conv); localStorage.setItem(lastDomainKey(tenant), runDomain); } catch { /* ignore */ }
    setReq({ tenant, domain: runDomain, goal: finalGoal, conversation: conv, nonce: Date.now() });
    setGoal(""); setAttached([]);
  };
  const inject = async () => {
    const text = injectText.trim();
    if (!text) return;
    if (isStopIntent(text)) { setInjectText(""); await stop(); return; }
    if (!convRef.current) return;
    setInjectText("");
    // #4: read back whether a live brain will drain this NOW vs save it for the next continue, so
    // the user gets honest feedback instead of an inject silently vanishing into an idle mailbox.
    try {
      const r = await fetch("/v1/agent-factory/inject", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", ...tenantHeader() }, body: JSON.stringify({ conversation: convRef.current, text }) });
      const b = await r.json();
      if (b?.data && b.data.active === false) setInjectNote("已记下——当前没有正在运行的任务，下次继续这个对话时会自动带上你的补充。");
      else { setInjectNote("✓ 已发送，将在下一步纳入"); setTimeout(() => setInjectNote(""), 2500); }
    } catch { /* ignore */ }
  };
  const decideBoundary = async (evs: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>) => {
    if (!convRef.current) return;
    await apiSend("/v1/agent-factory/inject", "POST", { conversation: convRef.current, text: `[边界事件决策] ${JSON.stringify(evs)}` });
  };
  const decideTestCases = async (decision: "approve" | "regenerate", note?: string) => {
    if (!convRef.current) return;
    await apiSend("/v1/agent-factory/inject", "POST", { conversation: convRef.current, text: `[测试用例决策: ${decision === "approve" ? "执行" : "重新生成"}] ${note ?? ""}`.trim() });
  };
  const decideClarify = async (answer: string) => {
    if (!convRef.current) return;
    await apiSend("/v1/agent-factory/inject", "POST", { conversation: convRef.current, text: `[澄清回答] ${answer}` });
  };
  // R12: supplement + regenerate ONE agent. Inject while a run is live; otherwise resume the
  // conversation with a scoped directive so the brain re-designs only this agent.
  const regenerateAgent = (actionName: string, supplement: string) => {
    const directive = `请只重新设计 agent「${actionName}」${supplement ? `，补充信息：${supplement}` : ""}，别动其它已采纳的 agent。`;
    if (running && convRef.current) { void apiSend("/v1/agent-factory/inject", "POST", { conversation: convRef.current, text: directive }); return; }
    let conv = convRef.current;
    if (!conv) { conv = `factory-${tenant}-${domain}-${Date.now()}`; setConv(conv); }
    try { localStorage.setItem(convStoreKey(tenant, domain), conv); localStorage.setItem(lastDomainKey(tenant), domain); } catch { /* ignore */ }
    setViewingRun(null); setSelectedSlug(null);
    setReq({ tenant, domain, goal: directive, conversation: conv, nonce: Date.now() });
  };
  const openRun = async (id: string) => { const d = await apiGet<{ run: { transcript: BrainEvent[] } }>(`/v1/agent-factory/runs/${id}`); if (d) { setViewingRun({ id, transcript: d.run.transcript }); setReq(null); setSelectedSlug(null); setTab("flow"); } };
  const deleteRunUi = async (id: string) => {
    if (!window.confirm("删除该运行？(软删除，可在「回收站」恢复)")) return;
    await apiSend(`/v1/agent-factory/runs/${id}`, "DELETE");
    if (viewingRun?.id === id) setViewingRun(null);
    refreshRuns();
    if (showTrash) refreshDeletedRuns();
  };
  const clearRunsUi = async () => {
    if (!domain || !window.confirm("清空该业务域所有已完成的运行？(软删除)")) return;
    await apiSend(`/v1/agent-factory/runs?domain=${encodeURIComponent(domain)}`, "DELETE");
    refreshRuns();
  };
  const showCode = (a: AgentCardData) => setModal({ title: `${a.nameZh} · 代码`, body: <CodeBox code={a.code ?? ""} /> });
  // #6: AI run review of the current/viewed run (needs a saved transcript → a finished run).
  const analyzeRunUi = async () => {
    const id = viewingRun?.id ?? runId;
    if (!id || analyzing) return;
    setAnalyzing(true); setAnalysis(null);
    try {
      const r = await fetch(`/v1/agent-factory/runs/${id}/analyze`, { method: "POST", credentials: "same-origin", headers: { Accept: "application/json", ...tenantHeader() } });
      const b = await r.json();
      setAnalysis(b?.ok ? (b.data.review as Record<string, unknown>) : { error: b?.error?.message ?? "分析失败" });
    } catch (e) { setAnalysis({ error: (e as Error).message }); }
    finally { setAnalyzing(false); }
  };
  const deleteDraftUi = async (slug: string) => {
    if (!domain || !window.confirm("删除这个生成的草稿？（不影响已晋升上线的 agent）")) return;
    await apiSend(`/v1/agent-factory/drafts/${encodeURIComponent(slug)}?domain=${encodeURIComponent(domain)}`, "DELETE");
    refreshDrafts();
  };
  const promote = async (slugs?: string[]) => {
    if (!domain || promoting || !drafts.length) return;
    setPromoting(true); setPromoteMsg("");
    try {
      const r = await fetch("/v1/agent-factory/drafts/promote", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", ...tenantHeader() }, body: JSON.stringify({ domain, slugs: slugs && slugs.length ? slugs : undefined }) });
      const b = await r.json();
      if (b?.ok) { setPromoteMsg(`✅ 已晋升 ${b.data.promoted.length} 个 · 注册 ${b.data.functionsRegistered} 个函数 · 工作流现 ${b.data.liveAgents} 个 agent`); refreshRuns(); }
      else setPromoteMsg(`晋升失败：${b?.error?.message ?? "未知错误"}`);
    } catch (e) { setPromoteMsg(`晋升失败：${(e as Error).message}`); }
    finally { setPromoting(false); }
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
            setReq({ tenant, reconnectRunId: id, nonce: Date.now() });
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
    if (selectedAgent) return <AgentInspector agent={selectedAgent} io={selectedIo} score={selectedScore} versions={agentVersions.get(selectedAgent.slug) ?? []} onBack={() => setSelectedSlug(null)} onShowCode={showCode} onRegenerate={regenerateAgent} />;
    return (
      <div>
        <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
          {([["cards", "卡片列表"], ["graph", "事件图"]] as Array<["cards" | "graph", string]>).map(([k, label]) => (
            <button key={k} onClick={() => setDeliverView(k)} style={{ fontSize: 11.5, padding: "3px 12px", borderRadius: 20, cursor: "pointer", border: `1px solid ${deliverView === k ? "var(--signal)" : "var(--border)"}`, background: deliverView === k ? "var(--panel-2)" : "transparent", color: deliverView === k ? "var(--text)" : "var(--text-3)" }}>{label}</button>
          ))}
        </div>
        {deliverView === "cards"
          ? <AgentCardList agents={agents} degraded={degraded} ioByShort={ioByShort} onShowCode={showCode} onRegenerate={regenerateAgent} onSelect={setSelectedSlug} />
          : <div style={full ? { height: "78vh" } : undefined}><EventGraph agents={agents} scores={scores} degraded={degraded} selectedSlug={selectedSlug} onSelect={setSelectedSlug} /></div>}
      </div>
    );
  };
  const TAB_TITLE: Record<string, string> = { flow: "智能体 · 交付", brain: "大脑", test: "测试 · 沙箱 I/O", summary: "总结", bg: "后台任务" };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.factory")}
        subtitle={t("factory.subtitle")}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {running && <Badge tone="signal">运行中</Badge>}
            {viewingRun && <Badge tone="muted">查看历史</Badge>}
            <Button icon="plus" onClick={newConversation}>新会话</Button>
          </div>
        }
      />
      {modal && <FullModal title={modal.title} onClose={() => setModal(null)}>{modal.body}</FullModal>}
      {ontoMgrOpen && (
        <FullModal title="本地本体 · 上传与管理" onClose={() => setOntoMgrOpen(false)}>
          <OntologyManager currentDomain={domain} onDomainsChanged={() => void refreshDomains()} />
        </FullModal>
      )}
      {fullscreen && (
        <FullModal title={`${TAB_TITLE[fullscreen] ?? "全屏"} · 全屏`} onClose={() => setFullscreen(null)}>
          {renderTabBody(true)}
        </FullModal>
      )}

      <div style={{ flex: 1, position: "relative", display: "grid", gridTemplateColumns: `${leftOpen ? "238px" : "0px"} 1fr ${rightOpen ? "420px" : "0px"}`, minHeight: 0, transition: "grid-template-columns 0.2s ease" }}>
        {/* 栏收起/展开：手柄贴在各自分隔线上（不再挤在页头，方向不再歧义）。 */}
        <button
          title={leftOpen ? "收起左栏" : "展开左栏"}
          onClick={toggleLeft}
          style={{ position: "absolute", left: leftOpen ? 238 : 0, top: "50%", transform: leftOpen ? "translate(-50%, -50%)" : "translateY(-50%)", zIndex: 5, width: 18, height: 48, borderRadius: leftOpen ? 9 : "0 9px 9px 0", border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text-3)", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0, transition: "left 0.2s ease" }}
        >{leftOpen ? "‹" : "›"}</button>
        <button
          title={rightOpen ? "收起右栏" : "展开右栏"}
          onClick={toggleRight}
          style={{ position: "absolute", right: rightOpen ? 420 : 0, top: "50%", transform: rightOpen ? "translate(50%, -50%)" : "translateY(-50%)", zIndex: 5, width: 18, height: 48, borderRadius: rightOpen ? 9 : "9px 0 0 9px", border: "1px solid var(--border)", background: "var(--panel)", color: "var(--text-3)", cursor: "pointer", fontSize: 12, lineHeight: 1, padding: 0, transition: "right 0.2s ease" }}
        >{rightOpen ? "›" : "‹"}</button>
        {/* ── left rail ── */}
        <div style={{ borderRight: leftOpen ? "1px solid var(--border)" : "none", overflow: "auto", padding: leftOpen ? 12 : 0, display: leftOpen ? "flex" : "none", flexDirection: "column", gap: 14 }}>
          <CollapsibleSection title="业务域" storageKey={`ao:factory:sec:domains:${tenant}`}>
            <DomainList domains={domains} domain={domain} query={domainQuery} setQuery={setDomainQuery} onSelect={pickDomain} />
            <button onClick={() => setOntoMgrOpen(true)} className="factory-cta" style={{ marginTop: 6, width: "100%", textAlign: "left", fontSize: 11, padding: "5px 8px", borderRadius: 7, border: "1px dashed var(--border)", background: "none", color: "var(--text-3)", cursor: "pointer" }}>
              📦 本地本体 · 上传 / 管理
            </button>
          </CollapsibleSection>
          <CollapsibleSection title="历史运行" defaultOpen={false} badge={<span style={{ fontSize: 10, color: "var(--text-3)" }}>{runs.length}</span>} storageKey={`ao:factory:sec:runs:${tenant}`}>
            <HistoryList runs={runs} viewingRunId={viewingRun?.id ?? null} onOpen={openRun} onDelete={deleteRunUi} onClear={clearRunsUi} deletedRuns={deletedRuns} showTrash={showTrash} onToggleTrash={toggleTrash} onRestore={restoreRunUi} />
          </CollapsibleSection>
          <CollapsibleSection title="已生成 · 草稿" defaultOpen={false} badge={<span style={{ fontSize: 10, color: "var(--text-3)" }}>{drafts.length}</span>} storageKey={`ao:factory:sec:drafts:${tenant}`}>
            <DraftList drafts={drafts} promoting={promoting} promoteMsg={promoteMsg} onPromote={promote} onDelete={deleteDraftUi} />
          </CollapsibleSection>
          <HealthStrip checks={healthChecks} />
        </div>

        {/* ── center: hero / transcript + composer ── */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0, borderRight: "1px solid var(--border)" }}>
          {!gatewayOk && (
            <div style={{ margin: 12, marginBottom: 0, padding: "10px 12px", border: "1px solid var(--amber)", borderRadius: 8, background: "var(--panel-2)", fontSize: 12.5, color: "var(--amber)", lineHeight: 1.6 }}>
              ⚠ LLM 网关未配置 —— 大脑无法运行。请在 <code style={{ fontFamily: "var(--mono)" }}>.env</code> 设置 <code style={{ fontFamily: "var(--mono)" }}>CUSTOM_LLM_BASE_URL</code> + <code style={{ fontFamily: "var(--mono)" }}>CUSTOM_LLM_API_KEY</code>（或 <code style={{ fontFamily: "var(--mono)" }}>OPENAI_API_KEY</code>），重启 API 后生效。
            </div>
          )}
          {streamError && (
            <div role="alert" style={{ margin: 12, marginBottom: 0, padding: "10px 12px", border: "1px solid var(--red)", borderRadius: 10, background: "var(--panel-2)", fontSize: 12.5, color: "var(--red)", lineHeight: 1.6 }}>⚠ {streamError}</div>
          )}
          {!isHero && (
            <div style={{ display: "flex", gap: 5, alignItems: "center", padding: "8px 16px", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
              <span style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", marginRight: 2 }}>筛选</span>
              {TRANSCRIPT_FILTERS.map((f) => <FilterChip key={f.key} active={transcriptFilter === f.key} onClick={() => setTranscriptFilter(f.key)}>{f.label}</FilterChip>)}
            </div>
          )}
          <div ref={feedRef} style={{ flex: 1, overflow: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 7 }}>
            {isHero ? (
              <div className="rise" style={{ margin: "auto", maxWidth: 580, textAlign: "center" }}>
                <div style={{ fontSize: 30, marginBottom: 10 }}>⚡</div>
                <h2 style={{ fontSize: 21, fontWeight: 700, color: "var(--text)", margin: "0 0 8px", letterSpacing: "-0.01em" }}>自主智能体工厂</h2>
                <p style={{ fontSize: 13.5, color: "var(--text-3)", lineHeight: 1.6, margin: "0 0 22px" }}>描述目标或上传本体，自动生成、验证并交付可运行的智能体。</p>
                <div style={{ fontSize: 11, color: "var(--text-3)", textAlign: "left", marginBottom: 8 }}>试试这些目标</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {SAMPLE_GOALS.map((g) => <button key={g} className="factory-cta" onClick={() => setGoal(g)} style={{ textAlign: "left", padding: "11px 13px", borderRadius: 9, border: "1px solid var(--border)", background: "var(--panel-2)", color: "var(--text-2)", cursor: "pointer", fontSize: 12.5, lineHeight: 1.5 }}>{g}</button>)}
                </div>
              </div>
            ) : filteredBlocks.length === 0 ? (
              <div style={{ margin: "auto", fontSize: 12, color: "var(--text-4)" }}>该筛选下暂无内容</div>
            ) : (
              <TranscriptFeed blocks={filteredBlocks} grouped={transcriptFilter === "all"} />
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
          {!viewingRun && running && <InteractionDock blocks={blocks} onClarify={decideClarify} onDecide={decideTestCases} onBoundary={decideBoundary} />}

          {/* composer (业务域 selector removed — pick the domain in the left sidebar) */}
          <div style={{ borderTop: "1px solid var(--border)", padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
            {viewingRun ? (
              <Button onClick={newConversation}>← 返回，开始新会话</Button>
            ) : running ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={injectText} onChange={(e) => setInjectText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") inject(); }} placeholder="运行中，可随时打字介入（输入「停止」中止）" style={{ flex: 1, fontSize: 13, padding: "8px 10px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8 }} />
                  <Button onClick={inject} disabled={!injectText.trim()}>介入 ↵</Button>
                  <Button icon="pause" tone="danger" onClick={stop}>停止</Button>
                </div>
                {injectNote && <div style={{ fontSize: 11.5, color: "var(--text-3)" }}>{injectNote}</div>}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {/* 曲别针只收工具/参考文档（📄）——本体统一走左栏「本地本体 · 上传/管理」，不再两处重复。 */}
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
                {composerErr && <div style={{ fontSize: 11.5, color: "var(--red)" }}>{composerErr}</div>}
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <input ref={fileRef} type="file" multiple accept=".json,.txt,.md,.markdown,.html,.htm,.csv,application/json,text/*" style={{ display: "none" }} onChange={(e) => void onAttachFiles(e.target.files)} />
                  <button className="factory-cta" onClick={() => fileRef.current?.click()} title="上传本体 JSON 或工具文档" style={{ fontSize: 16, lineHeight: 1, padding: "8px 10px", background: "var(--panel-2)", color: "var(--text-2)", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" }}>📎</button>
                  <textarea value={goal} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} placeholder={convId ? "继续对话…  ⌘/Ctrl+Enter 发送" : attached.length ? "可补充目标（可留空）…  ⌘/Ctrl+Enter 发送" : "描述你要做什么，或点 📎 附上工具/参考文档 …  ⌘/Ctrl+Enter 发送"} rows={2} style={{ flex: 1, resize: "none", fontSize: 13, padding: "8px 10px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "var(--sans)" }} />
                  <Button icon="spark" tone="primary" onClick={() => void submit()} disabled={running || !domain || (!goal.trim() && attached.length === 0)}>{convId ? "发送" : "开始"}</Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── right pane: pinned stage rail + 4 tabs (智能体 / 大脑 / 测试 / 总结), 可收起 + 每 tab 全屏 ── */}
        {rightOpen && (
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* pinned at-a-glance stage rail — always visible above the tabs */}
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <StageRail stages={stages} current={current} running={running} refineCount={refineCount} />
            {awaitingHint && (
              <div style={{ marginTop: 7, fontSize: 11.5, color: "var(--amber)", display: "flex", alignItems: "center", gap: 6 }}>
                <span className="health-pulse" style={{ color: "var(--amber)", width: 9, height: 9 }} />等你决定：{awaitingHint}（在中间聊天区回答）
              </div>
            )}
          </div>
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
            {([["flow", `智能体${agents.length ? ` · ${agents.length}` : ""}`], ["brain", "大脑"], ["test", `测试${testCaseList.length || sandboxRuns.length ? ` · ${testCaseList.length || sandboxRuns.length}` : ""}`], ["summary", "总结"], ["bg", `${awaitingHint ? "● " : ""}后台`]] as Array<["flow" | "brain" | "test" | "summary" | "bg", string]>).map(([k, label]) => (
              <button key={k} onClick={() => { setTab(k); setSelectedSlug(null); }} style={{ flex: "1 0 auto", padding: "9px 6px", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", background: "none", border: "none", borderBottom: tab === k ? "2px solid var(--signal)" : "2px solid transparent", color: tab === k ? "var(--text)" : "var(--text-3)", cursor: "pointer", transition: "color 0.15s ease, border-color 0.15s ease" }}>{label}</button>
            ))}
            <button title="全屏查看当前标签" onClick={() => setFullscreen(tab)} style={{ padding: "0 10px", background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", display: "inline-flex", alignItems: "center" }}>
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
