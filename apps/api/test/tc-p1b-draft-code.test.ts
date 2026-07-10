import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FsAgentDraftStore } from "../src/services/agent-factory/agent-draft-store";
import { testGeneratedFunction } from "../src/services/agent-factory/function-tester-run";
import { validateAgentCode, type GeneratedAgentSpec } from "@agentic/agent-factory";

// #P1b — 生成→落盘可部署 .ts→读回→真跑。证明:一次完成的工厂运行会把【可下载的 function 代码】
// (inngest.createFunction 形态)持久化,而且这份持久化的代码本身能在隔离里真跑通并发出事件。

function spec(over: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "x", actionName: "processResume", slug: "raas-process-resume", short: "ResumeAgent", domainId: "raas-v1",
    nameZh: "简历处理", kind: "llm", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"], tools: ["parseResumeApi"],
    unresolvedTools: [], objects: ["Candidate"], systemPrompt: "解析简历原文。", userPrompt: "", steps: [], ruleRefs: [],
    retries: 3, hitl: false, confidence: 0.9, promptSource: "llm" as GeneratedAgentSpec["promptSource"], ...over,
  } as GeneratedAgentSpec;
}

let tmpRoot: string;
let prevRoot: string | undefined;

beforeAll(async () => {
  prevRoot = process.env.AGENTIC_DATA_ROOT;
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "p1b-drafts-"));
  process.env.AGENTIC_DATA_ROOT = tmpRoot;
});
afterAll(async () => {
  if (prevRoot === undefined) delete process.env.AGENTIC_DATA_ROOT;
  else process.env.AGENTIC_DATA_ROOT = prevRoot;
  await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe("TC-P1b: 落盘可部署 .ts 交付物 + 真跑", () => {
  it("save() 同时写出 <slug>.ts(可部署 function 代码)", async () => {
    const store = new FsAgentDraftStore();
    const n = await store.save("raas-v1", [spec()]);
    expect(n).toBe(1);
    const tsPath = path.join(tmpRoot, "factory-drafts", "raas-v1", "raas-process-resume.ts");
    const code = await fs.readFile(tsPath, "utf8");
    expect(code).toContain("inngest.createFunction(");
    expect(code).toContain('const AGENT_ID = "raas-process-resume"');
    expect((await validateAgentCode(code)).ok).toBe(true);
  });

  it("getCode() 读回持久化的 .ts", async () => {
    const store = new FsAgentDraftStore();
    await store.save("raas-v1", [spec()]);
    const code = await store.getCode("raas-v1", "raas-process-resume");
    expect(code).not.toBeNull();
    expect(code!).toContain("export const resumeAgent = inngest.createFunction(");
  });

  it("getCode() 对没有 .ts 的旧草稿按需从 spec 渲染", async () => {
    const store = new FsAgentDraftStore();
    // 手写一个只有 .json 没有 .ts 的旧草稿
    const dir = path.join(tmpRoot, "factory-drafts", "legacy");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "old-agent.json"), JSON.stringify({ domain: "legacy", slug: "old-agent", spec: spec({ slug: "old-agent" }), createdAt: new Date(0).toISOString() }), "utf8");
    const code = await store.getCode("legacy", "old-agent");
    expect(code).not.toBeNull();
    expect(code!).toContain("inngest.createFunction(");
  });

  it("持久化的 .ts 本身能在隔离里真跑通并发出事件(端到端)", async () => {
    const store = new FsAgentDraftStore();
    await store.save("raas-v1", [spec()]);
    const code = await store.getCode("raas-v1", "raas-process-resume");
    // 直接把落盘的代码喂给 Tester(经 harness)——证明交付物真跑,不是只编译过
    const { verdict } = await testGeneratedFunction(spec(), { testEvent: { data: { payload: { upload_id: "u1" } } }, expectEmits: ["RESUME_PROCESSED"] });
    expect(verdict.pass).toBe(true);
    expect(code).toContain("RESUME_PROCESSED");
  }, 20000);

  it("delete() 连带清掉 .ts", async () => {
    const store = new FsAgentDraftStore();
    await store.save("raas-v1", [spec({ slug: "to-delete" })]);
    expect(await store.delete("raas-v1", "to-delete")).toBe(true);
    expect(await store.getCode("raas-v1", "to-delete")).toBeNull();
  });
});
