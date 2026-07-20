// Phase 3 / T3 — sandbox tool-dispatch mode. In an isolated Agent Factory ephemeral sandbox tenant, a generated
// agent's tool steps must NOT hit real external APIs by default (a Phase-1 `type:"tool"` plan step
// calls the real handler directly — no LLM in the loop — so without interception a sandbox run
// would POST to RoboHire/etc. for real). This resolves the mode and provides a stub + a best-effort
// cassette lookup. Runtime-local (no agent-factory import); mirrors verificationPolicy's env knob.
//
//   gated (non-test default) → real reads; external writes require a scoped grant
//   live                     → real reads; writes still require a scoped grant
//   mock/replay              → deterministic NODE_ENV=test modes only

import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import {
  canonicalToolCassetteKey,
  cassetteHash,
  isCanonicalCassette,
  lookupCanonicalToolCassette,
  stableJson,
  type CanonicalCassetteDocument,
} from "@agentic/shared/cassette";
import { eq, factorySandboxAttempts, getDb } from "@agentic/db";
import {
  isToolExecutionPolicy,
  type ToolExecutionPolicy,
} from "@agentic/tools";

// #REDESIGN P1b — "gated" is the new DEFAULT (拒绝 mock): tool READS run LIVE (real integration, no
// external side-effect), external WRITES are gated (recorded-at-boundary, not fired) unless the
// caller supplies a run-scoped, server-owned authorization.  A process-global environment switch
// is deliberately not supported: it could authorize unrelated tenants and concurrent attempts.
// Tests keep "mock" for free/deterministic/offline CI. Legacy "mock"/"replay"/"live" stay available.
export type SandboxToolMode = "mock" | "replay" | "live" | "gated";
export type SandboxToolExecutionPolicy = ToolExecutionPolicy;
export type SandboxToolDispatchDecision =
  | "live"
  | "gate_profile"
  | "gate_grant"
  | "replay"
  | "stub"
  | "reject";

export interface FactorySandboxExecutionScope {
  kind: "sandbox";
  target_domain_id: string;
  candidate_fingerprint: string;
  attempt_id: string;
}

/** Immutable pointer copied into the nonce sandbox manifest after the API has
 * validated and staged one definition-bound cassette. The worker receives
 * hashes only; source paths and credentials never enter generated code. */
export interface FactorySandboxReplayRef {
  definition_hash: string;
  content_hash: string;
}

export type FactorySandboxDispatchKind =
  | "replay"
  | "replay_miss"
  | "sandbox_local"
  | "external_live";

/** Secret-free receipt written at the actual runtime tool boundary. */
export interface FactorySandboxDispatchReceipt {
  schema: "agent-factory-sandbox-dispatch/v1";
  attemptId: string;
  tenantSlug: string;
  tool: string;
  kind: FactorySandboxDispatchKind;
  effectScope: ToolExecutionPolicy["effectScope"];
  argsHash: string;
  cassetteKey: string;
  definitionHash?: string;
  contentHash?: string;
  responseStatus?: number;
  at: string;
}

export interface FactorySandboxDispatchEvidence {
  schema: "agent-factory-sandbox-dispatch-evidence/v1";
  attemptId: string;
  tenantSlug: string;
  replayReceipts: FactorySandboxDispatchReceipt[];
  dispatches: FactorySandboxDispatchReceipt[];
  externalLiveCalls: number;
  replayMisses: number;
  sandboxLocalCalls: number;
  complete: boolean;
}

export function sandboxToolMode(env: NodeJS.ProcessEnv = process.env): SandboxToolMode {
  const dflt = env.NODE_ENV === "test" ? "mock" : "gated";
  const m = (env.FACTORY_SANDBOX_TOOL_MODE ?? dflt).toLowerCase();
  const resolved = m === "replay" || m === "live" || m === "mock" || m === "gated"
    ? (m as SandboxToolMode)
    : dflt;
  if (env.NODE_ENV !== "test" && (resolved === "mock" || resolved === "replay")) {
    throw new Error(
      `FACTORY_SANDBOX_TOOL_MODE=${resolved} is test-only; production sandboxes must use gated or live`,
    );
  }
  return resolved;
}

