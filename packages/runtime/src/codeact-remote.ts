import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import type {
  CodeActContainerResult,
} from "./codeact-container";
import type { CodeActRpcMethod } from "./codeact-worker";

const EXECUTE_SCHEMA = "agentic-production-codeact-execute/v1" as const;
const TERMINAL_SCHEMA = "agentic-production-codeact-terminal/v1" as const;
const RPC_SCHEMA = "agentic-production-codeact-rpc/v1" as const;
const RPC_RESULT_SCHEMA = "agentic-production-codeact-rpc-result/v1" as const;
const SHA256 = /^[a-f0-9]{64}$/;
const PINNED_IMAGE = /^(?:[a-z0-9][a-z0-9._/-]*@)?sha256:[a-f0-9]{64}$/;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_RPC_RESPONSES = 4_096;
const RPC_METHODS = new Set<CodeActRpcMethod>([
  "reason",
  "tool",
  "memory.get",
  "memory.put",
  "memory.delete",
  "memory.search",
  "invoke",
  "spawn",
]);

function canonicalJsonValue(value: unknown, arrayEntry = false): unknown {
  if (
    value === undefined
    || typeof value === "function"
    || typeof value === "symbol"
  ) return arrayEntry ? null : undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalJsonValue(entry, true));
  }
  const canonical: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))) {
    const normalized = canonicalJsonValue(entry);
    if (normalized !== undefined) canonical[key] = normalized;
  }
  return canonical;
}

function stableJson(value: unknown): string {
  const encoded = JSON.stringify(canonicalJsonValue(value));
  if (encoded === undefined) throw new Error("production CodeAct message is not JSON serializable");
  return encoded;
}

export function productionCodeActMessageSignature(
  value: unknown,
  secret: string,
): string {
  return createHmac("sha256", secret).update(stableJson(value), "utf8").digest("hex");
}

export function verifyProductionCodeActMessageSignature(
  value: unknown,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature || !SHA256.test(signature)) return false;
  const actual = Buffer.from(signature, "hex");
  const expected = Buffer.from(productionCodeActMessageSignature(value, secret), "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function productionCodeActSecret(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const direct = env.PRODUCTION_CODEACT_EXECUTOR_TOKEN?.trim();
  const file = env.PRODUCTION_CODEACT_EXECUTOR_TOKEN_FILE?.trim();
  if (direct && file) throw new Error("PRODUCTION_CODEACT_EXECUTOR_TOKEN and *_FILE cannot both be set");
  const value = direct || (file ? readFileSync(file, "utf8").trim() : "");
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("PRODUCTION_CODEACT_EXECUTOR_TOKEN(_FILE) must contain at least 32 bytes");
  }
  return value;
}

/** Cheap transport pre-authentication used before Fastify parses a potentially
 * multi-megabyte internal protocol body. The signed body remains the
 * authoritative identity/integrity check; this bearer only prevents an
 * unauthenticated parser/allocator DoS on the shared API listener. */
export function productionCodeActBearerMatches(
  header: string | undefined,
  secret: string,
): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = header.slice("Bearer ".length).trim();
  if (!supplied) return false;
  const actual = createHash("sha256").update(supplied, "utf8").digest();
  const expected = createHash("sha256").update(secret, "utf8").digest();
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function requiredOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.PRODUCTION_CODEACT_EXECUTOR_URL?.trim();
  if (!raw) throw new Error("PRODUCTION_CODEACT_EXECUTOR_URL is required");
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("PRODUCTION_CODEACT_EXECUTOR_URL must be a credential-free origin");
  }
  if (url.protocol === "https:") return url.origin;
  const allowed = new Set((env.PRODUCTION_CODEACT_EXECUTOR_HTTP_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean));
  if (
    url.protocol !== "http:"
    || env.AGENTIC_PROCESS_ROLE !== "api"
    || !allowed.has(url.hostname.toLowerCase())
  ) {
    throw new Error("Plain HTTP production CodeAct is allowed only from the API to an explicitly allowlisted internal executor host");
  }
  return url.origin;
}

export function productionCodeActRemoteEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.PRODUCTION_CODEACT_EXECUTOR_ENABLED === "1";
}

