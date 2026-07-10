// #SCALE-BLOB — pluggable SHARED blob backend. Local fs stays the hot cache (blob-store.ts);
// when a backend is configured every local write is REPLICATED out (fire-and-forget — content-
// addressed keys make the PUT idempotent) and a local read MISS falls back to the backend. Two
// built-ins, selected by env (S3 wins when both are set), plus a runtime setter for custom impls:
//
//   S3/SigV4 (AWS S3 · Cloudflare R2 · MinIO — hand-rolled signer, no aws-sdk):
//     AGENTIC_BLOB_S3_BUCKET   (required to activate)
//     AGENTIC_BLOB_S3_REGION   (default us-east-1; R2 uses "auto")
//     AGENTIC_BLOB_S3_ENDPOINT (optional, e.g. https://<acct>.r2.cloudflarestorage.com or http://minio:9000
//                               → path-style; unset = AWS virtual-hosted <bucket>.s3.<region>.amazonaws.com)
//     AGENTIC_BLOB_S3_PREFIX   (key prefix, default "blobs/")
//     AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN)
//
//   Plain HTTP (any PUT/GET store behind a bearer token — Supabase storage gateway, nginx+webdav…):
//     AGENTIC_BLOB_HTTP_BASE (+ AGENTIC_BLOB_HTTP_TOKEN)

import { createHash } from "node:crypto";
import { sigV4Sign, amzNow } from "./sigv4";

export interface BlobRemoteBackend {
  /** short id surfaced in /health (e.g. "s3", "http"). */
  name: string;
  put(hash: string, bytes: string, contentType?: string): Promise<void>;
  get(hash: string): Promise<string | null>;
}

export function makeHttpBackend(env: Record<string, string | undefined> = process.env): BlobRemoteBackend | null {
  const base = env.AGENTIC_BLOB_HTTP_BASE?.replace(/\/+$/, "");
  if (!base) return null;
  const headers = (): Record<string, string> => (env.AGENTIC_BLOB_HTTP_TOKEN ? { Authorization: `Bearer ${env.AGENTIC_BLOB_HTTP_TOKEN}` } : {});
  return {
    name: "http",
    async put(hash, bytes, contentType) {
      await fetch(`${base}/${hash}`, { method: "PUT", headers: { ...headers(), "content-type": contentType ?? "application/octet-stream" }, body: bytes });
    },
    async get(hash) {
      const res = await fetch(`${base}/${hash}`, { headers: headers() });
      return res.ok ? res.text() : null;
    },
  };
}

export function makeS3Backend(env: Record<string, string | undefined> = process.env): BlobRemoteBackend | null {
  const bucket = env.AGENTIC_BLOB_S3_BUCKET;
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;
  const region = env.AGENTIC_BLOB_S3_REGION || "us-east-1";
  const sessionToken = env.AWS_SESSION_TOKEN || undefined;
  const prefix = env.AGENTIC_BLOB_S3_PREFIX ?? "blobs/";
  // Custom endpoint (R2/MinIO) → path-style /<bucket>/<key>; plain AWS → virtual-hosted bucket host.
  const endpoint = env.AGENTIC_BLOB_S3_ENDPOINT?.replace(/\/+$/, "");
  const url = (key: string) => (endpoint ? `${endpoint}/${bucket}/${key}` : `https://${bucket}.s3.${region}.amazonaws.com/${key}`);

  const signed = (method: string, key: string, body?: string): { target: string; headers: Record<string, string> } => {
    const target = url(key);
    const u = new URL(target);
    const payloadHash = createHash("sha256").update(body ?? "", "utf8").digest("hex");
    const headers = sigV4Sign({
      method,
      host: u.host,
      path: u.pathname,
      query: "",
      payloadHash,
      region,
      service: "s3",
      accessKeyId,
      secretAccessKey,
      sessionToken,
      amzDate: amzNow(),
    });
    return { target, headers };
  };

  return {
    name: "s3",
    async put(hash, bytes, contentType) {
      const { target, headers } = signed("PUT", `${prefix}${hash}`, bytes);
      await fetch(target, { method: "PUT", headers: { ...headers, "content-type": contentType ?? "application/octet-stream" }, body: bytes });
    },
    async get(hash) {
      const { target, headers } = signed("GET", `${prefix}${hash}`);
      const res = await fetch(target, { headers });
      return res.ok ? res.text() : null;
    },
  };
}

// Selection: manual override (setBlobRemoteBackend) > S3 > HTTP > none. Cached after first resolve
// (env doesn't change mid-process); tests reset via setBlobRemoteBackend(null) + resetBlobBackendCache.
let manual: BlobRemoteBackend | null | undefined; // undefined = no manual override; null = forced OFF
let cached: BlobRemoteBackend | null | undefined;

/** Plug a CUSTOM backend at runtime (or force off with null). Clears the env-derived cache. */
export function setBlobRemoteBackend(backend: BlobRemoteBackend | null | undefined): void {
  manual = backend;
  cached = undefined;
}

export function resetBlobBackendCache(): void {
  cached = undefined;
}

export function activeBlobBackend(env: Record<string, string | undefined> = process.env): BlobRemoteBackend | null {
  if (manual !== undefined) return manual;
  if (cached === undefined) cached = makeS3Backend(env) ?? makeHttpBackend(env);
  return cached;
}

/** For /health: "fs" (local only) or "fs+s3" / "fs+http" / "fs+<custom>". */
export function blobBackendStatus(): string {
  const b = activeBlobBackend();
  return b ? `fs+${b.name}` : "fs";
}
