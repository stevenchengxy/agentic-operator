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

export type SandboxToolMode = "mock" | "replay" | "live";

export function sandboxToolMode(env: NodeJS.ProcessEnv = process.env): SandboxToolMode {
  const m = (env.FACTORY_SANDBOX_TOOL_MODE ?? "mock").toLowerCase();
  return m === "replay" || m === "live" ? (m as SandboxToolMode) : "mock";
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
