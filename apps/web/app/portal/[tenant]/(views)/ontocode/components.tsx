"use client";

/**
 * OntoCode — presentational components (v10 light style, `.oc` scope).
 *
 * Everything here is a pure render of oc-model / factory-model projections;
 * page.tsx owns all data + handlers. Copy is intentionally literal Chinese for
 * P0 (i18n extraction tracked in the integration plan).
 */

import { Fragment, useMemo, useState } from "react";
import type { AgentCardData } from "../factory/model";
import type { BrainStep } from "../factory/model";
import type { ExecLineState, FlowGraphData, NextStep, TodoItem } from "./oc-model";

// ── 执行行 ────────────────────────────────────────────────────────────────────

export function OcExecLine({ exec, onOpenRail }: { exec: ExecLineState; onOpenRail: () => void }) {
  if (exec.state === "idle") return null;
  return (
    <div className={`oc-exec ${exec.state}`}>
      {exec.state === "running" ? <span className="spin" /> : exec.state === "error" ? "✕" : "✓"}
      <span>{exec.text}</span>
      <span className="meta">
        {exec.agentCount > 0 ? `${exec.agentCount} agents · ` : ""}
        {exec.toolCount} 次工具调用
      </span>
      <button type="button" className="oc-ghost raillink" style={{ border: "none", padding: 0 }} onClick={onOpenRail}>
        推理与日志见右栏
      </button>
    </div>
  );
}

// ── 事件与业务流 ──────────────────────────────────────────────────────────────

/** Linearize the graph: BFS from entry nodes, one row per branch chain. */
function chainRows(graph: FlowGraphData): string[][] {
  const next = new Map<string, Array<{ to: string; event: string }>>();
  for (const e of graph.edges) {
    const list = next.get(e.from) ?? [];
    list.push({ to: e.to, event: e.event });
    next.set(e.from, list);
  }
  const started = new Set(graph.entryEvents.map((e) => e.to));
  const roots = graph.nodes.filter((n) => started.has(n.slug));
  const seen = new Set<string>();
  const rows: string[][] = [];
  const walk = (slug: string, row: string[]) => {
    if (seen.has(slug)) { rows.push([...row, slug]); return; }
    seen.add(slug);
    row.push(slug);
    const outs = next.get(slug) ?? [];
    if (outs.length === 0) { rows.push(row); return; }
    outs.forEach((o, i) => walk(o.to, i === 0 ? row : [slug]));
  };
  for (const r of roots.length ? roots : graph.nodes.slice(0, 1)) walk(r.slug, []);
  for (const n of graph.nodes) if (!seen.has(n.slug)) rows.push([n.slug]);
  return rows;
}

export function OcFlowStrip({
  graph,
  onNode,
  highlight,
}: {
  graph: FlowGraphData;
  onNode: (slug: string) => void;
  highlight: string | null;
}) {
  const rows = useMemo(() => chainRows(graph), [graph]);
  if (!graph.nodes.length) return null;
  const edgeEvent = (from: string, to: string) =>
    graph.edges.find((e) => e.from === from && e.to === to)?.event;
  const entryOf = (slug: string) => graph.entryEvents.find((e) => e.to === slug)?.event;
  const terminalsOf = (slug: string) => graph.terminalEvents.filter((e) => e.from === slug);
  return (
    <details className="oc-flow" open>
      <summary>
        事件与业务流 <span className="hint">自动生成 · 只读 · 点节点看逻辑</span>
      </summary>
      <div className="oc-flowbody">
        {rows.map((row, ri) => (
          <div className="oc-flowline" key={ri} style={ri ? { marginTop: 10 } : undefined}>
            {row.map((slug, i) => {
              const prev = i > 0 ? row[i - 1]! : null;
              const entry = i === 0 ? entryOf(slug) : null;
              const ev = prev ? edgeEvent(prev, slug) : null;
              const terms = i === row.length - 1 ? terminalsOf(slug) : [];
              return (
                <Fragment key={`${slug}-${i}`}>
                  {entry && (
                    <>
                      <span className="oc-fev">⚡ {entry}</span>
                      <span className="oc-farrow">→</span>
                    </>
                  )}
                  {ev && (
                    <>
                      <span className="oc-farrow">→</span>
                      <span className="oc-fev">{ev}</span>
                      <span className="oc-farrow">→</span>
                    </>
                  )}
                  <button
                    type="button"
                    className={`oc-fnode${highlight === slug ? " hl" : ""}`}
                    onClick={() => onNode(slug)}
                  >
                    {slug}
                  </button>
                  {terms.map((t) => (
                    <Fragment key={t.event}>
                      <span className="oc-farrow">→</span>
                      <span className="oc-fterm">↦ {t.event}</span>
                    </Fragment>
                  ))}
                </Fragment>
              );
            })}
          </div>
        ))}
      </div>
    </details>
  );
}

