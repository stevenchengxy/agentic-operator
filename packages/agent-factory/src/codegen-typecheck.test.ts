import { describe, it, expect } from "vitest";
import { validateAgentCode, specToAgentCode } from "./codegen";
import type { GeneratedAgentSpec, PlanStep } from "./spec-types";

// #REAL-TYPECHECK — validateAgentCode used to be transpile-only (syntax): code calling
// nonexistent ctx methods or importing modules that resolve to {} at run time passed
// "compile" and got graded executable. The semantic program over the ambient ctx surface
// now rejects exactly that class of fake code.

const okSpec = {
  key: "a", actionName: "matchResume", slug: "rec-match-resume", short: "MatchResume",
  domainId: "rec", nameZh: "简历匹配", kind: "llm", trigger: ["RESUME_PROCESSED"],
  emit: ["MATCHED", "REJECTED"], tools: ["matchResumeApi"], unresolvedTools: [], objects: [],
  systemPrompt: "匹配简历与岗位。", userPrompt: "", steps: [], ruleRefs: [], retries: 3,
  hitl: false, confidence: 0.9, promptSource: "llm",
  plan: [
    { stepId: "is-ready", kind: "condition", condition: "event.data.parsed == true" },
    { stepId: "match", kind: "tool", tool: "matchResumeApi", dependsOn: ["is-ready"], onError: "soft", defaultResult: { matchScore: null } },
  ] as PlanStep[],
} as unknown as GeneratedAgentSpec;

describe("validateAgentCode — real semantic typecheck", () => {
  it("renders ontology optional fields as optional TypeScript properties", () => {
    const code = specToAgentCode({
      ...okSpec,
      inputSchema: [
        { field: "candidate_id", type: "String", required: true },
        { field: "failure_reason", type: "String", required: false },
      ],
    });
    expect(code).toContain("candidate_id: string;");
    expect(code).toContain("failure_reason?: string;");
  });

  it("passes the deterministic render (plan + conditions + multi-emit)", async () => {
    const r = await validateAgentCode(specToAgentCode(okSpec));
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("passes hand-written import-style code using the real ctx surface", async () => {
    const code = [
      'import { defineAgent } from "@agentic/runtime";',
      "export const a = defineAgent({",
      '  id: "x", name: "X",',
      "  async handler(input, ctx) {",
      '    const parsed = await ctx.tools.run("parseResumeApi", input);',
      '    const d = await ctx.reason("sp", { input, parsed });',
      '    await ctx.emit("DONE", { ...input, ...d });',
      "    return { ok: true };",
      "  },",
      "});",
    ].join("\n");
    const r = await validateAgentCode(code);
    expect(r.errors).toEqual([]);
  });

  it("REJECTS calls to nonexistent ctx methods (the fake-capability class)", async () => {
    const code = [
      'import { defineAgent } from "@agentic/runtime";',
      "export const a = defineAgent({",
      "  async handler(input, ctx) {",
      '    const d = await ctx.reasoning("sp", input);', // no such method
      "    return { ok: true, d };",
      "  },",
      "});",
    ].join("\n");
    const r = await validateAgentCode(code);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/reasoning/);
  });

  it("REJECTS imports that resolve to {} at run time (ghost modules)", async () => {
    const code = [
      'import axios from "axios";',
      'import { defineAgent } from "@agentic/runtime";',
      "export const a = defineAgent({",
      "  async handler(input, ctx) {",
      '    const r = await axios.get("https://x");',
      '    await ctx.emit("DONE", r as Record<string, unknown>);',
      "    return { ok: true };",
      "  },",
      "});",
    ].join("\n");
    const r = await validateAgentCode(code);
    expect(r.ok).toBe(false);
    expect(r.errors.join("\n")).toMatch(/axios/);
  });

  it("still rejects plain syntax errors, with line numbers", async () => {
    const r = await validateAgentCode("export const a = defineAgent({ async handler(input, ctx) { return { ok: true ;");
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});
