import { describe, it, expect } from "vitest";
import { probeAgentModule, specToAgentCode } from "./codegen";
import type { GeneratedAgentSpec } from "./spec-types";

// #REDESIGN FU3 — the reviewLoop PROBE stage: code must not only COMPILE, it must LOAD and expose a
// callable handler (the same structural gate the runtime applies before executing). This catches
// codegen that type-checks but has no runnable handler — which a compile-only check graded as
// "executable".

describe("probeAgentModule — reviewLoop load probe", () => {
  it("passes a defineAgent module with a real handler (import-style)", async () => {
    const code = [
      'import { defineAgent } from "@agentic/runtime";',
      'export const publishJd = defineAgent({',
      '  id: "publish-jd", name: "PublishJd",',
      '  async handler(input, ctx) { const d = await ctx.reason("sp", input); await ctx.emit("JD_PUBLISHED", { ...input }); return { ok: true, d }; }',
      '});',
    ].join("\n");
    const r = await probeAgentModule(code);
    expect(r.loads).toBe(true);
  });

  it("routes a deterministic tool render to the declarative runtime instead of claiming CodeAct parity", async () => {
    const spec = {
      slug: "eval-interview", short: "EvaluateInterview", nameZh: "评估面试", actionName: "EvaluateInterview",
      domainId: "raas", systemPrompt: "评估候选人的面试表现并给出结论。", tools: ["matchResumeApi"],
      trigger: ["AI_INTERVIEW_COMPLETED"], emit: ["INTERVIEW_EVALUATED"], inputSchema: [], outputSchema: [],
      unresolvedTools: [],
    } as unknown as GeneratedAgentSpec;
    const code = specToAgentCode(spec);
    const r = await probeAgentModule(code);
    expect(r.loads).toBe(false);
    expect(r.reason).toMatch(/工具|declarative|声明式/i);
  });

  it("REJECTS code that compiles but exposes no callable handler", async () => {
    const r = await probeAgentModule('export const notAnAgent = { value: 42 };\nexport function helper() { return 1; }');
    expect(r.loads).toBe(false);
    expect(r.reason).toMatch(/handler/);
  });

  it("REJECTS empty / trivial code", async () => {
    expect((await probeAgentModule("")).loads).toBe(false);
    expect((await probeAgentModule("const x = 1;")).loads).toBe(false);
  });
});
