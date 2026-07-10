/**
 * Per-agent throughput — the honest replacement for a stage "funnel".
 *
 * For the tenant's LIVE workflow we count, per agent and over a rolling
 * window, the DISTINCT subjects it processed plus its total run count.
 * Counting distinct subjects answers "how much real work moved through each
 * agent" without pretending non-linear tenants are conversion funnels. The
 * dashboard renders one labelled bar per agent (sorted by subjects desc).
 *
 * Agents come from the DAG so every live agent shows a bar even at zero;
 * test runs (`is_test = 1`) never contribute.
 */

import { eq } from "drizzle-orm";
import { getDb, runs, tenants } from "@agentic/db";
import type { ThroughputResult } from "@agentic/contracts";
import { getDag } from "./workflows";

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

export async function getThroughput(
  tenantSlug: string,
  rawWindow?: string,
): Promise<ThroughputResult> {
  const { window, windowMs } = resolveWindow(rawWindow);
  const db = getDb();
  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .all()[0];
  if (!tenant) return { window, windowMs, agents: [] };

  // Live-workflow agents — the same source the canvas/DAG uses, so labels
  // and membership can never disagree with the rest of the UI.
  const dag = await getDag(tenantSlug);

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

  const subjectsByAgent = new Map<string, Set<string>>();
  const runsByAgent = new Map<string, number>();
  for (const r of rows) {
    if (r.isTest) continue;
    if (!r.startedAt || r.startedAt < since) continue;
    runsByAgent.set(r.agentId, (runsByAgent.get(r.agentId) ?? 0) + 1);
    if (!r.subject) continue;
    let set = subjectsByAgent.get(r.agentId);
    if (!set) {
      set = new Set<string>();
      subjectsByAgent.set(r.agentId, set);
    }
    set.add(r.subject);
  }

  const agents = dag.agents
    .map((a) => ({
      kebabId: a.kebabId,
      name: a.name,
      title: a.title,
      subjects: subjectsByAgent.get(a.id)?.size ?? 0,
      runs: runsByAgent.get(a.id) ?? 0,
    }))
    .sort((a, b) => b.subjects - a.subjects || b.runs - a.runs);

  return { window, windowMs, agents };
}
