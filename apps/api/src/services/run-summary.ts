/**
 * #W2 — AI summary of a PRODUCTION run.
 *
 * Ports the factory `analyzeRun` pattern to the production runs/steps/log/
 * llm_turns data: build a faithful digest of everything the run did, hand it to
 * the shared LLM gateway, and get back a natural-language summary. On success
 * the model describes the business outcome; on failure it describes the problem
 * and guesses likely causes from the error. Degrades to digest-only when the
 * gateway can't produce JSON (e.g. mock provider in demo mode). Results are
 * cached in `run_summaries` (see queries/reasoning.ts) so re-opening a run
 * doesn't re-spend tokens.
 */

import { readFile } from "node:fs/promises";
import type { RunSummary, RunRow, StepRow } from "@agentic/contracts";
import { getLLMGateway } from "./llm";
import { getRun, listSteps } from "../queries/runs";
import {
  listRunTurns,
  saveRunSummary,
  resolveTenantId,
  type RunTurnRow,
} from "../queries/reasoning";

const clip = (s: string, n: number): string =>
  s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s;

function preview(v: unknown, n: number): string {
  if (v == null) return "∅";
  try {
    return clip(typeof v === "string" ? v : JSON.stringify(v), n);
  } catch {
    return String(v);
  }
}

/** Last `maxLines` lines of a run's `.log` file (bounded). Best-effort. */
async function readLogTail(
  logPath: string | null | undefined,
  maxLines: number,
): Promise<string> {
  if (!logPath) return "";
  try {
    const text = await readFile(logPath, "utf8");
    const lines = text.split("\n").filter(Boolean);
    return lines.slice(-maxLines).join("\n");
  } catch {
    return "";
  }
}

/**
 * A faithful, human-readable narrative of everything the run did — the LLM's
 * input. Pure + testable. Carries the run header, per-step status + I/O
 * previews, the captured LLM turns (response/reasoning/tools), and a log tail.
 */
export function buildRunDigest(
  run: RunRow,
  steps: StepRow[],
  turns: RunTurnRow[],
  logTail: string,
): string {
  const errorMsg = run.errorMessage ?? run.error ?? null;
  const lines: string[] = [];
  lines.push(
    `运行 ${run.id}｜agent: ${run.agentTitle ?? run.agentName}｜状态: ${run.status}`,
  );
  lines.push(
    `主题: ${run.subject ?? "—"}｜触发事件: ${run.triggerEvent ?? "—"}｜产出事件: ${run.emittedEvent ?? "—"}`,
  );
  lines.push(
    `耗时: ${run.durationMs ?? "?"}ms｜模型: ${run.model ?? "—"}｜tokens: in ${run.tokensIn ?? 0} / out ${run.tokensOut ?? 0}`,
  );
  if (errorMsg) lines.push(`⛔ 运行错误: ${clip(String(errorMsg), 600)}`);

  lines.push(`\n=== 步骤 (${steps.length}) ===`);
  for (const s of steps) {
    lines.push(
      `#${s.ord} ${s.name} [${s.type}] → ${s.status}${s.durationMs != null ? ` (${s.durationMs}ms)` : ""}${s.error ? `  ✗ ${clip(String(s.error), 300)}` : ""}`,
    );
    if (s.input !== undefined) lines.push(`   📥 ${preview(s.input, 500)}`);
    if (s.output !== undefined) lines.push(`   📤 ${preview(s.output, 700)}`);
  }

  if (turns.length > 0) {
    lines.push(`\n=== LLM 回合 (${turns.length}) ===`);
    for (const t of turns) {
      if (t.reasoning) lines.push(`💭 推理: ${clip(t.reasoning, 800)}`);
      if (t.responseText) lines.push(`🗣 回应: ${clip(t.responseText, 900)}`);
      for (const c of t.toolCalls)
        lines.push(`🔧 调用 ${c.name}｜输入: ${preview(c.input, 400)}`);
    }
  }

  if (logTail) lines.push(`\n=== 日志尾部 ===\n${clip(logTail, 6000)}`);

  return lines.join("\n").slice(0, 30000);
}

