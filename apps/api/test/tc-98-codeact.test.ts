/**
 * TC-98 — #G: true CodeAct. The runtime EXECUTES a generated agent's AI-written `defineAgent`
 * handler (transpile + run with a controlled ctx), so "跑通" reflects the deployable code — not a
 * spec re-interpretation. Gated by FACTORY_EXEC_GENERATED; any failure falls back (returns null).
 */

import { describe, it, expect } from "vitest";
import { runGeneratedCode } from "@agentic/runtime";

const CODE = `
const SYSTEM_PROMPT = "decide";
export const myAgent = defineAgent({
  id: "my-agent", name: "My", actor: ["Agent"], trigger: ["IN"], emit: ["OUT"], tools: [], systemPrompt: SYSTEM_PROMPT,
  async handler(input, ctx) {
    await ctx.emit("OUT", { ...input, decided: true });
    return { ok: true, n: input.n + 1 };
  },
});
`;

// What codegen_agent actually instructs the LLM to write (import → export). The require shim must
// resolve `@agentic/runtime`'s defineAgent for this to run (review fix #1).
const CODE_WITH_IMPORT = `import { defineAgent } from "@agentic/runtime";\n` + CODE;

describe("TC-98: runGeneratedCode (#G true CodeAct)", () => {
  it("transpiles + runs the AI handler, capturing the emit + _emit branch hint", async () => {
    const r = await runGeneratedCode(CODE, { n: 41 });
    expect(r).not.toBeNull();
    expect(r!.data.n).toBe(42);
    expect(r!.data._emit).toBe("OUT");
    expect(r!.emitted[0]!.event).toBe("OUT");
    expect(r!.emitted[0]!.payload).toMatchObject({ decided: true });
  });

  it("runs IMPORT-having code (the real codegen shape: `import { defineAgent } from \"@agentic/runtime\"`)", async () => {
    const r = await runGeneratedCode(CODE_WITH_IMPORT, { n: 7 });
    expect(r).not.toBeNull();
    expect(r!.data.n).toBe(8);
    expect(r!.emitted[0]!.event).toBe("OUT");
  });

  it("ISOLATION: refuses to execute on a non-sandbox (production) tenant", async () => {
    expect(await runGeneratedCode(CODE_WITH_IMPORT, { n: 1 }, { tenantSlug: "raas" })).toBeNull();
    // a -sb sandbox tenant is allowed:
    expect(await runGeneratedCode(CODE_WITH_IMPORT, { n: 1 }, { tenantSlug: "agents-generation-sb" })).not.toBeNull();
  });

  it("respects the FACTORY_EXEC_GENERATED=0 kill switch", async () => {
    const old = process.env.FACTORY_EXEC_GENERATED;
    process.env.FACTORY_EXEC_GENERATED = "0";
    expect(await runGeneratedCode(CODE, { n: 1 })).toBeNull();
    if (old === undefined) delete process.env.FACTORY_EXEC_GENERATED;
    else process.env.FACTORY_EXEC_GENERATED = old;
  });

  it("falls back (null) when the code has no defineAgent handler", async () => {
    expect(await runGeneratedCode(`export const x = defineAgent({ id: "x", name: "x", actor: ["Agent"], trigger: [], emit: [] });`, {})).toBeNull();
  });

  it("falls back (null) on trivially-short / empty code", async () => {
    expect(await runGeneratedCode("nope", {})).toBeNull();
  });
});
