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
  const reflects = pick(blocks, "reflect").map((b) => b.text);
  const skills = pick(blocks, "skill").map((b) => b.name);
  const scores = pick(blocks, "score");
  const reverts = pick(blocks, "revert");

  const a = analysis && !analysis.error ? analysis : null;
  const score = a ? Number(a.score) || 0 : 0;
  const scoreColor = score >= 80 ? "var(--green)" : score >= 55 ? "var(--amber)" : "var(--red)";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
