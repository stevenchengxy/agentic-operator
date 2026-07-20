// Phase 2 Tier A — the EXECUTOR for brain-authored declarative HTTP tools. The factory's
// create_tool persists a factory_tools row (name / method / urlTemplate / headers / bodyTemplate /
// returnsSchema); DrizzleToolStore loads it; this turns each row into a runtime-invocable,
// SSRF-guarded ToolDescriptor. Folding the result into the runtime resolution chain (per-tenant
// overlay) is what finally lets a deployed agent CALL a tool the brain declared — closing the
// "can declare but never invoke" gap. No eval: only string-template interpolation + guarded fetch.

import { defineTool } from "@agentic/agent-kit";
import type { ToolContext, ToolDescriptor } from "@agentic/agent-kit";
import { safeFetch } from "./ssrf";
import { validateToolSchema } from "./schema-validation";
import {
  isToolExecutionPolicy,
  type ToolEffectScope,
  type ToolOperation,
  type ToolSandboxPolicy,
} from "../registry";

/** Structural shape of a persisted declarative tool (matches agent-factory's DeclarativeTool /
 *  the factory_tools row — kept local so packages/tools needs no cross-package type import). */
export interface DeclarativeToolDef {
  name: string;
  description?: string;
  method: string;
  urlTemplate: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
  requestSpec?: DeclarativeRequestSpec;
  responseSpec?: DeclarativeResponseSpec;
  examples?: DeclarativeExchangeExample[];
  sideEffect?: string;
  operation?: ToolOperation;
  effectScope?: ToolEffectScope;
  sandboxPolicy?: ToolSandboxPolicy;
  paramsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
}

export interface DeclarativeMultipartFileSpec {
  field: string;
  base64Path: string;
  filename?: string;
  filenamePath?: string;
  mime?: string;
  mimePath?: string;
  required?: boolean;
}

export interface DeclarativeRequestSpec {
  encoding: "json" | "multipart";
  bodyPath?: string;
  fields?: Record<string, string>;
  files?: DeclarativeMultipartFileSpec[];
  maxBytes?: number;
}

export interface DeclarativeResponseAssertion {
  path: string;
  op: "exists" | "non_empty" | "eq" | "neq" | "in" | "not_in";
  value?: unknown;
  values?: unknown[];
  failure: "retryable" | "terminal";
  code: string;
  message?: string;
}

export interface DeclarativeResponseSpec {
  unwrapPath?: string;
  mappings?: Record<string, string>;
  assertions?: DeclarativeResponseAssertion[];
}

export interface DeclarativeExchangeExample {
  request: Record<string, unknown>;
  response: unknown;
  note?: string;
  source?: "human" | "probe" | "documentation";
}

export interface DeclarativeObservedExchange {
  request: { method: string; url: string; body: unknown };
  response: { status: number; body: unknown };
}

