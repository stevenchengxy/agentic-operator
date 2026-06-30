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
import { StageRail, EventGraph } from "./canvas";
import { BrainFlow } from "./brain-flow";
import { ActivityLog } from "./activity-log";
import { AgentInspector } from "./inspector";
import { AgentCardList, SandboxIOPanel } from "./agent-cards";
import { RunSummary } from "./run-summary";
import { CollapsibleSection, DomainList, HistoryList, DraftList, HealthStrip } from "./left-rail";
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
  const [attached, setAttached] = useState<Array<{ name: string; text: string; kind: "ontology" | "tooldoc" }>>([]);
  const [ontologyName, setOntologyName] = useState("");
  const [composerErr, setComposerErr] = useState("");
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [injectNote, setInjectNote] = useState("");
  const [req, setReq] = useState<{ tenant: string; domain?: string; goal?: string; conversation?: string; reconnectRunId?: string; nonce: number } | null>(null);
  const [viewingRun, setViewingRun] = useState<{ id: string; transcript: BrainEvent[] } | null>(null);
  const [tab, setTab] = useState<"flow" | "brain" | "test" | "summary">("flow");
  const [deliverView, setDeliverView] = useState<"cards" | "graph">("cards"); // #F — agent card list default
  const [brainView, setBrainView] = useState<"flow" | "log">("flow");
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [transcriptFilter, setTranscriptFilter] = useState("all");
  const [leftOpen, setLeftOpen] = useState(true);
  const [fullscreen, setFullscreen] = useState<null | "flow" | "brain">(null);
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
    setDomain(pick);
  }, [domains, domain, tenant]);
  useEffect(() => { refreshRuns(); }, [refreshRuns]);
  useEffect(() => { refreshDrafts(); }, [refreshDrafts, runs]);
  useEffect(() => { try { const v = localStorage.getItem(`ao:factory:leftOpen:${tenant}`); if (v != null) setLeftOpen(v === "1"); } catch { /* ignore */ } }, [tenant]);
  const toggleLeft = () => setLeftOpen((o) => { const n = !o; try { localStorage.setItem(`ao:factory:leftOpen:${tenant}`, n ? "1" : "0"); } catch { /* ignore */ } return n; });

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
  // Merge multiple uploaded ontology JSON files into one bundle. Each file may be a combined
  // object ({actions,events,rules,dataObjects}) OR a bare array (type inferred from the filename:
  // *event*/*rule*/*object|entity*/else actions). So you can drop actions.json + events.json +
  // rules.json + dataObjects.json separately and they fuse into one local business domain.
  const mergeOntologyFiles = (files: Array<{ name: string; text: string }>) => {
    const bundle: Record<"actions" | "events" | "rules" | "dataObjects", unknown[]> = { actions: [], events: [], rules: [], dataObjects: [] };
    const put = (k: keyof typeof bundle, v: unknown) => { if (Array.isArray(v)) bundle[k].push(...v); };
    for (const f of files) {
      let json: unknown;
      try { json = JSON.parse(f.text); } catch { continue; }
      if (Array.isArray(json)) {
        const n = f.name.toLowerCase();
        const k = /event/.test(n) ? "events" : /rule/.test(n) ? "rules" : /object|entit|dataobject/.test(n) ? "dataObjects" : "actions";
        put(k, json);
      } else if (json && typeof json === "object") {
        const o = json as Record<string, unknown>;
        put("actions", o.actions ?? o.action); put("events", o.events ?? o.event);
        put("rules", o.rules ?? o.rule); put("dataObjects", o.dataObjects ?? o.objects ?? o.entities);
      }
    }
    return bundle;
  };

  // Infer intent from the file CONTENT, not just the extension (the user wants the AI to figure out
  // what an uploaded doc IS): ontology-shaped JSON (actions/events/rules/dataObjects, or an array of
  // action-like objects) → treat as an ONTOLOGY to generate from; anything else (a tool/API doc, an
  // OpenAPI spec, prose) → a TOOL DOC for the brain to reason about + create_tool. The chip lets the
  // user flip the guess (intent override).
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

  // Derive a human domain name from a file name — but NOT from a raw split-export like
  // "actions_v0_1_005_6agents" (that landed verbatim in the name field and read as a spurious
  // duplicate chip). Versioned exports → "" (leave the placeholder); clean names → titled.
  const cleanDomainName = (filename: string): string => {
    const base = filename.replace(/\.[^.]+$/, "");
    if (/_v\d/i.test(base)) return ""; // versioned ontology export → no clean human name
    const stem = base
      .replace(/^(actions?|events?|rules?|data[_-]?objects?|objects?|entit(?:y|ies))[_-]+/i, "")
      .replace(/[_-]+/g, " ")
      .trim();
    return /[a-z一-鿿]{2,}/i.test(stem) ? stem : "";
  };

  const onAttachFiles = async (files: FileList | null) => {
    if (!files) return;
    const next = [...attached];
    for (const f of Array.from(files)) {
      const text = await f.text().catch(() => "");
      if (text) next.push({ name: f.name, text, kind: classifyAttachment(f.name, text) });
    }
    setAttached(next);
    const firstOnto = next.find((a) => a.kind === "ontology");
    if (firstOnto && !ontologyName.trim()) {
      const clean = cleanDomainName(firstOnto.name);
      if (clean) setOntologyName(clean);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const submit = async () => {
    if (running) return;
    setComposerErr("");
    const onto = attached.filter((a) => a.kind === "ontology");
    const docs = attached.filter((a) => a.kind === "tooldoc");
    let runDomain = domain;
    // 1) ontology files → create a reusable LOCAL business domain, switch to it.
    if (onto.length) {
      const bundle = mergeOntologyFiles(onto);
      if (!bundle.actions.length) { setComposerErr("上传的本体文件里没有任何 action（actions），无法作为业务域。"); return; }
      const nm = ontologyName.trim() || onto[0]!.name.replace(/\.[^.]+$/, "") || "上传本体";
      try {
        const r = await fetch("/v1/agent-factory/ontology-upload", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", Accept: "application/json", ...tenantHeader() }, body: JSON.stringify({ name: nm, ontology: bundle }) });
        const b = await r.json();
        if (!b?.ok) { setComposerErr(`本体上传失败：${b?.error?.message ?? ""}`); return; }
        runDomain = b.data.uploaded.id;
        await refreshDomains();
        setDomain(runDomain);
      } catch (e) { setComposerErr(`本体上传失败：${(e as Error).message}`); return; }
    }
    if (!runDomain) { setComposerErr("请先在左侧选一个业务域，或上传一份本体文件。"); return; }
    if (!goal.trim() && !docs.length && !onto.length) return;
    // 2) tool docs → a directive + the doc text composed into the goal, so the brain reads, reasons,
    //    and uses create_tool to build the needed tools INTO this domain's tool library.
    let finalGoal = goal.trim();
    if (docs.length) {
      const block = docs.map((d, i) => `--- 工具文档 ${i + 1}：${d.name} ---\n${d.text.slice(0, 3000)}`).join("\n\n");
      finalGoal = `【附带 ${docs.length} 份工具文档：请先阅读、推理，用 create_tool 把其中可用的 API 整合成工具、存进本业务域的工具库，再继续生成/验证 agents】\n\n${block}\n\n${finalGoal || "据此为本业务域生成能真正跑通的智能体并验证整条事件链。"}`;
    } else if (!finalGoal && onto.length) {
      finalGoal = "读取我刚上传的本体，为本业务域生成能真正跑通的智能体并试运行验证整条事件链。";
    }
    // 3) start the run.
    setViewingRun(null); setSelectedSlug(null);
    let conv = convRef.current;
    if (!conv || runDomain !== domain) { conv = `factory-${tenant}-${runDomain}-${Date.now()}`; setConv(conv); }
    try { localStorage.setItem(convStoreKey(tenant, runDomain), conv); localStorage.setItem(lastDomainKey(tenant), runDomain); } catch { /* ignore */ }
    setReq({ tenant, domain: runDomain, goal: finalGoal, conversation: conv, nonce: Date.now() });
    setGoal(""); setAttached([]); setOntologyName("");
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

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <ViewHeader
        title={t("nav.factory")}
        subtitle={t("factory.subtitle")}
        action={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Button icon={leftOpen ? "chevron-left" : "chevron-right"} onClick={toggleLeft}>{leftOpen ? "收起栏" : "展开栏"}</Button>
            {running && <Badge tone="signal">运行中</Badge>}
            {viewingRun && <Badge tone="muted">查看历史</Badge>}
            <Button icon="plus" onClick={newConversation}>新会话</Button>
          </div>
        }
      />
      {modal && <FullModal title={modal.title} onClose={() => setModal(null)}>{modal.body}</FullModal>}
      {fullscreen && (
        <FullModal title={fullscreen === "brain" ? "大脑 · 决策流" : "交付图 · 智能体事件流"} onClose={() => setFullscreen(null)}>
          {fullscreen === "brain"
            ? (brainView === "log" ? <ActivityLog blocks={blocks} /> : <BrainFlow steps={brainSteps} running={running} />)
            : <EventGraph agents={agents} scores={scores} degraded={degraded} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />}
        </FullModal>
      )}

      <div style={{ flex: 1, display: "grid", gridTemplateColumns: `${leftOpen ? "238px" : "0px"} 1fr 420px`, minHeight: 0, transition: "grid-template-columns 0.2s ease" }}>
        {/* ── left rail ── */}
        <div style={{ borderRight: leftOpen ? "1px solid var(--border)" : "none", overflow: "auto", padding: leftOpen ? 12 : 0, display: leftOpen ? "flex" : "none", flexDirection: "column", gap: 14 }}>
          <CollapsibleSection title="业务域" storageKey={`ao:factory:sec:domains:${tenant}`}>
            <DomainList domains={domains} domain={domain} query={domainQuery} setQuery={setDomainQuery} onSelect={pickDomain} />
          </CollapsibleSection>
          <CollapsibleSection title="历史运行" defaultOpen={false} badge={<span style={{ fontSize: 10, color: "var(--text-3)" }}>{runs.length}</span>} storageKey={`ao:factory:sec:runs:${tenant}`}>
            <HistoryList runs={runs} viewingRunId={viewingRun?.id ?? null} onOpen={openRun} onDelete={deleteRunUi} onClear={clearRunsUi} deletedRuns={deletedRuns} showTrash={showTrash} onToggleTrash={toggleTrash} onRestore={restoreRunUi} />
          </CollapsibleSection>
          <CollapsibleSection title="已生成 · 草稿" defaultOpen={false} badge={<span style={{ fontSize: 10, color: "var(--text-3)" }}>{drafts.length}</span>} storageKey={`ao:factory:sec:drafts:${tenant}`}>
            <DraftList drafts={drafts} promoting={promoting} promoteMsg={promoteMsg} onPromote={promote} />
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
              <TranscriptFeed blocks={filteredBlocks} grouped={transcriptFilter === "all"} onDecide={decideTestCases} onBoundary={decideBoundary} onClarify={decideClarify} />
            )}
          </div>

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
                {/* attachments: ontology JSON (→ 本地业务域) + 工具文档 (→ 大脑造工具进本域库) */}
                {attached.length > 0 && (() => {
                  // Ontology files (actions/events/rules/dataObjects of one bundle) merge into ONE
                  // business domain — show a SINGLE chip, not N duplicate-looking ones. Tool docs stay
                  // individual (each is its own source). This removes the "duplicate chip" confusion.
                  const onto = attached.filter((a) => a.kind === "ontology");
                  const docs = attached.filter((a) => a.kind === "tooldoc");
                  const clip = (s: string) => (s.length > 22 ? s.slice(0, 21) + "…" : s);
                  return (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
                      {onto.length > 0 && (
                        <span className="factory-cta" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "3px 9px", borderRadius: 12, border: "1px solid var(--green)", color: "var(--text-2)" }}>
                          <span style={{ color: "var(--green)", fontWeight: 600 }}>📦 本体</span>
                          ·{onto.length === 1 ? clip(onto[0]!.name) : `${onto.length} 个文件 · 合并为一个业务域`}
                          <button onClick={() => setAttached(attached.filter((a) => a.kind !== "ontology"))} title="移除本体" style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 12, padding: 0 }}>✕</button>
                        </span>
                      )}
                      {docs.map((a) => {
                        const idx = attached.indexOf(a);
                        return (
                          <span key={idx} className="factory-cta" style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11, padding: "3px 9px", borderRadius: 12, border: "1px solid var(--violet)", color: "var(--text-2)" }}>
                            <span style={{ color: "var(--violet)", fontWeight: 600 }}>📄 工具文档</span>
                            ·{clip(a.name)}
                            <button onClick={() => setAttached(attached.map((x, j) => (j === idx ? { ...x, kind: "ontology" } : x)))} title="改为本体" style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 12, padding: 0 }}>↔</button>
                            <button onClick={() => setAttached(attached.filter((_, j) => j !== idx))} title="移除" style={{ background: "none", border: "none", color: "var(--text-3)", cursor: "pointer", fontSize: 12, padding: 0 }}>✕</button>
                          </span>
                        );
                      })}
                      {onto.length > 0 && (
                        <input value={ontologyName} onChange={(e) => setOntologyName(e.target.value)} placeholder="业务域名字（可留空）" style={{ fontSize: 11.5, padding: "3px 8px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 6, width: 160 }} />
                      )}
                    </div>
                  );
                })()}
                {composerErr && <div style={{ fontSize: 11.5, color: "var(--red)" }}>{composerErr}</div>}
                <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
                  <input ref={fileRef} type="file" multiple accept=".json,.txt,.md,.markdown,.html,.htm,.csv,application/json,text/*" style={{ display: "none" }} onChange={(e) => void onAttachFiles(e.target.files)} />
                  <button className="factory-cta" onClick={() => fileRef.current?.click()} title="上传本体 JSON 或工具文档" style={{ fontSize: 16, lineHeight: 1, padding: "8px 10px", background: "var(--panel-2)", color: "var(--text-2)", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer" }}>📎</button>
                  <textarea value={goal} onChange={(e) => setGoal(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(); }} placeholder={convId ? "继续对话…  ⌘/Ctrl+Enter 发送" : attached.length ? "可补充目标（可留空）…  ⌘/Ctrl+Enter 发送" : "描述你要做什么，或点 📎 上传本体 …  ⌘/Ctrl+Enter 发送"} rows={2} style={{ flex: 1, resize: "none", fontSize: 13, padding: "8px 10px", background: "var(--panel-2)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 8, fontFamily: "var(--sans)" }} />
                  <Button icon="spark" tone="primary" onClick={() => void submit()} disabled={running || !domain || (!goal.trim() && attached.length === 0)}>{convId ? "发送" : "开始"}</Button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── right pane: pinned stage rail + 3 tabs (交付图 / 大脑 / 总结) ── */}
        <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {/* pinned at-a-glance stage rail — always visible above the tabs */}
          <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
            <StageRail stages={stages} current={current} running={running} refineCount={refineCount} />
            {awaitingHint && (
              <div style={{ marginTop: 7, fontSize: 11.5, color: "var(--amber)", display: "flex", alignItems: "center", gap: 6 }}>
                <span className="health-pulse" style={{ color: "var(--amber)", width: 9, height: 9 }} />等你决定：{awaitingHint}
              </div>
            )}
          </div>
          <div style={{ display: "flex", borderBottom: "1px solid var(--border)", alignItems: "center" }}>
            {([["flow", `智能体${agents.length ? ` · ${agents.length}` : ""}`], ["brain", "大脑"], ["test", `测试${testCaseList.length || sandboxRuns.length ? ` · ${testCaseList.length || sandboxRuns.length}` : ""}`], ["summary", "总结"]] as Array<["flow" | "brain" | "test" | "summary", string]>).map(([k, label]) => (
              <button key={k} onClick={() => { setTab(k); setSelectedSlug(null); }} style={{ flex: "1 0 auto", padding: "9px 6px", fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap", background: "none", border: "none", borderBottom: tab === k ? "2px solid var(--signal)" : "2px solid transparent", color: tab === k ? "var(--text)" : "var(--text-3)", cursor: "pointer", transition: "color 0.15s ease, border-color 0.15s ease" }}>{label}</button>
            ))}
            {(tab === "flow" || tab === "brain") && (
              <button title="全屏查看" onClick={() => setFullscreen(tab === "brain" ? "brain" : "flow")} style={{ padding: "0 10px", background: "none", border: "none", cursor: "pointer", color: "var(--text-3)", display: "inline-flex", alignItems: "center" }}>
                <Icon name="external" size={14} />
              </button>
            )}
          </div>
          <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
            {tab === "summary" ? (
              <RunSummary blocks={blocks} lastBudget={lastBudget} analysis={analysis} analyzing={analyzing} canAnalyze={!!(viewingRun?.id || (runId && !running))} onAnalyze={analyzeRunUi} />
            ) : tab === "test" ? (
              <SandboxIOPanel testCases={testCaseList} agentRuns={sandboxRuns} />
            ) : tab === "brain" ? (
              <div>
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  {([["flow", "决策流"], ["log", "活动日志"]] as Array<["flow" | "log", string]>).map(([k, label]) => (
                    <button key={k} onClick={() => setBrainView(k)} style={{ fontSize: 11.5, padding: "3px 12px", borderRadius: 20, cursor: "pointer", border: `1px solid ${brainView === k ? "var(--signal)" : "var(--border)"}`, background: brainView === k ? "var(--panel-2)" : "transparent", color: brainView === k ? "var(--text)" : "var(--text-3)" }}>{label}</button>
                  ))}
                </div>
                {brainView === "log" ? <ActivityLog blocks={blocks} /> : <BrainFlow steps={brainSteps} running={running} />}
              </div>
            ) : selectedAgent ? (
              <AgentInspector agent={selectedAgent} io={selectedIo} score={selectedScore} versions={agentVersions.get(selectedAgent.slug) ?? []} onBack={() => setSelectedSlug(null)} onShowCode={showCode} onRegenerate={regenerateAgent} />
            ) : (
              <div>
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  {([["cards", "卡片列表"], ["graph", "事件图"]] as Array<["cards" | "graph", string]>).map(([k, label]) => (
                    <button key={k} onClick={() => setDeliverView(k)} style={{ fontSize: 11.5, padding: "3px 12px", borderRadius: 20, cursor: "pointer", border: `1px solid ${deliverView === k ? "var(--signal)" : "var(--border)"}`, background: deliverView === k ? "var(--panel-2)" : "transparent", color: deliverView === k ? "var(--text)" : "var(--text-3)" }}>{label}</button>
                  ))}
                </div>
                {deliverView === "cards"
                  ? <AgentCardList agents={agents} degraded={degraded} ioByShort={ioByShort} onShowCode={showCode} onRegenerate={regenerateAgent} onSelect={setSelectedSlug} />
                  : <EventGraph agents={agents} scores={scores} degraded={degraded} selectedSlug={selectedSlug} onSelect={setSelectedSlug} />}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
