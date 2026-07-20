import { describe, it, expect } from "vitest";
import {
  inspectGeneratedToolCalls,
  lintGeneratedToolCode,
  validateGeneratedToolAllowlist,
  validateGeneratedToolCoverage,
} from "./code-lint";

// Phase 2 Tier B — a security lint gates AI-authored code tools before they can be promoted to a
// runtime-invocable capability. (A lint is NOT a substitute for execution isolation or human
// review — both are still required — but it catches the clear-cut dangerous APIs cheaply.)

describe("lintGeneratedToolCode", () => {
  it("passes a clean pdf-lib-style tool", () => {
    const code = `
      import { PDFDocument } from "pdf-lib";
      export default async function handler(input) {
        const doc = await PDFDocument.create();
        const page = doc.addPage();
        page.drawText(String(input.name ?? "Candidate"));
        return { pdfBase64: Buffer.from(await doc.save()).toString("base64") };
      }
    `;
    expect(lintGeneratedToolCode(code).ok).toBe(true);
  });

  it("flags child_process", () => {
    const r = lintGeneratedToolCode(`import cp from "node:child_process"; cp.execSync("rm -rf /");`);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/child_process/);
  });

  it("flags eval and new Function", () => {
    expect(lintGeneratedToolCode(`eval("2+2")`).ok).toBe(false);
    expect(lintGeneratedToolCode(`const f = new Function("return 1")`).ok).toBe(false);
  });

  it("flags constructor-chain host escapes", () => {
    const direct = lintGeneratedToolCode(
      `const proc = module.constructor.constructor("return process")();`,
    );
    const computed = lintGeneratedToolCode(
      `const proc = module["constructor"]["constructor"]("return process")();`,
    );
    expect(direct.ok).toBe(false);
    expect(direct.violations.join(" ")).toMatch(/constructor/);
    expect(computed.ok).toBe(false);
    expect(computed.violations.join(" ")).toMatch(/constructor/);
  });

  it("flags raw fs writes (must use the provided fs.* tools, data-root scoped)", () => {
    const r = lintGeneratedToolCode(`import fs from "node:fs"; fs.writeFileSync("/etc/x","y");`);
    expect(r.ok).toBe(false);
    expect(r.violations.join(" ")).toMatch(/fs|filesystem/i);
  });

  it("flags process.exit / process.kill", () => {
    expect(lintGeneratedToolCode(`process.exit(1)`).ok).toBe(false);
    expect(lintGeneratedToolCode(`process.kill(0)`).ok).toBe(false);
  });

  it("flags raw network modules (use declarative HTTP tool / safeFetch instead)", () => {
    expect(lintGeneratedToolCode(`import net from "node:net";`).ok).toBe(false);
    expect(lintGeneratedToolCode(`import http from "node:http";`).ok).toBe(false);
  });

  it("flags worker_threads and vm", () => {
    expect(lintGeneratedToolCode(`import { Worker } from "node:worker_threads";`).ok).toBe(false);
    expect(lintGeneratedToolCode(`import vm from "node:vm";`).ok).toBe(false);
  });

  // #REDESIGN FU2 — the AST lint removes the raw-text FALSE POSITIVES the old regex tripped on: a
  // local variable named `vm`, or a module name appearing only inside a comment/string, is NOT an
  // actual import/require and must pass.
  it("does NOT false-positive on a local var named vm or a module name in a comment", () => {
    const code = `
      // never touch child_process here — use the sandbox
      export default async function handler(input) {
        const vm = { render: (x) => x };
        const note = "fs and http are provided as tools";
        return { out: vm.render(String(input.name ?? "") + note) };
      }
    `;
    expect(lintGeneratedToolCode(code).ok).toBe(true);
  });

  // #REDESIGN FU2 — the AST lint catches EVASION a substring scan misses: a module name assembled by
  // concatenation and passed to a dynamic require, or the import-equals form.
  it("flags obfuscated dynamic require and import-equals", () => {
    expect(lintGeneratedToolCode(`const n = "child" + "_process"; const cp = require(n); cp.exec("x");`).ok).toBe(false);
    expect(lintGeneratedToolCode(`import cp = require("child_process");`).ok).toBe(false);
  });

  // #REDESIGN FU2 — broader dangerous builtins the old regex let through (dns/os/tls/cluster/…).
  it("flags dns, os, tls, cluster imports", () => {
    for (const m of ["node:dns", "node:os", "node:tls", "node:cluster"]) {
      expect(lintGeneratedToolCode(`import x from "${m}";`).ok).toBe(false);
    }
  });
});

