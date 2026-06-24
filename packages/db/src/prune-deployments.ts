/**
 * `pnpm db:prune-deployments` — cap the `rolled_back` deployment history so
 * the Deployments page (`/portal/<tenant>/deployments`, backed by
 * `listDeployments`) stays readable.
 *
 * Background: every intentional (re)deploy demotes the prior live row to
 * `rolled_back` and inserts a new live row — that is correct. But repeated
 * forced re-bootstraps and legacy boot churn (from before the P0-RT-07
 * no-op-reboot guard) left hundreds of near-identical tombstones, e.g.
 * "auto-bootstrapped from RAAS-v1" ×42, "force re-bootstrapped from RAAS-v1"
 * ×29, plus null/`tc-27` test noise.
 *
 * Retention key is **(tenant_id, target, note)**, NOT version_id. The two
 * row shapes look opposite in the data:
 *   - Churn:   one boilerplate note repeated many times (often across
 *              several version_ids, since the note is derived from the model
 *              FOLDER name, not the version).
 *   - History: the seeded RAAS timeline records many DISTINCT descriptive
 *              notes that all share ONE workflow version_id.
 * Keying on note therefore collapses churn while preserving every distinct
 * history entry. Keying on version_id would do the reverse — it would nuke
 * the rich history and keep the churn. Ordering by deployed_at can't be the
 * sole discriminator either: the churn is NEWER than the real history, so
 * "keep the most recent N per target" would also delete history.
 *
 * Only `status='rolled_back'` rows are touched — `live` and `pending` are
 * never deleted. Idempotent: re-running once each (tenant, target, note)
 * group is already at or below the cap is a no-op.
 */

import { closeDb, getRawSqlite } from "./client";

/** Rolled-back tombstones to retain per (tenant_id, target, note) group. */
export const DEFAULT_ROLLED_BACK_RETENTION = 5;

export interface PruneDeploymentsReport {
  before: number;
  after: number;
  deleted: number;
  retainPerNote: number;
}

export function pruneRolledBackDeployments(
  retainPerNote: number = DEFAULT_ROLLED_BACK_RETENTION,
): PruneDeploymentsReport {
  const sqlite = getRawSqlite();

  const countRolledBack = () =>
    (
      sqlite
        .prepare(`SELECT COUNT(*) AS n FROM deployments WHERE status = 'rolled_back'`)
        .get() as { n: number }
    ).n;

  const before = countRolledBack();

  // ROW_NUMBER over each (tenant_id, target, note) group, newest first, then
  // drop everything past the retention cap. SQLite groups NULL notes into a
  // single partition — same semantics as the GROUP BY the Deployments audit
  // uses — so unlabelled boilerplate collapses together too.
  sqlite
    .prepare(
      `DELETE FROM deployments
       WHERE id IN (
         SELECT id FROM (
           SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY tenant_id, target, note
               ORDER BY deployed_at DESC, id DESC
             ) AS rn
           FROM deployments
           WHERE status = 'rolled_back'
         )
         WHERE rn > ?
       )`,
    )
    .run(retainPerNote);

  const after = countRolledBack();

  return { before, after, deleted: before - after, retainPerNote };
}

async function main(): Promise<void> {
  console.log(
    `[prune-deployments] capping rolled_back deployments at ${DEFAULT_ROLLED_BACK_RETENTION} per (tenant, target, note) …`,
  );
  const report = pruneRolledBackDeployments();
  console.log(
    `[prune-deployments] done — deleted ${report.deleted} row(s) (was ${report.before}, now ${report.after})`,
  );
  closeDb();
}

const isMain =
  !!process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  main().catch((err) => {
    console.error("[prune-deployments] failed", err);
    process.exit(1);
  });
}
