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

import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { type BlobRef, isBlobRef } from "./message-envelope";
import { activeBlobBackend } from "./blob-backend";

/** Root for the content-addressed store. Pinned via AGENTIC_BLOB_DIR, else `<data root>/blobs`
 *  (AGENTIC_DATA_ROOT keeps parity with the fs.* tools + cassettes; see CLAUDE.md's data-root note). */
export function blobDir(): string {
  return process.env.AGENTIC_BLOB_DIR ?? path.join(process.env.AGENTIC_DATA_ROOT ?? "./data", "blobs");
}

function blobPath(hash: string): string {
  if (!/^[a-f0-9]{8,128}$/i.test(hash)) {
    throw new TypeError("blob hash must be 8-128 hexadecimal characters");
  }
  // Shard by the first 2 hex chars so a directory never holds millions of entries.
  return path.join(blobDir(), hash.slice(0, 2), hash);
}

function contentHash(bytes: string): string {
  return createHash("sha256").update(bytes, "utf8").digest("hex");
}

export class BlobIntegrityError extends Error {
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(expectedHash: string, actualHash: string) {
    super(
      `Blob integrity check failed: expected sha256 ${expectedHash}, received ${actualHash}`,
    );
    this.name = "BlobIntegrityError";
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function blobRefFor(
  hash: string,
  bytes: string,
  contentType?: string,
): BlobRef {
  return {
    __ref: "blob",
    hash,
    bytes: Buffer.byteLength(bytes, "utf8"),
    contentType,
    preview: bytes.slice(0, 24),
  };
}

/** Store and verify the local content-addressed copy without remote side effects. */
function putBlobLocal(bytes: string, contentType?: string): BlobRef {
  const hash = contentHash(bytes);
  const fp = blobPath(hash);
  if (existsSync(fp)) {
    // A pre-existing CAS entry is reusable only if it still matches its key.
    // Disk corruption must not be laundered into a fresh successful BlobRef.
    getBlob(hash);
    return blobRefFor(hash, bytes, contentType);
  }

  mkdirSync(path.dirname(fp), { recursive: true });
  // #W1-8 — atomic write (tmp + rename) closes the TOCTOU window: a concurrent identical write can
  // no longer leave a half-written blob if the second write dies midway. Rename is atomic on POSIX.
  const tmp = `${fp}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(tmp, bytes, "utf8");
  try {
    renameSync(tmp, fp);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // The original rename failure remains authoritative.
    }
    // A concurrent writer may already have materialized the same hash. Only
    // a verified byte-identical winner is a safe success.
    try {
      if (getBlob(hash) === bytes) return blobRefFor(hash, bytes, contentType);
    } catch {
      // Preserve the original write/rename failure below.
    }
    throw error;
  }
  return blobRefFor(hash, bytes, contentType);
}

/** Write bytes content-addressed (dedup: no-op if the hash already exists) and return a BlobRef. */
export function putBlob(bytes: string, contentType?: string): BlobRef {
  const ref = putBlobLocal(bytes, contentType);
  // Idempotently mirror even when the local content-addressed file predated
  // backend configuration. This closes the "local exists, remote never got it"
  // gap after enabling a shared backend.
  void replicateBlob(ref.hash, bytes, contentType).catch((error) => {
    const backend = activeBlobBackend();
    console.error(
      `[blob-store] replication to ${backend?.name ?? "configured backend"} failed for ${ref.hash}:`,
      String((error as { message?: unknown } | null)?.message ?? error).slice(
        0,
        240,
      ),
    );
  });
  return ref;
}

/** Read and verify a blob by hash. Returns null only when absent. */
export function getBlob(hash: string): string | null {
  try {
    const bytes = readFileSync(blobPath(hash), "utf8");
    const actualHash = contentHash(bytes);
    if (actualHash !== hash.toLowerCase()) {
      throw new BlobIntegrityError(hash, actualHash);
    }
    return bytes;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
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

export interface DurableBlobOffloader {
  offload: (fieldPath: string, value: unknown) => BlobRef | null;
  /** Wait for every shared-backend write initiated by this envelope. */
  flush(): Promise<void>;
}

/**
 * Envelope-scoped offloader whose shared-backend writes are awaitable. Use it
 * before persisting/emitting BlobRefs: a failed remote PUT then fails the run
 * instead of publishing a reference that another instance cannot resolve.
 */
export function makeDurableBlobOffloader(
  opts: { thresholdBytes?: number } = {},
): DurableBlobOffloader {
  const pending = new Map<string, Promise<void>>();
  const put = (bytes: string, contentType?: string): BlobRef => {
    const ref = putBlobLocal(bytes, contentType);
    if (!pending.has(ref.hash)) {
      const replication = replicateBlob(ref.hash, bytes, contentType);
      // Attach a rejection observer immediately; flush still awaits the raw
      // promise and remains the authoritative failure path.
      void replication.catch(() => undefined);
      pending.set(ref.hash, replication);
    }
    return ref;
  };
  return {
    offload: makeBlobOffloader({
      thresholdBytes: opts.thresholdBytes,
      put,
    }),
    async flush(): Promise<void> {
      const batch = [...pending.values()];
      if (batch.length === 0) return;
      await Promise.all(batch);
      pending.clear();
    },
  };
}

// #SCALE-BLOB — shared-backend bridge. The concrete transports (S3/SigV4, plain HTTP, or a custom
// runtime-plugged impl) live in blob-backend.ts; this file only routes: every local write REPLICATES
// out asynchronously (content-addressed keys make the PUT idempotent), and a local read MISS
// falls back to the backend then re-caches locally. No backend configured = pure single-instance fs.

/** Replicate a blob to the shared backend. Callers that publish the resulting
 * reference must await this promise (normally via makeDurableBlobOffloader). */
export function replicateBlob(
  hash: string,
  bytes: string,
  contentType?: string,
): Promise<void> {
  const backend = activeBlobBackend();
  if (!backend) return Promise.resolve();
  return backend.put(hash, bytes, contentType);
}

/** Fetch a blob from the shared backend on local miss; caches it locally for next time. */
export async function fetchBlobRemote(hash: string): Promise<string | null> {
  // Validate before handing a user-controlled ref to a backend path/key.
  blobPath(hash);
  const backend = activeBlobBackend();
  if (!backend) return null;
  const bytes = await backend.get(hash);
  if (bytes == null) return null;
  const actualHash = contentHash(bytes);
  if (actualHash !== hash.toLowerCase()) {
    throw new BlobIntegrityError(hash, actualHash);
  }
  // Remote bytes are already authoritative. Cache failures do not invalidate
  // this read, but the caller still receives the exact remote content.
  try {
    putBlobLocal(bytes);
  } catch (error) {
    console.warn(
      `[blob-store] local cache write failed for remote blob ${hash}:`,
      String((error as { message?: unknown } | null)?.message ?? error).slice(
        0,
        240,
      ),
    );
  }
  return bytes;
}

/** Async blob resolution: local fs first, then the shared backend (multi-instance path). */
export async function resolveBlobRefAsync(ref: BlobRef): Promise<string | null> {
  return getBlob(ref.hash) ?? (await fetchBlobRemote(ref.hash));
}
