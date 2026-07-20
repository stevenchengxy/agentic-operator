/**
 * TC-98 — #G: the runtime executes a generated agent's AI-written `defineAgent`
 * handler through the production one-shot-container protocol. The injected
 * transport is intentionally test-only and does not itself constitute
 * promotable isolation evidence. Gated by FACTORY_EXEC_GENERATED; any failure
 * falls back (returns null).
 */

import { afterAll, beforeAll, describe, it, expect } from "vitest";
import { runGeneratedCode } from "@agentic/runtime";
import { codeActContainerTestOptions } from "./codeact-container-test-transport";

const FACTORY_SANDBOX = {
  tenantSlug: "af-sbx-98c0deac-7e57c0de-123456789abc-sb",
  tenantId: "ten-codeact-98-sandbox",
  factoryExecutionScope: {
    kind: "sandbox" as const,
    target_domain_id: "Agents-generation",
    candidate_fingerprint: "candidate:tc-98-codeact",
    attempt_id: "98c0deac-7e57-4c0d-a123-123456789abc",
  },
};

// These are low-level executor-kernel tests. Durable attempt/app/tenant
// binding is enforced before this API is reached and has separate register and
// sandbox-dispatch coverage; this suite never treats its fixture as an
// authorization receipt.
function sandboxExecutorOptions() {
  return {
    ...FACTORY_SANDBOX,
    ...codeActContainerTestOptions(),
  };
}

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

describe.sequential("TC-98: runGeneratedCode (#G true CodeAct)", () => {
  const previousGenerated = process.env.FACTORY_EXEC_GENERATED;

  beforeAll(() => {
    // The production switch remains fail-closed. This suite opts in only while
    // injecting the one-shot container protocol's test transport.
    process.env.FACTORY_EXEC_GENERATED = "1";
  });

  afterAll(() => {
    if (previousGenerated === undefined) delete process.env.FACTORY_EXEC_GENERATED;
    else process.env.FACTORY_EXEC_GENERATED = previousGenerated;
  });

  it("transpiles + runs the AI handler, capturing the emit + _emit branch hint", async () => {
    const r = await runGeneratedCode(CODE, { n: 41 }, sandboxExecutorOptions());
    expect(r).not.toBeNull();
    expect(r!.data.n).toBe(42);
    expect(r!.data._emit).toBe("OUT");
    expect(r!.emitted[0]!.event).toBe("OUT");
    expect(r!.emitted[0]!.payload).toMatchObject({ decided: true });
  });

  it("runs IMPORT-having code (the real codegen shape: `import { defineAgent } from \"@agentic/runtime\"`)", async () => {
    const r = await runGeneratedCode(CODE_WITH_IMPORT, { n: 7 }, sandboxExecutorOptions());
    expect(r).not.toBeNull();
    expect(r!.data.n).toBe(8);
    expect(r!.emitted[0]!.event).toBe("OUT");
  });

  it("ISOLATION: refuses to execute on a non-sandbox (production) tenant", async () => {
    expect(await runGeneratedCode(CODE_WITH_IMPORT, { n: 1 }, {
      tenantSlug: "raas",
      tenantId: "ten-raas",
      ...codeActContainerTestOptions(),
    })).toBeNull();
    // Only the nonce-bearing Factory sandbox identity is used for the positive
    // path. A suffix such as arbitrary-tenant-sb is not an authorization fact.
    expect(await runGeneratedCode(
      CODE_WITH_IMPORT,
      { n: 1 },
      sandboxExecutorOptions(),
    )).not.toBeNull();
  });

  it("respects the FACTORY_EXEC_GENERATED=0 kill switch", async () => {
    const old = process.env.FACTORY_EXEC_GENERATED;
    process.env.FACTORY_EXEC_GENERATED = "0";
    expect(await runGeneratedCode(CODE, { n: 1 }, sandboxExecutorOptions())).toBeNull();
    if (old === undefined) delete process.env.FACTORY_EXEC_GENERATED;
    else process.env.FACTORY_EXEC_GENERATED = old;
  });

  it("falls back (null) when the code has no defineAgent handler", async () => {
    expect(await runGeneratedCode(
      `export const x = defineAgent({ id: "x", name: "x", actor: ["Agent"], trigger: [], emit: [] });`,
      {},
      sandboxExecutorOptions(),
    )).toBeNull();
  });

  it("falls back (null) on trivially-short / empty code", async () => {
    expect(await runGeneratedCode("nope", {}, sandboxExecutorOptions())).toBeNull();
  });
});