export interface ProductionCodeActExecutionIdentity {
  tenantId: string;
  tenantSlug: string;
  runId: string;
  agentName: string;
  correlationId: string;
  subject?: string;
  promotionVersionId: string;
  regressionSuiteFingerprint: string;
  codeSha256: string;
}

export interface ProductionCodeActExecuteCommand {
  schema: typeof EXECUTE_SCHEMA;
  executionId: string;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
  identity: ProductionCodeActExecutionIdentity;
  identityHash: string;
  code: string;
  input: Record<string, unknown>;
  policy: {
    timeoutMs: number;
    memoryMb: number;
    cpus: number;
    pidsLimit: number;
  };
}

export interface ProductionCodeActRpcRequest {
  schema: typeof RPC_SCHEMA;
  executionId: string;
  identityHash: string;
  codeSha256: string;
  rpcId: string;
  method: CodeActRpcMethod;
  args: unknown[];
  issuedAt: string;
  expiresAt: string;
}

export interface ProductionCodeActRpcResponse {
  schema: typeof RPC_RESULT_SCHEMA;
  executionId: string;
  identityHash: string;
  rpcId: string;
  ok: boolean;
  value?: unknown;
  error?: string;
}

export interface ProductionCodeActTerminalResponse {
  schema: typeof TERMINAL_SCHEMA;
  executionId: string;
  identityHash: string;
  codeSha256: string;
  executorId: string;
  buildId: string;
  completedAt: string;
  result: CodeActContainerResult;
}

interface ExpectedProductionExecutor {
  executorId: string;
  buildId: string;
  candidateRefs: Set<string>;
  candidateImageIds: Set<string>;
}

export interface ProductionCodeActRemoteHealthExpectation
  extends ExpectedProductionExecutor {
  origin: string;
}

function immutableList(
  raw: string | undefined,
  name: string,
  pattern: RegExp,
): Set<string> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw ?? ""); }
  catch { throw new Error(`${name} must be a JSON array`); }
  if (
    !Array.isArray(parsed)
    || parsed.length < 1
    || parsed.length > 64
    || parsed.some((entry) => typeof entry !== "string" || !pattern.test(entry))
    || new Set(parsed).size !== parsed.length
  ) throw new Error(`${name} must contain 1-64 unique immutable identities`);
  return new Set(parsed as string[]);
}

function expectedProductionExecutor(env: NodeJS.ProcessEnv): ExpectedProductionExecutor {
  const executorId = env.PRODUCTION_CODEACT_EXPECTED_EXECUTOR_ID?.trim() ?? "";
  const buildId = env.PRODUCTION_CODEACT_EXPECTED_BUILD_ID?.trim() ?? "";
  if (!executorId || executorId.length > 200) {
    throw new Error("PRODUCTION_CODEACT_EXPECTED_EXECUTOR_ID is required");
  }
  if (!buildId || buildId.length > 200) {
    throw new Error("PRODUCTION_CODEACT_EXPECTED_BUILD_ID is required");
  }
  return {
    executorId,
    buildId,
    candidateRefs: immutableList(
      env.PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS,
      "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_REFS",
      PINNED_IMAGE,
    ),
    candidateImageIds: immutableList(
      env.PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS,
      "PRODUCTION_CODEACT_ALLOWED_CANDIDATE_IMAGE_IDS",
      /^sha256:[a-f0-9]{64}$/,
    ),
  };
}

/** Secret-free identities required when the API probes the isolated launcher.
 * The bearer is resolved separately and must never be returned by health. */
export function productionCodeActRemoteHealthExpectation(
  env: NodeJS.ProcessEnv = process.env,
): ProductionCodeActRemoteHealthExpectation {
  return {
    origin: requiredOrigin(env),
    ...expectedProductionExecutor(env),
  };
}

interface ActiveRpcContext {
  identity: ProductionCodeActExecutionIdentity;
  identityHash: string;
  expiresAt: number;
  onRpc(method: CodeActRpcMethod, args: unknown[]): Promise<unknown>;
  responses: Map<string, ProductionCodeActRpcResponse>;
}

const rpcContexts = new Map<string, ActiveRpcContext>();

export function activeProductionCodeActRpcContexts(): number {
  return rpcContexts.size;
}

