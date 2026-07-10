/**
 * Demo mode flag — `AGENTIC_DEMO_MODE`.
 *
 * The architectural rule (locked 2026-05-26): production mode = ZERO mock
 * data, demo mode = seed + loop. Two clean states only. No "looks like
 * demo, actually mock fallback" ambiguity.
 *
 * - Default: `false` (production)
 * - Truthy:  `true`, `1`, `yes` (case-insensitive)
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

const TRUTHY = new Set(["true", "1", "yes"]);

/**
 * Runtime override — set by `POST /v1/demo/start` so the user can flip demo
 * mode ON from the UI without an api restart. Layered on top of the env
 * flag: a `true` here forces demo mode ON regardless of env; a `false`
 * (default) falls through to `AGENTIC_DEMO_MODE`. This means the env flag
 * remains the boot-time default, and `AGENTIC_DEMO_MODE=false` is the
 * recommended setting since the toggle then becomes the only way demo
 * traffic ever starts — matches the user requirement that demo must NEVER
 * run unless explicitly started from the UI.
 */
let _runtimeOn = false;
let _runtimeOverrides: DemoOverrideRecord[] = [];

/**
 * Whether `AGENTIC_DEMO_MODE` was truthy at PROCESS BOOT, captured once before any runtime toggle.
 * #NOMOCK — used to make a runtime swap-to-mock from a PRODUCTION boot LOUD, so a mock runtime can
 * never silently masquerade as real (the audit's "mock masquerading as real" hole).
 */
const _bootDemoMode: boolean = (() => {
  const raw = process.env.AGENTIC_DEMO_MODE;
  return !!raw && TRUTHY.has(raw.toLowerCase().trim());
})();

/** Read the current demo-mode state. Runtime toggle wins; falls through to env. */
export function isDemoMode(): boolean {
  if (_runtimeOn) return true;
  const raw = process.env.AGENTIC_DEMO_MODE;
  if (!raw) return false;
  return TRUTHY.has(raw.toLowerCase().trim());
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
 * Apply the same env swap as `applyDemoModeOverrides` but unconditional —
 * used by `POST /v1/demo/start` to flip overrides into place even though
 * `AGENTIC_DEMO_MODE` is `false` (production default). The route then
 * stashes the returned record so `POST /v1/demo/stop` can restore.
 */
export function forceApplyDemoOverrides(): DemoOverrideRecord[] {
  const applied: DemoOverrideRecord[] = [];

  // LLM provider — swap to `mock` unless the operator explicitly opted
  // into a real provider under demo mode via AGENTIC_DEMO_LLM_PROVIDER.
  const wantProvider =
    process.env.AGENTIC_DEMO_LLM_PROVIDER?.trim() || "mock";
  const beforeProvider = process.env.LLM_DEFAULT_PROVIDER;
  if (beforeProvider !== wantProvider) {
    process.env.LLM_DEFAULT_PROVIDER = wantProvider;
    applied.push({
      key: "LLM_DEFAULT_PROVIDER",
      before: beforeProvider,
      after: wantProvider,
    });
  }
  // #NOMOCK — a runtime swap to MOCK from a PRODUCTION boot (AGENTIC_DEMO_MODE=false) must be LOUD, so
  // it can never masquerade as real. /health also persistently surfaces llmGateway.mock=true. To run
  // demo with a real LLM instead, set AGENTIC_DEMO_LLM_PROVIDER=<real provider>.
  if (wantProvider === "mock" && !_bootDemoMode) {
    // eslint-disable-next-line no-console
    console.warn(
      "[demo-mode] ⚠️  运行时已把 LLM 网关切到 MOCK（回声、非真实模型），但本进程以生产模式启动（AGENTIC_DEMO_MODE=false）。" +
        "/health 的 llmGateway.mock=true 会持续暴露此状态；POST /v1/demo/stop 恢复。要在 demo 下用真实 LLM：设 AGENTIC_DEMO_LLM_PROVIDER。",
    );
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
 * Activate the runtime demo-mode override. Sets the flag so `isDemoMode()`
 * returns true, applies the env overrides (mock LLM by default), and
 * stashes the prior env values so `deactivateRuntimeDemoMode()` can
 * restore them cleanly. Idempotent — a second call while already active
 * returns the already-stashed records.
 */
export function activateRuntimeDemoMode(): DemoOverrideRecord[] {
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
