import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DraftVersionConflictError, FsAgentDraftStore } from "../src/services/agent-factory/agent-draft-store";
import { testGeneratedFunction } from "../src/services/agent-factory/function-tester-run";
import { validateAgentCode, type GeneratedAgentSpec } from "@agentic/agent-factory";
import { makeToolCassetteEntry } from "@agentic/shared/cassette";

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
    const { verdict } = await testGeneratedFunction(spec(), {
      code: code!,
      // Generic functions consume canonical event.data. Legacy `payload`
      // envelopes belong in a tenant adapter, not in the generated handler.
      testEvent: { data: { upload_id: "u1" } },
      expectEmits: ["RESUME_PROCESSED"],
      fixture: {
        toolCassettes: {
          parseResumeApi: {
            version: 1,
            tool: { name: "parseResumeApi", definitionHash: "def-1" },
            evidence: { recordedAt: new Date(0).toISOString(), mode: "signed-fixture" },
            entries: [makeToolCassetteEntry({
              toolName: "parseResumeApi",
              args: { upload_id: "u1", results: {} },
              status: 200,
              body: { name: "张三" },
            })],
          },
        },
        reasonResult: { pass: true, ok: true, emit: "RESUME_PROCESSED" },
      },
    });
    expect(verdict.pass, JSON.stringify(verdict)).toBe(true);
    expect(code).toContain("RESUME_PROCESSED");
  }, 20000);

  it("delete() 只隐藏当前投影，历史不可变版本仍可审计和回放", async () => {
    const store = new FsAgentDraftStore();
    await store.save("raas-v1", [spec({ slug: "to-delete" })]);
    const versionId = (await store.listVersions("raas-v1"))[0]!.versionId;
    const exactBefore = await store.getCode("raas-v1", "to-delete", versionId);
    expect(await store.delete("raas-v1", "to-delete")).toBe(true);
    expect(await store.getCode("raas-v1", "to-delete")).toBeNull();
    expect((await store.list("raas-v1")).some((draft) => draft.slug === "to-delete")).toBe(false);
    expect(await store.getCode("raas-v1", "to-delete", versionId)).toBe(exactBefore);
    expect((await store.getVersion("raas-v1", versionId)).map((draft) => draft.slug)).toContain("to-delete");
    expect((await store.listVersions("raas-v1")).map((version) => version.versionId)).toContain(versionId);

    await store.save("raas-v1", [spec({ slug: "to-delete", systemPrompt: "重新生成后的当前版本。" })]);
    expect(await store.getCode("raas-v1", "to-delete")).not.toBeNull();
    expect(await store.getCode("raas-v1", "to-delete", versionId)).toBe(exactBefore);
  });

  it("PATCH 采用 latest CAS，拒绝旧页面覆盖新版本，也不允许只改 tools 半套契约", async () => {
    const store = new FsAgentDraftStore();
    await store.save("raas-v1", [spec({ slug: "cas-agent" })]);
    const base = (await store.listVersions("raas-v1"))[0]!.versionId;
    const next = await store.createPatchedVersion("raas-v1", base, "cas-agent", {
      set: { systemPrompt: "第一位审查者的修改。" },
    });
    await expect(store.createPatchedVersion("raas-v1", base, "cas-agent", {
      set: { systemPrompt: "来自旧页面的覆盖。" },
    })).rejects.toBeInstanceOf(DraftVersionConflictError);
    await expect(store.createPatchedVersion("raas-v1", next.versionId, "cas-agent", {
      set: { tools: ["another.tool"] },
    })).rejects.toThrow(/immutable or unknown/);
  });
});
