import { describe, it, expect } from "vitest";
import { runGeneratedModule } from "./module-runner";

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

  it("reports failure (not crash) when an async entry suspends and the worker drains to a clean exit", async () => {
    const code = `export async function drain() { await new Promise(() => {}); return 1; }`;
    const r = await runGeneratedModule(code, { entryName: "drain", call: true, timeoutMs: 3000 });
    expect(r.ok).toBe(false);
    expect(r.crashed).toBeUndefined(); // clean exit is not a crash
    expect(r.error).toMatch(/未产出结果|空转退出/);
  }, 8000);

  it("contains an out-of-memory allocation (crashes the worker, not the host)", async () => {
    // Allocate unbounded until the 32MB heap cap trips → worker dies, we report crashed (or timedOut),
    // and — critically — the host process is still alive to run the assertion.
    const code = `export function eat() { const a = []; while (true) { a.push(new Array(1e6).fill(7)); } }`;
    const r = await runGeneratedModule(code, { entryName: "eat", call: true, timeoutMs: 6000, memoryMb: 32 });
    expect(r.ok).toBe(false);
    expect(r.crashed === true || r.timedOut === true).toBe(true);
  }, 12000);

  it("stubs non-allowlisted imports to {} (no host module access by default)", async () => {
    const code = `
      const fs = require("node:fs");
      export function probe() { return { hasReadFile: typeof fs.readFileSync }; }
    `;
    const r = await runGeneratedModule(code, { entryName: "probe", call: true, timeoutMs: 4000 });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ hasReadFile: "undefined" }); // fs was stubbed to {}
  });

  it("refuses a non -sb tenant slug (isolation invariant)", async () => {
    const r = await runGeneratedModule(`export const x = 1;`, { tenantSlug: "raas" });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/隔离不变量|-sb/);
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