const SYSTEM_PROMPT = [
  "你是生产运行监控的【资深值班工程师】。下面是一次真实业务 agent 运行的【完整活动叙事】——运行头、每一步的状态与输入/输出、LLM 的推理与回应、调用的工具、以及日志尾部。",
  "请判断这次运行是成功还是失败，并给出精炼、可执行的总结：",
  "· 若成功：在 businessDetails 里用具体业务语言描述发生了什么（处理了哪个对象、关键数值/结论、产出了什么事件），problem 置为 null。",
  "· 若失败或异常：在 problem 里说清哪一步、出了什么问题；在 likelyCauses 里【根据 error/报错/堆栈】给出最可能的原因猜测（按可能性排序）；在 suggestions 里给出下一步排查/修复动作。",
  "严格接地于叙事，不要编造未出现的字段。回复语言与运行内容一致（内容为中文则用中文）。",
  '只输出 JSON：{"headline":string,"narrative":string,"businessDetails":string[],"problem":string|null,"likelyCauses":string[],"suggestions":string[]}。不要任何其它文字。',
].join("\n");

/** Extract the first balanced JSON object from a model reply (strips fences/prose). */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const toStr = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const toArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(toStr).filter(Boolean) : [];

function fallback(run: RunRow, digest: string, failed: boolean): RunSummary {
  const errorMsg = run.errorMessage ?? run.error ?? null;
  return {
    scored: false,
    status: run.status,
    headline: failed
      ? `运行失败（${run.agentTitle ?? run.agentName}）`
      : `运行 ${run.status}（${run.agentTitle ?? run.agentName}）`,
    narrative: "（未启用 LLM 网关或解析失败，仅给出活动叙事；配置真实 provider 后可生成 AI 总结）",
    businessDetails: [],
    problem: failed && errorMsg ? String(errorMsg) : null,
    likelyCauses: [],
    suggestions: [],
    model: "",
    digest,
  };
}

/**
 * Generate (and cache) the AI summary for a run. Returns null when the run
 * isn't found / not owned by the tenant. Never throws — degrades to a
 * digest-only summary on any gateway/parse failure.
 */
export async function generateRunSummary(
  tenantSlug: string,
  runId: string,
): Promise<RunSummary | null> {
  const tenantId = resolveTenantId(tenantSlug);
  if (!tenantId) return null;
  const run = await getRun(tenantSlug, runId);
  if (!run) return null;

  const steps = await listSteps(run.id);
  const turns = listRunTurns(run.id);
  const logTail = await readLogTail(run.logPath, 80);
  const digest = buildRunDigest(run, steps, turns, logTail);
  const failed =
    run.status === "failed" || Boolean(run.errorMessage ?? run.error);

  let summary: RunSummary;
  try {
    const gw = getLLMGateway();
    const res = await gw.chat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: digest },
      ],
      jsonMode: true,
      purpose: "run_summary",
      tenantSlug,
      temperature: 0.3,
      maxTokens: 1600,
    });
    const j = parseJsonObject(res.text);
    if (!j) throw new Error("run_summary: model returned non-JSON");
    summary = {
      scored: true,
      status: run.status,
      headline: toStr(j.headline) || fallback(run, digest, failed).headline,
      narrative: toStr(j.narrative),
      businessDetails: toArr(j.businessDetails),
      problem: j.problem == null ? null : toStr(j.problem) || null,
      likelyCauses: toArr(j.likelyCauses),
      suggestions: toArr(j.suggestions),
      model: res.model,
      digest,
    };
  } catch {
    summary = fallback(run, digest, failed);
  }

  saveRunSummary(tenantId, run.id, summary, summary.model);
  return { ...summary, createdAt: new Date() };
}
