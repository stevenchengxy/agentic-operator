"use client";

/**
 * OntoCode — the v10-style front door over the factory brain.
 *
 * One workbench: task composer (with @-references) → single execution line →
 * product area (flow strip + agent cards) → 待你决定 todo queue with a
 * dynamically-rendered config overlay. All reasoning/logs live in the right
 * rail. Data source is the SAME SSE brain stream + endpoints as /factory —
 * the old page stays available as 高级模式.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { usePreferences } from "@/app/portal/lib/preferences-context";
import { useBrainStream, activeRunKey, type BrainStreamRequest } from "@/lib/hooks/useBrainStream";
import { useAgentFactoryDomains } from "@/lib/hooks/useAgentFactoryDomains";
import {
  deriveAgents,
  deriveBrainFlow,
  sandboxEvidenceStatus,
  toBlocks,
  type RunRow,
} from "../factory/model";
import { buildFactoryGoalSuggestions } from "../factory/factory-goals";
import { replayModeForStart } from "../factory/factory-run-start";
import {
  boundaryDecisionText,
  clarifyAnswerText,
  deriveExecLine,
  deriveFlowGraph,
  deriveNextSteps,
  deriveTodos,
  testDecisionText,
  type TodoItem,
} from "./oc-model";
import { fetchFactoryRuns, injectGateAnswer, startFactoryRun } from "./oc-api";
import {
  OcAgentCard,
  OcConfigOverlay,
  OcExecLine,
  OcFlowStrip,
  OcNextSteps,
  OcSessionRail,
  OcTodoQueue,
} from "./components";
import "./ontocode.css";

const convKey = (tenant: string, domain: string) => `ao:factory:conv:${tenant}:${domain}`;

export default function OntoCodePage() {
  const params = useParams<{ tenant: string }>();
  const tenant = params.tenant;
  const { t } = usePreferences();

  // ── domain binding ────────────────────────────────────────────────────────
  const domainsQuery = useAgentFactoryDomains(tenant);
  const binding = domainsQuery.data?.binding ?? null;
  const boundDomain = domainsQuery.data?.boundDomain ?? null;
  const domainId = binding?.ontologyDomainId ?? boundDomain?.id ?? domainsQuery.data?.domains[0]?.id ?? "";
  const domainLabel = boundDomain?.name ?? boundDomain?.id ?? domainId;

  // ── composer state ────────────────────────────────────────────────────────
  const [goal, setGoal] = useState("");
  const [atTokens, setAtTokens] = useState<string[]>([]);
  const [atOpen, setAtOpen] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // ── stream ────────────────────────────────────────────────────────────────
  const [streamReq, setStreamReq] = useState<BrainStreamRequest | null>(null);
  const nonceRef = useRef(0);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const { events, running, error: streamError } = useBrainStream(streamReq);

  // Reattach: a still-running brain (activeRunKey) wins; otherwise stay idle.
  useEffect(() => {
    if (!tenant || !domainId || streamReq) return;
    const active = localStorage.getItem(activeRunKey(tenant));
    const conv = localStorage.getItem(convKey(tenant, domainId));
    if (active) {
      nonceRef.current += 1;
      setConversationId(conv ?? active);
      setStreamReq({
        tenant,
        reconnectRunId: active,
        conversation: conv ?? active,
        replayMode: "replace",
        nonce: nonceRef.current,
      });
    } else if (conv) {
      setConversationId(conv);
    }
  }, [tenant, domainId, streamReq]);

  // ── recent runs ───────────────────────────────────────────────────────────
  const [runs, setRuns] = useState<RunRow[]>([]);
  useEffect(() => {
    if (!tenant || !domainId) return;
    let cancelled = false;
    void fetchFactoryRuns(t, tenant, domainId).then((r) => {
      if (!cancelled && r.ok && Array.isArray(r.data.runs)) setRuns(r.data.runs.slice(0, 8));
    });
    return () => { cancelled = true; };
  }, [tenant, domainId, t, running]);

  // ── projections ───────────────────────────────────────────────────────────
  const blocks = useMemo(() => toBlocks(t, events), [t, events]);
  const agents = useMemo(() => deriveAgents(events), [events]);
  const brainSteps = useMemo(() => deriveBrainFlow(t, events), [t, events]);
  const todos = useMemo(() => deriveTodos(blocks), [blocks]);
  const exec = useMemo(() => deriveExecLine(events, running), [events, running]);
  const graph = useMemo(() => deriveFlowGraph(agents), [agents]);
  const evidence = useMemo(() => sandboxEvidenceStatus(events), [events]);
  const nextSteps = useMemo(() => deriveNextSteps(exec, todos, tenant), [exec, todos, tenant]);
  const suggestions = useMemo(
    () =>
      buildFactoryGoalSuggestions(
        t,
        boundDomain ? { id: boundDomain.id, name: boundDomain.name ?? undefined } : null,
        domainsQuery.data?.boundActions ?? [],
      ).slice(0, 3),
    [t, boundDomain, domainsQuery.data?.boundActions],
  );
  const logLines = useMemo(() => {
    const lines: string[] = [];
    for (const b of blocks) {
      if (b.kind === "tool") lines.push(`[tool] ${b.name} ${b.ok === undefined ? "…" : b.ok ? "ok" : "FAIL"}${b.summary ? ` — ${b.summary}` : ""}`);
      else if (b.kind === "sandbox") lines.push(`[sbx] ${JSON.stringify(b.ev).slice(0, 160)}`);
      else if (b.kind === "error") lines.push(`[error] ${b.text}`);
      else if (b.kind === "budget") lines.push(`[budget] ${b.text}`);
    }
    return lines.slice(-100);
  }, [blocks]);

  // ── ui state ──────────────────────────────────────────────────────────────
  const [openCard, setOpenCard] = useState<string | null>(null);
  const [overlayTodo, setOverlayTodo] = useState<TodoItem | null>(null);
  const [sendingTodoId, setSendingTodoId] = useState<string | null>(null);
  const [railTab, setRailTab] = useState<"session" | "logs">("session");
  const [railCollapsed, setRailCollapsed] = useState(false);

  // A resolved gate disappears from `todos` — clear the pending marker then.
  useEffect(() => {
    if (sendingTodoId && !todos.some((td) => td.id === sendingTodoId)) setSendingTodoId(null);
  }, [todos, sendingTodoId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOverlayTodo(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── actions ───────────────────────────────────────────────────────────────
  const start = useCallback(async () => {
    const text = goal.trim();
    const prefixed = [...atTokens.map((tk) => `@${tk}`), text].filter(Boolean).join(" ");
    if (!prefixed) { setStartError("请描述一个场景，或选择推荐场景"); return; }
    if (!domainId) { setStartError("尚未绑定 Ontology 域 — 请先在高级模式绑定或上传"); return; }
    setStarting(true);
    setStartError(null);
    const hadConversation = Boolean(conversationId);
    const result = await startFactoryRun(t, tenant, {
      domain: domainId,
      goal: prefixed,
      ...(conversationId ? { conversation: conversationId } : {}),
    });
    setStarting(false);
    if (!result.ok) { setStartError(result.message); return; }
    const receipt = result.data;
    const conv = conversationId ?? receipt.runId;
    setConversationId(conv);
    localStorage.setItem(convKey(tenant, domainId), conv);
    nonceRef.current += 1;
    setStreamReq({
      tenant,
      reconnectRunId: receipt.runId,
      conversation: conv,
      replayMode: replayModeForStart(receipt, hadConversation),
      nonce: nonceRef.current,
    });
    setGoal("");
    setAtTokens([]);
  }, [goal, atTokens, domainId, conversationId, t, tenant]);

  const attachRun = useCallback((runId: string) => {
    nonceRef.current += 1;
    setConversationId(runId);
    if (domainId) localStorage.setItem(convKey(tenant, domainId), runId);
    setStreamReq({ tenant, reconnectRunId: runId, conversation: runId, replayMode: "replace", nonce: nonceRef.current });
  }, [tenant, domainId]);

  const submitGate = useCallback(async (todo: TodoItem, kindText: string) => {
    const conversation = streamReq?.conversation ?? conversationId;
    if (!conversation || !todo.interactionId) { setStartError("缺少会话或交互标识，无法提交"); return; }
    setSendingTodoId(todo.id);
    setOverlayTodo(null);
    const result = await injectGateAnswer(t, tenant, {
      conversation,
      interactionId: todo.interactionId,
      kind: todo.kind,
      text: kindText,
    });
    if (!result.ok) { setSendingTodoId(null); setStartError(result.message); }
  }, [streamReq, conversationId, t, tenant]);

  const jumpInteraction = useCallback((interactionId: string) => {
    const todo = todos.find((td) => td.interactionId === interactionId);
    if (todo) setOverlayTodo(todo);
  }, [todos]);

  const hasAwait = todos.length > 0;
  const showHero = events.length === 0 && !running;
  const suiteReady = agents.length > 0;

  const statusChipFor = () => {
    if (running) return { label: "生成中…", tone: "dim" as const };
    if (evidence === "real") return { label: "已验证 ✓", tone: "ok" as const };
    if (hasAwait) return { label: "待决定", tone: "warn" as const };
    return { label: "草稿", tone: "dim" as const };
  };

  return (
    <div className="oc">
      {/* ── top bar ── */}
      <div className="oc-top">
        <span className="oc-logo">Onto<em>Code</em></span>
        <span className="oc-pill">⬡ {domainLabel || "未绑定域"}</span>
        {boundDomain?.counts?.actions != null && (
          <span className="oc-pill">{boundDomain.counts.actions} 动作 · {boundDomain.counts.rules ?? 0} 规则</span>
        )}
        <span className="oc-sp" />
        {evidence === "real" && <span className="oc-pill ok">✓ 沙箱证据</span>}
        <Link className="oc-pill" href={`/portal/${tenant}/factory`} title="晋升/部署走高级模式的审查流程">
          部署（高级模式审查）→
        </Link>
      </div>

      <div className={`oc-layout${railCollapsed ? " rail-collapsed" : ""}`}>
        {/* ── left rail ── */}
        <nav className="oc-left">
          <button type="button" className="oc-newtask" onClick={() => { setGoal(""); setAtTokens([]); }}>
            ＋ 新任务
          </button>
          <button type="button" className="oc-navitem on">✦ 工作台</button>
          <Link className="oc-navitem" href={`/portal/${tenant}/factory`}>
            ⬡ Ontology 域 <span className="oc-cnt">{domainsQuery.data?.domains.length ?? "…"}</span>
          </Link>
          <button type="button" className="oc-navitem" disabled title="P1 规划中">
            ▤ 模板库 <span className="oc-cnt">即将推出</span>
          </button>
          <div className="oc-recent oc-navlabel">
            <h4>最近任务</h4>
            {runs.length === 0 && <div className="oc-empty">暂无历史</div>}
            {runs.map((r) => (
              <button
                key={r.id}
                type="button"
                className={`oc-runrow${streamReq?.reconnectRunId === r.id ? " on" : ""}`}
                onClick={() => attachRun(r.id)}
              >
                <span className={`st ${r.status === "finished" || r.status === "done" ? "st-live" : r.status === "failed" ? "st-fail" : "st-draft"}`}>
                  {r.agentsCount} agents
                </span>
                {r.goal.slice(0, 26) || r.id}
                <span className="meta">{new Date(r.createdAt).toLocaleString()} · {r.status}</span>
              </button>
            ))}
          </div>
          <div className="oc-leftfoot">
            <Link href={`/portal/${tenant}/factory`}>高级模式（原工厂界面）→</Link>
          </div>
        </nav>

        {/* ── center ── */}
        <main className="oc-main">
          {showHero && (
            <div className="oc-hero">
              <h2>描述场景，或直接给我 <em>Ontology</em></h2>
              <p>一次生成可部署的 agents 代码 · 沙箱验证 · 思考过程在右栏 · 无需对话</p>
            </div>
          )}

          <div className="oc-composer">
            <textarea
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void start(); }
                if (e.key === "@") setAtOpen(true);
              }}
              placeholder={
                suiteReady
                  ? "继续描述修改，或输入 @ 引用某个 agent（如 @jd-matcher 分数线改成 75）…"
                  : "描述一个场景，或什么都不写——绑定 Ontology 域后直接 Generate…"
              }
            />
            <div className="oc-comprow">
              {atOpen && (
                <div className="oc-atmenu">
                  {agents.length === 0 && <div className="oc-empty">生成后可 @ 引用 agent</div>}
                  {agents.map((a) => (
                    <button
                      key={a.slug}
                      type="button"
                      onClick={() => { setAtTokens((prev) => [...new Set([...prev, a.slug])]); setAtOpen(false); }}
                    >
                      <span className="k">@{a.slug}</span> {a.nameZh || a.actionName}
                      <span className="d">agent</span>
                    </button>
                  ))}
                  {runs.filter((r) => r.status === "failed").slice(0, 3).map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => { setAtTokens((prev) => [...new Set([...prev, r.id])]); setAtOpen(false); }}
                    >
                      <span className="k">@{r.id.slice(0, 12)}…</span> 失败 run
                      <span className="d">debug</span>
                    </button>
                  ))}
                  <button type="button" onClick={() => setAtOpen(false)}><span className="d">关闭</span></button>
                </div>
              )}
              <span className="oc-chip src">⬡ {domainLabel || "未绑定"}</span>
              {atTokens.map((tk) => (
                <span className="oc-chip at" key={tk}>
                  @{tk}
                  <span className="x" onClick={() => setAtTokens((prev) => prev.filter((x) => x !== tk))}>✕</span>
                </span>
              ))}
              <button type="button" className="oc-chip" onClick={() => setAtOpen((v) => !v)} title="引用 agent / 失败 run">
                ＠ 引用
              </button>
              <button
                type="button"
                className="oc-generate"
                disabled={starting || running}
                onClick={() => void start()}
                title={running ? "生成进行中" : undefined}
              >
                {starting ? "启动中…" : running ? "运行中…" : "Generate"} <span className="kbd">⌘↵</span>
              </button>
            </div>
          </div>

          {showHero && suggestions.length > 0 && (
            <div className="oc-suggest">
              <span className="cap">来自 {domainLabel} 的推荐场景</span>
              {suggestions.map((s) => (
                <button key={s} type="button" onClick={() => setGoal(s)}>{s}</button>
              ))}
            </div>
          )}

          {startError && <div className="oc-exec error">✕ {startError}</div>}
          {streamError && <div className="oc-exec error">✕ 流连接异常（{streamError}）— 可在最近任务中重新打开</div>}
          <OcExecLine exec={exec} onOpenRail={() => { setRailCollapsed(false); setRailTab("session"); }} />

          {suiteReady && (
            <div className="oc-suitehead">
              <b>套件 · {agents.length} 个 AGENTS</b>
              <span className={`oc-badge ${evidence === "real" ? "ok" : evidence === "simulated_only" ? "bad" : "dim"}`}>
                {evidence === "real" ? "✓ 沙箱真跑证据" : evidence === "simulated_only" ? "仅模拟证据" : "未验证"}
              </span>
              <span className="oc-sp" />
              <OcNextSteps steps={nextSteps} />
            </div>
          )}

          {suiteReady && (
            <OcFlowStrip
              graph={graph}
              highlight={openCard}
              onNode={(slug) => {
                setOpenCard(slug);
                document.getElementById(`oc-agent-${slug}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
              }}
            />
          )}

          {suiteReady && (
            <div className="oc-grid">
              {agents.map((a) => (
                <OcAgentCard
                  key={a.slug}
                  agent={a}
                  open={openCard === a.slug}
                  onToggle={() => setOpenCard((cur) => (cur === a.slug ? null : a.slug))}
                  statusChip={statusChipFor()}
                />
              ))}
            </div>
          )}

          <OcTodoQueue todos={todos} sendingId={sendingTodoId} onHandle={(todo) => setOverlayTodo(todo)} />
        </main>

        {/* ── right rail ── */}
        <OcSessionRail
          steps={brainSteps}
          logLines={logLines}
          tab={railTab}
          onTab={setRailTab}
          collapsed={railCollapsed}
          onToggleCollapse={() => setRailCollapsed((v) => !v)}
          hasAwait={hasAwait}
          onJumpInteraction={jumpInteraction}
        />
      </div>

      {overlayTodo && (
        <OcConfigOverlay
          todo={overlayTodo}
          busy={sendingTodoId === overlayTodo.id}
          impact={
            overlayTodo.kind === "boundary"
              ? [...new Set((overlayTodo.proposals ?? []).flatMap((p) => p.producers))]
              : agents.slice(0, 3).map((a) => a.slug)
          }
          onClose={() => setOverlayTodo(null)}
          onClarify={(answer) => void submitGate(overlayTodo, clarifyAnswerText(answer))}
          onTest={(decision, note) => void submitGate(overlayTodo, testDecisionText(decision, note))}
          onBoundary={(evs) => void submitGate(overlayTodo, boundaryDecisionText(evs))}
        />
      )}
    </div>
  );
}
