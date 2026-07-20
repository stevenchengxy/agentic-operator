/**
 * Tenant-owned RAAS remote-resume adapter shared by the HTTP ingress and the
 * zhaopin override of fs.readFromInbox.
 *
 * A bare event delivered by a shared Inngest instance can bypass `/v1/events`,
 * so processResume's first tenant tool must materialize the object itself.
 * Endpoints are read only from trusted environment configuration; event data
 * supplies path parameters but can never choose a host (payload SSRF guard).
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "@agentic/tools/fs";

type JsonRecord = Record<string, unknown>;

const RAAS_TENANT = "zhaopin";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".txt", ".md"]);

export class RemoteResumeError extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "RemoteResumeError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RemoteResumeOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

function field(payload: JsonRecord, name: string): string | null {
  const value = payload[name];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function validateRemoteBucket(bucket: string): void {
  if (
    Buffer.byteLength(bucket, "utf8") < 3 ||
    Buffer.byteLength(bucket, "utf8") > 63 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(bucket) ||
    bucket.includes("..")
  ) {
    throw new RemoteResumeError(
      "invalid_raas_bucket",
      "RESUME_DOWNLOADED bucket is not a safe S3/MinIO bucket name.",
    );
  }
}

export function validateRemoteObjectKey(objectKey: string): void {
  if (
    !objectKey ||
    Buffer.byteLength(objectKey, "utf8") > 1024 ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(objectKey)
  ) {
    throw new RemoteResumeError(
      "invalid_raas_object_key",
      "RESUME_DOWNLOADED object_key is empty, oversized, absolute, or contains unsafe characters.",
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(objectKey);
  } catch {
    throw new RemoteResumeError(
      "invalid_raas_object_key",
      "RESUME_DOWNLOADED object_key contains malformed percent encoding.",
    );
  }
  for (const candidate of [objectKey, decoded]) {
    if (candidate.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new RemoteResumeError(
        "invalid_raas_object_key",
        "RESUME_DOWNLOADED object_key contains an empty or traversal path segment.",
      );
    }
  }
}

function safeFilename(raw: string): string {
  let value = path.basename(raw)
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .replace(/\.\.+/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!value) {
    throw new RemoteResumeError(
      "invalid_raas_filename",
      "RESUME_DOWNLOADED filename cannot be converted to a safe local filename.",
    );
  }
  const ext = path.extname(value).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new RemoteResumeError(
      "unsupported_raas_resume_format",
      `RESUME_DOWNLOADED filename extension '${ext || "(none)"}' is not supported.`,
      422,
    );
  }
  while (Buffer.byteLength(value, "utf8") > 180 && value.length > ext.length + 1) {
    value = `${value.slice(0, -ext.length - 2)}${ext}`;
  }
  return value;
}

function filenameFrom(payload: JsonRecord, objectKey: string): string {
  const explicit = field(payload, "filename");
  if (explicit) return safeFilename(explicit);
  const leaf = objectKey.split("/").at(-1) ?? "";
  try {
    return safeFilename(decodeURIComponent(leaf));
  } catch (error) {
    if (error instanceof RemoteResumeError) throw error;
    return safeFilename(leaf);
  }
}

function enc(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

/** Minimal AWS Signature V4 GET signer for path-style S3/MinIO requests. */
function signMinioGet(input: {
  host: string;
  canonicalPath: string;
  region: string;
  accessKey: string;
  secretKey: string;
}): Record<string, string> {
  const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const emptyHash = sha256("");
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": emptyHash,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [
    "GET",
    input.canonicalPath,
    "",
    canonicalHeaders,
    signedHeaders,
    emptyHash,
  ].join("\n");
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function httpRequest(
  env: Record<string, string | undefined>,
  values: { uploadId: string; bucket: string; objectKey: string },
): { url: URL; headers: Record<string, string>; source: "raas-http" } | null {
  const template = env.RAAS_RESUME_FETCH_URL_TEMPLATE?.trim();
  if (!template) return null;
  const expanded = template
    .replaceAll("{upload_id}", enc(values.uploadId))
    .replaceAll("{bucket}", enc(values.bucket))
    .replaceAll("{object_key}", enc(values.objectKey));
  if (/\{(?:upload_id|bucket|object_key)\}/.test(expanded)) {
    throw new RemoteResumeError(
      "invalid_raas_fetch_config",
      "RAAS_RESUME_FETCH_URL_TEMPLATE contains an unresolved placeholder.",
      503,
    );
  }
  let url: URL;
  try {
    url = new URL(expanded);
  } catch {
    throw new RemoteResumeError(
      "invalid_raas_fetch_config",
      "RAAS_RESUME_FETCH_URL_TEMPLATE is not a valid absolute URL.",
      503,
    );
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new RemoteResumeError(
      "invalid_raas_fetch_config",
      "RAAS resume fetch URL must use http(s) and must not embed credentials.",
      503,
    );
  }
  return {
    url,
    headers: env.RAAS_RESUME_FETCH_TOKEN
      ? { authorization: `Bearer ${env.RAAS_RESUME_FETCH_TOKEN}` }
      : {},
    source: "raas-http",
  };
}

