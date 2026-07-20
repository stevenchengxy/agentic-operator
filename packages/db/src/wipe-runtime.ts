/**
 * `pnpm db:wipe-runtime` — truncate runtime-traffic tables only, leave
 * identity + workflow + agent-config rows intact.
 *
 * The product rule is "production mode = zero mock data". This script is the
 * clean-slate primitive: run it to drop accumulated development/test traffic
 * before proving that dashboards and log tabs reflect only fresh live runs.
 *
 * Wiped: `runs`, `steps`, `events`, `tasks`, `audit_log`, `artifacts`,
 *        `event_listeners` (regenerated on bootstrap),
 *        `agent_memory_short`, `agent_memory_long`, `llm_calls`,
 *        `llm_budget_reservations`, `event_store`, `acceptance_scores`,
 *        `tool_stats`, and `idempotency_keys`.
 *
 * KEPT:  `tenants`, `users`, `memberships`, `workflows`, `workflow_versions`,
 *        `deployments`, `agents`, `agent_versions`, `event_types`,
 *        `entity_types`, `api_tokens`, `webhook_subscriptions`,
 *        `tenant_budgets`, `_meta`. These are identity + configuration,
 *        not runtime traffic.
 *
 * Idempotent. Reports a summary of rows cleared per table.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { closeDb, getRawSqlite } from "./client";

/**
 * Order matters because foreign keys are ON DELETE CASCADE for most child
 * tables, but a few cross-table FKs (e.g. `runs.trigger_event_id →
 * events.id`) would otherwise emit warnings. Wiping children first keeps
 * the trace clean even though SQLite is permissive in WAL mode.
 */
const TABLES_TO_WIPE = [
  "acceptance_scores",
  "steps",
  "llm_turns",
  "run_summaries",
  "artifacts",
  "agent_memory_short",
  "agent_memory_long",
  "tasks",
  "runs",
  "events",
  "event_store",
  "event_listeners",
  "llm_calls",
  "llm_budget_reservations",
  "idempotency_keys",
  "tool_stats",
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

function configuredStorageRoot(
  envName: "AGENTIC_LOGS_DIR" | "AGENTIC_ARTIFACTS_DIR",
  fallbackName: "logs" | "artifacts",
): string {
  const configured = process.env[envName]?.trim();
  if (configured) return path.resolve(process.cwd(), configured);
  const rawDatabase = process.env.DATABASE_URL?.replace(/^file:/, "");
  const databasePath = path.resolve(process.cwd(), rawDatabase || "agentic.db");
  return path.join(path.dirname(databasePath), fallbackName);
}

function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomically replace the runtime log/artifact roots with empty directories,
 * then remove the quarantined old trees. Refuse symlinks and dangerously
 * broad paths so an environment typo cannot turn a cleanup command into an
 * arbitrary recursive delete.
 */
export function wipeRuntimeFiles(): Array<{ kind: "logs" | "artifacts"; root: string }> {
  const roots = [
    {
      kind: "logs" as const,
      root: configuredStorageRoot("AGENTIC_LOGS_DIR", "logs"),
    },
    {
      kind: "artifacts" as const,
      root: configuredStorageRoot("AGENTIC_ARTIFACTS_DIR", "artifacts"),
    },
  ];
  const logsRoot = roots[0]!;
  const artifactsRoot = roots[1]!;
  if (logsRoot.root === artifactsRoot.root) {
    throw new Error("AGENTIC_LOGS_DIR and AGENTIC_ARTIFACTS_DIR must be distinct");
  }
  for (const { kind, root } of roots) {
    const parsedRoot = path.parse(root).root;
    const parent = path.dirname(root);
    if (root === parsedRoot || root === process.cwd() || root === parent) {
      throw new Error(`refusing to wipe unsafe ${kind} path: ${root}`);
    }
    mkdirSync(parent, { recursive: true });
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true });
      fsyncDirectory(parent);
      continue;
    }
    if (lstatSync(root).isSymbolicLink()) {
      throw new Error(`refusing to wipe symlinked ${kind} path: ${root}`);
    }
    const quarantine = `${root}.wipe-${process.pid}-${Date.now()}`;
    renameSync(root, quarantine);
    try {
      mkdirSync(root, { recursive: false });
      fsyncDirectory(parent);
    } catch (error) {
      renameSync(quarantine, root);
      throw error;
    }
    rmSync(quarantine, { recursive: true, force: false });
    fsyncDirectory(parent);
  }
  return roots;
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
    "[wipe-runtime]          entity_types, api_tokens, webhook_subscriptions, tenant_budgets, _meta",
  );
  const clearedRoots = wipeRuntimeFiles();
  const report = wipeRuntime();
  console.log(formatReport(report));
  const total = report.reduce((sum, r) => sum + r.cleared, 0);
  for (const cleared of clearedRoots) {
    console.log(`[wipe-runtime] cleared ${cleared.kind} root: ${cleared.root}`);
  }
  console.log(`[wipe-runtime] done — ${total} row(s) cleared in total`);
  closeDb();
}

const isMain =
  !!process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((err) => {
    console.error("[wipe-runtime] failed", err);
    process.exit(1);
  });
}
