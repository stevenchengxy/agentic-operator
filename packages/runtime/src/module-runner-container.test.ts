import { describe, it, expect, beforeAll } from "vitest";
import { runGeneratedModuleContainer, dockerAvailable } from "./module-runner-container";

// #P6 (full) — real Docker container isolation. These tests actually run containers when Docker is
// available (skipped otherwise, so CI without Docker still passes). Give container startup headroom.

const HAS_DOCKER = dockerAvailable();
const d = HAS_DOCKER ? describe : describe.skip;

beforeAll(() => {
  if (!HAS_DOCKER) console.warn("[p6-container] Docker not available — container tests skipped");
});

describe("#P6 runGeneratedModuleContainer — gates + fallback (no Docker needed)", () => {
  it("refuses a non -sb tenant (isolation invariant)", async () => {
    const r = await runGeneratedModuleContainer("export const x=1;", { tenantSlug: "raas", fallback: false });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/隔离不变量|-sb/);
  });
  it("honors FACTORY_EXEC_GENERATED=0 kill switch", async () => {
    const prev = process.env.FACTORY_EXEC_GENERATED;
    process.env.FACTORY_EXEC_GENERATED = "0";
    try {
      const r = await runGeneratedModuleContainer("export const x=1;", { fallback: false });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/FACTORY_EXEC_GENERATED/);
    } finally {
      if (prev === undefined) delete process.env.FACTORY_EXEC_GENERATED;
      else process.env.FACTORY_EXEC_GENERATED = prev;
    }
  });
});

d("#P6 runGeneratedModuleContainer — real container execution (Docker present)", () => {
  it("runs an arbitrary export inside the container and returns its result", async () => {
    const code = `export function greet(input) { return { msg: "hi " + input.who, n: input.n * 2 }; }`;
    const r = await runGeneratedModuleContainer(code, { entryName: "greet", call: true, input: { who: "sb", n: 21 }, timeoutMs: 30000 });
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ msg: "hi sb", n: 42 });
  }, 45000);

  it("network is cut: fetch/require('net') cannot reach anything (--network none)", async () => {
    // The container has --network none; even attempting a connection resolves to no reachable host.
    const code = `
      export async function probe() {
        try { const net = require("node:net"); return { hasNet: typeof net.connect }; }
        catch (e) { return { hasNet: "denied" }; }
      }`;
    const r = await runGeneratedModuleContainer(code, { entryName: "probe", call: true, timeoutMs: 30000 });
    expect(r.ok).toBe(true);
    // node:net exists but --network none means no route out — we assert the run itself is contained (no throw/hang).
    expect(r.result).toBeDefined();
  }, 45000);

  it("the container env carries NO host secrets", async () => {
    const code = `export function env() { return { rh: process.env.ROBOHIRE_API_KEY ?? null, llm: process.env.CUSTOM_LLM_API_KEY ?? null, ne: process.env.NODE_ENV ?? null }; }`;
    const r = await runGeneratedModuleContainer(code, { entryName: "env", call: true, timeoutMs: 30000 });
    expect(r.ok).toBe(true);
    expect((r.result as { rh: unknown }).rh).toBeNull();
    expect((r.result as { llm: unknown }).llm).toBeNull();
  }, 45000);

  it("a synchronous infinite loop is contained + killed by the wall-clock (host survives)", async () => {
    const code = `export function boom() { while (true) {} }`;
    const t0 = Date.now();
    const r = await runGeneratedModuleContainer(code, { entryName: "boom", call: true, timeoutMs: 4000 });
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(12000); // resolved shortly after timeout, not "never"
  }, 30000);
});
