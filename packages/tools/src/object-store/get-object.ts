/**
 * objectStore.getObject — bounded S3/MinIO object reader.
 *
 * The LLM may supply only a bucket and object key. Endpoint and credentials
 * are server-owned configuration: the endpoint is taken from trusted manifest
 * config (or an env reference in that config), and every credential is read
 * through an env reference. Requests are signed with AWS Signature V4.
 */

import { createHash, createHmac } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";
import {
  readEnvironmentReference,
  readOptionalEnvironmentReference,
} from "../config/env-ref";

type JsonRecord = Record<string, unknown>;

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 100 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;

export class ObjectStoreError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ObjectStoreError";
    this.code = code;
  }
}

export interface ObjectStoreGetObjectOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new ObjectStoreError(
      "invalid_object_store_config",
      `objectStore.getObject configuration must be an integer between 1 and ${maximum}.`,
    );
  }
  return value as number;
}

export function validateObjectStoreBucket(bucket: string): void {
  const bytes = Buffer.byteLength(bucket, "utf8");
  if (
    bytes < 3 ||
    bytes > 63 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(bucket) ||
    bucket.includes("..") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(bucket)
  ) {
    throw new ObjectStoreError(
      "invalid_bucket",
      "objectStore.getObject bucket is not a safe S3/MinIO bucket name.",
    );
  }
}

export function validateObjectStoreKey(objectKey: string): void {
  if (
    !objectKey ||
    Buffer.byteLength(objectKey, "utf8") > 1024 ||
    objectKey.startsWith("/") ||
    objectKey.endsWith("/") ||
    objectKey.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(objectKey)
  ) {
    throw new ObjectStoreError(
      "invalid_object_key",
      "objectStore.getObject object_key is empty, oversized, absolute, directory-like, or contains unsafe characters.",
    );
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(objectKey);
  } catch {
    throw new ObjectStoreError(
      "invalid_object_key",
      "objectStore.getObject object_key contains malformed percent encoding.",
    );
  }
  for (const candidate of [objectKey, decoded]) {
    if (
      candidate
        .split("/")
        .some(
          (segment) => segment === "" || segment === "." || segment === "..",
        )
    ) {
      throw new ObjectStoreError(
        "invalid_object_key",
        "objectStore.getObject object_key contains an empty or traversal path segment.",
      );
    }
  }
}

function encodePathPart(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

export function signObjectStoreGet(input: {
  host: string;
  canonicalPath: string;
  region: string;
  accessKey: string;
  secretKey: string;
  sessionToken?: string;
  now: Date;
}): Record<string, string> {
  const amzDate = input.now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const date = amzDate.slice(0, 8);
  const emptyHash = digest("");
  const headers: Record<string, string> = {
    host: input.host,
    "x-amz-content-sha256": emptyHash,
    "x-amz-date": amzDate,
  };
  if (input.sessionToken) headers["x-amz-security-token"] = input.sessionToken;
  const headerNames = Object.keys(headers).sort();
  const canonicalHeaders = headerNames
    .map((name) => `${name}:${headers[name]!.trim()}\n`)
    .join("");
  const signedHeaders = headerNames.join(";");
  const canonicalRequest = [
    "GET",
    input.canonicalPath,
    "",
    canonicalHeaders,
    signedHeaders,
    emptyHash,
  ].join("\n");
  const scope = `${date}/${input.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    digest(canonicalRequest),
  ].join("\n");
  const kDate = hmac(`AWS4${input.secretKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, "s3");
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");
  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function trustedEndpoint(
  config: JsonRecord,
  env: Record<string, string | undefined>,
): URL {
  const literal = stringField(config.endpoint);
  const reference = stringField(config.endpoint_env);
  if ((literal && reference) || (!literal && !reference)) {
    throw new ObjectStoreError(
      "invalid_object_store_config",
      "objectStore.getObject requires exactly one trusted config field: endpoint or endpoint_env.",
    );
  }
  const raw = reference
    ? readEnvironmentReference(
        env,
        reference,
        "objectStore.getObject config.endpoint_env",
      )
    : literal!;
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new ObjectStoreError(
      "invalid_object_store_config",
      "objectStore.getObject endpoint is not a valid absolute URL.",
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
    throw new ObjectStoreError(
      "invalid_object_store_config",
      "objectStore.getObject endpoint must be an http(s) origin without credentials, path, query, or fragment.",
    );
  }
  return endpoint;
}

function objectRequest(
  args: JsonRecord,
  config: JsonRecord,
  options: Required<Pick<ObjectStoreGetObjectOptions, "env" | "now">>,
): {
  url: URL;
  headers: Record<string, string>;
  bucket: string;
  objectKey: string;
} {
  for (const forbidden of [
    "endpoint",
    "endpoint_url",
    "host",
    "url",
    "access_key",
    "secret_key",
    "token",
  ]) {
    if (forbidden in args) {
      throw new ObjectStoreError(
        "untrusted_object_store_parameter",
        `objectStore.getObject does not accept '${forbidden}' from tool-call input.`,
      );
    }
  }
  const bucket =
    stringField(args.bucket) ?? stringField(config.default_bucket) ?? "";
  const objectKey =
    stringField(args.object_key) ?? stringField(args.objectKey) ?? "";
  validateObjectStoreBucket(bucket);
  validateObjectStoreKey(objectKey);

  const allowedBuckets = Array.isArray(config.allowed_buckets)
    ? config.allowed_buckets
        .map(stringField)
        .filter((value): value is string => Boolean(value))
    : [];
  if (allowedBuckets.length > 0 && !allowedBuckets.includes(bucket)) {
    throw new ObjectStoreError(
      "bucket_not_allowed",
      "objectStore.getObject bucket is outside config.allowed_buckets.",
    );
  }
  const fixedBucket = stringField(config.default_bucket);
  if (fixedBucket && allowedBuckets.length === 0 && bucket !== fixedBucket) {
    throw new ObjectStoreError(
      "bucket_not_allowed",
      "objectStore.getObject cannot override config.default_bucket unless allowed_buckets is configured.",
    );
  }

  const endpoint = trustedEndpoint(config, options.env);
  const canonicalObjectPath = objectKey
    .split("/")
    .map(encodePathPart)
    .join("/");
  const pathStyle = config.force_path_style !== false;
  const url = new URL(endpoint.origin);
  let canonicalPath: string;
  if (pathStyle) {
    canonicalPath = `/${encodePathPart(bucket)}/${canonicalObjectPath}`;
    url.pathname = canonicalPath;
  } else {
    url.hostname = `${bucket}.${endpoint.hostname}`;
    canonicalPath = `/${canonicalObjectPath}`;
    url.pathname = canonicalPath;
  }

  const auth = stringField(config.auth) ?? "sigv4";
  if (auth === "anonymous") return { url, headers: {}, bucket, objectKey };
  if (auth !== "sigv4") {
    throw new ObjectStoreError(
      "invalid_object_store_config",
      "objectStore.getObject config.auth must be 'sigv4' or 'anonymous'.",
    );
  }
  const accessKey = readEnvironmentReference(
    options.env,
    config.access_key_env,
    "objectStore.getObject config.access_key_env",
  );
  const secretKey = readEnvironmentReference(
    options.env,
    config.secret_key_env,
    "objectStore.getObject config.secret_key_env",
  );
  const sessionToken = readOptionalEnvironmentReference(
    options.env,
    config.session_token_env,
    "objectStore.getObject config.session_token_env",
  );
  return {
    url,
    headers: signObjectStoreGet({
      host: url.host,
      canonicalPath,
      region: stringField(config.region) ?? "us-east-1",
      accessKey,
      secretKey,
      sessionToken,
      now: options.now(),
    }),
    bucket,
    objectKey,
  };
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw new ObjectStoreError(
      "object_too_large",
      `objectStore.getObject object exceeds the configured ${maxBytes}-byte limit.`,
    );
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    total += chunk.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ObjectStoreError(
        "object_too_large",
        `objectStore.getObject object exceeded the configured ${maxBytes}-byte limit while downloading.`,
      );
    }
    chunks.push(Buffer.from(chunk.value));
  }
  return Buffer.concat(chunks, total);
}