/** External mutation is determined only from reviewed policy. Unknown policy
 * is not guessed; callers must reject it. */
export function requiresAttemptGrant(policy: unknown): boolean {
  return isToolExecutionPolicy(policy)
    && policy.sandboxPolicy === "requires_attempt_grant";
}

/** Record-at-boundary marker for a gated external write: the REAL payload is captured (so the run is
 *  faithful up to the boundary), but the write is NOT fired. */
export function gatedWriteMarker(name: string, args: unknown): Record<string, unknown> {
  return gatedToolMarker(name, args, "requires_attempt_grant");
}

/** Record a blocked boundary without making a blocked external read look like
 * a write. The real payload remains visible for review and downstream fixture
 * shaping, while `gateReason` says which server-owned proof is missing. */
export function gatedToolMarker(
  name: string,
  args: unknown,
  gateReason: "sandbox_profile" | "requires_attempt_grant",
): Record<string, unknown> {
  const payload = (args ?? {}) as Record<string, unknown>;
  // Spread the real payload fields at the TOP LEVEL too, so a downstream tool that chains on
  // ctx.lastResult (e.g. reads `.base64`/`.id`) still sees the real values instead of undefined —
  // the write isn't fired, but the data flows on. __gated marks it so callers can detect the gate.
  return gateReason === "sandbox_profile"
    ? {
        ...payload,
        __gated: true,
        gateReason,
        tool: name,
        wouldCall: payload,
        note: "外部调用已门控：还没有确认该工具使用独立的 sandbox profile；不会借用生产配置",
      }
    : {
        ...payload,
        __gated: true,
        gateReason,
        tool: name,
        wouldWrite: payload,
        note: "外部写入已门控（记录真实 payload，未真发）；需要与当前沙箱 attempt 绑定的授权、安全测试数据、清理和缺席回读证据",
      };
}

/**
 * The dispatch decision for a sandbox tool call. Both positive options are
 * server-owned facts. Generated code and arbitrary tool config cannot supply
 * either one. Missing, malformed, or semantically inconsistent policy rejects
 * before mock/replay handling, so tests cannot hide an unreviewed capability.
 */
export function toolDispatchDecision(
  policy: unknown,
  mode: SandboxToolMode,
  options: {
    sandboxProfileVerified?: boolean;
    attemptGrantVerified?: boolean;
  } = {},
): SandboxToolDispatchDecision {
  if (!isToolExecutionPolicy(policy)) return "reject";
  if (mode === "mock") return "stub";
  if (mode === "replay") return "replay";
  switch (policy.sandboxPolicy) {
    case "pure":
    case "sandbox_local":
      return "live";
    case "live_external":
      return options.sandboxProfileVerified === true ? "live" : "gate_profile";
    case "requires_attempt_grant":
      return options.attemptGrantVerified === true ? "live" : "gate_grant";
  }
}

/** Non-test Agent Factory nonce apps have a stricter invariant than legacy
 * tenant sandboxes: every external capability is evidence replay only. Pure
 * and sandbox-local capabilities may execute their reviewed local handler.
 * This intentionally ignores FACTORY_SANDBOX_TOOL_MODE so an operator typo or
 * generated config cannot re-enable a live external call. */
export function factorySandboxDispatchDecision(
  policy: unknown,
  tenantSlug: string | undefined,
  scope: FactorySandboxExecutionScope | { kind: "production" } | undefined,
): "live" | "replay" | "reject" | null {
  if (!isFactorySandboxTenant(tenantSlug)) return null;
  if (!scope || scope.kind !== "sandbox" || !isToolExecutionPolicy(policy)) {
    return "reject";
  }
  if (policy.effectScope === "external") return "replay";
  if (
    (policy.effectScope === "none" && policy.sandboxPolicy === "pure") ||
    (policy.effectScope === "sandbox_local" && policy.sandboxPolicy === "sandbox_local")
  ) return "live";
  return "reject";
}

/**
 * Agent Factory ephemeral sandbox identity.
 *
 * A plain `-sb` suffix is not an authorization boundary: a real tenant can be
 * named that way, and historically any such tenant silently received sandbox
 * tool interception and generated-code privileges. Runtime code now recognizes
 * only the nonce-bearing identity minted by ManifestSandboxDeployer. The legacy
 * suffix remains available in NODE_ENV=test solely for old isolated fixtures.
 */
