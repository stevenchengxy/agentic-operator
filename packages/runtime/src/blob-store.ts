// #COMMS — content-addressed blob store for oversized inter-agent payload fields.
//
// A large field (e.g. a base64 PDF) that would otherwise ride INLINE across every hop — bloating
// every event row, NDJSON ledger line and step artifact — is written ONCE here keyed by its sha256,
// and replaced on the wire by a small `BlobRef`. Content-addressing means the SAME bytes hash to the
// SAME path, so a blob that flows through N agents is stored exactly once (dedup), and the downstream
// resolves it on demand via `getBlob`.
//
// Sync fs on purpose: this runs inside an Inngest `step.run` (blocking is fine there) and keeping it
// sync lets the offloader be a pure `(field, value) => BlobRef | null` — which keeps assembleEmitPayload
// pure + unit-testable.

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync } from "node:fs";
import path from "node:path";
import { type BlobRef, isBlobRef } from "./message-envelope";
import { activeBlobBackend } from "./blob-backend";

/** Root for the content-addressed store. Pinned via AGENTIC_BLOB_DIR, else `<data root>/blobs`
 *  (AGENTIC_DATA_ROOT keeps parity with the fs.* tools + cassettes; see CLAUDE.md's data-root note). */
export function blobDir(): string {
  return process.env.AGENTIC_BLOB_DIR ?? path.join(process.env.AGENTIC_DATA_ROOT ?? "./data", "blobs");
}

function blobPath(hash: string): string {
  // Shard by the first 2 hex chars so a directory never holds millions of entries.
  return path.join(blobDir(), hash.slice(0, 2), hash);
}

/** Write bytes content-addressed (dedup: no-op if the hash already exists) and return a BlobRef. */
export function putBlob(bytes: string, contentType?: string): BlobRef {
  const hash = createHash("sha256").update(bytes, "utf8").digest("hex");
  const fp = blobPath(hash);
  if (!existsSync(fp)) {
    mkdirSync(path.dirname(fp), { recursive: true });
    // #W1-8 — atomic write (tmp + rename) closes the TOCTOU window: a concurrent identical write can
    // no longer leave a half-written blob if the second write dies midway. Rename is atomic on POSIX.
    const tmp = `${fp}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmp, bytes, "utf8");
    try {
      renameSync(tmp, fp);
    } catch {
      // lost the race to an identical-content writer — the winner's file is byte-identical.
    }
    replicateBlob(hash, bytes, contentType); // #SCALE-BLOB — write-through to the shared backend when configured
  }
  return { __ref: "blob", hash, bytes: Buffer.byteLength(bytes, "utf8"), contentType, preview: bytes.slice(0, 24) };
}

/** Read a blob back by hash. Returns null when absent (never throws). */
export function getBlob(hash: string): string | null {
  try {
    return readFileSync(blobPath(hash), "utf8");
  } catch {
    return null;
  }
}

/** Resolve a BlobRef to its bytes (for rehydratePayload). */
export function resolveBlobRef(ref: BlobRef): string | null {
  return getBlob(ref.hash);
}

const DEFAULT_THRESHOLD = Number(process.env.AGENTIC_BLOB_THRESHOLD_BYTES) || 8_192;

/**
 * Build the offloader assembleEmitPayload injects. Offloads STRING fields over the threshold (the real
 * bloat case — base64 blobs / large text). Small strings, numbers, booleans and structured objects
 * stay inline (offloading a structured object would change its shape on rehydrate; strings round-trip
 * cleanly). Already-offloaded values (BlobRef) are skipped.
 */
export function makeBlobOffloader(
  opts: { thresholdBytes?: number; put?: (bytes: string, contentType?: string) => BlobRef } = {},
): (fieldPath: string, value: unknown) => BlobRef | null {
  const threshold = opts.thresholdBytes ?? DEFAULT_THRESHOLD;
  const put = opts.put ?? putBlob;
  return (_fieldPath, value) => {
    if (isBlobRef(value)) return null;
    if (typeof value !== "string" || value.length <= threshold) return null;
    return put(value, "text/plain");
  };
}

// #SCALE-BLOB — shared-backend bridge. The concrete transports (S3/SigV4, plain HTTP, or a custom
// runtime-plugged impl) live in blob-backend.ts; this file only routes: every local write REPLICATES
// out (fire-and-forget — content-addressed keys make the PUT idempotent), and a local read MISS
// falls back to the backend then re-caches locally. No backend configured = pure single-instance fs.

/** Replicate a blob to the shared backend (fire-and-forget; content-addressed → idempotent). */
export function replicateBlob(hash: string, bytes: string, contentType?: string): void {
  const backend = activeBlobBackend();
  if (!backend) return;
  void backend.put(hash, bytes, contentType).catch(() => {});
}

/** Fetch a blob from the shared backend on local miss; caches it locally for next time. */
export async function fetchBlobRemote(hash: string): Promise<string | null> {
  const backend = activeBlobBackend();
  if (!backend) return null;
  try {
    const bytes = await backend.get(hash);
    if (bytes == null) return null;
    try { putBlob(bytes); } catch { /* local cache best-effort */ }
    return bytes;
  } catch {
    return null;
  }
}

/** Async blob resolution: local fs first, then the shared backend (multi-instance path). */
export async function resolveBlobRefAsync(ref: BlobRef): Promise<string | null> {
  return getBlob(ref.hash) ?? (await fetchBlobRemote(ref.hash));
}
