import { describe, expect, it, vi } from "vitest";
import { deriveBrainFlow, toBlocks } from "./model";
import {
  buildCasePayloadDecision,
  parseTestCasePayload,
  uploadBinaryFixtureAndInject,
} from "./test-fixtures";

describe("Agent Factory test fixtures", () => {
  it("preserves the authoritative test-case id and nested payload", () => {
    const [block] = toBlocks([{
      t: "test.cases",
      cases: [{
        id: "case:resume/01",
        name: "nested resume",
        kind: "pass",
        scenario: "nested data",
        entryEvent: "RESUME_UPLOADED",
        expectedOutcome: "PARSED",
        payload: { candidate: { contacts: [{ kind: "mobile", value: "test-only" }] } },
      }],
      awaitingApproval: true,
    }]);

    expect(block?.kind).toBe("testcases");
    if (block?.kind !== "testcases") throw new Error("missing test block");
    expect(block.cases[0]?.id).toBe("case:resume/01");
    expect(block.cases[0]?.payload).toEqual({
      candidate: { contacts: [{ kind: "mobile", value: "test-only" }] },
    });
  });

  it("builds a structured nested-payload decision with the exact case id", () => {
    const payload = parseTestCasePayload('{"candidate":{"documents":[{"name":"resume.pdf"}]}}');
    const directive = buildCasePayloadDecision("case/exact-id", payload);

    expect(directive).toBe(
      '[测试用例决策: 补数据] {"case_payloads":[{"case_id":"case/exact-id","payload":{"candidate":{"documents":[{"name":"resume.pdf"}]}}}]}',
    );
    expect(() => parseTestCasePayload("[]")).toThrow("JSON 对象");
    expect(() => parseTestCasePayload("not-json")).toThrow("有效的 JSON");
  });

  it("keeps the approval gate awaiting when the third decision state supplies data", () => {
    const events = [{
      t: "test.cases",
      cases: [{
        id: "case-1",
        name: "resume",
        kind: "pass",
        scenario: "needs a resume file",
        entryEvent: "RESUME_UPLOADED",
        expectedOutcome: "PARSED",
      }],
      awaitingApproval: true,
    }, {
      t: "test.decision",
      decision: "supply_data",
      note: '{"asset_id":"asset-must-not-render","base64":"AAECAw=="}',
    }];

    const blocks = toBlocks(events);
    const testBlock = blocks.find((block) => block.kind === "testcases");
    const decisionBlock = blocks.findLast((block) => block.kind === "message");
    expect(testBlock?.kind === "testcases" && testBlock.awaiting).toBe(true);
    expect(decisionBlock?.kind === "message" && decisionBlock.text).toContain("已补充测试数据");
    expect(JSON.stringify(decisionBlock)).not.toContain("asset-must-not-render");
    expect(JSON.stringify(decisionBlock)).not.toContain("AAECAw==");
    expect(JSON.stringify(decisionBlock)).not.toContain("重新生成");

    const gate = deriveBrainFlow(events).findLast((step) => step.kind === "gate" && step.label === "用例确认");
    expect(gate).toMatchObject({ status: "await", detail: "补充数据已提交 · 应用后仍需确认" });
  });

  it("redacts fixture content and internal asset ids from visible tool I/O", () => {
    const blocks = toBlocks([{
      t: "tool.call",
      id: "tool-1",
      name: "supply_test_data",
      reasoning: 'bind {"asset_id":"asset-in-reasoning"}',
      input: {
        binary_files: [{
          case_id: "case-1",
          path: "/candidate/resume",
          asset_id: "asset-private-1",
          base64: "AAECAw==",
        }],
      },
    }, {
      t: "tool.result",
      id: "tool-1",
      ok: true,
      summary: '{"assetId":"asset-in-summary"}',
      output: 'data:application/pdf;base64,AAECAw==',
    }]);

    const visible = JSON.stringify(blocks);
    expect(visible).not.toContain("asset-private-1");
    expect(visible).not.toContain("asset-in-reasoning");
    expect(visible).not.toContain("asset-in-summary");
    expect(visible).not.toContain("AAECAw==");
    expect(visible).toContain("/candidate/resume");
    expect(visible).toContain("内部测试资产引用已隐藏");
    expect(visible).toContain("测试文件内容已隐藏");
  });

  it("sends base64 only to the fixture endpoint and injects only its asset reference", async () => {
    const uploadBodies: Array<{ path: string; body: Record<string, unknown> }> = [];
    const injected: string[] = [];
    const upload = vi.fn(async (path: string, body: Record<string, unknown>) => {
      uploadBodies.push({ path, body });
      return {
        ok: true as const,
        status: 201,
        data: {
          assetId: "asset-fixture-1",
          sha256: "sha256:fixture",
          bytes: 4,
          mimeType: "application/pdf",
          filename: "resume.pdf",
        },
      };
    });

    await uploadBinaryFixtureAndInject({
      runId: "run/one",
      caseId: "case-1",
      path: "/candidate/resume",
      placement: "object",
      file: {
        name: "resume.pdf",
        type: "application/pdf",
        size: 4,
        arrayBuffer: async () => Uint8Array.from([0, 1, 2, 3]).buffer,
      },
      upload,
      inject: async (text) => { injected.push(text); },
    });

    expect(uploadBodies).toEqual([{
      path: "/v1/agent-factory/runs/run%2Fone/fixtures",
      body: {
        caseId: "case-1",
        path: "/candidate/resume",
        base64: "AAECAw==",
        mimeType: "application/pdf",
        filename: "resume.pdf",
      },
    }]);
    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain('"asset_id":"asset-fixture-1"');
    expect(injected[0]).toContain('"case_id":"case-1"');
    expect(injected[0]).not.toContain("AAECAw==");
    expect(injected[0]).not.toContain("base64");
  });

  it("surfaces upload errors and never injects an unusable fixture", async () => {
    const inject = vi.fn(async () => undefined);

    await expect(uploadBinaryFixtureAndInject({
      runId: "run-1",
      caseId: "case-1",
      path: "/document",
      placement: "data_url",
      file: {
        name: "resume.pdf",
        type: "application/pdf",
        size: 2,
        arrayBuffer: async () => Uint8Array.from([1, 2]).buffer,
      },
      upload: async () => ({ ok: false, status: 413, message: "文件超过上限" }),
      inject,
    })).rejects.toThrow("文件超过上限");
    expect(inject).not.toHaveBeenCalled();
  });
});
