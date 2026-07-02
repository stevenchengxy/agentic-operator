"use client";

/**
 * Agent 工厂 — RUN SUMMARY (the kept 过程 tab; the only standing non-canvas surface). The
 * "after the fact, what did this run cost and learn" view: cost, build plans, the refinement
 * timeline (now incl. the previously-invisible score deltas + reverts), reflections, and skills.
 */

import { Panel, Button } from "@/app/portal/components";
import { Ledger } from "./atoms";
import type { Block } from "./model";

function pick<K extends Block["kind"]>(blocks: Block[], kind: K): Extract<Block, { kind: K }>[] {
  return blocks.filter((b) => b.kind === kind) as Extract<Block, { kind: K }>[];
}

// #6 — the AI run-review panel: score + strengths / problems / suggestions.
function ReviewList({ label, items, color }: { label: string; items: unknown; color: string }) {
  const arr = (Array.isArray(items) ? items : []).map(String).filter(Boolean);
  if (!arr.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 10.5, color: "var(--text-3)", fontFamily: "var(--mono)", textTransform: "uppercase", marginBottom: 3 }}>{label}</div>
      {arr.map((t, i) => <div key={i} style={{ fontSize: 12, color: "var(--text-2)", lineHeight: 1.5, paddingLeft: 12, textIndent: -10 }}><span style={{ color }}>· </span>{t}</div>)}
    </div>
  );
}

