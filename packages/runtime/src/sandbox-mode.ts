// Phase 3 / T3 — sandbox tool-dispatch mode. In the isolated `-sb` sandbox tenant, a generated
// agent's tool steps must NOT hit real external APIs by default (a Phase-1 `type:"tool"` plan step
// calls the real handler directly — no LLM in the loop — so without interception a sandbox run
// would POST to RoboHire/etc. for real). This resolves the mode and provides a stub + a best-effort
// cassette lookup. Runtime-local (no agent-factory import); mirrors verificationPolicy's env knob.
//
//   mock   (default) → return a representative stub, zero external side effects, deterministic
//   replay           → answer from a recorded cassette (CI determinism); miss → stub
//   live             → call the real handler (against sandbox-scoped creds) — explicit opt-in

import path from "node:path";
import { promises as fs } from "node:fs";

// #REDESIGN P1b — "gated" is the new DEFAULT (拒绝 mock): tool READS run LIVE (real integration, no
// external side-effect), external WRITES are gated (recorded-at-boundary, not fired) unless
// FACTORY_SANDBOX_ALLOW_WRITES=1 (the "confirm" the user supplies alongside real test data). Tests
// keep "mock" for free/deterministic/offline CI. Legacy "mock"/"replay"/"live" stay available.
export type SandboxToolMode = "mock" | "replay" | "live" | "gated";

export function sandboxToolMode(env: NodeJS.ProcessEnv = process.env): SandboxToolMode {
  const dflt = env.NODE_ENV === "test" ? "mock" : "gated";
  const m = (env.FACTORY_SANDBOX_TOOL_MODE ?? dflt).toLowerCase();
  return m === "replay" || m === "live" || m === "mock" || m === "gated" ? (m as SandboxToolMode) : dflt;
}

/** Heuristic: does this tool WRITE / SEND to an external system (a real side-effect worth gating)?
 *  Errs toward write (safer — gates more) for ambiguous names. Read-ish tools run live in "gated". */
const WRITE_VERB = /(^|[._])(write|append|send|post|put|patch|delete|del|create|update|upsert|insert|save|store|persist|notify|email|invite|publish|sync|upload|submit|dispatch|charge|pay|provision|deploy|remove|archive|revoke|log|record|set|push|enqueue|schedule|mutate|apply)/i;
export function isWriteTool(name: string): boolean {
  return WRITE_VERB.test(name);
}

/** Whether external WRITES may fire live in the gated sandbox (the user's real-data + confirm opt-in). */
export function sandboxWritesAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.FACTORY_SANDBOX_ALLOW_WRITES === "1";
}

/** Record-at-boundary marker for a gated external write: the REAL payload is captured (so the run is
 *  faithful up to the boundary), but the write is NOT fired. Set FACTORY_SANDBOX_ALLOW_WRITES=1 to fire. */
export function gatedWriteMarker(name: string, args: unknown): Record<string, unknown> {
  const payload = (args ?? {}) as Record<string, unknown>;
  // Spread the real payload fields at the TOP LEVEL too, so a downstream tool that chains on
  // ctx.lastResult (e.g. reads `.base64`/`.id`) still sees the real values instead of undefined —
  // the write isn't fired, but the data flows on. __gated marks it so callers can detect the gate.
  return { ...payload, __gated: true, tool: name, wouldWrite: payload, note: "外部写入已门控（记录真实 payload，未真发）；FACTORY_SANDBOX_ALLOW_WRITES=1 且备真实数据后可真写" };
}

/** The dispatch decision for a sandbox tool call, given the resolved mode. */
export function toolDispatchDecision(name: string, mode: SandboxToolMode, env: NodeJS.ProcessEnv = process.env): "live" | "gate" | "replay" | "stub" {
  if (mode === "live") return "live";
  if (mode === "mock") return "stub";
  if (mode === "replay") return "replay";
  // gated: reads live, writes gated unless the confirm opt-in is set.
  return isWriteTool(name) ? (sandboxWritesAllowed(env) ? "live" : "gate") : "live";
}

/** The isolated sandbox tenant slug convention is `<domain>-sb` (see ManifestSandboxDeployer). */
export function isSandboxTenant(tenantSlug?: string): boolean {
  return !!tenantSlug && tenantSlug.endsWith("-sb");
}

/** Representative stub returned for a sandbox tool call in mock mode (or a replay miss). Shaped so a
 *  downstream step / the LLM sees a plausible non-empty object rather than a real side effect. */
export function sandboxToolStub(name: string, note = "sandbox mock — no real external side effect"): Record<string, unknown> {
  return { __sandbox: true, mock: true, tool: name, note };
}

/** Stable hash of a tool call's args, for keying a cassette entry. */
export function cassetteKey(name: string, args: unknown): string {
  const s = `${name} ${JSON.stringify(args ?? {})}`;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

function dataRoot(): string {
  return process.env.AGENTIC_DATA_ROOT?.trim() || "./data";
}

/** Best-effort REPLAY: load a recorded response for (tenant, tool, args) from
 *  `<dataRoot>/factory-cassettes/<tenant>/<tool>.json` (a `{ [key]: body }` map). Returns the
 *  recorded body, or undefined on any miss/error (caller falls back to a stub). Never throws. */
export async function cassetteLookup(tenantSlug: string, name: string, args: unknown): Promise<unknown | undefined> {
  try {
    const safe = name.replace(/[^A-Za-z0-9_.-]/g, "_");
    const file = path.resolve(dataRoot(), "factory-cassettes", tenantSlug, `${safe}.json`);
    const raw = await fs.readFile(file, "utf8");
    const tape = JSON.parse(raw) as Record<string, unknown>;
    return tape[cassetteKey(name, args)];
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
