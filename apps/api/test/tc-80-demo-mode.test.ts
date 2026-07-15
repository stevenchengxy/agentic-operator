/**
 * TC-80 — AGENTIC_DEMO_MODE (locked 2026-05-26).
 *
 * The architectural rule: production mode = ZERO mock/seed data, demo mode
 * = seed + loop. This test exercises the contract from a few angles:
 *
 *   1. `isDemoMode()` truthiness logic (case + whitespace tolerant).
 *   2. The demo-runner is a no-op when NODE_ENV=test (defense in depth so
 *      vitest never sees background interval traffic regardless of the flag).
 *   3. The demo-runner is a no-op when the flag is off, even outside test.
 *   4. With the flag on (and NODE_ENV temporarily unset) the runner spins
 *      up — and a `stop()` returns it cleanly to idle.
 *   5. `/health` surfaces a stable `demoMode` boolean so the web sidebar
 *      can render the "DEMO" pill without reading server env.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  _getDemoRunnerForTests,
  startDemoRunner,
} from "../src/services/demo-runner.js";
import {
  activateRuntimeDemoMode,
  deactivateRuntimeDemoMode,
  describeDemoMode,
  isDemoMode,
  isDemoModeConfigured,
  isRuntimeDemoActive,
} from "../src/config/demo-mode.js";
import { buildTestEnv, type TestEnv } from "./harness.js";

const NULL_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe("TC-80: AGENTIC_DEMO_MODE", () => {
  // Snapshot env so per-it() mutation doesn't leak.
  const savedFlag = process.env.AGENTIC_DEMO_MODE;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedProvider = process.env.LLM_DEFAULT_PROVIDER;
  const savedModel = process.env.LLM_DEFAULT_MODEL;

  afterEach(() => {
    if (savedFlag === undefined) delete process.env.AGENTIC_DEMO_MODE;
    else process.env.AGENTIC_DEMO_MODE = savedFlag;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    // Belt-and-braces: never leave a runner active or runtime override
    // sticky across cases.
    const active = _getDemoRunnerForTests();
    if (active) active.stop();
    if (isRuntimeDemoActive()) deactivateRuntimeDemoMode();
    if (savedProvider === undefined) delete process.env.LLM_DEFAULT_PROVIDER;
    else process.env.LLM_DEFAULT_PROVIDER = savedProvider;
    if (savedModel === undefined) delete process.env.LLM_DEFAULT_MODEL;
    else process.env.LLM_DEFAULT_MODEL = savedModel;
  });

  describe("runtime controls (POST /v1/demo/start path)", () => {
    it("cannot activate unless AGENTIC_DEMO_MODE=true is explicit", () => {
      delete process.env.AGENTIC_DEMO_MODE;
      process.env.LLM_DEFAULT_PROVIDER = "openrouter";
      process.env.LLM_DEFAULT_MODEL = "google/gemini-3.1-flash-lite-preview";

      expect(isDemoMode()).toBe(false);
      expect(() => activateRuntimeDemoMode()).toThrow(
        "set AGENTIC_DEMO_MODE=true",
      );
      expect(isRuntimeDemoActive()).toBe(false);
      expect(process.env.LLM_DEFAULT_PROVIDER).toBe("openrouter");
      expect(process.env.LLM_DEFAULT_MODEL).toBe(
        "google/gemini-3.1-flash-lite-preview",
      );
    });

    it("activate stashes prior env after the explicit gate is enabled", () => {
      process.env.AGENTIC_DEMO_MODE = "true";
      process.env.LLM_DEFAULT_PROVIDER = "openrouter";
      process.env.LLM_DEFAULT_MODEL = "google/gemini-3.1-flash-lite-preview";

      const applied = activateRuntimeDemoMode();
      expect(isRuntimeDemoActive()).toBe(true);
      expect(isDemoMode()).toBe(true);
      expect(process.env.LLM_DEFAULT_PROVIDER).toBe("mock");
      expect(process.env.LLM_DEFAULT_MODEL).toBe("mock-model-v1");
      // Records carry the prior values so a deactivate can restore.
      const providerRec = applied.find((r) => r.key === "LLM_DEFAULT_PROVIDER");
      expect(providerRec?.before).toBe("openrouter");
    });

    it("deactivate restores prior env and clears the runtime flag", () => {
      process.env.AGENTIC_DEMO_MODE = "true";
      process.env.LLM_DEFAULT_PROVIDER = "openrouter";
      process.env.LLM_DEFAULT_MODEL = "google/gemini-3.1-flash-lite-preview";

      activateRuntimeDemoMode();
      expect(process.env.LLM_DEFAULT_PROVIDER).toBe("mock");

      deactivateRuntimeDemoMode();
      expect(isRuntimeDemoActive()).toBe(false);
      expect(isDemoMode()).toBe(true);
      expect(process.env.LLM_DEFAULT_PROVIDER).toBe("openrouter");
      expect(process.env.LLM_DEFAULT_MODEL).toBe(
        "google/gemini-3.1-flash-lite-preview",
      );
    });

    it("second activate while already on is a no-op (idempotent)", () => {
      process.env.AGENTIC_DEMO_MODE = "true";
      process.env.LLM_DEFAULT_PROVIDER = "openrouter";

      const first = activateRuntimeDemoMode();
      const second = activateRuntimeDemoMode();
      expect(second).toBe(first);
      // And the stashed `before` value must NOT mutate to "mock" on the
      // second call — otherwise deactivate would put "mock" back instead
      // of the real provider.
      const rec = second.find((r) => r.key === "LLM_DEFAULT_PROVIDER");
      expect(rec?.before).toBe("openrouter");
    });
  });

  describe("isDemoMode()", () => {
    it("is false by default (undefined env)", () => {
      delete process.env.AGENTIC_DEMO_MODE;
      expect(isDemoMode()).toBe(false);
    });

    it("accepts only an explicit true value (case-insensitive)", () => {
      for (const v of ["true", "TRUE", "  True "]) {
        process.env.AGENTIC_DEMO_MODE = v;
        expect(isDemoModeConfigured()).toBe(true);
        expect(isDemoMode()).toBe(true);
      }
    });

    it("fails closed for aliases and all non-true values", () => {
      for (const v of ["false", "1", "yes", "0", "no", "off", "maybe", ""]) {
        process.env.AGENTIC_DEMO_MODE = v;
        expect(isDemoModeConfigured()).toBe(false);
        expect(isDemoMode()).toBe(false);
      }
    });

    it("describeDemoMode prints a single-line marker", () => {
      process.env.AGENTIC_DEMO_MODE = "true";
      expect(describeDemoMode()).toBe("[bootstrap] demo mode: ON");
      process.env.AGENTIC_DEMO_MODE = "false";
      expect(describeDemoMode()).toBe("[bootstrap] demo mode: OFF");
    });
  });

  describe("startDemoRunner — no-op gates", () => {
    it("is a no-op when AGENTIC_DEMO_MODE is off, even outside NODE_ENV=test", () => {
      process.env.AGENTIC_DEMO_MODE = "false";
      const savedTestEnv = process.env.NODE_ENV;
      delete process.env.NODE_ENV; // bypass the test-mode gate too
      try {
        const r = startDemoRunner(NULL_LOGGER);
        expect(r.running).toBe(false);
        expect(_getDemoRunnerForTests()).toBeNull();
      } finally {
        if (savedTestEnv !== undefined) process.env.NODE_ENV = savedTestEnv;
      }
    });

    it("is a no-op when NODE_ENV=test, even with the flag ON (vitest safety)", () => {
      process.env.AGENTIC_DEMO_MODE = "true";
      process.env.NODE_ENV = "test";
      const r = startDemoRunner(NULL_LOGGER);
      expect(r.running).toBe(false);
      expect(_getDemoRunnerForTests()).toBeNull();
    });
  });

  describe("startDemoRunner — happy path (flag on, NODE_ENV bypass)", () => {
    it("spins up the runner and stop() returns to idle", () => {
      process.env.AGENTIC_DEMO_MODE = "true";
      // Manually clear test gate so the runner actually starts. The afterEach
      // restores both env vars to their snapshot state.
      delete process.env.NODE_ENV;

      const r = startDemoRunner(NULL_LOGGER);
      expect(r.running).toBe(true);
      const active = _getDemoRunnerForTests();
      expect(active).not.toBeNull();
      expect(active!.state.eventsFired).toBe(0);
      expect(active!.state.tasksResolved).toBe(0);

      r.stop();
      expect(_getDemoRunnerForTests()).toBeNull();
    });

    it("second start() while already running returns the same handle", () => {
      process.env.AGENTIC_DEMO_MODE = "true";
      delete process.env.NODE_ENV;
      const first = startDemoRunner(NULL_LOGGER);
      const second = startDemoRunner(NULL_LOGGER);
      expect(first.running).toBe(true);
      expect(second.running).toBe(true);
      first.stop();
      // Second handle stops the same loop — calling it again is a no-op
      // (already cleared in afterEach guard above).
      second.stop();
      expect(_getDemoRunnerForTests()).toBeNull();
    });
  });

  describe("production HTTP surfaces", () => {
    let env: TestEnv;
    beforeAll(async () => {
      env = await buildTestEnv();
    });
    afterAll(async () => {
      await env.cleanup();
    });

    it("returns a stable boolean (matches isDemoMode at request time)", async () => {
      const res = await env.fetch("/health");
      expect([200, 503]).toContain(res.status);
      const body = (await res.json()) as { demoMode?: boolean };
      // setup.ts pins NODE_ENV=test and never sets AGENTIC_DEMO_MODE, so
      // demoMode should be `false` in this run regardless of the user's
      // env.local. We assert the type more than the value to keep the
      // test robust if a future contributor flips the test-time default.
      expect(typeof body.demoMode).toBe("boolean");
      expect(body.demoMode).toBe(false);
    });

    it("reports demo status as off without starting anything", async () => {
      delete process.env.AGENTIC_DEMO_MODE;

      const res = await env.fetch("/v1/demo/status");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        data?: {
          demoMode: boolean;
          running: boolean;
          runtimeOverride: boolean;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.data).toMatchObject({
        demoMode: false,
        running: false,
        runtimeOverride: false,
      });
      expect(_getDemoRunnerForTests()).toBeNull();
    });

    it("rejects POST /demo/start when the explicit env gate is off", async () => {
      delete process.env.AGENTIC_DEMO_MODE;
      process.env.NODE_ENV = "development"; // exercise the production gate, not the test gate
      process.env.LLM_DEFAULT_PROVIDER = "openrouter";
      process.env.LLM_DEFAULT_MODEL = "production-model";

      const res = await env.fetch("/v1/demo/start", { method: "POST" });
      expect(res.status).toBe(409);
      const body = (await res.json()) as {
        ok: boolean;
        error?: { code: string; message: string };
      };
      expect(body).toMatchObject({
        ok: false,
        error: { code: "demo_disabled" },
      });
      expect(process.env.LLM_DEFAULT_PROVIDER).toBe("openrouter");
      expect(process.env.LLM_DEFAULT_MODEL).toBe("production-model");
      expect(isRuntimeDemoActive()).toBe(false);
      expect(_getDemoRunnerForTests()).toBeNull();
    });
  });
});
