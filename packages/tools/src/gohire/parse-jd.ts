/**
 * gohireParseJdApi — POST {base}/parse-jd on the GoHire ATS API. Companion
 * to gohireParseResumeApi for the job-description side. Forwards the caller's
 * payload ({jd_text}, {jd_url}, {jd_base64}) verbatim; upstream validation
 * errors surface as tool_result:is_error so the LLM can self-correct.
 *
 * Credential / base-URL resolution: see rest-helper.ts.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { ghFetch } from "./rest-helper";

export const gohireParseJdApi = defineTool({
  name: "gohireParseJdApi",
  description:
    "Call GoHire POST /parse-jd to turn a job description (plain text, URL, or base64 PDF) into structured requirements. Provide one of {jd_text, jd_url, jd_base64}.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const raw = (ctx.event?.data ?? {}) as Record<string, unknown>;
    if (Object.keys(raw).length === 0) {
      throw new Error(
        "gohireParseJdApi: empty input — provide one of {jd_url, jd_base64, jd_text}.",
      );
    }
    const res = await ghFetch<Record<string, unknown>>(ctx, "POST", "/parse-jd", raw);
    if (!res.ok) {
      throw new Error(
        `gohireParseJdApi: ${res.message} — body=${JSON.stringify(res.errorBody)}`,
      );
    }
    return {
      data: res.data,
      meta: {
        provider: "gohire",
        endpoint: "POST /parse-jd",
        upstreamStatus: res.status,
      },
    };
  },
});