// ── agent 卡片 ───────────────────────────────────────────────────────────────

function decisionSteps(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 12);
}

export function OcAgentCard({
  agent,
  open,
  onToggle,
  statusChip,
}: {
  agent: AgentCardData;
  open: boolean;
  onToggle: () => void;
  statusChip: { label: string; tone: "ok" | "warn" | "bad" | "dim" };
}) {
  const steps = decisionSteps(agent.decisionLogic);
  return (
    <div className={`oc-card${open ? " open" : ""}`} id={`oc-agent-${agent.slug}`}>
      <button type="button" className="oc-cardhead" onClick={onToggle}>
        <span className="nm">{agent.slug}</span>
        {agent.nameZh && <span className="zh">{agent.nameZh}</span>}
        <span className={`oc-badge ${statusChip.tone}`}>{statusChip.label}</span>
        <span className="chev">{open ? "▲" : "▼"}</span>
      </button>
      <div className="oc-wire">
        <span className="ev">⚡ {agent.trigger.join(", ") || "—"}</span>
        {" → "}
        {agent.actionName || agent.short}
        {" → "}
        <span className="em">↦ {agent.emit.join(", ") || "—"}</span>
      </div>
      {open && (
        <div className="oc-cardbody">
          {steps.length > 0 && (
            <div>
              <div className="oc-secttl">步骤逻辑</div>
              <div className="oc-steps" style={{ marginTop: 6 }}>
                {steps.map((s, i) => (
                  <div className="oc-step" key={i}>
                    <span className="n">{i + 1}</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {agent.tools.length > 0 && (
            <div>
              <div className="oc-secttl">工具</div>
              <div className="oc-toolchips" style={{ marginTop: 6 }}>
                {agent.tools.map((tl) => (
                  <span className="oc-tc" key={tl}>{tl}</span>
                ))}
              </div>
            </div>
          )}
          {agent.systemPrompt && (
            <details>
              <summary className="oc-secttl" style={{ cursor: "pointer" }}>系统提示词</summary>
              <div style={{ fontSize: 12.5, color: "var(--oc-text-2)", whiteSpace: "pre-wrap", marginTop: 6 }}>
                {agent.systemPrompt}
              </div>
            </details>
          )}
          {agent.code ? (
            <div>
              <div className="oc-secttl">代码（{agent.codeSource ?? "generated"}）</div>
              <pre className="oc-code" style={{ marginTop: 6 }}>{agent.code}</pre>
            </div>
          ) : (
            <div className="oc-empty">此 agent 为声明式 manifest（无独立代码文件）</div>
          )}
        </div>
      )}
    </div>
  );
}

// ── 待你决定 ─────────────────────────────────────────────────────────────────

export function OcTodoQueue({
  todos,
  onHandle,
  sendingId,
}: {
  todos: TodoItem[];
  onHandle: (todo: TodoItem) => void;
  sendingId: string | null;
}) {
  if (!todos.length) return null;
  const kindLabel: Record<TodoItem["kind"], string> = {
    clarify: "澄清",
    test_approval: "测试用例批准",
    boundary: "边界事件分类",
  };
  return (
    <div className="oc-todos">
      <div className="oc-todohead">
        ⚠ <b>待你决定 · {todos.length}</b>
        <span style={{ color: "var(--oc-text-3)", fontSize: 11.5 }}>
          回答后大脑自动继续 · 完成即沙箱验证
        </span>
      </div>
      {todos.map((todo) => (
        <div className={`oc-todorow${sendingId === todo.id ? " sending" : ""}`} key={todo.id}>
          <span className="q">
            <span className="req">必答</span>
            {todo.title}
            <span className="why">
              {kindLabel[todo.kind]}
              {todo.credentialLike ? " · 疑似缺少凭证 — 可先到 Settings→Integrations 配置" : ""}
              {todo.context ? ` · ${todo.context}` : ""}
            </span>
          </span>
          <button
            type="button"
            className="oc-handle"
            disabled={sendingId === todo.id}
            onClick={() => onHandle(todo)}
          >
            {sendingId === todo.id ? "已提交 · 大脑继续中…" : "处理 →"}
          </button>
        </div>
      ))}
    </div>
  );
}

// ── 动态配置覆盖层 ────────────────────────────────────────────────────────────

export function OcConfigOverlay({
  todo,
  busy,
  impact,
  onClose,
  onClarify,
  onTest,
  onBoundary,
}: {
  todo: TodoItem;
  busy: boolean;
  impact: string[];
  onClose: () => void;
  onClarify: (answer: string) => void;
  onTest: (decision: "approve" | "regenerate", note?: string) => void;
  onBoundary: (
    events: Array<{ event: string; kind: string; consumer?: string; payloadContract?: string }>,
  ) => void;
}) {
  const [custom, setCustom] = useState("");
  const [selected, setSelected] = useState<string | null>(
    todo.options?.find((o) => o.recommended)?.value ?? null,
  );
  const [note, setNote] = useState("");
  const [kinds, setKinds] = useState<Record<string, string>>(() =>
    Object.fromEntries((todo.proposals ?? []).map((p) => [p.event, p.suggestedKind])),
  );
  const [consumers, setConsumers] = useState<Record<string, string>>(() =>
    Object.fromEntries((todo.proposals ?? []).map((p) => [p.event, p.consumer ?? ""])),
  );

  const kindLabels: Record<TodoItem["kind"], string> = {
    clarify: "补充信息",
    test_approval: "沙箱测试用例",
    boundary: "边界事件分类",
  };

  return (
    <>
      <div className="oc-scrim" onClick={onClose} />
      <aside className="oc-overlay" role="dialog" aria-label={kindLabels[todo.kind]}>
        <div className="oc-ovhead">
          <h3>{kindLabels[todo.kind]}</h3>
          <div className="ctx">
            {todo.title}
            <br />
            {impact.length > 0 && <>影响：{impact.join(" · ")} · </>}
            ✓ 完成后大脑自动继续并重跑受影响的沙箱验证 · Esc / 点遮罩退出
          </div>
        </div>

        <div className="oc-ovbody">
          {todo.kind === "clarify" && (
            <>
              {todo.credentialLike && (
                <div className="oc-caserow" style={{ borderColor: "var(--oc-amber)" }}>
                  <span className="k">凭证类问题</span>
                  <div className="d">
                    写副作用凭证不能替你猜。可先去 Settings → Integrations 配置真实凭证，
                    或在下方选择/填写替代方案（如使用测试 key）。
                  </div>
                </div>
              )}
              {(todo.options ?? []).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`oc-opt${selected === opt.value ? " sel" : opt.recommended ? " rec" : ""}`}
                  onClick={() => { setSelected(opt.value); setCustom(""); }}
                >
                  {opt.label}
                  {opt.recommended && <span className="tag">推荐</span>}
                </button>
              ))}
              <textarea
                className="oc-textarea"
                placeholder="或自定义回答…"
                value={custom}
                onChange={(e) => { setCustom(e.target.value); if (e.target.value.trim()) setSelected(null); }}
              />
            </>
          )}

          {todo.kind === "test_approval" && (
            <>
              {(todo.cases ?? []).map((c) => (
                <div className="oc-caserow" key={c.id}>
                  <span className="k">{c.entryEvent}</span> <b style={{ fontSize: 12.5 }}>{c.name}</b>
                  <span className="oc-badge dim" style={{ marginLeft: 8 }}>{c.kind}</span>
                  <div className="d">{c.scenario} → 期望：{c.expectedOutcome}</div>
                </div>
              ))}
              {todo.coverage && todo.coverage.uncoveredNeedingData.length > 0 && (
                <div className="oc-caserow" style={{ borderColor: "var(--oc-amber)" }}>
                  <span className="k">覆盖缺口</span>
                  <div className="d">{todo.coverage.uncoveredNeedingData.join("、")} 需要补充数据（可在高级模式上传夹具）</div>
                </div>
              )}
              <textarea
                className="oc-textarea"
                placeholder="重新生成时的备注（可选）…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </>
          )}

          {todo.kind === "boundary" && (
            <>
              {(todo.proposals ?? []).map((p) => (
                <div className="oc-caserow" key={p.event}>
                  <span className="k">{p.event}</span>
                  <div className="d">{p.why} · 产出方：{p.producers.join(", ") || "—"}</div>
                  <div style={{ marginTop: 7, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span className="oc-seg">
                      {(["terminal", "external", "break"] as const).map((k) => (
                        <button
                          key={k}
                          type="button"
                          className={kinds[p.event] === k ? "on" : ""}
                          onClick={() => setKinds((m) => ({ ...m, [p.event]: k }))}
                        >
                          {k === "terminal" ? "业务终点" : k === "external" ? "外部消费" : "断链需修"}
                        </button>
                      ))}
                    </span>
                    {kinds[p.event] === "external" && (
                      <input
                        className="oc-textarea"
                        style={{ minHeight: 0, padding: "6px 10px", flex: 1, minWidth: 140 }}
                        placeholder="消费方（系统/服务名）"
                        value={consumers[p.event] ?? ""}
                        onChange={(e) => setConsumers((m) => ({ ...m, [p.event]: e.target.value }))}
                      />
                    )}
                  </div>
                </div>
              ))}
            </>
          )}
        </div>

        <div className="oc-ovfoot">
          {todo.kind === "clarify" && (
            <button
              type="button"
              className="oc-primary"
              disabled={busy || (!custom.trim() && !selected)}
              onClick={() => {
                const answer = custom.trim()
                  || todo.options?.find((o) => o.value === selected)?.label
                  || selected
                  || "";
                onClarify(answer);
              }}
            >
              {busy ? "提交中…" : "提交回答"}
            </button>
          )}
          {todo.kind === "test_approval" && (
            <>
              <button type="button" className="oc-primary" disabled={busy} onClick={() => onTest("approve")}>
                {busy ? "提交中…" : "批准并执行"}
              </button>
              <button type="button" className="oc-ghost" disabled={busy} onClick={() => onTest("regenerate", note.trim() || undefined)}>
                重新生成用例
              </button>
            </>
          )}
          {todo.kind === "boundary" && (
            <button
              type="button"
              className="oc-primary"
              disabled={busy}
              onClick={() =>
                onBoundary(
                  (todo.proposals ?? []).map((p) => ({
                    event: p.event,
                    kind: kinds[p.event] ?? p.suggestedKind,
                    ...(kinds[p.event] === "external" && consumers[p.event]?.trim()
                      ? { consumer: consumers[p.event]!.trim() }
                      : {}),
                    ...(p.payloadContract ? { payloadContract: p.payloadContract } : {}),
                  })),
                )
              }
            >
              {busy ? "提交中…" : "提交分类"}
            </button>
          )}
          <button type="button" className="oc-ghost" onClick={onClose}>返回</button>
        </div>
      </aside>
    </>
  );
}

// ── 右栏（会话 / 日志） ────────────────────────────────────────────────────────

export function OcSessionRail({
  steps,
  logLines,
  tab,
  onTab,
  collapsed,
  onToggleCollapse,
  hasAwait,
  onJumpInteraction,
}: {
  steps: BrainStep[];
  logLines: string[];
  tab: "session" | "logs";
  onTab: (t: "session" | "logs") => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  hasAwait: boolean;
  onJumpInteraction: (interactionId: string) => void;
}) {
  if (collapsed) {
    return (
      <aside className="oc-rail">
        <div className="oc-railslim" onClick={onToggleCollapse} title="展开会话与日志">
          <span>◧</span>
          {hasAwait && <span className="dotwarn" title="有待你决定的事项" />}
          <span style={{ writingMode: "vertical-rl", fontSize: 11 }}>会话 · 日志</span>
        </div>
      </aside>
    );
  }
  return (
    <aside className="oc-rail">
      <div className="oc-railtabs">
        <button type="button" className={tab === "session" ? "on" : ""} onClick={() => onTab("session")}>
          推理与工具调用
        </button>
        <button type="button" className={tab === "logs" ? "on" : ""} onClick={() => onTab("logs")}>
          日志
        </button>
        <button type="button" className="fold" onClick={onToggleCollapse} title="折叠">⇥</button>
      </div>
      <div className="oc-railbody">
        {tab === "session" ? (
          steps.length ? (
            <div className="oc-tl">
              {steps.map((s) => (
                <div className="oc-tlrow" key={s.id}>
                  <span className={`oc-tldot ${s.status}`} />
                  <span className="oc-tltxt">
                    <span
                      className={`lb${s.interactionId && s.status === "await" ? " link" : ""}`}
                      onClick={
                        s.interactionId && s.status === "await"
                          ? () => onJumpInteraction(s.interactionId!)
                          : undefined
                      }
                    >
                      {s.label}
                    </span>
                    {s.detail && <span className="dt"> · {s.detail}</span>}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <div className="oc-empty">开始一次生成后，这里显示完整的推理与工具调用时间线</div>
          )
        ) : logLines.length ? (
          <div className="oc-lograil">{logLines.join("\n")}</div>
        ) : (
          <div className="oc-empty">暂无日志</div>
        )}
      </div>
      <div className="oc-railfoot">主页面保持精简 — 思考过程只在此栏展示</div>
    </aside>
  );
}

// ── 下一步 chips ─────────────────────────────────────────────────────────────

export function OcNextSteps({ steps }: { steps: NextStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="oc-nextsteps">
      下一步
      {steps.map((s) => (
        <a key={s.id} href={s.href}>{s.label}</a>
      ))}
    </div>
  );
}