export function productionCodeActIdentityHash(identity: ProductionCodeActExecutionIdentity): string {
  return `sha256:${createHash("sha256").update(stableJson(identity), "utf8").digest("hex")}`;
}

function boundedJson(value: unknown, label: string): void {
  const encoded = JSON.stringify(value);
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_BODY_BYTES) {
    throw new Error(`${label} is not bounded JSON`);
  }
}

function validIdentity(identity: ProductionCodeActExecutionIdentity): boolean {
  return Boolean(
    identity.tenantId?.trim()
    && identity.tenantSlug?.trim()
    && identity.runId?.trim()
    && identity.agentName?.trim()
    && identity.correlationId?.trim()
    && identity.promotionVersionId?.trim()
    && /^regression-suite:v1:/.test(identity.regressionSuiteFingerprint)
    && SHA256.test(identity.codeSha256),
  );
}

/** Called only by the authenticated internal Fastify callback route. */
export async function handleProductionCodeActRpc(
  body: ProductionCodeActRpcRequest,
  signature: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ statusCode: number; body: ProductionCodeActRpcResponse; signature: string }> {
  const secret = productionCodeActSecret(env);
  const reject = (statusCode: number, error: string) => {
    const response: ProductionCodeActRpcResponse = {
      schema: RPC_RESULT_SCHEMA,
      executionId: typeof body?.executionId === "string" ? body.executionId : "invalid",
      identityHash: typeof body?.identityHash === "string" ? body.identityHash : "invalid",
      rpcId: typeof body?.rpcId === "string" ? body.rpcId : "invalid",
      ok: false,
      error,
    };
    return {
      statusCode,
      body: response,
      signature: productionCodeActMessageSignature(response, secret),
    };
  };
  if (!verifyProductionCodeActMessageSignature(body, signature, secret)) {
    return reject(401, "production CodeAct RPC signature is invalid");
  }
  const context = rpcContexts.get(body.executionId);
  if (
    body.schema !== RPC_SCHEMA
    || !context
    || context.identityHash !== body.identityHash
    || context.identity.codeSha256 !== body.codeSha256
    || Date.now() > context.expiresAt
    || Date.parse(body.issuedAt) > Date.now() + 5_000
    || Date.parse(body.expiresAt) < Date.now()
    || !body.rpcId?.trim()
    || !RPC_METHODS.has(body.method)
    || !Array.isArray(body.args)
  ) {
    return reject(409, "production CodeAct RPC identity is stale or mismatched");
  }
  const cached = context.responses.get(body.rpcId);
  if (cached) {
    return {
      statusCode: cached.ok ? 200 : 502,
      body: cached,
      signature: productionCodeActMessageSignature(cached, secret),
    };
  }
  if (context.responses.size >= MAX_RPC_RESPONSES) {
    return reject(429, "production CodeAct RPC limit exceeded");
  }
  let response: ProductionCodeActRpcResponse;
  try {
    const value = await context.onRpc(body.method, body.args);
    boundedJson(value, "production CodeAct RPC result");
    response = {
      schema: RPC_RESULT_SCHEMA,
      executionId: body.executionId,
      identityHash: body.identityHash,
      rpcId: body.rpcId,
      ok: true,
      value: value === undefined ? null : value,
    };
  } catch (error) {
    response = {
      schema: RPC_RESULT_SCHEMA,
      executionId: body.executionId,
      identityHash: body.identityHash,
      rpcId: body.rpcId,
      ok: false,
      error: String((error as Error)?.message ?? error).slice(0, 800),
    };
  }
  context.responses.set(body.rpcId, response);
  return {
    statusCode: response.ok ? 200 : 502,
    body: response,
    signature: productionCodeActMessageSignature(response, secret),
  };
}