describe("generated CodeAct tool allowlist inspection", () => {
  it("extracts both supported literal call spellings as an exact set", () => {
    const inspected = inspectGeneratedToolCalls(`
      export const agent = defineAgent({
        async handler(input, runtime) {
          await runtime.tool("records.lookup", input);
          await runtime.tools.run("ontology.fetchActionRules", input);
          await runtime.tool("records.lookup", input);
        },
      });
    `);
    expect(inspected).toEqual({
      calledTools: ["ontology.fetchActionRules", "records.lookup"],
      violations: [],
    });
  });

  it("allows a literal subset and does not require every reviewed tool to be called", () => {
    const checked = validateGeneratedToolAllowlist(
      `export const agent = defineAgent({ async handler(input, ctx) {
        return ctx.tool("meta.ping", input);
      }});`,
      ["meta.ping", "ontology.fetchActionRules"],
    );
    expect(checked).toMatchObject({
      ok: true,
      calledTools: ["meta.ping"],
      undeclaredTools: [],
      violations: [],
    });
  });

  it("requires exact reviewed-tool coverage for a CodeAct execution owner", () => {
    const checked = validateGeneratedToolCoverage(
      `export const agent = defineAgent({ async handler(input, ctx) {
        // await ctx.tools.run("records.write", input);
        return ctx.tool("meta.ping", input);
      }});`,
      ["meta.ping", "records.write"],
    );
    expect(checked.ok).toBe(false);
    expect(checked.calledTools).toEqual(["meta.ping"]);
    expect(checked.missingReviewedTools).toEqual(["records.write"]);
    expect(checked.violations.join(" ")).toMatch(/handler.*没有直接字面量调用/);
  });

  it("allows only direct calls to the declared non-tool runtime surface", () => {
    const direct = inspectGeneratedToolCalls(`
      export const agent = defineAgent({ async handler(input, ctx) {
        const reasoned = await ctx.reason("decide", input);
        await ctx.memory.put("last", reasoned);
        ctx.emit("DONE", { tenant: ctx.tenantSlug });
        return reasoned;
      }});
    `);
    expect(direct.violations).toEqual([]);

    const aliased = inspectGeneratedToolCalls(`
      export const agent = defineAgent({ async handler(input, ctx) {
        const emit = ctx.emit;
        emit("DONE", input);
        return ctx.secretCapability(input);
      }});
    `);
    expect(aliased.violations.join(" ")).toMatch(/ctx\.emit.*别名|别名.*ctx\.emit/);
    expect(aliased.violations.join(" ")).toMatch(/未声明.*ctx\.secretCapability/);
  });

  it("rejects undeclared literal and dynamic tool names", () => {
    const undeclared = validateGeneratedToolAllowlist(
      `export const agent = defineAgent({ async handler(input, ctx) {
        return ctx.tool("records.upsert", input);
      }});`,
      ["meta.ping"],
    );
    expect(undeclared.ok).toBe(false);
    expect(undeclared.undeclaredTools).toEqual(["records.upsert"]);
    expect(undeclared.violations.join(" ")).toMatch(/未在不可变 spec\.tools/);

    const dynamic = validateGeneratedToolAllowlist(
      `export const agent = defineAgent({ async handler(input, ctx) {
        const name = input.tool;
        return ctx.tool(name, input);
      }});`,
      ["meta.ping"],
    );
    expect(dynamic.ok).toBe(false);
    expect(dynamic.violations.join(" ")).toMatch(/动态工具名/);
  });

  it("rejects computed and aliased access to the runtime tool capability", () => {
    const computed = inspectGeneratedToolCalls(`
      export const agent = defineAgent({ async handler(input, ctx) {
        return ctx["tool"]("meta.ping", input);
      }});
    `);
    expect(computed.violations.join(" ")).toMatch(/计算属性/);

    const aliased = inspectGeneratedToolCalls(`
      export const agent = defineAgent({ async handler(input, ctx) {
        const call = ctx.tool;
        return call("meta.ping", input);
      }});
    `);
    expect(aliased.violations.join(" ")).toMatch(/别名\/间接调用/);
  });

  it("rejects tools namespace destructuring/aliasing and passing ctx to helpers", () => {
    for (const code of [
      `export const agent = defineAgent({ async handler(input, ctx) {
        const { run } = ctx.tools; return run("meta.ping", input);
      }});`,
      `export const agent = defineAgent({ async handler(input, ctx) {
        const tools = ctx.tools; return tools.run("meta.ping", input);
      }});`,
      `async function hidden(runtime, input) { return runtime.tool(input.name, input); }
       export const agent = defineAgent({ async handler(input, ctx) { return hidden(ctx, input); }});`,
    ]) {
      const inspected = inspectGeneratedToolCalls(code);
      expect(inspected.violations.length).toBeGreaterThan(0);
    }
  });

  it("rejects context escape through assignment, arrays, and objects", () => {
    for (const code of [
      `export const agent = defineAgent({ async handler(input, ctx) {
        let runtime; runtime = ctx; return runtime.tool(input.name, input);
      }});`,
      `export const agent = defineAgent({ async handler(input, ctx) {
        const box = [ctx]; return box[0].tool(input.name, input);
      }});`,
      `export const agent = defineAgent({ async handler(input, ctx) {
        const box = { runtime: ctx }; return box.runtime.tool(input.name, input);
      }});`,
    ]) {
      expect(inspectGeneratedToolCalls(code).violations.length).toBeGreaterThan(0);
    }
  });
});
