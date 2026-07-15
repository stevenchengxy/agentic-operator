/**
 * Demo mode flag — `AGENTIC_DEMO_MODE`.
 *
 * The architectural rule (locked 2026-05-26): production mode = ZERO mock
 * data, demo mode = seed + loop. Two clean states only. No "looks like
 * demo, actually mock fallback" ambiguity.
 *
 * - Default: `false` (production)
 * - Enabled only by the explicit value `true` (case-insensitive)
 *
 * Boot logic that depends on this:
 *   - apps/api/src/bootstrap.ts    → runs seed:rich + starts demo-runner
 *   - apps/api/src/routes/health.ts → exposes `demoMode` so the UI sidebar
 *                                     can render a "DEMO" badge
 *   - apps/api/src/services/demo-runner.ts → no-ops when false (extra safety)
 *
 * NEVER auto-enable from NODE_ENV. The flag is the only switch; a
 * `NODE_ENV=development` install can still be in real production
 * (= zero mock) mode.
 */

/**
 * Runtime state is retained only so an explicitly configured demo process
 * can stop/restart its runner without restarting the API. It is never allowed
 * to override production mode: `AGENTIC_DEMO_MODE=true` is the prerequisite
 * for every demo-mode entry point.
 */
let _runtimeOn = false;
let _runtimeOverrides: DemoOverrideRecord[] = [];

/**
 * Return whether the operator explicitly enabled demo mode in the environment.
 *
 * Deliberately do not accept broad truthy aliases such as `1` or `yes`. Demo
 * mode writes seed data and starts synthetic traffic, so ambiguous values must
 * fail closed to production.
 */
export function isDemoModeConfigured(): boolean {
  return process.env.AGENTIC_DEMO_MODE?.trim().toLowerCase() === "true";
}

/** Read the current mode. Runtime state can never override the env gate. */
export function isDemoMode(): boolean {
  return isDemoModeConfigured();
}

/** Is the runtime override currently active (vs. env-driven)? */
export function isRuntimeDemoActive(): boolean {
  return _runtimeOn;
}

/**
 * Compose a single-line marker for the boot log. Surfaces in stdout so
 * operators reading the dev console can confirm at a glance which mode the
 * api came up in. Format: `[bootstrap] demo mode: ON` or `OFF`.
 */
export function describeDemoMode(): string {
  return `[bootstrap] demo mode: ${isDemoMode() ? "ON" : "OFF"}`;
}

/**
 * Auto-applied env overrides when demo mode is ON. Called by bootstrap
 * BEFORE the LLM gateway is constructed (otherwise the gateway picks up
 * the original `.env` values and the demo would still bill OpenRouter).
 *
 * **Rationale.** The demo runner fires events every 30s; each event
 * triggers a manifest workflow that calls the configured LLM. With the
 * user's typical `.env` (LLM_DEFAULT_PROVIDER=openrouter), demo mode would
 * bleed real $ for free. Swapping in the `mock` provider keeps the
 * dashboard animated without external API hits.
 *
 * **Restore on flip-off is automatic** — this function only mutates
 * `process.env` in-process. The on-disk `.env` file is NEVER touched. So
 * setting `AGENTIC_DEMO_MODE=false` and restarting brings back the
 * original values from `.env` with zero cleanup needed.
 *
 * **Operator escape hatches** (if you genuinely want to test real LLM
 * calls under demo mode):
 *   - `AGENTIC_DEMO_LLM_PROVIDER=openrouter` → keep your real provider
 *   - `AGENTIC_DEMO_LLM_MODEL=...`           → keep your real model
 *
 * Both override the override.
 *
 * Returns a snapshot of what changed (for the boot log) so the operator
 * sees exactly which knobs flipped vs. their `.env`. No-op when the flag
 * is off.
 */
export interface DemoOverrideRecord {
  key: string;
  before: string | undefined;
  after: string;
}

export function applyDemoModeOverrides(): DemoOverrideRecord[] {
  if (!isDemoMode()) return [];
  return forceApplyDemoOverrides();
}

/**
 * Apply the same env swap as `applyDemoModeOverrides`. This low-level helper
 * does not inspect the mode flag; callers must first pass the explicit env
 * gate. It remains exported for the boot/runtime wiring and focused tests.
 */
function forceApplyDemoOverrides(): DemoOverrideRecord[] {
  const applied: DemoOverrideRecord[] = [];

  // LLM provider — swap to `mock` unless the operator explicitly opted
  // into a real provider under demo mode via AGENTIC_DEMO_LLM_PROVIDER.
  const wantProvider = process.env.AGENTIC_DEMO_LLM_PROVIDER?.trim() || "mock";
  const beforeProvider = process.env.LLM_DEFAULT_PROVIDER;
  if (beforeProvider !== wantProvider) {
    process.env.LLM_DEFAULT_PROVIDER = wantProvider;
    applied.push({
      key: "LLM_DEFAULT_PROVIDER",
      before: beforeProvider,
      after: wantProvider,
    });
  }

  const wantModel =
    process.env.AGENTIC_DEMO_LLM_MODEL?.trim() || "mock-model-v1";
  const beforeModel = process.env.LLM_DEFAULT_MODEL;
  if (beforeModel !== wantModel) {
    process.env.LLM_DEFAULT_MODEL = wantModel;
    applied.push({
      key: "LLM_DEFAULT_MODEL",
      before: beforeModel,
      after: wantModel,
    });
  }

  return applied;
}

/**
 * Activate runtime controls for an explicitly configured demo process and
 * stash the prior LLM env values so `deactivateRuntimeDemoMode()` can restore
 * them cleanly. This function fails closed when the explicit env gate is not
 * enabled, preventing future callers from bypassing production mode.
 */
export function activateRuntimeDemoMode(): DemoOverrideRecord[] {
  if (!isDemoModeConfigured()) {
    throw new Error(
      "demo mode is disabled; set AGENTIC_DEMO_MODE=true and restart the API",
    );
  }
  if (_runtimeOn) return _runtimeOverrides;
  _runtimeOn = true;
  _runtimeOverrides = forceApplyDemoOverrides();
  return _runtimeOverrides;
}

/**
 * Deactivate the runtime override and restore prior env values. Idempotent.
 * After this returns the caller MUST call `resetLLMGateway()` so the next
 * `getLLMGateway()` rebuilds with the restored provider.
 */
export function deactivateRuntimeDemoMode(): DemoOverrideRecord[] {
  if (!_runtimeOn) return [];
  const restored = _runtimeOverrides;
  for (const r of restored) {
    if (r.before === undefined) {
      delete process.env[r.key];
    } else {
      process.env[r.key] = r.before;
    }
  }
  _runtimeOn = false;
  _runtimeOverrides = [];
  return restored;
}

/** Format the override record for the boot log. */
export function describeDemoOverrides(applied: DemoOverrideRecord[]): string {
  if (applied.length === 0) return "";
  const items = applied
    .map(
      (r) =>
        `${r.key}=${r.after}${r.before !== undefined ? ` (was ${r.before})` : ""}`,
    )
    .join(", ");
  return `[bootstrap] demo overrides — ${items}`;
}