function minioRequest(
  env: Record<string, string | undefined>,
  bucket: string,
  objectKey: string,
): { url: URL; headers: Record<string, string>; source: "minio" } | null {
  const endpointRaw = env.MINIO_ENDPOINT?.trim();
  const accessKey = env.MINIO_ACCESS_KEY?.trim();
  const secretKey = env.MINIO_SECRET_KEY?.trim();
  if (!endpointRaw && !accessKey && !secretKey) return null;
  if (!endpointRaw || !accessKey || !secretKey) {
    throw new RemoteResumeError(
      "invalid_raas_fetch_config",
      "MinIO resume fetch requires MINIO_ENDPOINT, MINIO_ACCESS_KEY, and MINIO_SECRET_KEY.",
      503,
    );
  }
  const rawUrl = /^https?:\/\//i.test(endpointRaw)
    ? endpointRaw
    : `${env.MINIO_USE_SSL === "true" ? "https" : "http"}://${endpointRaw}`;
  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    throw new RemoteResumeError(
      "invalid_raas_fetch_config",
      "MINIO_ENDPOINT is not a valid hostname or URL.",
      503,
    );
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    !["", "/"].includes(endpoint.pathname) ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new RemoteResumeError(
      "invalid_raas_fetch_config",
      "MINIO_ENDPOINT must be an http(s) origin without credentials, path, query, or fragment.",
      503,
    );
  }
  if (!endpoint.port && env.MINIO_PORT) {
    const port = Number(env.MINIO_PORT);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new RemoteResumeError(
        "invalid_raas_fetch_config",
        "MINIO_PORT must be an integer between 1 and 65535.",
        503,
      );
    }
    endpoint.port = String(port);
  }
  const canonicalPath = `/${enc(bucket)}/${objectKey.split("/").map(enc).join("/")}`;
  const url = new URL(canonicalPath, endpoint.origin);
  return {
    url,
    headers: signMinioGet({
      host: url.host,
      canonicalPath,
      region: env.MINIO_REGION?.trim() || "us-east-1",
      accessKey,
      secretKey,
    }),
    source: "minio",
  };
}

async function boundedBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new RemoteResumeError(
      "raas_resume_too_large",
      `RAAS resume is ${advertised} bytes; maximum is ${maxBytes}.`,
      413,
    );
  }
  if (!response.body) {
    throw new RemoteResumeError("raas_resume_empty", "RAAS resume fetch returned no body.", 502);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RemoteResumeError(
        "raas_resume_too_large",
        `RAAS resume exceeded the ${maxBytes}-byte limit while downloading.`,
        413,
      );
    }
    chunks.push(next.value);
  }
  if (total === 0) {
    throw new RemoteResumeError("raas_resume_empty", "RAAS resume fetch returned an empty file.", 502);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

async function download(
  payload: JsonRecord,
  options: RemoteResumeOptions,
): Promise<{ bytes: Buffer; source: "raas-http" | "minio" }> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const uploadId = field(payload, "upload_id")!;
  const bucket = field(payload, "bucket")!;
  const objectKey = field(payload, "object_key")!;
  const request =
    httpRequest(env, { uploadId, bucket, objectKey }) ?? minioRequest(env, bucket, objectKey);
  if (!request) {
    throw new RemoteResumeError(
      "raas_resume_fetch_not_configured",
      "Remote RESUME_DOWNLOADED has no fetch transport. Set RAAS_RESUME_FETCH_URL_TEMPLATE or MINIO_*.",
      503,
    );
  }
  const timeoutMs = positiveInt(env.RAAS_RESUME_FETCH_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new RemoteResumeError(
        "raas_resume_fetch_failed",
        `RAAS resume fetch failed (${request.source}) with HTTP ${response.status}.`,
        response.status === 404 ? 422 : 502,
      );
    }
    // Keep the abort timer alive until the complete body has been consumed.
    // `fetch()` resolves as soon as headers arrive; clearing it there lets a
    // peer stall the stream forever after returning HTTP 200.
    const bytes = await boundedBytes(
      response,
      positiveInt(env.RAAS_RESUME_MAX_BYTES, DEFAULT_MAX_BYTES),
    );
    return { bytes, source: request.source };
  } catch (error) {
    if (error instanceof RemoteResumeError) throw error;
    const detail = controller.signal.aborted
      ? `timed out after ${timeoutMs}ms`
      : error instanceof Error
        ? error.message
        : String(error);
    throw new RemoteResumeError(
      "raas_resume_fetch_failed",
      `RAAS resume fetch failed (${request.source}): ${detail}`,
      502,
    );
  } finally {
    clearTimeout(timer);
  }
}

