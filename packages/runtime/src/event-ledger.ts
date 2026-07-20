/**
 * Event ledger — append-only NDJSON file per day per tenant.
 * Path: `logs/<tenant>/events/<YYYY-MM-DD>.ndjson`.
 *
 * Returns `payload_ref` ("path#byteOffset") so the DB's `events.payload_ref`
 * column can locate the payload on demand without storing it twice.
 */

import { mkdir, appendFile, stat } from "node:fs/promises";
import path from "node:path";

// `stat()` followed by `appendFile()` is not an atomic pair.  Without a
// per-file queue, concurrent appends can both observe the same size and
// return identical payload refs even though only one record starts there.
// Keep the queue process-local: a logs directory is instance-local unless a
// deployment deliberately mounts it as shared storage.
const appendQueues = new Map<string, Promise<void>>();

function logRoot() {
  return process.env.AGENTIC_LOGS_DIR ?? "./logs";
}

function dateDir(at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function eventLedgerPath(
  tenantSlug: string,
  at: Date = new Date(),
): string {
  return path.join(logRoot(), tenantSlug, "events", `${dateDir(at)}.ndjson`);
}

export interface LedgerRecord {
  id: string;
  name: string;
  subject?: string;
  data: unknown;
  ts: number;
}

/** Returns "path#byteOffset" pointer suitable for events.payload_ref. */
export async function appendToLedger(
  tenantSlug: string,
  record: LedgerRecord,
): Promise<string> {
  const filePath = eventLedgerPath(tenantSlug);
  const previous = appendQueues.get(filePath) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(filePath), { recursive: true });
    let offset = 0;
    try {
      offset = (await stat(filePath)).size;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    await appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
    return `${filePath}#${offset}`;
  });
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  appendQueues.set(filePath, tail);
  try {
    return await operation;
  } finally {
    if (appendQueues.get(filePath) === tail) appendQueues.delete(filePath);
  }
}