export function RunSummary({ blocks, lastBudget, analysis, analyzing, canAnalyze, onAnalyze }: { blocks: Block[]; lastBudget?: Record<string, unknown>; analysis?: Record<string, unknown> | null; analyzing?: boolean; canAnalyze?: boolean; onAnalyze?: () => void }) {
  const plans = pick(blocks, "plan").map((b) => b.summary);
  const refines = pick(blocks, "refine").map((b) => `${b.action}：${b.critique}`);
  const allReflects = pick(blocks, "reflect").map((b) => b.text);
  // 意图门的结论单独成区（大脑对"你要什么"的理解——理解偏了应该当场看见），不混在普通反思里。
  const intents = allReflects.filter((t) => t.startsWith("意图理解：")).map((t) => t.replace(/^意图理解：/, ""));
  const reflects = allReflects.filter((t) => !t.startsWith("意图理解："));
  // 你的介入记录（[人工介入] 的回执消息），与意图并排——共同构成"大脑记住的你"。
  const interventions = pick(blocks, "message").map((b) => b.text).filter((t) => t.startsWith("🧑 收到你的介入")).map((t) => t.replace(/^🧑 收到你的介入：「?/, "").replace(/」?——下一步会纳入。$/, ""));
  const skills = pick(blocks, "skill").map((b) => b.name);
  const scores = pick(blocks, "score");
  const reverts = pick(blocks, "revert");
  // 认知专家（四维分治等轻通道派生）的完成情况——工厂内部多 agent 系统的工作痕迹。
  const specialists = pick(blocks, "subagent").filter((b) => b.task.startsWith("认知专家"));

  const a = analysis && !analysis.error ? analysis : null;
  const score = a ? Number(a.score) || 0 : 0;
  const scoreColor = score >= 80 ? "var(--green)" : score >= 55 ? "var(--amber)" : "var(--red)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {(intents.length > 0 || interventions.length > 0) && (
        <Panel title="大脑对你的理解" padded={false}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {intents.map((t, i) => (
              <div key={`i-${i}`} style={{ display: "flex", gap: 8, padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : "none", fontSize: 12, lineHeight: 1.55 }}>
                <span title="意图门解析" style={{ flexShrink: 0, color: "var(--signal)" }}>🎯</span>
                <span style={{ color: "var(--text-2)" }}>{t}</span>
              </div>
            ))}
            {interventions.map((t, i) => (
              <div key={`v-${i}`} style={{ display: "flex", gap: 8, padding: "8px 12px", borderTop: intents.length || i ? "1px solid var(--border)" : "none", fontSize: 12, lineHeight: 1.55 }}>
                <span title="你的介入" style={{ flexShrink: 0 }}>🧑</span>
                <span style={{ color: "var(--text-2)" }}>{t}</span>
              </div>
            ))}
            <div style={{ padding: "6px 12px", fontSize: 10.5, color: "var(--text-4)", borderTop: "1px solid var(--border)" }}>意图与介入是折叠幸存者——对话再长、重启多少次，大脑都记得。</div>
          </div>
        </Panel>
      )}

      {specialists.length > 0 && (
        <Panel title="认知专家（工厂内部派生）" padded={false}>
          <div style={{ display: "flex", flexDirection: "column" }}>
            {specialists.map((s, i) => (
              <div key={i} style={{ display: "flex", gap: 8, padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : "none", fontSize: 12, lineHeight: 1.55 }}>
                <span style={{ flexShrink: 0 }}>🧩</span>
                <span style={{ color: "var(--text)", flexShrink: 0 }}>{s.task.replace(/^认知专家 · /, "")}</span>
                <span style={{ color: "var(--text-3)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.summary ?? "进行中…"}</span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="AI 运行评审">
        <div style={{ padding: 12 }}>
          {!a && (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Button onClick={onAnalyze} disabled={!canAnalyze || analyzing}>{analyzing ? "评审中…" : "🔎 AI 评审本次运行"}</Button>
              {!canAnalyze && <span style={{ fontSize: 11.5, color: "var(--text-3)" }}>运行结束后可评审</span>}
              {!!analysis?.error && <span style={{ fontSize: 11.5, color: "var(--red)" }}>{String(analysis.error)}</span>}
            </div>
          )}
          {a && (
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 26, fontWeight: 800, color: scoreColor, fontFamily: "var(--mono)" }}>{a.scored ? score : "—"}</span>
                <span style={{ fontSize: 11, color: "var(--text-3)" }}>/ 100</span>
                {a.scored && a.model ? <span title="评审使用的模型" style={{ fontSize: 10, color: "var(--text-3)", fontFamily: "var(--mono)", border: "1px solid var(--border)", borderRadius: 4, padding: "0 5px" }}>🧠 {String(a.model).split("/").pop()}</span> : null}
                <span style={{ marginLeft: "auto" }}><Button onClick={onAnalyze} disabled={analyzing}>{analyzing ? "评审中…" : "重新评审"}</Button></span>
              </div>
              {a.summary ? <div style={{ fontSize: 12.5, color: "var(--text-2)", marginTop: 8, lineHeight: 1.6 }}>{String(a.summary)}</div> : null}
              <ReviewList label="问题" items={a.problems} color="var(--red)" />
              <ReviewList label="建议" items={a.suggestions} color="var(--green)" />
              <ReviewList label="优点" items={a.strengths} color="var(--text-3)" />
            </div>
          )}
        </div>
      </Panel>

      {lastBudget && (
        <Panel title="成本">
          <div style={{ padding: 12, fontSize: 12.5, color: "var(--text-2)" }}>
            {Math.round(Number(lastBudget.tokens) / 1000)}k tokens · {String(lastBudget.turn)} 轮 · {String(lastBudget.sandboxRuns ?? 0)} 次沙箱{lastBudget.level === "high" ? " · ⚠ 成本偏高" : lastBudget.level === "elevated" ? " · 成本中高" : ""}
          </div>
        </Panel>
      )}

      <Panel title="精修时间线" padded={false}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {scores.length === 0 && reverts.length === 0 && <div style={{ padding: 12, fontSize: 11.5, color: "var(--text-4)" }}>还没精修——大脑校验后若发现问题会在这里逐轮记录评分变化</div>}
          {(() => { const attempt: Record<string, number> = {}; return scores.map((s, i) => {
            attempt[s.action] = (attempt[s.action] ?? 0) + 1; // #6 — per-agent round number (逐轮打分)
            return (
            <div key={`s-${i}`} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderTop: i ? "1px solid var(--border)" : "none" }}>
              <span style={{ fontSize: 12, color: "var(--text)", flex: 1, minWidth: 0 }}>{s.action} <span style={{ fontSize: 10.5, color: "var(--text-4)", fontFamily: "var(--mono)" }}>第{attempt[s.action]}轮</span></span>
              <span style={{ fontSize: 11.5, fontFamily: "var(--mono)", color: "var(--text-3)" }}>{s.prior}→{s.next}</span>
              <span style={{ fontSize: 12, fontWeight: 700, color: s.regression ? "var(--red)" : "var(--green)" }}>{s.delta >= 0 ? "▲+" : "▼"}{s.delta}</span>
            </div>
          ); }); })()}
          {reverts.map((r, i) => (
            <div key={`r-${i}`} style={{ padding: "8px 12px", borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--amber)" }}>↩ 回滚「{r.action}」到第 {r.toAttempt} 次之前</div>
          ))}
        </div>
      </Panel>

      {/* Empty ledgers don't render — no more bordered "还没…" placeholder panels cluttering 总结. */}
      {plans.length > 0 && <Ledger title="构建计划" items={plans} empty="还没规划" />}
      {refines.length > 0 && <Ledger title="修订记录" items={refines} empty="还没修订" />}
      {reflects.length > 0 && <Ledger title="学到的经验（反思）" items={reflects} empty="还没反思" />}
      {skills.length > 0 && <Ledger title="技能" items={skills} empty="本次没造技能" />}
    </div>
  );
}
