import { describe, it, expect } from "vitest";
import { renderTsFunctionModule } from "./ts-function-module";
import { validateAgentCode } from "./codegen";
import type { GeneratedAgentSpec } from "./spec-types";

function spec(over: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "parseResume",
    actionName: "parseResume",
    slug: "raas-parse-resume",
    short: "ResumeParserAgent",
    domainId: "raas-v1",
    nameZh: "简历解析",
    kind: "llm",
    trigger: ["RESUME_DOWNLOADED"],
    emit: ["RESUME_PROCESSED"],
    tools: ["parseResumeApi", "fs.readFromInbox"],
    unresolvedTools: [],
    objects: ["Candidate", "Resume"],
    systemPrompt: "你负责解析简历原文,产出结构化候选人信息。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 3,
    hitl: false,
    confidence: 0.9,
    promptSource: "llm" as GeneratedAgentSpec["promptSource"],
    ...over,
  } as GeneratedAgentSpec;
}

describe("#P1 renderTsFunctionModule — inngest.createFunction 形态", () => {
  it("产出 inngest.createFunction 骨架(对标旧 AO),含 id/name/retries/trigger", () => {
    const code = renderTsFunctionModule(spec());
    expect(code).toContain("inngest.createFunction(");
    expect(code).toContain('const AGENT_ID = "raas-parse-resume"');
    expect(code).toContain("retries: 3");
    expect(code).toContain('{ event: "RESUME_DOWNLOADED" }');
    expect(code).toContain("export const resumeParserAgent = inngest.createFunction(");
  });

  it("挖出三个定制槽位(fieldMapping / errorTaxonomy / controlFlow)", () => {
    const code = renderTsFunctionModule(spec());
    expect(code).toContain("#SLOT-1 fieldMapping");
    expect(code).toContain("function mapFields(");
    expect(code).toContain("#SLOT-2 errorTaxonomy");
    expect(code).toContain("function classifyError(");
    expect(code).toContain("#SLOT-3 controlFlow");
    // 黄金范例锚点被写进注释(防过拟合:按模式引用,不整文件复制)
    expect(code).toContain("buildPromptFromRequirement");
    expect(code).toContain("isInfraFailure");
  });

  it("只用三种 step 原语:step.run(工具) + step.sendEvent(emit),无 waitForEvent/cancelOn/并发键", () => {
    const code = renderTsFunctionModule(spec());
    expect(code).toContain("await step.run(");
    expect(code).toContain("await step.sendEvent(");
    expect(code).not.toContain("waitForEvent");
    expect(code).not.toContain("cancelOn");
    expect(code).not.toContain("concurrency");
    // 每个工具一个 step.run
    expect((code.match(/await step\.run\(/g) ?? []).length).toBe(2);
  });

  it("多 trigger → triggers 数组;多 emit → 分支 emit", () => {
    const code = renderTsFunctionModule(spec({ trigger: ["REQUIREMENT_LOGGED", "CLARIFICATION_READY", "JD_REJECTED"], emit: ["JD_GENERATED", "JD_FAILED"] }));
    expect(code).toContain('[{ event: "REQUIREMENT_LOGGED" }, { event: "CLARIFICATION_READY" }, { event: "JD_REJECTED" }]');
    expect(code).toContain("if (decision.pass)");
    expect(code).toContain('name: "JD_GENERATED"');
    expect(code).toContain('name: "JD_FAILED"');
  });

  it("错误分类 catch:park/rethrow 上抛,business_fail/terminal 发 _FAILED", () => {
    const code = renderTsFunctionModule(spec());
    expect(code).toContain("const kind = classifyError(e)");
    expect(code).toContain('if (kind === "park" || kind === "rethrow") throw e');
    // 单 emit(RESUME_PROCESSED)→ 派生 RESUME_FAILED 作失败事件
    expect(code).toContain("RESUME_FAILED");
  });

  it("hitl agent retries=1;old-ao profile 生成 @/lib import 注释", () => {
    expect(renderTsFunctionModule(spec({ hitl: true }))).toContain("retries: 1");
    const old = renderTsFunctionModule(spec(), { profile: "old-ao", pauseGate: "skipIfRaasV1Paused" });
    expect(old).toContain('import { inngest } from "@/server/inngest/client"');
    expect(old).toContain("@/lib/");
    expect(old).toContain("skipIfRaasV1Paused");
  });

  it("产出是语法有效的 TS(通过 validateAgentCode 编译)", async () => {
    const code = renderTsFunctionModule(spec());
    const v = await validateAgentCode(code);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
  });

  it("确定性:同 spec 同 opts 逐字节同输出", () => {
    const a = renderTsFunctionModule(spec(), { profile: "old-ao" });
    const b = renderTsFunctionModule(spec(), { profile: "old-ao" });
    expect(a).toBe(b);
  });
});