function outputPayload(
  payload: JsonRecord,
  localFilename: string,
  originalFilename: string,
  bytes: Buffer,
  source: "raas-http" | "minio" | "cache",
): JsonRecord {
  const meta =
    payload.__raas && typeof payload.__raas === "object" && !Array.isArray(payload.__raas)
      ? (payload.__raas as JsonRecord)
      : {};
  return {
    ...payload,
    original_filename: payload.original_filename ?? originalFilename,
    filename: localFilename,
    resume_filename: localFilename,
    resume_file_path: localFilename,
    __raas: {
      ...meta,
      resume_materialization: {
        source,
        local_filename: localFilename,
        original_filename: originalFilename,
        bytes: bytes.length,
        sha256: sha256(bytes),
      },
    },
  };
}

/**
 * Fetch a zhaopin RAAS object into `data/resumes/zhaopin/inbox` exactly once.
 * Payloads without bucket/object_key remain ordinary local-inbox events.
 */
export async function materializeRemoteResume(
  tenantSlug: string,
  payload: JsonRecord,
  options: RemoteResumeOptions = {},
): Promise<JsonRecord> {
  if (tenantSlug !== RAAS_TENANT) return payload;
  const uploadId = field(payload, "upload_id") ?? field(payload, "uploadId");
  const bucket = field(payload, "bucket");
  const objectKey = field(payload, "object_key") ?? field(payload, "objectKey");
  if (!bucket && !objectKey) return payload;
  if (!uploadId || !bucket || !objectKey) {
    throw new RemoteResumeError(
      "invalid_raas_resume_transport",
      "Legacy RESUME_DOWNLOADED requires non-empty upload_id, bucket, and object_key.",
    );
  }
  validateRemoteBucket(bucket);
  validateRemoteObjectKey(objectKey);
  const normalized = {
    ...payload,
    upload_id: uploadId,
    uploadId,
    bucket,
    object_key: objectKey,
    objectKey,
  };
  const original = filenameFrom(normalized, objectKey);
  const identity = `${uploadId}\n${bucket}\n${objectKey}\n${field(payload, "etag") ?? ""}`;
  const prefix = sha256(identity).slice(0, 16);
  const localFilename = `${prefix}-${original}`;
  const env = options.env ?? process.env;
  const inbox = path.resolve(resolveDataRoot(env), "resumes", RAAS_TENANT, "inbox");
  fs.mkdirSync(inbox, { recursive: true });
  const target = path.resolve(inbox, localFilename);
  if (!target.startsWith(`${inbox}${path.sep}`)) {
    throw new RemoteResumeError("invalid_raas_filename", "Resume path escaped the tenant inbox.");
  }

  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new RemoteResumeError(
        "unsafe_raas_resume_target",
        "Existing resume target is not a regular file.",
        409,
      );
    }
    const maxBytes = positiveInt(env.RAAS_RESUME_MAX_BYTES, DEFAULT_MAX_BYTES);
    if (stat.size === 0) {
      throw new RemoteResumeError(
        "raas_resume_empty",
        "Cached RAAS resume is empty.",
        409,
      );
    }
    if (stat.size > maxBytes) {
      throw new RemoteResumeError(
        "raas_resume_too_large",
        `Cached RAAS resume is ${stat.size} bytes; maximum is ${maxBytes}.`,
        413,
      );
    }
    return outputPayload(normalized, localFilename, original, fs.readFileSync(target), "cache");
  } catch (error) {
    if (error instanceof RemoteResumeError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const fetched = await download(normalized, options);
  const temp = path.join(inbox, `.${prefix}-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, fetched.bytes, { flag: "wx", mode: 0o600 });
    try {
      fs.linkSync(temp, target); // atomic, no overwrite
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!fs.readFileSync(target).equals(fetched.bytes)) {
        throw new RemoteResumeError(
          "raas_resume_conflict",
          "A different file exists for the same RAAS upload identity.",
          409,
        );
      }
    }
  } finally {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* best-effort */
    }
  }
  return outputPayload(normalized, localFilename, original, fetched.bytes, fetched.source);
}