const FACTORY_SANDBOX_SLUG_RE = /^af-sbx-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{12}-sb$/;

export function isFactorySandboxTenant(tenantSlug?: string): boolean {
  return typeof tenantSlug === "string" && FACTORY_SANDBOX_SLUG_RE.test(tenantSlug);
}

export function isSandboxTenant(tenantSlug?: string): boolean {
  if (isFactorySandboxTenant(tenantSlug)) return true;
  return process.env.NODE_ENV === "test" && !!tenantSlug && tenantSlug.endsWith("-sb");
}

/** Runtime-friendly dispatch guard in addition to the DB INSERT trigger. The
 * durable attempt row, not the app name or a generated manifest flag, decides
 * whether a new execution may be allocated. */
export function assertSandboxAttemptDispatchAllowed(args: {
  tenantId: string;
  tenantSlug: string;
  appId: string;
  executionScope?: FactorySandboxExecutionScope | { kind: "production" };
}): void {
  if (!isFactorySandboxTenant(args.tenantSlug)) return;
  const scope = args.executionScope;
  if (!scope || scope.kind !== "sandbox") {
    throw new Error("sandbox dispatch refused: exact attempt execution scope is missing");
  }
  const attempt = getDb()
    .select()
    .from(factorySandboxAttempts)
    .where(eq(factorySandboxAttempts.id, scope.attempt_id))
    .all()[0];
  if (
    !attempt ||
    attempt.sandboxTenantId !== args.tenantId ||
    attempt.sandboxTenantSlug !== args.tenantSlug ||
    attempt.appId !== args.appId ||
    attempt.targetDomainId !== scope.target_domain_id ||
    attempt.candidateFingerprint !== scope.candidate_fingerprint
  ) {
    throw new Error("sandbox dispatch refused: attempt/app/tenant/domain identity mismatch");
  }
  if (attempt.status !== "active") {
    throw new Error(`sandbox dispatch refused: attempt ${attempt.id} is ${attempt.status}`);
  }
}

/** Representative stub returned for a sandbox tool call in mock mode (or a replay miss). Shaped so a
 *  downstream step / the LLM sees a plausible non-empty object rather than a real side effect. */
export function sandboxToolStub(name: string, note = "sandbox mock — no real external side effect"): Record<string, unknown> {
  return { __sandbox: true, mock: true, tool: name, note };
}

/** Stable hash of a tool call's args, for keying a cassette entry. */
export function cassetteKey(name: string, args: unknown): string {
  return canonicalToolCassetteKey(name, args);
}

function dataRoot(): string {
  return process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
}

const HASH_256_RE = /^[a-f0-9]{64}$/;
const ATTEMPT_ID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function sha256(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function assertFactoryReplayIdentity(
  scope: FactorySandboxExecutionScope,
  tenantSlug: string,
): void {
  if (!isFactorySandboxTenant(tenantSlug)) {
    throw new Error("factory sandbox replay requires a nonce sandbox tenant");
  }
  if (!ATTEMPT_ID_RE.test(scope.attempt_id)) {
    throw new Error("factory sandbox replay requires a UUID attempt id");
  }
  if (!scope.candidate_fingerprint.trim() || !scope.target_domain_id.trim()) {
    throw new Error("factory sandbox replay scope is incomplete");
  }
}

function factoryReplayAttemptRoot(attemptId: string): string {
  if (!ATTEMPT_ID_RE.test(attemptId)) {
    throw new Error("invalid factory sandbox attempt id");
  }
  return path.resolve(dataRoot(), "factory-sandbox-attempts", attemptId);
}

function safeToolSegment(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safe || safe === "." || safe === "..") {
    throw new Error("invalid factory sandbox replay tool name");
  }
  return safe;
}

function factoryReplayMetadata(scope: FactorySandboxExecutionScope, tenantSlug: string) {
  return {
    schema: "agent-factory-sandbox-replay-attempt/v1" as const,
    attemptId: scope.attempt_id,
    tenantSlug,
    targetDomainId: scope.target_domain_id,
    candidateFingerprint: scope.candidate_fingerprint,
  };
}

