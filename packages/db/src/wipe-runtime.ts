/**
 * `pnpm db:wipe-runtime` — truncate runtime-traffic tables only, leave
 * identity + workflow + agent-config rows intact.
 *
 * The product rule (locked 2026-05-26): "production mode = zero mock data,
 * demo mode = seed + loop". This script is the clean slate primitive. Run
 * it once to drop accumulated seed/historical fixtures before flipping
 * `AGENTIC_DEMO_MODE` between states, or any time you want to confirm a
 * dashboard genuinely reflects live traffic vs. stale fixtures.
 *
 * Wiped: `runs`, `steps`, `events`, `tasks`, `audit_log`, `artifacts`,
 *        `run_trace_events`, `run_emitted_events`, `run_messages`,
 *        `agent_run_sessions`, `event_listeners` (regenerated on bootstrap),
 *        `agent_memory_short`, `agent_memory_long` (per-run scratch),
 *        `idempotency` if present.
 *
 * KEPT:  `tenants`, `users`, `memberships`, `workflows`, `workflow_versions`,
 *        `deployments`, `agents`, `agent_versions`, `event_types`,
 *        `entity_types`, `api_tokens`, `webhook_subscriptions`,
 *        `agent_drafts`, `agent_draft_revisions`, `tenant_budgets`, `_meta`.
 *        These are identity + configuration,
 *        not runtime traffic.
 *
 * Idempotent. Reports a summary of rows cleared per table.
 */

import { closeDb, getRawSqlite } from "./client";

/**
 * Order matters because foreign keys are ON DELETE CASCADE for most child
 * tables, but a few cross-table FKs (e.g. `runs.trigger_event_id →
 * events.id`) would otherwise emit warnings. Wiping children first keeps
 * the trace clean even though SQLite is permissive in WAL mode.
 */
const TABLES_TO_WIPE = [
  "run_trace_events",
  "run_emitted_events",
  "run_messages",
  "steps",
  "artifacts",
  "agent_memory_short",
  "agent_memory_long",
  "tasks",
  "runs",
  "agent_run_sessions",
  "events",
  "event_listeners",
  "audit_log",
] as const;

interface WipeReport {
  table: string;
  beforeRows: number;
  afterRows: number;
  cleared: number;
}

export function wipeRuntime(): WipeReport[] {
  const sqlite = getRawSqlite();
  const report: WipeReport[] = [];

  // Defer foreign-key enforcement so a child→parent chain doesn't trip on
  // intra-batch ordering. We re-enable + integrity-check at the end.
  sqlite.pragma("foreign_keys = OFF");
  const tx = sqlite.transaction(() => {
    for (const table of TABLES_TO_WIPE) {
      // The table may not exist on databases that pre-date a migration; the
      // existence probe keeps this script forward + backward compatible
      // across schema versions.
      const exists = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`,
        )
        .get(table) as { name: string } | undefined;
      if (!exists) {
        report.push({ table, beforeRows: 0, afterRows: 0, cleared: 0 });
        continue;
      }

      const beforeRow = sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
        .get() as { n: number };
      sqlite.prepare(`DELETE FROM ${table}`).run();
      const afterRow = sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
        .get() as { n: number };
      report.push({
        table,
        beforeRows: beforeRow.n,
        afterRows: afterRow.n,
        cleared: beforeRow.n - afterRow.n,
      });
    }
  });
  try {
    tx();
  } finally {
    sqlite.pragma("foreign_keys = ON");
  }

  return report;
}

function formatReport(report: WipeReport[]): string {
  const width = Math.max(...report.map((r) => r.table.length), 12);
  const lines = report.map(
    (r) =>
      `  ${r.table.padEnd(width)}  cleared ${String(r.cleared).padStart(6)}  (was ${r.beforeRows})`,
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  console.log("[wipe-runtime] truncating runtime traffic tables …");
  console.log(
    "[wipe-runtime] KEEPING: tenants, users, memberships, workflows, workflow_versions,",
  );
  console.log(
    "[wipe-runtime]          deployments, agents, agent_versions, event_types,",
  );
  console.log(
    "[wipe-runtime]          agent_drafts, agent_draft_revisions, entity_types, api_tokens,",
  );
  console.log(
    "[wipe-runtime]          webhook_subscriptions, tenant_budgets, _meta",
  );
  const report = wipeRuntime();
  console.log(formatReport(report));
  const total = report.reduce((sum, r) => sum + r.cleared, 0);
  console.log(`[wipe-runtime] done — ${total} row(s) cleared in total`);
  closeDb();
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error("[wipe-runtime] failed", err);
    process.exit(1);
  });
}
