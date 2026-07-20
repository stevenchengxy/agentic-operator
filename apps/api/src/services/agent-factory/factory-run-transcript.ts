import { appendFile, mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BrainEvent } from "@agentic/agent-factory";

/**
 * Append-only NDJSON transcript sidecar — the DURABLE SOURCE OF TRUTH for a
 * factory run's full event stream.
 *
 * Background: the durable transcript used to be re-serialized in full into a
 * single `factory_runs.transcript_json` SQLite row every 5s AND on every budget
 * frame (audit findings F-03 / F-04 — O(N) synchronous write-amplification that
 * stalled the shared event loop and, on the budget path, fail-stopped healthy
 * runs). Here the transcript is appended incrementally (O(delta)); SQLite keeps
 * only a small structural projection for cheap evidence derivation. This file
 * also keeps EVERY event (including streamed `think` deltas) so a reconnecting
 * client replays the exact story — structural frames are never folded away
 * (also addresses F-15).
 */

const MAX_READ_BYTES = 64 * 1024 * 1024; // guard: never buffer an unbounded file into memory

function dataRoot(): string {
  return process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
}

/** Path-safe segment: ids are opaque strings; never let one escape the dir. */
function safeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "_");
  return cleaned.slice(0, 200) || "_";
}

function transcriptDir(tenantId: string | undefined): string {
  return path.resolve(dataRoot(), "logs", "factory-runs", safeSegment(tenantId || "_shared"));
}

function transcriptPath(tenantId: string | undefined, runId: string): string {
  return path.join(transcriptDir(tenantId), `${safeSegment(runId)}.ndjson`);
}

/** Append newly-emitted events to the run's NDJSON sidecar. Best-effort by
 * contract — the caller treats a rejection as a non-fatal mirror miss (the next
 * flush retries the still-pending tail), never a run failure. */
export async function appendFactoryRunTranscript(
  tenantId: string | undefined,
  runId: string,
  events: readonly BrainEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const dir = transcriptDir(tenantId);
  await mkdir(dir, { recursive: true });
  const lines = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  await appendFile(path.join(dir, `${safeSegment(runId)}.ndjson`), lines, "utf8");
}

/** Read the full durable transcript for replay (reconnect after eviction /
 * restart). Returns [] when there is no sidecar (an old run persisted before
 * this mechanism, or a run that never emitted). Malformed trailing lines from a
 * crash mid-append are skipped rather than throwing. */
export async function readFactoryRunTranscript(
  tenantId: string | undefined,
  runId: string,
): Promise<BrainEvent[]> {
  const file = transcriptPath(tenantId, runId);
  try {
    const info = await stat(file);
    if (info.size === 0) return [];
    if (info.size > MAX_READ_BYTES) {
      // A pathologically large transcript is read from its tail so replay stays
      // bounded; the head is already summarized in the SQLite projection.
      const buf = Buffer.alloc(MAX_READ_BYTES);
      const { open } = await import("node:fs/promises");
      const handle = await open(file, "r");
      try {
        await handle.read(buf, 0, MAX_READ_BYTES, info.size - MAX_READ_BYTES);
      } finally {
        await handle.close();
      }
      return parseLines(buf.toString("utf8"), true);
    }
    return parseLines(await readFile(file, "utf8"), false);
  } catch {
    return [];
  }
}

function parseLines(text: string, dropFirstPartial: boolean): BrainEvent[] {
  const out: BrainEvent[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    // When reading from a byte offset (tail), the first line is likely a partial
    // record; skip it.
    if (dropFirstPartial && i === 0) continue;
    try {
      out.push(JSON.parse(line) as BrainEvent);
    } catch {
      /* a torn final line (crash mid-append) is skipped, not fatal */
    }
  }
  return out;
}

/** Remove a run's sidecar (hard cleanup / GC). Best-effort. */
export async function deleteFactoryRunTranscript(
  tenantId: string | undefined,
  runId: string,
): Promise<void> {
  try {
    await rm(transcriptPath(tenantId, runId), { force: true });
  } catch {
    /* best-effort */
  }
}
