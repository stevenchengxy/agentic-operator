import { describe, it, expect } from "vitest";
import {
  runGeneratedModuleProcess,
  scrubEnv,
  DEFAULT_ENV_ALLOWLIST,
  SECRET_ENV_PATTERN,
} from "./module-runner-proc";

// #P6-1 — the stronger-isolation proof: generated code runs in a SEPARATE OS process whose env has been
// scrubbed of every real credential, in a throwaway cwd, under a SIGKILL wall-clock + memory cap + a ban
// on runtime string code-gen. The scrubEnv unit tests are pure/fast; the child-process tests fork a real
// node process (transpile TS → vm.compileFunction → run), so give them headroom.

describe("scrubEnv — pure secret-stripping (whitelist + blacklist)", () => {
  it("strips every secret-shaped var (case- and substring-insensitive) and keeps whitelisted plain vars", () => {
    const input = {
      // whitelisted, non-secret → KEPT
      PATH: "/usr/bin:/bin",
      NODE_ENV: "production",
      HOME: "/home/agent",
      // secrets → STRIPPED (each matches the deny pattern via a substring, any case)
      custom_llm_api_key: "sk-lower", // _api_ + key + custom_llm
      ROBOHIRE_API_KEY: "rh-live", // robohire + _api_ + key
      AUTH_SESSION_SECRET: "sess", // auth + secret
      ANTHROPIC_API_KEY: "sk-ant", // _api_ + key
      OPENAI_TOKEN: "tok", // token
      DATABASE_URL: "postgres://u:p@h/db", // database
      MY_PASSWORD: "hunter2", // password
      SOME_CREDENTIAL: "cred", // credential
    };
    const out = scrubEnv(input);

    // whitelisted plain vars survive
    expect(out.PATH).toBe("/usr/bin:/bin");
    expect(out.NODE_ENV).toBe("production");
    expect(out.HOME).toBe("/home/agent");

    // every secret is gone
    for (const secret of [
      "custom_llm_api_key",
      "ROBOHIRE_API_KEY",
      "AUTH_SESSION_SECRET",
      "ANTHROPIC_API_KEY",
      "OPENAI_TOKEN",
      "DATABASE_URL",
      "MY_PASSWORD",
      "SOME_CREDENTIAL",
    ]) {
      expect(out).not.toHaveProperty(secret);
    }
  });

  it("drops a non-secret var that is not on the whitelist (whitelist is primary)", () => {
    const out = scrubEnv({ PATH: "/bin", RANDOM_FEATURE_FLAG: "on" });
    expect(out.PATH).toBe("/bin");
    expect(out).not.toHaveProperty("RANDOM_FEATURE_FLAG"); // not secret, but not whitelisted → dropped
  });

  it("blacklist BEATS whitelist — a secret-shaped name is stripped even when explicitly allowed", () => {
    const out = scrubEnv(
      { PATH: "/bin", TENANT_API_KEY: "leak" },
      { allowExtra: ["TENANT_API_KEY"] }, // caller tries to allow it…
    );
    expect(out.PATH).toBe("/bin");
    expect(out).not.toHaveProperty("TENANT_API_KEY"); // …but the deny pattern still wins
  });

  it("skips unset (undefined) vars and never mutates its input", () => {
    const input: Record<string, string | undefined> = { PATH: "/bin", TZ: undefined };
    const out = scrubEnv(input);
    expect(out.PATH).toBe("/bin");
    expect(out).not.toHaveProperty("TZ");
    expect(input).toEqual({ PATH: "/bin", TZ: undefined }); // input untouched
  });

  it("exposes a sane default allowlist and secret pattern", () => {
    expect(DEFAULT_ENV_ALLOWLIST).toContain("PATH");
    expect(DEFAULT_ENV_ALLOWLIST).toContain("NODE_ENV");
    // the pattern the task pins down
    for (const s of ["ANY_KEY", "X_TOKEN", "A_SECRET", "DB_PASSWORD", "X_CREDENTIAL", "FOO_API_BAR", "CUSTOM_LLM_X", "ROBOHIRE_X", "X_AUTH", "DATABASE_X"]) {
      expect(SECRET_ENV_PATTERN.test(s)).toBe(true);
    }
    expect(SECRET_ENV_PATTERN.test("PATH")).toBe(false);
    expect(SECRET_ENV_PATTERN.test("NODE_ENV")).toBe(false);
  });
});

