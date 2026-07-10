/**
 * TC-53 — `assertAuthModeSafe` boot guard (P5-TEN-01).
 *
 * Principal Engineer review flagged this as the single biggest production
 * footgun: `AUTH_MODE=dev` + `NODE_ENV=production` plus the default
 * `AGENTIC_DEV_TENANT=raas` makes every unauthenticated request the raas
 * tenant admin.
 *
 * The guard at `apps/api/src/plugins/auth.ts:assertAuthModeSafe` fires at
 * `registerAuth` time (boot). This test exercises the pure function directly
 * by toggling env vars, so we don't have to stand up a full Fastify instance
 * just to assert a boot-time throw.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Import the module under test fresh each time so env-var reads happen
// at the function call (the guard reads process.env at call time, not at
// module load, so this is mostly belt-and-suspenders).
async function loadGuard(): Promise<() => void> {
  const mod = await import("../src/plugins/auth");
  // assertAuthModeSafe is module-private; we expose it via the side effect of
  // registerAuth. To avoid touching Fastify we re-implement the env check
  // here as a smoke test, then assert the side effect via registerAuth on a
  // tiny stub. The behavior under test is the env-var combination check.
  void mod;
  // Direct re-import of the guard function. We keep this indirection so a
  // future refactor that exports `assertAuthModeSafe` doesn't break the test.
  const direct = await import("../src/plugins/auth");
  // @ts-expect-error — registerAuth is the public surface; we call it
  // against a minimal mock to trigger the guard.
  return async function callGuardViaRegister() {
    const stub = {
      addHook: (_phase: string, _fn: () => unknown) => undefined,
    };
    await direct.registerAuth(stub as never);
  };
}

const saved: Record<string, string | undefined> = {};

function snapshotEnv() {
  saved.AUTH_MODE = process.env.AUTH_MODE;
  saved.NODE_ENV = process.env.NODE_ENV;
  saved.AGENTIC_DEV_TENANT = process.env.AGENTIC_DEV_TENANT;
  saved.AUTH_SESSION_SECRET = process.env.AUTH_SESSION_SECRET;
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe("TC-53: assertAuthModeSafe boot guard", () => {
  beforeEach(() => snapshotEnv());
  afterEach(() => restoreEnv());

  it("refuses to start when AUTH_MODE=dev + NODE_ENV=production", async () => {
    process.env.AUTH_MODE = "dev";
    process.env.NODE_ENV = "production";
    process.env.AGENTIC_DEV_TENANT = "raas";

    const callGuard = await loadGuard();
    await expect(callGuard()).rejects.toThrow(
      /AUTH_MODE=dev is incompatible with NODE_ENV=production/,
    );
  });

  it("refuses to start when AUTH_MODE=dev but AGENTIC_DEV_TENANT doesn't exist", async () => {
    process.env.AUTH_MODE = "dev";
    process.env.NODE_ENV = "test"; // bypass the production block
    process.env.AGENTIC_DEV_TENANT = "does-not-exist-xyz";

    const callGuard = await loadGuard();
    await expect(callGuard()).rejects.toThrow(
      /AGENTIC_DEV_TENANT to match an existing tenant slug/,
    );
  });

  it("allows boot when AUTH_MODE=dev + valid tenant + non-prod env", async () => {
    process.env.AUTH_MODE = "dev";
    process.env.NODE_ENV = "test";
    process.env.AGENTIC_DEV_TENANT = "__system";

    const callGuard = await loadGuard();
    await expect(callGuard()).resolves.toBeUndefined();
  });

  it("allows boot when AUTH_MODE is unset (bearer-only mode)", async () => {
    delete process.env.AUTH_MODE;
    process.env.NODE_ENV = "production";
    // #AUDIT-FIX(P0-07) — production now requires a real ≥32-byte session secret (else session
    // signatures are forgeable). A prod bearer-only boot is only safe WITH such a secret configured.
    process.env.AUTH_SESSION_SECRET = "a-32-byte-or-longer-random-secret-value";

    const callGuard = await loadGuard();
    await expect(callGuard()).resolves.toBeUndefined();
  });

  it("refuses to start in production when AUTH_SESSION_SECRET is missing (P0-07)", async () => {
    delete process.env.AUTH_MODE;
    process.env.NODE_ENV = "production";
    delete process.env.AUTH_SESSION_SECRET;

    const callGuard = await loadGuard();
    await expect(callGuard()).rejects.toThrow(/session secret|会话签名|AUTH_SESSION_SECRET/);
  });
});
