import { describe, it, expect } from "vitest";
import { testGeneratedFunction } from "../src/services/agent-factory/function-tester-run";
import type { GeneratedAgentSpec } from "@agentic/agent-factory";

// #P2.5-Tester — 端到端证明:一个生成的 ts_function_module 的 handler 能在 P0a worker 隔离里【真执行】
// 并发出期望事件。这是"生成→真跑→验收"闭环的实证(不是编译过就算,而是真跑 handler)。

function spec(over: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "x", actionName: "processResume", slug: "raas-process-resume", short: "ResumeAgent", domainId: "raas-v1",
    nameZh: "简历处理", kind: "llm", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"], tools: ["parseResumeApi"],
    unresolvedTools: [], objects: ["Candidate"], systemPrompt: "解析简历原文，产出结构化候选人信息。", userPrompt: "",
    steps: [], ruleRefs: [], retries: 3, hitl: false, confidence: 0.9, promptSource: "llm" as GeneratedAgentSpec["promptSource"], ...over,
  } as GeneratedAgentSpec;
}

describe("TC-P25: 生成的 function 在隔离里真跑 handler + 发出事件", () => {
  it("单 emit：handler 真跑通并发出 RESUME_PROCESSED", async () => {
    const { verdict } = await testGeneratedFunction(spec(), {
      testEvent: { data: { payload: { upload_id: "u1" } } },
      expectEmits: ["RESUME_PROCESSED"],
    });
    expect(verdict.ran).toBe(true);
    expect(verdict.pass).toBe(true);
    expect(verdict.emitNames).toContain("RESUME_PROCESSED");
  }, 20000);

  it("多 emit + decision.pass=true 走成功分支", async () => {
    const { verdict } = await testGeneratedFunction(
      spec({ actionName: "createJd", slug: "raas-create-jd", emit: ["JD_GENERATED", "JD_FAILED"], tools: [] }),
      { expectEmits: ["JD_GENERATED"] },
    );
    expect(verdict.ran).toBe(true);
    expect(verdict.emitNames).toContain("JD_GENERATED");
  }, 20000);

  it("old-ao profile 渲染的 function 同样能在隔离里真跑", async () => {
    const { verdict } = await testGeneratedFunction(spec(), {
      render: { profile: "old-ao", pauseGate: "skipIfRaasV1Paused" },
      expectEmits: ["RESUME_PROCESSED"],
    });
    expect(verdict.ran).toBe(true);
    expect(verdict.pass).toBe(true);
  }, 20000);
});
