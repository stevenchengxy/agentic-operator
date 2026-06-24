/**
 * Stage funnel — conversion view for the dashboard.
 *
 * For the tenant's LIVE workflow we map each agent to its pipeline stage
 * (the numeric kebab-id prefix `getDag` already derives) and then, over a
 * rolling window, count the DISTINCT subjects whose runs reached each
 * stage. Counting distinct subjects (rather than raw runs) makes the
 * panel a true conversion/drop-off funnel: "of the subjects that entered
 * intake, how many made it to submit?".
 *
 * Stages come from the DAG, not from whatever happened to run — so an
 * empty stage shows as a real gap (count 0) instead of vanishing. The
 * unstaged sentinel (stage 99, kebab without a numeric prefix) is dropped,
 * and test runs (`is_test = 1`) never contribute.
 */

import { eq } from "drizzle-orm";
import { getDb, runs, tenants } from "@agentic/db";
import type { FunnelResult } from "@agentic/contracts";
import { getDag } from "./workflows";

const UNSTAGED = 99;

const WINDOWS: Record<string, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};
const DEFAULT_WINDOW = "24h";

/** Resolve a human window token to (label, ms), falling back to 24h. */
export function resolveWindow(raw?: string): { window: string; windowMs: number } {
  const key = raw && raw in WINDOWS ? raw : DEFAULT_WINDOW;
  return { window: key, windowMs: WINDOWS[key]! };
}

export async function getFunnel(
  tenantSlug: string,
  rawWindow?: string,
): Promise<FunnelResult> {
  const { window, windowMs } = resolveWindow(rawWindow);
  const db = getDb();
  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!tenant) return { window, windowMs, stages: [] };

  // Stage assignment comes from the same source the canvas uses, so the
  // funnel and the DAG can never disagree about which stage an agent is in.
  const dag = await getDag(tenantSlug);
  const stageByAgent = new Map<string, number>();
  for (const a of dag.agents) stageByAgent.set(a.id, a.stage);

  // The full ordered set of staged stages defined by the workflow — drives
  // the rendered columns so empty stages stay visible as gaps.
  const definedStages = Array.from(
    new Set(dag.agents.map((a) => a.stage).filter((s) => s !== UNSTAGED)),
  ).sort((a, b) => a - b);

  const since = new Date(Date.now() - windowMs);
  const rows = db
    .select({
      agentId: runs.agentId,
      subject: runs.subject,
      startedAt: runs.startedAt,
      isTest: runs.isTest,
    })
    .from(runs)
    .where(eq(runs.tenantId, tenant.id))
    .all();

  const subjectsByStage = new Map<number, Set<string>>();
  for (const r of rows) {
    if (r.isTest) continue;
    if (!r.startedAt || r.startedAt < since) continue;
    if (!r.subject) continue;
    const stage = stageByAgent.get(r.agentId);
    if (stage === undefined || stage === UNSTAGED) continue;
    let set = subjectsByStage.get(stage);
    if (!set) {
      set = new Set<string>();
      subjectsByStage.set(stage, set);
    }
    set.add(r.subject);
  }

  return {
    window,
    windowMs,
    stages: definedStages.map((stage) => ({
      stage,
      count: subjectsByStage.get(stage)?.size ?? 0,
    })),
  };
}
