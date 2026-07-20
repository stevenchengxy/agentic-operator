// #SCALE-BLOB — pluggable SHARED blob backend. Local fs stays the hot cache (blob-store.ts);
// when a backend is configured every local write is REPLICATED out asynchronously (content-
// addressed keys make the PUT idempotent) and a local read MISS falls back to the backend. Two
// built-ins, selected by an unambiguous env configuration, plus a runtime setter for custom impls:
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

export class BlobBackendConfigurationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid shared blob backend configuration: ${issues.join("; ")}`);
    this.name = "BlobBackendConfigurationError";
    this.issues = issues;
  }
}

export class BlobBackendRequestError extends Error {
  readonly backend: string;
  readonly operation: "PUT" | "GET";
  readonly status: number;

  constructor(backend: string, operation: "PUT" | "GET", status: number, detail?: string) {
    super(
      `${backend} blob ${operation} failed with HTTP ${status}${detail ? `: ${detail}` : ""}`,
    );
    this.name = "BlobBackendRequestError";
    this.backend = backend;
    this.operation = operation;
    this.status = status;
  }
}

export class ConfiguredBlobBackendUnavailableError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      `Configured shared blob backend is unavailable: ${String(
        (cause as { message?: unknown } | null)?.message ?? cause,
      ).slice(0, 240)}`,
    );
    this.name = "ConfiguredBlobBackendUnavailableError";
    this.cause = cause;
  }
}

export interface BlobBackendHealth {
  configured: boolean;
  ok: boolean;
  driver: string;
  note?: string;
}

const present = (env: Record<string, string | undefined>, key: string): boolean =>
  (env[key]?.trim().length ?? 0) > 0;

/** Validate intent separately from construction. Before this gate, a typo such as a bucket with
 * no credentials silently selected local fs, creating a split-brain deployment. */
export function validateBlobBackendConfiguration(
  env: Record<string, string | undefined> = process.env,
): { configured: boolean; kind: "s3" | "http" | null } {
  const s3Intent = [
    "AGENTIC_BLOB_S3_BUCKET",
    "AGENTIC_BLOB_S3_REGION",
    "AGENTIC_BLOB_S3_ENDPOINT",
    "AGENTIC_BLOB_S3_PREFIX",
  ].some((key) => present(env, key));
  const httpIntent = ["AGENTIC_BLOB_HTTP_BASE", "AGENTIC_BLOB_HTTP_TOKEN"].some((key) =>
    present(env, key),
  );
  const issues: string[] = [];

  if (s3Intent && httpIntent) {
    issues.push("S3 and HTTP blob backends are both configured; choose exactly one");
  }
  if (s3Intent) {
    if (!present(env, "AGENTIC_BLOB_S3_BUCKET")) issues.push("AGENTIC_BLOB_S3_BUCKET is required");
    if (!present(env, "AWS_ACCESS_KEY_ID")) issues.push("AWS_ACCESS_KEY_ID is required for the S3 blob backend");
    if (!present(env, "AWS_SECRET_ACCESS_KEY")) issues.push("AWS_SECRET_ACCESS_KEY is required for the S3 blob backend");
    const endpoint = env.AGENTIC_BLOB_S3_ENDPOINT?.trim();
    if (endpoint) {
      try {
        const parsed = new URL(endpoint);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
      } catch {
        issues.push("AGENTIC_BLOB_S3_ENDPOINT must be an absolute http(s) URL");
      }
    }
  }
  if (httpIntent) {
    const base = env.AGENTIC_BLOB_HTTP_BASE?.trim();
    if (!base) {
      issues.push("AGENTIC_BLOB_HTTP_BASE is required when AGENTIC_BLOB_HTTP_TOKEN is set");
    } else {
      try {
        const parsed = new URL(base);
        if (!/^https?:$/.test(parsed.protocol)) throw new Error("unsupported protocol");
      } catch {
        issues.push("AGENTIC_BLOB_HTTP_BASE must be an absolute http(s) URL");
      }
    }
  }
  if (issues.length > 0) throw new BlobBackendConfigurationError(issues);
  return { configured: s3Intent || httpIntent, kind: s3Intent ? "s3" : httpIntent ? "http" : null };
}

function timeoutSignal(env: Record<string, string | undefined>): AbortSignal {
  const raw = Number(env.AGENTIC_BLOB_TIMEOUT_MS ?? 3_000);
  const ms = Number.isFinite(raw) && raw > 0 ? raw : 3_000;
  return AbortSignal.timeout(ms);
}

async function responseFailureDetail(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 160) : res.statusText || undefined;
  } catch {
    return res.statusText || undefined;
  }
}

export function makeHttpBackend(env: Record<string, string | undefined> = process.env): BlobRemoteBackend | null {
  const base = env.AGENTIC_BLOB_HTTP_BASE?.replace(/\/+$/, "");
  if (!base) return null;
  const headers = (): Record<string, string> => (env.AGENTIC_BLOB_HTTP_TOKEN ? { Authorization: `Bearer ${env.AGENTIC_BLOB_HTTP_TOKEN}` } : {});
  return {
    name: "http",
    async put(hash, bytes, contentType) {
      const res = await fetch(`${base}/${hash}`, { method: "PUT", headers: { ...headers(), "content-type": contentType ?? "application/octet-stream" }, body: bytes, signal: timeoutSignal(env) });
      if (!res.ok) throw new BlobBackendRequestError("http", "PUT", res.status, await responseFailureDetail(res));
    },
    async get(hash) {
      const res = await fetch(`${base}/${hash}`, { headers: headers(), signal: timeoutSignal(env) });
      if (res.status === 404) return null;
      if (!res.ok) throw new BlobBackendRequestError("http", "GET", res.status, await responseFailureDetail(res));
      return res.text();
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
      const res = await fetch(target, { method: "PUT", headers: { ...headers, "content-type": contentType ?? "application/octet-stream" }, body: bytes, signal: timeoutSignal(env) });
      if (!res.ok) throw new BlobBackendRequestError("s3", "PUT", res.status, await responseFailureDetail(res));
    },
    async get(hash) {
      const { target, headers } = signed("GET", `${prefix}${hash}`);
      const res = await fetch(target, { headers, signal: timeoutSignal(env) });
      if (res.status === 404) return null;
      if (!res.ok) throw new BlobBackendRequestError("s3", "GET", res.status, await responseFailureDetail(res));
      return res.text();
    },
  };
}

// Selection: manual override (setBlobRemoteBackend) > one validated env backend > none. Cached after first resolve
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
  const config = validateBlobBackendConfiguration(env);
  if (manual !== undefined) return manual;
  if (cached === undefined) {
    cached = config.kind === "s3" ? makeS3Backend(env) : config.kind === "http" ? makeHttpBackend(env) : null;
    if (config.configured && !cached) {
      throw new BlobBackendConfigurationError([`${config.kind ?? "configured"} backend could not be constructed`]);
    }
  }
  return cached;
}

/** For /health: "fs" (local only) or "fs+s3" / "fs+http" / "fs+<custom>". */
export function blobBackendStatus(): string {
  const b = activeBlobBackend();
  return b ? `fs+${b.name}` : "fs";
}

const PROBE_BYTES = "agentic-operator-shared-blob-readiness-v1";
const PROBE_HASH = createHash("sha256").update(PROBE_BYTES, "utf8").digest("hex");

/** Real read/write readiness check. The fixed content-addressed object makes repeated health probes
 * idempotent and verifies permissions, routing, response handling, and read-after-write semantics. */
export async function blobBackendHealth(
  env: Record<string, string | undefined> = process.env,
): Promise<BlobBackendHealth> {
  try {
    const config = validateBlobBackendConfiguration(env);
    const backend = activeBlobBackend(env);
    if (!backend) {
      if (config.configured) {
        return { configured: true, ok: false, driver: "unavailable", note: "configured backend is not active" };
      }
      return { configured: false, ok: true, driver: "fs" };
    }
    await backend.put(PROBE_HASH, PROBE_BYTES, "text/plain");
    const received = await backend.get(PROBE_HASH);
    if (received !== PROBE_BYTES) {
      throw new Error(received == null ? "readiness object was not readable after PUT" : "readiness object content mismatch");
    }
    return { configured: config.configured || manual !== undefined, ok: true, driver: `fs+${backend.name}` };
  } catch (err) {
    return {
      configured: true,
      ok: false,
      driver: (() => {
        try { return blobBackendStatus(); } catch { return "invalid"; }
      })(),
      note: String((err as { message?: unknown } | null)?.message ?? err).slice(0, 240),
    };
  }
}

/** Startup gate for a configured backend. Local fs remains a valid unconfigured deployment. */
export async function assertConfiguredBlobBackendReady(
  env: Record<string, string | undefined> = process.env,
): Promise<BlobBackendHealth> {
  // Throw the richer configuration error directly instead of reducing it to an availability note.
  const config = validateBlobBackendConfiguration(env);
  const health = await blobBackendHealth(env);
  if ((config.configured || manual !== undefined) && !health.ok) {
    throw new ConfiguredBlobBackendUnavailableError(health.note ?? "read/write probe failed");
  }
  return health;
}