function fallbackMime(objectKey: string): string {
  switch (path.extname(objectKey).toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".doc":
      return "application/msword";
    case ".json":
      return "application/json";
    case ".csv":
      return "text/csv";
    case ".txt":
    case ".md":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

export async function getObjectFromStore(
  args: JsonRecord,
  config: JsonRecord,
  options: ObjectStoreGetObjectOptions = {},
): Promise<{
  bucket: string;
  object_key: string;
  filename: string;
  mime: string;
  base64: string;
  sha256: string;
  bytes: number;
  etag: string | null;
  last_modified: string | null;
}> {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const maxBytes = positiveInteger(
    config.max_bytes,
    DEFAULT_MAX_BYTES,
    ABSOLUTE_MAX_BYTES,
  );
  const timeoutMs = positiveInteger(
    config.timeout_ms,
    DEFAULT_TIMEOUT_MS,
    120_000,
  );
  const request = objectRequest(args, config, { env, now });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(request.url, {
      method: "GET",
      headers: request.headers,
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ObjectStoreError(
        "object_store_redirect_rejected",
        "objectStore.getObject rejected an object-store redirect; configure the final trusted endpoint.",
      );
    }
    if (!response.ok) {
      throw new ObjectStoreError(
        "object_store_http_error",
        `objectStore.getObject failed with HTTP ${response.status}.`,
      );
    }
    const bytes = await readBoundedBody(response, maxBytes);
    const headerMime = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim();
    const leaf = request.objectKey.split("/").at(-1) ?? request.objectKey;
    let filename: string;
    try {
      filename = decodeURIComponent(leaf);
    } catch {
      filename = leaf;
    }
    return {
      bucket: request.bucket,
      object_key: request.objectKey,
      filename,
      mime: headerMime || fallbackMime(request.objectKey),
      base64: bytes.toString("base64"),
      sha256: digest(bytes),
      bytes: bytes.length,
      etag: response.headers.get("etag"),
      last_modified: response.headers.get("last-modified"),
    };
  } catch (error) {
    if (error instanceof ObjectStoreError) throw error;
    throw new ObjectStoreError(
      "object_store_fetch_failed",
      controller.signal.aborted
        ? `objectStore.getObject transport timed out after ${timeoutMs}ms.`
        : "objectStore.getObject transport failed.",
    );
  } finally {
    clearTimeout(timer);
  }
}

export const objectStoreGetObject = defineTool({
  name: "objectStore.getObject",
  description:
    "Read one bounded S3/MinIO object using a trusted configured endpoint and env-referenced credentials. " +
    "Tool input may contain only bucket/object_key; host and credentials can never come from the LLM.",
  output: z.object({
    bucket: z.string(),
    object_key: z.string(),
    filename: z.string(),
    mime: z.string(),
    base64: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    etag: z.string().nullable(),
    last_modified: z.string().nullable(),
  }),
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as JsonRecord;
    const config = (ctx.config ?? {}) as JsonRecord;
    return {
      data: await getObjectFromStore(args, config),
      meta: { transport: "s3-sigv4-or-anonymous", bounded: true },
    };
  },
});