export async function executeProductionCodeActRemote(input: {
  code: string;
  data: Record<string, unknown>;
  identity: ProductionCodeActExecutionIdentity;
  timeoutMs: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  onRpc(method: CodeActRpcMethod, args: unknown[]): Promise<unknown>;
  fetchFn?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}): Promise<CodeActContainerResult> {
  const env = input.env ?? process.env;
  if (!productionCodeActRemoteEnabled(env)) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "execution_disabled",
      error: "PRODUCTION_CODEACT_EXECUTOR_ENABLED is not exactly 1",
      durationMs: 0,
      executorStarted: false,
      candidateImageDigest: null,
    };
  }
  if (!validIdentity(input.identity) || productionCodeActIdentityHash(input.identity) === "") {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "production_executor_rejected",
      error: "production CodeAct execution identity is incomplete",
      durationMs: 0,
      executorStarted: false,
      candidateImageDigest: null,
    };
  }
  let origin: string;
  let secret: string;
  let expectedExecutor: ExpectedProductionExecutor;
  try {
    origin = requiredOrigin(env);
    secret = productionCodeActSecret(env);
    expectedExecutor = expectedProductionExecutor(env);
  } catch (error) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "production_executor_unavailable",
      error: String((error as Error)?.message ?? error).slice(0, 800),
      durationMs: 0,
      executorStarted: false,
      candidateImageDigest: null,
    };
  }
  const executionId = randomUUID();
  const identityHash = productionCodeActIdentityHash(input.identity);
  const now = Date.now();
  const command: ProductionCodeActExecuteCommand = {
    schema: EXECUTE_SCHEMA,
    executionId,
    nonce: randomUUID(),
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(30_000, input.timeoutMs + 30_000)).toISOString(),
    identity: input.identity,
    identityHash,
    code: input.code,
    input: input.data,
    policy: {
      timeoutMs: input.timeoutMs,
      memoryMb: input.memoryMb,
      cpus: input.cpus,
      pidsLimit: input.pidsLimit,
    },
  };
  boundedJson(command, "production CodeAct execute command");
  if (rpcContexts.has(executionId)) throw new Error("production CodeAct execution id collision");
  rpcContexts.set(executionId, {
    identity: input.identity,
    identityHash,
    expiresAt: Date.parse(command.expiresAt),
    onRpc: input.onRpc,
    responses: new Map(),
  });
  try {
    const response = await (input.fetchFn ?? fetch)(`${origin}/internal/v1/production-codeact/execute`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${secret}`,
        "content-type": "application/json",
        "x-agentic-codeact-signature": productionCodeActMessageSignature(command, secret),
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(input.timeoutMs + 45_000),
    });
    const terminal = await response.json() as ProductionCodeActTerminalResponse;
    const signature = response.headers.get("x-agentic-codeact-signature") ?? undefined;
    if (
      !response.ok
      || !verifyProductionCodeActMessageSignature(terminal, signature, secret)
      || terminal.schema !== TERMINAL_SCHEMA
      || terminal.executionId !== executionId
      || terminal.identityHash !== identityHash
      || terminal.codeSha256 !== input.identity.codeSha256
      || terminal.executorId !== expectedExecutor.executorId
      || terminal.buildId !== expectedExecutor.buildId
      || !terminal.result
      || terminal.result.isolation !== "isolated_container"
      || (terminal.result.ok && (
        terminal.result.evidence?.codeSha256 !== input.identity.codeSha256
        || !expectedExecutor.candidateRefs.has(terminal.result.candidateImageDigest ?? "")
        || !expectedExecutor.candidateRefs.has(terminal.result.evidence?.candidateImageDigest ?? "")
        || !expectedExecutor.candidateImageIds.has(terminal.result.evidence?.imageId ?? "")
        || terminal.result.evidence?.removed !== true
        || terminal.result.evidence?.absenceVerified !== true
      ))
    ) {
      throw new Error("production CodeAct executor returned an invalid signed terminal result");
    }
    return terminal.result;
  } catch (error) {
    return {
      ok: false,
      isolation: "isolated_container",
      failure: "production_executor_unavailable",
      error: String((error as Error)?.message ?? error).slice(0, 800),
      durationMs: 0,
      executorStarted: false,
      candidateImageDigest: null,
    };
  } finally {
    rpcContexts.delete(executionId);
  }
}

export const PRODUCTION_CODEACT_PROTOCOL = {
  execute: EXECUTE_SCHEMA,
  terminal: TERMINAL_SCHEMA,
  rpc: RPC_SCHEMA,
  rpcResult: RPC_RESULT_SCHEMA,
} as const;
