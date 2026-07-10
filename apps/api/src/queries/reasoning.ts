/**
 * Reads for the LLM-reasoning surfaces (W0/W2/W3):
 *   - `listRunTurns` — the captured raw LLM turns for one run (digest + detail).
 *   - `getRunSummary` / `saveRunSummary` — the cached AI run summary (W2).
 *
 * The cross-run recent-turns feed + rule-audit query for the 推理审计 page (W3)
 * live in `reasoning-feed.ts`.
 */

import { and, asc, eq } from "drizzle-orm";
import { getDb, llmTurns, runSummaries, tenants } from "@agentic/db";
import type { RunSummary } from "@agentic/contracts";

export interface RunTurnRow {
  id: string;
  stepId: string | null;
  ord: number;
  promptPreview: string | null;
  responseText: string | null;
  reasoning: string | null;
  toolCalls: Array<{ name: string; input: unknown }>;
  provider: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  finishReason: string | null;
  latencyMs: number | null;
  createdAt: Date | null;
}

export function resolveTenantId(slug: string): string | null {
  const db = getDb();
  return (
    db.select({ id: tenants.id }).from(tenants).where(eq(tenants.slug, slug)).all()[0]
      ?.id ?? null
  );
}

/**
 * All captured LLM turns for a run, in execution order. Ordered by
 * `(created_at, ord)` — turns of the same step share a created_at (batch
 * insert) and `ord` disambiguates within the step; distinct steps differ by
 * created_at. `toolCallsJson` is stored as JSON so drizzle returns it parsed.
 */
export function listRunTurns(runId: string): RunTurnRow[] {
  const db = getDb();
  const rows = db
    .select({
      id: llmTurns.id,
      stepId: llmTurns.stepId,
      ord: llmTurns.ord,
      promptPreview: llmTurns.promptPreview,
      responseText: llmTurns.responseText,
      reasoning: llmTurns.reasoning,
      toolCallsJson: llmTurns.toolCallsJson,
      provider: llmTurns.provider,
      model: llmTurns.model,
      tokensIn: llmTurns.tokensIn,
      tokensOut: llmTurns.tokensOut,
      finishReason: llmTurns.finishReason,
      latencyMs: llmTurns.latencyMs,
      createdAt: llmTurns.createdAt,
    })
    .from(llmTurns)
    .where(eq(llmTurns.runId, runId))
    .orderBy(asc(llmTurns.createdAt), asc(llmTurns.ord))
    .all();
  return rows.map(({ toolCallsJson, ...r }) => ({
    ...r,
    toolCalls: Array.isArray(toolCallsJson)
      ? (toolCallsJson as Array<{ name: string; input: unknown }>)
      : [],
  }));
}

/** Cached AI summary for a run, tenant-scoped. Null when not yet generated. */
export function getRunSummary(tenantId: string, runId: string): RunSummary | null {
  const db = getDb();
  const row = db
    .select()
    .from(runSummaries)
    .where(and(eq(runSummaries.runId, runId), eq(runSummaries.tenantId, tenantId)))
    .all()[0];
  if (!row) return null;
  const s = row.summaryJson as RunSummary;
  return { ...s, createdAt: row.createdAt };
}

/** Upsert the cached AI summary (regenerate replaces). */
export function saveRunSummary(
  tenantId: string,
  runId: string,
  summary: RunSummary,
  model: string,
): void {
  const db = getDb();
  const now = new Date();
  db.insert(runSummaries)
    .values({ runId, tenantId, summaryJson: summary, model, createdAt: now })
    .onConflictDoUpdate({
      target: runSummaries.runId,
      set: { summaryJson: summary, model, createdAt: now },
    })
    .run();
}
