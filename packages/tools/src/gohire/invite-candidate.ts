/**
 * gohireInviteCandidateApi — POST {base}/invite-candidate on the GoHire ATS
 * API. Generates an interview-invitation for a candidate. Pass-through
 * payload ({candidate_name, job_title, ...} or whatever the upstream wants).
 *
 * Credential / base-URL resolution: see rest-helper.ts.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { ghFetch } from "./rest-helper";

export const gohireInviteCandidateApi = defineTool({
  name: "gohireInviteCandidateApi",
  description:
    "Call GoHire POST /invite-candidate to generate an interview invitation for a candidate. " +
    "Accepts {candidate_name, job_title, ...} (passed through verbatim).",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const raw = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const res = await ghFetch<Record<string, unknown>>(
      ctx,
      "POST",
      "/invite-candidate",
      raw,
    );
    if (!res.ok) {
      throw new Error(
        `gohireInviteCandidateApi: ${res.message} — body=${JSON.stringify(res.errorBody)}`,
      );
    }
    return {
      data: res.data,
      meta: {
        provider: "gohire",
        endpoint: "POST /invite-candidate",
        upstreamStatus: res.status,
      },
    };
  },
});
