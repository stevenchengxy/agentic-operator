import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { ReportRunner } from "./ports";

// generate_report — the brain's proper path for「分析本体/生成分析报告」chat asks. Locks:
//   1. Registered as a brain tool (the observed failure: the brain tried the RUNTIME tool
//      report.htmlToPdf, got "不存在", then hand-wrote a full HTML report into the chat).
//   2. Unwired port → honest refusal that STEERS away from hand-writing HTML.
//   3. Wired port → starts the job with ctx.domain, returns artifact download paths on done.
//   4. Error status → ok:false with the pipeline's error.

const generate_report = FACTORY_TOOLS.find((t) => t.name === "generate_report")!;

function ctx(report?: ReportRunner): BrainCtx {
  const emitted: unknown[] = [];
  return {
    specs: [],
    domain: "Agents-generation",
    emit: (e: unknown) => emitted.push(e),
    ports: { report },
    __emitted: emitted,
  } as unknown as BrainCtx;
}

describe("generate_report brain tool", () => {
  it("is registered in FACTORY_TOOLS", () => {
    expect(generate_report).toBeTruthy();
    expect(generate_report.description).toContain("不要自己在聊天里手写");
  });

  it("refuses honestly when the report port is unwired (never suggests hand-writing HTML)", async () => {
    const r = await generate_report.execute({}, ctx(undefined));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("后台任务");
    expect(r.summary).toContain("不要手写 HTML");
  });

  it("starts the job on ctx.domain and returns artifact paths when the job finishes", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const runner: ReportRunner = {
      start: async (o) => {
        calls.push(o as unknown as Record<string, unknown>);
        return { id: "rpt-test-1" };
      },
      status: async () => ({
        status: "done",
        title: "Agents-generation · 分析报告",
        artifacts: [{ id: "art-1", kind: "text/html", label: "HTML 报告", size: 1234 }],
      }),
    };
    const r = await generate_report.execute({ format: "html", focus: "断点" }, ctx(runner));
    expect(r.ok).toBe(true);
    expect(calls[0]).toMatchObject({ domain: "Agents-generation", format: "html", focus: "断点" });
    expect(r.summary).toContain("/v1/artifacts/art-1");
    expect(r.summary).toContain("后台任务");
  }, 15_000);

  it("surfaces a pipeline error as ok:false", async () => {
    const runner: ReportRunner = {
      start: async () => ({ id: "rpt-test-2" }),
      status: async () => ({ status: "error", error: "业务域没有可分析的本体内容", artifacts: [] }),
    };
    const r = await generate_report.execute({}, ctx(runner));
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("没有可分析的本体内容");
  }, 15_000);
});