function readPath(obj: unknown, path: string): unknown {
  const normalized = path.replace(/^\$\.?/, "");
  if (obj == null || !normalized) return normalized ? undefined : obj;
  let cur: unknown = obj;
  for (const part of normalized.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** Replace {dotted.path} tokens from a scope. URL substitutions are URL-encoded; header/body are not. */
function fillTemplate(tpl: string, scope: Record<string, unknown>, encode: boolean): string {
  return tpl.replace(/\{([\w.]+)\}/g, (_m, key: string) => {
    const v = readPath(scope, key);
    if (v == null) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return encode ? encodeURIComponent(s) : s;
  });
}

export type DeclarativeToolFailureKind =
  | "network"
  | "http_4xx"
  | "rate_limit"
  | "http_5xx"
  | "empty_200"
  | "invalid_json"
  | "schema_mismatch"
  | "response_assertion";

export class DeclarativeToolExecutionError extends Error {
  readonly retryable: boolean;
  readonly terminal: boolean;
  readonly code: string;

  constructor(
    public readonly kind: DeclarativeToolFailureKind,
    message: string,
    public readonly status?: number,
    opts: { retryable?: boolean; code?: string } = {},
  ) {
    super(`${kind}: ${message}`);
    this.name = "DeclarativeToolExecutionError";
    this.retryable = opts.retryable ?? new Set<DeclarativeToolFailureKind>(["network", "rate_limit", "http_5xx", "empty_200", "invalid_json"]).has(kind);
    this.terminal = !this.retryable;
    this.code = opts.code ?? kind;
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:api[_-]?key|token|authorization|secret|password)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, "$1[REDACTED]");
}

function schemaSummary(issues: ReturnType<typeof validateToolSchema>): string {
  return issues.slice(0, 5).map((issue) => `${issue.path}: ${issue.expected} (got ${issue.actual})`).join("; ");
}

export interface MakeDeclarativeToolOpts {
  /** Inject a fetch implementation (tests / cassette replay). Defaults to global fetch via safeFetch. */
  fetchFn?: typeof fetch;
  /** Probe-only observation hook. Callers must redact before persistence. */
  onExchange?: (exchange: DeclarativeObservedExchange) => void;
}

/** Resolve non-secret `*_env` references at the last possible moment. The
 * persisted manifest contains only an environment variable NAME; the secret is
 * never copied into the tool definition, cassette, transcript, or error text. */
export function resolveDeclarativeToolConfig(
  config: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
): { resolved: Record<string, unknown>; missingEnv: string[] } {
  const resolved = { ...config };
  const missingEnv: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (!/_env$/i.test(key) || typeof value !== "string" || !value.trim()) continue;
    const envName = value.trim();
    const secret = env[envName];
    if (typeof secret === "string" && secret.length > 0) {
      const target = key.replace(/_env$/i, "");
      if (!(target in resolved)) resolved[target] = secret;
    } else {
      missingEnv.push(envName);
    }
  }
  return { resolved, missingEnv: [...new Set(missingEnv)] };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function strictBase64(value: unknown, label: string, maxBytes: number): Uint8Array {
  if (typeof value !== "string" || !value.length || value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new DeclarativeToolExecutionError("schema_mismatch", `${label} must be canonical padded base64`);
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new DeclarativeToolExecutionError("schema_mismatch", `${label} is not canonical base64`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new DeclarativeToolExecutionError("schema_mismatch", `${label} exceeds ${maxBytes} bytes`);
  }
  return new Uint8Array(bytes);
}

function equalValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length > 0;
  return true;
}

function assertionPass(value: unknown, assertion: DeclarativeResponseAssertion): boolean {
  const values = assertion.values ?? (Array.isArray(assertion.value) ? assertion.value : []);
  switch (assertion.op) {
    case "exists": return value !== undefined;
    case "non_empty": return isNonEmpty(value);
    case "eq": return equalValue(value, assertion.value);
    case "neq": return !equalValue(value, assertion.value);
    case "in": return values.some((candidate) => equalValue(value, candidate));
    case "not_in": return !values.some((candidate) => equalValue(value, candidate));
  }
}

function applyResponseSpec(raw: unknown, spec: DeclarativeResponseSpec | undefined): unknown {
  if (!spec) return raw;
  for (const assertion of spec.assertions ?? []) {
    const value = readPath(raw, assertion.path);
    if (assertionPass(value, assertion)) continue;
    const retryable = assertion.failure === "retryable";
    throw new DeclarativeToolExecutionError(
      "response_assertion",
      assertion.message ?? `response assertion ${assertion.path} ${assertion.op} failed`,
      retryable ? 502 : 422,
      { retryable, code: assertion.code },
    );
  }
  if (spec.mappings && Object.keys(spec.mappings).length > 0) {
    return Object.fromEntries(
      Object.entries(spec.mappings).map(([field, path]) => [field, readPath(raw, path)]),
    );
  }
  return spec.unwrapPath ? readPath(raw, spec.unwrapPath) : raw;
}

function buildRequestBody(
  def: DeclarativeToolDef,
  method: string,
  scope: Record<string, unknown>,
  args: Record<string, unknown>,
  config: Record<string, unknown>,
): { body?: BodyInit; preview: unknown; multipart: boolean } {
  if (method === "GET" || method === "HEAD") return { preview: null, multipart: false };
  const request = def.requestSpec;
  if (request?.encoding === "multipart") {
    const form = new FormData();
    const preview: Record<string, unknown> = { fields: {}, files: [] };
    for (const [field, template] of Object.entries(request.fields ?? {})) {
      const value = fillTemplate(template, scope, false);
      form.append(field, value);
      (preview.fields as Record<string, unknown>)[field] = value;
    }
    const configuredMax = typeof config.max_upload_bytes === "number" && Number.isFinite(config.max_upload_bytes)
      ? Math.max(1, Math.floor(config.max_upload_bytes))
      : undefined;
    const maxBytes = Math.min(request.maxBytes ?? 10 * 1024 * 1024, configuredMax ?? Number.MAX_SAFE_INTEGER);
    for (const file of request.files ?? []) {
      const encoded = readPath(scope, file.base64Path);
      if ((encoded === undefined || encoded === null || encoded === "") && file.required !== true) continue;
      const bytes = strictBase64(encoded, file.base64Path, maxBytes);
      const filenameValue = file.filenamePath ? readPath(scope, file.filenamePath) : undefined;
      const mimeValue = file.mimePath ? readPath(scope, file.mimePath) : undefined;
      const filename = typeof filenameValue === "string" && filenameValue.trim()
        ? filenameValue.trim()
        : file.filename?.trim() || "upload.bin";
      const mime = typeof mimeValue === "string" && mimeValue.trim()
        ? mimeValue.trim()
        : file.mime?.trim() || "application/octet-stream";
      const blobBytes = new Uint8Array(bytes.byteLength);
      blobBytes.set(bytes);
      form.append(file.field, new Blob([blobBytes.buffer as ArrayBuffer], { type: mime }), filename);
      (preview.files as unknown[]).push({ field: file.field, filename, mime, bytes: bytes.byteLength });
    }
    return { body: form, preview, multipart: true };
  }
  if (def.bodyTemplate) {
    const body = fillTemplate(def.bodyTemplate, scope, false);
    return { body, preview: body, multipart: false };
  }
  if (request?.encoding === "json") {
    const value = request.bodyPath ? readPath(scope, request.bodyPath) : args;
    if (value === undefined) {
      throw new DeclarativeToolExecutionError("schema_mismatch", `request body path ${request.bodyPath} is missing`);
    }
    const body = JSON.stringify(value);
    return { body, preview: value, multipart: false };
  }
  return { preview: null, multipart: false };
}

/** Build a runtime ToolDescriptor from a declarative tool definition. The handler reads the
 *  LLM-supplied args from ctx.event.data (the runtime overrides `event` with the tool-call input
 *  at dispatch), merges ctx.config (per-tenant creds/paths), fills the templates, calls the
 *  SSRF-guarded fetch, and validates required return fields. Throws on failure so the runtime
 *  surfaces tool_result:is_error and the LLM can self-correct. */
export function makeDeclarativeTool(def: DeclarativeToolDef, opts?: MakeDeclarativeToolOpts): ToolDescriptor {
  if (def.sideEffect !== "read" && def.sideEffect !== "write" && def.sideEffect !== "dual") {
    throw new Error(`declarative tool ${def.name || "(unnamed)"} must declare sideEffect as read, write, or dual`);
  }
  const executionPolicy = {
    operation: def.operation,
    effectScope: def.effectScope,
    sandboxPolicy: def.sandboxPolicy,
  };
  if (!isToolExecutionPolicy(executionPolicy) || executionPolicy.effectScope !== "external") {
    throw new Error(
      `declarative tool ${def.name || "(unnamed)"} must declare a valid external operation/effectScope/sandboxPolicy; legacy sideEffect or HTTP method is never used as a default`,
    );
  }
  const fetchFn = opts?.fetchFn ?? fetch;
  return defineTool({
    name: def.name,
    description: def.description ?? `declarative HTTP tool ${def.method} ${def.urlTemplate}`,
    async handler(ctx: ToolContext) {
      const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
      // config supplies creds/paths; LLM args win on key collision.
      const materialized = resolveDeclarativeToolConfig((ctx.config ?? {}) as Record<string, unknown>);
      if (materialized.missingEnv.length) {
        throw new DeclarativeToolExecutionError(
          "schema_mismatch",
          `required credential environment variable is not configured: ${materialized.missingEnv.join(", ")}`,
        );
      }
      const lastResult = asRecord(ctx.lastResult) ?? {};
      const scope = {
        ...materialized.resolved,
        ...lastResult,
        ...args,
        args,
        config: materialized.resolved,
        lastResult,
      };
      const argIssues = validateToolSchema(scope, def.paramsSchema);
      if (argIssues.length) {
        throw new DeclarativeToolExecutionError("schema_mismatch", `request schema mismatch: ${schemaSummary(argIssues)}`);
      }
      const method = (def.method || "GET").toUpperCase();
      const url = fillTemplate(def.urlTemplate, scope, true);
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(def.headers ?? {})) headers[k] = fillTemplate(v, scope, false);
      const requestBody = buildRequestBody(def, method, scope, args, materialized.resolved);
      const init: RequestInit = { method, headers, ...(requestBody.body !== undefined ? { body: requestBody.body } : {}) };
      if (requestBody.body !== undefined && !requestBody.multipart && !headers["content-type"] && !headers["Content-Type"]) {
        headers["content-type"] = "application/json";
      }
      if (requestBody.multipart) {
        // The fetch implementation must add the boundary-bearing Content-Type.
        delete headers["content-type"];
        delete headers["Content-Type"];
      }
      let res: Response;
      try {
        res = await safeFetch(url, init, fetchFn);
      } catch (error) {
        if (error instanceof DeclarativeToolExecutionError) throw error;
        throw new DeclarativeToolExecutionError("network", redactSensitiveText((error as Error).message));
      }
      const text = await res.text();
      let parsed: unknown = text;
      let parsedJson = false;
      try {
        parsed = JSON.parse(text);
        parsedJson = true;
      } catch {
        /* non-JSON response — keep raw text */
      }
      try {
        opts?.onExchange?.({
          request: { method, url, body: requestBody.preview },
          response: { status: res.status, body: parsed },
        });
      } catch {
        // Observation is probe telemetry and must never change tool behavior.
      }
      if (!res.ok) {
        const kind: DeclarativeToolFailureKind = res.status === 429 ? "rate_limit" : res.status >= 500 ? "http_5xx" : "http_4xx";
        throw new DeclarativeToolExecutionError(kind, `declarative tool ${def.name} HTTP ${res.status}: ${redactSensitiveText(String(text)).slice(0, 200)}`, res.status);
      }
      if (!text.trim() && def.returnsSchema && Object.keys(def.returnsSchema).length) {
        throw new DeclarativeToolExecutionError("empty_200", `declarative tool ${def.name} returned an empty successful response`, res.status);
      }
      const normalizedReturnType = typeof def.returnsSchema?.type === "string" ? def.returnsSchema.type : undefined;
      if (!parsedJson && normalizedReturnType && /object|array/i.test(normalizedReturnType)) {
        throw new DeclarativeToolExecutionError("invalid_json", `declarative tool ${def.name} returned non-JSON for ${normalizedReturnType}`, res.status);
      }
      const normalized = applyResponseSpec(parsed, def.responseSpec);
      const returnIssues = validateToolSchema(normalized, def.returnsSchema);
      if (returnIssues.length) {
        throw new DeclarativeToolExecutionError("schema_mismatch", `declarative tool ${def.name} response schema mismatch: ${schemaSummary(returnIssues)}`, res.status);
      }
      return { data: normalized, meta: { declarative: true, tool: def.name, status: res.status } };
    },
  });
}

/** Turn a set of declarative tool rows into a name→descriptor overlay map. The runtime merges
 *  this into the per-tenant tool registry so resolution finds them BEFORE the global registry. */
export function buildDeclarativeOverlay(
  defs: DeclarativeToolDef[],
  opts?: MakeDeclarativeToolOpts,
): Record<string, ToolDescriptor> {
  const overlay: Record<string, ToolDescriptor> = {};
  for (const def of defs) {
    if (!def?.name) continue;
    overlay[def.name] = makeDeclarativeTool(def, opts);
  }
  return overlay;
}
