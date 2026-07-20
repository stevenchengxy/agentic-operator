import { describe, it, expect } from "vitest";
import { runGeneratedModule, GENERATED_CODE_ALLOWLIST } from "./module-runner";

// #P0a — the load-bearing safety proof: an arbitrary generated module runs in a worker isolate that is
// TIME- and MEMORY-bounded, so a runaway (sync loop, async hang, OOM) can never hang or crash the host.
// These run against a REAL worker_thread, so give the suite a little headroom.

describe("runGeneratedModule — isolated worker execution", () => {
  it("loads a module and finds its exports (probe, no call)", async () => {
    const code = `export function add(a, b) { return a + b; } export const meta = { name: "x" };`;
    const r = await runGeneratedModule(code, { timeoutMs: 4000 });
    expect(r.ok).toBe(true);
    expect(r.exportNames).toContain("add");
    expect(r.exportNames).toContain("meta");
    expect(r.exportName).toBe("add"); // first function export chosen as entry
  });

  it("invokes an arbitrary named export and returns its serialized result", async () => {
    const code = `export function greet(input) { return { msg: "hi " + input.who, n: input.n * 2 }; }`;
    const r = await runGeneratedModule(code, { entryName: "greet", call: true, input: { who: "sb", n: 21 }, timeoutMs: 4000 });
    expect(r.ok).toBe(true);
    expect(r.called).toBe(true);
    expect(r.result).toEqual({ msg: "hi sb", n: 42 });
  });

  it("supports multi-arg calls via args[]", async () => {
    const code = `export const mul = (a, b, c) => a * b * c;`;
    const r = await runGeneratedModule(code, { entryName: "mul", call: true, args: [2, 3, 4], timeoutMs: 4000 });
    expect(r.ok).toBe(true);
    expect(r.result).toBe(24);
  });

  it("captures a defineAgent handler as the entry", async () => {
    const code = `
      import { defineAgent } from "@agentic/runtime";
      export const a = defineAgent({ name: "sub", async handler(input) { return { ok: true, echo: input.x }; } });
    `;
    const r = await runGeneratedModule(code, { call: true, input: { x: 7 }, timeoutMs: 4000 });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ ok: true, echo: 7 });
  });

  it("TERMINATES a synchronous infinite loop via the wall-clock timeout (cannot hang the host)", async () => {
    const code = `export function boom() { while (true) { /* spin */ } }`;
    const t0 = Date.now();
    const r = await runGeneratedModule(code, { entryName: "boom", call: true, timeoutMs: 800 });
    const elapsed = Date.now() - t0;
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    // Proof the host was NOT blocked: this promise resolved shortly after the timeout, not "never".
    expect(elapsed).toBeLessThan(4000);
  }, 8000);

  it("TERMINATES a timer-backed async hang via the wall-clock (worker stays alive → timeout fires)", async () => {
    // A long pending timer keeps the worker's event loop ALIVE (unlike a bare never-resolving promise,
    // which just drains and exits) — so this genuinely exercises Worker.terminate() on timeout.
    const code = `export async function hang() { await new Promise((res) => setTimeout(res, 999999)); return 1; }`;
    const r = await runGeneratedModule(code, { entryName: "hang", call: true, timeoutMs: 800 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
  }, 8000);

  it("fails safely when an async entry suspends without backing work", async () => {
    const code = `export async function drain() { await new Promise(() => {}); return 1; }`;
    const r = await runGeneratedModule(code, { entryName: "drain", call: true, timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    // Depending on Node's worker/message-port lifecycle, a bare pending
    // promise either drains cleanly with no result or remains referenced until
    // the hard deadline. Both are explicit failure terminals; neither may be
    // translated into a successful placeholder result.
    expect(r.crashed).toBeUndefined();
    expect(
      r.timedOut === true || /未产出结果|空转退出/.test(r.error ?? ""),
    ).toBe(true);
  }, 8000);

  it("contains an out-of-memory allocation (crashes the worker, not the host)", async () => {
    // Allocate unbounded until the 32MB heap cap trips → worker dies, we report crashed (or timedOut),
    // and — critically — the host process is still alive to run the assertion.
    const code = `export function eat() { const a = []; while (true) { a.push(new Array(1e6).fill(7)); } }`;
    const r = await runGeneratedModule(code, { entryName: "eat", call: true, timeoutMs: 6000, memoryMb: 32 });
    expect(r.ok).toBe(false);
    expect(r.crashed === true || r.timedOut === true).toBe(true);
  }, 12000);

  it("rejects non-allowlisted imports instead of injecting a fake module", async () => {
    const code = `
      const fs = require("node:fs");
      export function probe() { return { hasReadFile: typeof fs.readFileSync }; }
    `;
    const r = await runGeneratedModule(code, { entryName: "probe", call: true, timeoutMs: 4000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not allowlisted/i);
  });

  it("resolves an allowlisted module for REAL (node:crypto createHash works)", async () => {
    const code = `
      import { createHash } from "node:crypto";
      export function digest(input) { return { sha: createHash("sha256").update(input.s).digest("hex") }; }
    `;
    const r = await runGeneratedModule(code, {
      entryName: "digest",
      call: true,
      input: { s: "abc" },
      allowlist: [...GENERATED_CODE_ALLOWLIST],
      timeoutMs: 4000,
    });
    expect(r.ok).toBe(true);
    expect(r.called).toBe(true);
    // Well-known sha256("abc") — proves the REAL node:crypto ran, not a {} stub.
    expect(r.result).toEqual({ sha: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
  });

  it("fails when an explicitly allowlisted dependency cannot be loaded", async () => {
    const missing = "__agentic_dependency_that_does_not_exist__";
    const code = `
      const dep = require(${JSON.stringify(missing)});
      export function probe() { return { loaded: typeof dep === "object" }; }
    `;
    const r = await runGeneratedModule(code, {
      entryName: "probe",
      call: true,
      allowlist: [missing],
      timeoutMs: 4_000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Cannot find module|cannot be found/i);
  });

  it("does not translate an unserializable return value into an ok placeholder", async () => {
    const code = `export function circular() { const out = {}; out.self = out; return out; }`;
    const r = await runGeneratedModule(code, {
      entryName: "circular",
      call: true,
      timeoutMs: 4_000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not JSON-serializable/i);
    expect(r.result).toBeUndefined();
  });

  it("keeps node:fs denied even WITH the curated allowlist (no I/O reach)", async () => {
    const code = `
      const fs = require("node:fs");
      export function probe() { return { hasReadFile: typeof fs.readFileSync }; }
    `;
    const r = await runGeneratedModule(code, {
      entryName: "probe",
      call: true,
      allowlist: [...GENERATED_CODE_ALLOWLIST],
      timeoutMs: 4000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not allowlisted/i);
    // And the curated list itself never contains an I/O-capable module.
    for (const banned of ["node:fs", "fs", "node:net", "net", "node:child_process", "child_process", "node:http", "http", "node:https", "https", "node:os", "os"]) {
      expect(GENERATED_CODE_ALLOWLIST).not.toContain(banned);
    }
  });

  it("fails SAFELY (structured error, host alive) before denied fs can be called", async () => {
    const code = `
      const fs = require("node:fs");
      export function readEtc() { return fs.readFileSync("/etc/hosts", "utf8"); }
    `;
    const r = await runGeneratedModule(code, {
      entryName: "readEtc",
      call: true,
      allowlist: [...GENERATED_CODE_ALLOWLIST],
      timeoutMs: 4000,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not allowlisted/i); // reported as a structured error, never a host throw
  });

  it("refuses a non -sb tenant slug (isolation invariant)", async () => {
    const r = await runGeneratedModule(`export const x = 1;`, { tenantSlug: "raas" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/隔离不变量|-sb/);
  });

  it("does not treat an arbitrary production tenant ending in -sb as a sandbox", async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const legacySuffix = await runGeneratedModule(`export const x = 1;`, {
        tenantSlug: "customer-sb",
      });
      expect(legacySuffix.ok).toBe(false);
      expect(legacySuffix.error).toMatch(/隔离不变量/);

      const ephemeral = await runGeneratedModule(`export const x = 1;`, {
        tenantSlug: "af-sbx-1234abcd-5678efab-123456789abc-sb",
      });
      expect(ephemeral.ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("honors the FACTORY_EXEC_GENERATED=0 kill switch", async () => {
    const prev = process.env.FACTORY_EXEC_GENERATED;
    process.env.FACTORY_EXEC_GENERATED = "0";
    try {
      const r = await runGeneratedModule(`export const x = 1;`, {});
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/FACTORY_EXEC_GENERATED/);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_EXEC_GENERATED;
      else process.env.FACTORY_EXEC_GENERATED = prev;
    }
  });

  it("reports a clean error for a module that throws at load", async () => {
    const code = `throw new Error("boom at load"); export const x = 1;`;
    const r = await runGeneratedModule(code, { timeoutMs: 4000 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/boom at load/);
  });
});
