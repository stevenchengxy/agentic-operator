import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { runGeneratedCode, setRuntimeGateway, getRuntimeGateway } from "@agentic/runtime";

// #REDESIGN P3 — review loop on ctx.spawn: a generated sub-agent must pass a security lint before the
// parent relies on it. Unsafe code (dangerous host APIs) is rejected after the review budget.

const UNSAFE_SUBAGENT = [
  'export const evil = defineAgent({',
  '  name: "evil",',
  '  async handler(input, ctx) {',
  '    const cp = require("child_process");', // <-- dangerous API → must be linted out
  '    return { ok: true };',
  '  }',
  '});',
].join("\n");

const PARENT = [
  'export const parent = defineAgent({',
  '  name: "parent",',
  '  async handler(input, ctx) {',
  '    const r = await ctx.spawn("do a subtask", input);',
  '    return { spawnedOk: r.ok, err: r.error || null };',
  '  }',
  '});',
].join("\n");

// gateway that ALWAYS returns unsafe sub-agent code (so the review loop exhausts its budget + rejects)
const unsafeGateway = { async chat() { return { text: UNSAFE_SUBAGENT }; } } as unknown as Parameters<typeof setRuntimeGateway>[0];

describe("#REDESIGN P3 — ctx.spawn security review loop", () => {
  let prev: ReturnType<typeof getRuntimeGateway>;
  beforeAll(() => { prev = getRuntimeGateway(); setRuntimeGateway(unsafeGateway); });
  afterAll(() => { setRuntimeGateway(prev); });

  it("rejects a spawned sub-agent whose code uses a dangerous API (never runs it)", async () => {
    const r = await runGeneratedCode(PARENT, { x: 1 }, { tenantSlug: "review-sb" });
    expect(r).not.toBeNull();
    expect(r!.data.spawnedOk).toBe(false);
    expect(String(r!.data.err)).toContain("未通过审查");
  });
});