describe("runGeneratedModuleProcess — child-process isolation", () => {
  it("truly executes a generated `add` export in a child process and returns 3", async () => {
    const code = `export function add(a, b) { return a + b; }`;
    const r = await runGeneratedModuleProcess(code, { entryName: "add", call: true, args: [2, 1], timeoutMs: 12000 });
    expect(r.ok).toBe(true);
    expect(r.called).toBe(true);
    expect(r.exportName).toBe("add");
    expect(r.result).toBe(3);
  }, 20000);

  it("cannot read a scrubbed secret — process.env.ROBOHIRE_API_KEY is undefined in the child", async () => {
    // Plant a live-looking credential in THIS process's env; the child must NOT inherit it.
    const prev = process.env.ROBOHIRE_API_KEY;
    process.env.ROBOHIRE_API_KEY = "super-secret-live-key";
    try {
      const code = `export function probe() {
        return {
          robohire: typeof process.env.ROBOHIRE_API_KEY,        // must be "undefined"
          hasPath: typeof process.env.PATH === "string",         // whitelisted → present
        };
      }`;
      const r = await runGeneratedModuleProcess(code, { entryName: "probe", call: true, timeoutMs: 12000 });
      expect(r.ok).toBe(true);
      expect(r.result).toEqual({ robohire: "undefined", hasPath: true });
    } finally {
      if (prev === undefined) delete process.env.ROBOHIRE_API_KEY;
      else process.env.ROBOHIRE_API_KEY = prev;
    }
  }, 20000);

  it("rejects a non-allowlisted dependency instead of injecting a fake module", async () => {
    const code = `const fs = require("node:fs"); export function probe() { return typeof fs.readFileSync; }`;
    const r = await runGeneratedModuleProcess(code, {
      entryName: "probe",
      call: true,
      timeoutMs: 12_000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not allowlisted/i);
  }, 20_000);

  it("fails when an explicitly allowlisted dependency cannot be loaded", async () => {
    const missing = "__agentic_dependency_that_does_not_exist__";
    const code = `const dep = require(${JSON.stringify(missing)}); export function probe() { return !!dep; }`;
    const r = await runGeneratedModuleProcess(code, {
      entryName: "probe",
      call: true,
      allowlist: [missing],
      timeoutMs: 12_000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Cannot find module|cannot be found/i);
  }, 20_000);

  it("reports an unserializable return value as failure", async () => {
    const code = `export function circular() { const out = {}; out.self = out; return out; }`;
    const r = await runGeneratedModuleProcess(code, {
      entryName: "circular",
      call: true,
      timeoutMs: 12_000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not JSON-serializable/i);
    expect(r.result).toBeUndefined();
  }, 20_000);

  it("SIGKILLs a synchronous infinite loop at the wall-clock deadline (cannot hang the host)", async () => {
    const code = `export function boom() { while (true) { /* spin */ } }`;
    const t0 = Date.now();
    const r = await runGeneratedModuleProcess(code, { entryName: "boom", call: true, timeoutMs: 1200 });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    // Proof the host was NOT blocked: this resolved shortly after the deadline, not "never".
    expect(elapsed).toBeLessThan(6000);
  }, 20000);

  it("refuses a non -sb tenant slug (isolation invariant, no process spawned)", async () => {
    const r = await runGeneratedModuleProcess(`export const x = 1;`, { tenantSlug: "raas" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/隔离不变量|-sb/);
  });

  it("honors the FACTORY_EXEC_GENERATED=0 kill switch", async () => {
    const prev = process.env.FACTORY_EXEC_GENERATED;
    process.env.FACTORY_EXEC_GENERATED = "0";
    try {
      const r = await runGeneratedModuleProcess(`export const x = 1;`, {});
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/FACTORY_EXEC_GENERATED/);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_EXEC_GENERATED;
      else process.env.FACTORY_EXEC_GENERATED = prev;
    }
  });
});
