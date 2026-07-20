import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";

import { generateJdApi, GenerateJdApiError } from "./generate-jd";

function context(
  data: Record<string, unknown>,
  lastResult?: unknown,
): ToolContext {
  return {
    tenantSlug: "agents-generation",
    agentName: "createJD",
    actionName: "generateJdApi",
    correlationId: "corr-jd-1",
    event: { name: "CLARIFICATION_READY", data },
    lastResult,
    config: {
      api_key_env: "ROBOHIRE_API_KEY",
      base_url_env: "ROBOHIRE_API_BASE_URL",
    },
  } as ToolContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ROBOHIRE_API_KEY;
  delete process.env.ROBOHIRE_API_BASE_URL;
});

describe("generateJdApi", () => {
  it("calls the real endpoint contract and returns stage-verified output", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              title: "高级后端工程师",
              description: "负责核心平台服务",
              qualifications: "五年以上经验",
              hardRequirements: "1. TypeScript\n2、PostgreSQL",
              niceToHave: "- Kubernetes",
            },
            meta: { stages: { parse: "success", generate: "success" } },
            requestId: "req-jd-1",
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await generateJdApi.handler(
      context({
        prompt: "上海高级后端工程师，五年以上 TypeScript 与 PostgreSQL 经验",
        language: "zh",
        companyName: "Acme",
      }),
    );
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://robohire.test/api/v1/jobs/generate-jd",
    );
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({
      language: "zh",
      companyName: "Acme",
    });
    expect(result.data).toMatchObject({
      title: "高级后端工程师",
      jd_content:
        "# 高级后端工程师\n\n## 职位描述\n负责核心平台服务\n\n## 任职要求\n五年以上经验\n\n## 硬性要求\n1. TypeScript\n2、PostgreSQL\n\n## 加分项\n- Kubernetes",
      must_have_skills: ["TypeScript", "PostgreSQL"],
      nice_to_have_skills: ["Kubernetes"],
      request_id: "req-jd-1",
      stages: { parse: "success", generate: "success" },
    });
  });

  it("can build the prompt from a previous Job_Requisition result", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).prompt).toContain("高级数据工程师");
      return new Response(
        JSON.stringify({
          success: true,
          data: { title: "高级数据工程师", description: "建设数据平台" },
          requestId: "req-jd-2",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generateJdApi.handler(
        context(
          {},
          {
            requirement: {
              client_job_title: "高级数据工程师",
              city: "上海",
              job_responsibility: "建设数据平台",
            },
            specification: { degree_requirement: "本科" },
            clarifications: [{ content: "必须熟悉 Flink" }],
          },
        ),
      ),
    ).resolves.toMatchObject({ data: { title: "高级数据工程师" } });
    expect(
      JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).prompt,
    ).toContain("必须熟悉 Flink");
  });

  it("fails on a degraded 200 stage instead of persisting placeholder content", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: { title: "Untitled", description: "" },
              meta: { stages: { parse: "success", generate: "failed" } },
              requestId: "req-degraded",
            }),
          ),
      ),
    );
    await expect(
      generateJdApi.handler(context({ prompt: "a valid recruitment prompt" })),
    ).rejects.toMatchObject({
      name: "GenerateJdApiError",
      code: "generate_jd_stage_failed",
      retryable: true,
      terminal: false,
    });
  });

  it("rejects invalid input before network with a typed terminal error", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      generateJdApi.handler(context({ prompt: "x" })),
    ).rejects.toBeInstanceOf(GenerateJdApiError);
    await expect(
      generateJdApi.handler(context({ prompt: "x" })),
    ).rejects.toMatchObject({
      code: "generate_jd_input_invalid",
      terminal: true,
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a nominal 200 response with no usable JD body", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: { title: "Untitled" },
              requestId: "req-empty",
            }),
          ),
      ),
    );
    await expect(
      generateJdApi.handler(context({ prompt: "a valid recruitment prompt" })),
    ).rejects.toMatchObject({
      code: "generate_jd_output_invalid",
      retryable: true,
    });
  });

  it("accepts a thin-but-usable 200 whose only content the assembler consumes (benefits) — empty-check must match assembleGeneratedJdContent", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                title: "行政专员",
                benefits: "五险一金，弹性工作",
              },
              meta: { stages: { parse: "success", generate: "success" } },
              requestId: "req-thin",
            }),
          ),
      ),
    );
    const result = await generateJdApi.handler(
      context({ prompt: "a valid recruitment prompt" }),
    );
    expect(String(result.data.jd_content)).toContain("五险一金");
  });

  it("does not discard real content just because the title is the Untitled placeholder", async () => {
    process.env.ROBOHIRE_API_KEY = "test-key";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              success: true,
              data: {
                title: "Untitled",
                description: "负责政务对接与行政事务",
              },
              meta: { stages: { parse: "success", generate: "success" } },
              requestId: "req-untitled-content",
            }),
          ),
      ),
    );
    const result = await generateJdApi.handler(
      context({ prompt: "a valid recruitment prompt" }),
    );
    expect(String(result.data.jd_content)).toContain("负责政务对接与行政事务");
  });
});
