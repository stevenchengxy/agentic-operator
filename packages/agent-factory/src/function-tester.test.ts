import { describe, it, expect } from "vitest";
import { harnessTsModuleForTest, gradeFunctionTest } from "./function-tester";
import { renderTsFunctionModule } from "./ts-function-module";
import { validateAgentCode } from "./codegen";
import type { GeneratedAgentSpec } from "./spec-types";

function spec(over: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "x", actionName: "processResume", slug: "raas-process-resume", short: "ResumeAgent", domainId: "raas-v1",
    nameZh: "简历处理", kind: "llm", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"], tools: ["parseResumeApi"],
    unresolvedTools: [], objects: ["Candidate"], systemPrompt: "解析简历", userPrompt: "", steps: [], ruleRefs: [],
    retries: 3, hitl: false, confidence: 0.9, promptSource: "llm" as GeneratedAgentSpec["promptSource"], ...over,
  } as GeneratedAgentSpec;
}

describe("#P2.5-Tester harnessTsModuleForTest — 把交付形态变成可跑测试模块", () => {
  it("剥掉真 import,注入 mock inngest,追加 __run 入口", () => {
    const h = harnessTsModuleForTest(renderTsFunctionModule(spec()));
    expect(h).toContain("__inngest.createFunction");
    expect(h).toContain("export async function __run(event)");
    // 真 import 被移除(inngest client),但注释 import 可留
    expect(h).not.toMatch(/^\s*import\s.+from\s+['"]@\/server/m);
    expect(h).not.toMatch(/^\s*import\s.+from\s+['"]@\/lib/m);
  });

  it("产出仍是语法有效 TS(可编译)", async () => {
    const h = harnessTsModuleForTest(renderTsFunctionModule(spec()));
    const v = await validateAgentCode(h);
    expect(v.ok).toBe(true);
  });

  it("确定性:同源码同输出", () => {
    const code = renderTsFunctionModule(spec());
    expect(harnessTsModuleForTest(code)).toBe(harnessTsModuleForTest(code));
  });

  it("old-ao profile 的模块(@/lib import)也被正确剥离并可编译", async () => {
    const h = harnessTsModuleForTest(renderTsFunctionModule(spec(), { profile: "old-ao", pauseGate: "skipIfRaasV1Paused" }));
    expect(h).not.toMatch(/^\s*import\s.+from\s+['"]@\/server\/inngest\/client['"]/m);
    expect((await validateAgentCode(h)).ok).toBe(true);
  });
});

describe("#P2.5-Tester gradeFunctionTest — 验收判据", () => {
  it("隔离超时/崩溃 → 未跑通,pass=false", () => {
    expect(gradeFunctionTest({ ok: false, timedOut: true }).pass).toBe(false);
    expect(gradeFunctionTest({ ok: false, crashed: true }).pass).toBe(false);
    expect(gradeFunctionTest(null).pass).toBe(false);
  });
  it("handler 跑通且无 expectEmits → pass", () => {
    const v = gradeFunctionTest({ ok: true, result: { ran: true, emitNames: ["RESUME_PROCESSED"] } });
    expect(v.ran).toBe(true);
    expect(v.pass).toBe(true);
  });
  it("期望 emit 命中 → pass;未命中 → fail", () => {
    const hit = gradeFunctionTest({ ok: true, result: { ran: true, emitNames: ["RESUME_PROCESSED"] } }, { expectEmits: ["RESUME_PROCESSED"] });
    expect(hit.pass).toBe(true);
    const miss = gradeFunctionTest({ ok: true, result: { ran: true, emitNames: ["OTHER"] } }, { expectEmits: ["RESUME_PROCESSED"] });
    expect(miss.emittedExpected).toBe(false);
    expect(miss.pass).toBe(false);
    expect(miss.reasons.join()).toContain("未出现");
  });
  it("handler 抛错(ran:false) → fail 且带原因", () => {
    const v = gradeFunctionTest({ ok: true, result: { ran: false, error: "boom" } });
    expect(v.pass).toBe(false);
    expect(v.reasons.join()).toContain("boom");
  });
});
