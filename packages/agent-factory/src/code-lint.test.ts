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
});
