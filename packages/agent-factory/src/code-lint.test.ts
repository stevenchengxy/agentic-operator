import { describe, it, expect } from "vitest";
import { lintGeneratedToolCode } from "./code-lint";

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