async function readFactoryReplayMetadata(
  scope: FactorySandboxExecutionScope,
  tenantSlug: string,
): Promise<void> {
  assertFactoryReplayIdentity(scope, tenantSlug);
  const file = path.join(factoryReplayAttemptRoot(scope.attempt_id), "attempt.json");
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  const expected = factoryReplayMetadata(scope, tenantSlug);
  for (const [key, value] of Object.entries(expected)) {
    if (parsed[key] !== value) {
      throw new Error(`factory sandbox replay attempt identity mismatch (${key})`);
    }
  }
}

/** Create the attempt-owned replay namespace before any Inngest app is
 * registered. `wx` deliberately refuses reuse; every retry needs a fresh
 * attempt identity. */
export async function initializeFactorySandboxReplayAttempt(
  scope: FactorySandboxExecutionScope,
  tenantSlug: string,
): Promise<void> {
  assertFactoryReplayIdentity(scope, tenantSlug);
  const root = factoryReplayAttemptRoot(scope.attempt_id);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(
      path.join(root, "attempt.json"),
      JSON.stringify(factoryReplayMetadata(scope, tenantSlug)),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await fs.writeFile(path.join(root, "dispatch.ndjson"), "", {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    // Do not delete on EEXIST: a UUID collision or stale attempt must be
    // investigated, never "fixed" by erasing another attempt's evidence.
    // The lifecycle cleanup/reaper owns any partial directory we created.
    throw error;
  }
}

/** Stage only an already validated canonical cassette. The returned hashes are
 * what the manifest carries; a later byte or definition drift fails closed at
 * the worker boundary. */
export async function stageFactorySandboxReplayCassette(args: {
  scope: FactorySandboxExecutionScope;
  tenantSlug: string;
  toolName: string;
  definitionHash: string;
  document: CanonicalCassetteDocument;
}): Promise<FactorySandboxReplayRef> {
  await readFactoryReplayMetadata(args.scope, args.tenantSlug);
  const definitionHash = args.definitionHash.trim().toLowerCase();
  if (!HASH_256_RE.test(definitionHash)) {
    throw new Error(`invalid replay definition hash for '${args.toolName}'`);
  }
  if (
    !isCanonicalCassette(args.document) ||
    args.document.tool?.name !== args.toolName ||
    args.document.tool.definitionHash !== definitionHash ||
    !args.document.evidence?.mode
  ) {
    throw new Error(`cassette for '${args.toolName}' is not definition-bound evidence`);
  }
  const raw = JSON.stringify(args.document);
  const contentHash = sha256(raw);
  const directory = path.join(
    factoryReplayAttemptRoot(args.scope.attempt_id),
    "cassettes",
    definitionHash,
  );
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${safeToolSegment(args.toolName)}.json`);
  try {
    await fs.writeFile(file, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(file, "utf8");
    if (existing !== raw) {
      throw new Error(`conflicting replay evidence for '${args.toolName}'`);
    }
  }
  return { definition_hash: definitionHash, content_hash: contentHash };
}

async function appendFactorySandboxDispatch(
  scope: FactorySandboxExecutionScope,
  tenantSlug: string,
  receipt: FactorySandboxDispatchReceipt,
): Promise<void> {
  await readFactoryReplayMetadata(scope, tenantSlug);
  const file = path.join(factoryReplayAttemptRoot(scope.attempt_id), "dispatch.ndjson");
  const handle = await fs.open(
    file,
    constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW,
  );
  try {
    await handle.writeFile(`${JSON.stringify(receipt)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function baseDispatchReceipt(args: {
  scope: FactorySandboxExecutionScope;
  tenantSlug: string;
  toolName: string;
  toolArgs: unknown;
  kind: FactorySandboxDispatchKind;
  policy: ToolExecutionPolicy;
}): FactorySandboxDispatchReceipt {
  return {
    schema: "agent-factory-sandbox-dispatch/v1",
    attemptId: args.scope.attempt_id,
    tenantSlug: args.tenantSlug,
    tool: args.toolName,
    kind: args.kind,
    effectScope: args.policy.effectScope,
    argsHash: cassetteHash(stableJson(args.toolArgs ?? {})),
    cassetteKey: canonicalToolCassetteKey(args.toolName, args.toolArgs),
    at: new Date().toISOString(),
  };
}

/** Record a pure/sandbox-local dispatch before invoking its local handler. */
export async function recordFactorySandboxLocalDispatch(args: {
  scope: FactorySandboxExecutionScope;
  tenantSlug: string;
  toolName: string;
  toolArgs: unknown;
  policy: ToolExecutionPolicy;
}): Promise<FactorySandboxDispatchReceipt> {
  const receipt = baseDispatchReceipt({ ...args, kind: "sandbox_local" });
  await appendFactorySandboxDispatch(args.scope, args.tenantSlug, receipt);
  return receipt;
}

/** Exact external replay for a nonce Factory app. No environment switch can
 * turn this path into a live handler call. Missing ref/file/hash/args all write
 * a replay_miss receipt and fail closed. */
export async function replayFactorySandboxTool(args: {
  scope: FactorySandboxExecutionScope;
  tenantSlug: string;
  toolName: string;
  toolArgs: unknown;
  policy: ToolExecutionPolicy;
  replayRef?: FactorySandboxReplayRef;
}): Promise<{ body: unknown; receipt: FactorySandboxDispatchReceipt }> {
  const miss = async (message: string): Promise<never> => {
    const receipt = baseDispatchReceipt({ ...args, kind: "replay_miss" });
    if (args.replayRef) {
      receipt.definitionHash = args.replayRef.definition_hash;
      receipt.contentHash = args.replayRef.content_hash;
    }
    await appendFactorySandboxDispatch(args.scope, args.tenantSlug, receipt);
    throw new Error(message);
  };
  const ref = args.replayRef;
  if (
    !ref ||
    !HASH_256_RE.test(ref.definition_hash) ||
    !HASH_256_RE.test(ref.content_hash)
  ) {
    return miss(`No attempt-bound replay evidence exists for tool '${args.toolName}'`);
  }
  const file = path.join(
    factoryReplayAttemptRoot(args.scope.attempt_id),
    "cassettes",
    ref.definition_hash,
    `${safeToolSegment(args.toolName)}.json`,
  );
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    return miss(`Attempt-bound replay evidence is unavailable for tool '${args.toolName}'`);
  }
  if (sha256(raw) !== ref.content_hash) {
    return miss(`Attempt-bound replay content drifted for tool '${args.toolName}'`);
  }
  let document: CanonicalCassetteDocument;
  try {
    document = JSON.parse(raw) as CanonicalCassetteDocument;
  } catch {
    return miss(`Attempt-bound replay evidence is malformed for tool '${args.toolName}'`);
  }
  if (
    !isCanonicalCassette(document) ||
    document.tool?.name !== args.toolName ||
    document.tool.definitionHash !== ref.definition_hash ||
    !document.evidence?.mode
  ) {
    return miss(`Attempt-bound replay contract drifted for tool '${args.toolName}'`);
  }
  const key = canonicalToolCassetteKey(args.toolName, args.toolArgs);
  const entry = document.entries.find((candidate) =>
    candidate.key === key &&
    candidate.request.kind === "tool" &&
    candidate.request.toolName === args.toolName &&
    candidate.request.argsHash === cassetteHash(stableJson(args.toolArgs ?? {})));
  if (!entry) {
    return miss(`No attempt-bound replay cassette matches arguments for tool '${args.toolName}'`);
  }
  const receipt: FactorySandboxDispatchReceipt = {
    ...baseDispatchReceipt({ ...args, kind: "replay" }),
    definitionHash: ref.definition_hash,
    contentHash: ref.content_hash,
    responseStatus: entry.response.status,
  };
  await appendFactorySandboxDispatch(args.scope, args.tenantSlug, receipt);
  return { body: entry.response.body, receipt };
}

/** Read back the runtime-authored dispatch ledger. Malformed or missing
 * evidence throws; callers must never turn an absent ledger into zero calls. */
export async function readFactorySandboxDispatchEvidence(
  scope: FactorySandboxExecutionScope,
  tenantSlug: string,
): Promise<FactorySandboxDispatchEvidence> {
  await readFactoryReplayMetadata(scope, tenantSlug);
  const raw = await fs.readFile(
    path.join(factoryReplayAttemptRoot(scope.attempt_id), "dispatch.ndjson"),
    "utf8",
  );
  const dispatches = raw.split("\n").filter(Boolean).map((line) => {
    const receipt = JSON.parse(line) as FactorySandboxDispatchReceipt;
    if (
      receipt.schema !== "agent-factory-sandbox-dispatch/v1" ||
      receipt.attemptId !== scope.attempt_id ||
      receipt.tenantSlug !== tenantSlug ||
      !receipt.tool ||
      !["replay", "replay_miss", "sandbox_local", "external_live"].includes(receipt.kind)
    ) {
      throw new Error("factory sandbox dispatch ledger contains invalid evidence");
    }
    return receipt;
  });
  const externalLiveCalls = dispatches.filter((row) => row.kind === "external_live").length;
  const replayMisses = dispatches.filter((row) => row.kind === "replay_miss").length;
  return {
    schema: "agent-factory-sandbox-dispatch-evidence/v1",
    attemptId: scope.attempt_id,
    tenantSlug,
    replayReceipts: dispatches.filter((row) => row.kind === "replay"),
    dispatches,
    externalLiveCalls,
    replayMisses,
    sandboxLocalCalls: dispatches.filter((row) => row.kind === "sandbox_local").length,
    complete: externalLiveCalls === 0 && replayMisses === 0,
  };
}

export async function removeFactorySandboxReplayAttempt(
  scope: FactorySandboxExecutionScope,
  tenantSlug: string,
): Promise<void> {
  try {
    await readFactoryReplayMetadata(scope, tenantSlug);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await fs.rm(factoryReplayAttemptRoot(scope.attempt_id), {
    recursive: true,
    force: true,
  });
}

/** Test-only REPLAY lookup: load a recorded response for (tenant, tool, args) from
 *  `<dataRoot>/factory-cassettes/<tenant>/<tool>.json` (a `{ [key]: body }` map). Returns the
 *  recorded body, or undefined on any miss/error (the caller fails closed). */
export async function cassetteLookup(tenantSlug: string, name: string, args: unknown, expectedDefinitionHash?: string): Promise<unknown | undefined> {
  try {
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
    const file = path.resolve(dataRoot(), "factory-cassettes", tenantSlug, `${safe}.json`);
    const raw = await fs.readFile(file, "utf8");
    const tape = JSON.parse(raw) as unknown;
    const canonical = lookupCanonicalToolCassette(tape, name, args, expectedDefinitionHash);
    if (canonical !== undefined) return canonical;
    // One-release read compatibility for old `{key:body}` tapes. New recorders
    // only write the canonical versioned document above.
    if (tape && typeof tape === "object" && !Array.isArray(tape) && !("version" in tape)) {
      return (tape as Record<string, unknown>)[cassetteKey(name, args)];
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// #W3-FAULT — deterministic fault injection for sandbox test cases. A fired case payload may carry
// `__fault: { tool?, kind }`; at tool dispatch (sandbox tenants ONLY) a matching tool returns an
// injected failure instead of executing — proving the agent's failure path is wired (no crash, no
// false success terminal with a poisoned dependency). Production tenants never consult the marker.
export function injectedFault(eventData: unknown, toolName: string): { kind: string } | null {
  const f = (eventData as { __fault?: { tool?: string; kind?: string } } | null | undefined)?.__fault;
  if (!f || typeof f !== "object") return null;
  if (f.tool && f.tool !== toolName) return null;
  return { kind: String(f.kind ?? "timeout") };
}
export function faultResult(toolName: string, kind: string): Record<string, unknown> {
  const msg =
    kind === "timeout" ? `injected timeout calling ${toolName}` :
    kind === "http_500" ? `injected HTTP 500 from ${toolName}` :
    kind === "empty" ? `injected empty response from ${toolName}` :
    `injected ${kind} fault from ${toolName}`;
  return { __sandbox: true, __injectedFault: kind, __error: msg, tool: toolName };
}
