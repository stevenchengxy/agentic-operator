import type { ToolContext } from "@agentic/agent-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseResumeApi, ParseResumeApiError } from "./parse-resume";

function context(data: Record<string, unknown> = {}): ToolContext {
  return {
    tenantSlug: "agents-generation",
    agentName: "processResume",
    actionName: "parseResumeApi",
    correlationId: "corr-parse-resume-1",
    event: {
      name: "RESUME_DOWNLOADED",
      data: {
        resume_base64: Buffer.from("%PDF-1.7 test resume").toString("base64"),
        filename: "candidate.pdf",
        ...data,
      },
    },
    config: {
      api_key_env: "ROBOHIRE_API_KEY",
      base_url_env: "ROBOHIRE_API_BASE_URL",
    },
  } as ToolContext;
}

function respond(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  const fetchMock = vi.fn(async () => new Response(payload, { status }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  process.env.ROBOHIRE_API_KEY = "test-key";
  process.env.ROBOHIRE_API_BASE_URL = "https://robohire.test/api/v1";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ROBOHIRE_API_KEY;
  delete process.env.ROBOHIRE_API_BASE_URL;
});

describe("parseResumeApi", () => {
  it("accepts an unwrapped payload with substantive parsed content", async () => {
    const fetchMock = respond({
      name: "Wei Zhang",
      email: "wei.zhang@example.com",
      experience: [{ role: "Staff Engineer", company: "Acme" }],
    });

    const result = await parseResumeApi.handler(context());

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://robohire.test/api/v1/parse-resume",
    );
    expect(result).toMatchObject({
      data: {
        name: "Wei Zhang",
        email: "wei.zhang@example.com",
      },
      meta: {
        upstreamStatus: 200,
        responseWrapped: false,
        validatedContent: ["name", "contact", "experience"],
      },
    });
  });

  it("unwraps nested success envelopes before returning the validated payload", async () => {
    respond({
      success: true,
      request_id: "req-parse-1",
      data: {
        result: {
          raw_text: "Wei Zhang — Staff Engineer — TypeScript and PostgreSQL",
        },
      },
    });

    await expect(parseResumeApi.handler(context())).resolves.toMatchObject({
      data: {
        raw_text: "Wei Zhang — Staff Engineer — TypeScript and PostgreSQL",
      },
      meta: {
        responseWrapped: true,
        validatedContent: ["raw_text"],
      },
    });
  });

  it("rejects an empty nominal 200 as retryable dependency degradation", async () => {
    respond({ success: true, data: {} });

    const call = parseResumeApi.handler(context());
    await expect(call).rejects.toBeInstanceOf(ParseResumeApiError);
    await expect(call).rejects.toMatchObject({
      name: "ParseResumeApiError",
      kind: "dependency_degradation",
      code: "parse_resume_dependency_degradation",
      status: 502,
      retryable: true,
      terminal: false,
      details: { upstreamStatus: 200 },
    });
  });

  it("does not accept empty structured fields as parsed resume content", async () => {
    respond({
      success: true,
      data: {
        rawText: " ",
        name: "N/A",
        email: "",
        experience: [],
        education: [{}],
        skills: { technical: [] },
      },
    });

    await expect(parseResumeApi.handler(context())).rejects.toMatchObject({
      kind: "dependency_degradation",
      retryable: true,
      terminal: false,
    });
  });

  it("rejects malformed or non-JSON 2xx bodies as retryable degradation", async () => {
    respond("{not-json");

    await expect(parseResumeApi.handler(context())).rejects.toMatchObject({
      name: "ParseResumeApiError",
      kind: "dependency_degradation",
      code: "parse_resume_dependency_degradation",
      retryable: true,
      terminal: false,
    });
  });

  it("classifies explicit unsupported/unparseable document evidence as terminal", async () => {
    respond({
      success: false,
      error: {
        code: "UNPARSEABLE_DOCUMENT",
        message: "Scanned PDF has no extractable text",
      },
    });

    await expect(parseResumeApi.handler(context())).rejects.toMatchObject({
      name: "ParseResumeApiError",
      kind: "document_failure",
      code: "parse_resume_document_failure",
      status: 422,
      retryable: false,
      terminal: true,
      details: {
        upstreamStatus: 200,
        diagnostics: expect.arrayContaining([
          "UNPARSEABLE_DOCUMENT",
          "Scanned PDF has no extractable text",
        ]),
      },
    });
  });

  it("treats an explicit unsupported file-type response as terminal even on 2xx", async () => {
    respond({
      ok: false,
      code: "UNSUPPORTED_FILE_TYPE",
      reason: "Unsupported document format",
    });

    await expect(parseResumeApi.handler(context())).rejects.toMatchObject({
      kind: "document_failure",
      code: "parse_resume_document_failure",
      retryable: false,
      terminal: true,
    });
  });

  it("recognizes the provider's no-text extraction diagnostic as document failure", async () => {
    respond({
      success: false,
      error: "PDF extraction failed: no text could be extracted by any method",
      requestId: "req-no-text",
    });

    await expect(parseResumeApi.handler(context())).rejects.toMatchObject({
      kind: "document_failure",
      retryable: false,
      terminal: true,
    });
  });
});
