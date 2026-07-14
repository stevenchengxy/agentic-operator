/**
 * gohireMatchResumeApi — POST {base}/match-resume on the GoHire ATS API.
 *
 * The GoHire counterpart to robohire's `matchResumeApi`, with the same
 * tolerant input handling so an LLM (or a `type:"tool"` manifest action) can
 * pass the resume + JD as plain strings under any of the common field names.
 *
 * Returns the same normalised envelope shape as the RoboHire wrapper —
 * { matchScore, verdict, hiringRecommendation, summary, raw } — so a tenant
 * can switch ATS providers without changing a downstream prompt that reads
 * `matchScore` / `verdict`. The normalizer coalesces a few likely upstream
 * shapes and otherwise hands the raw body through under `raw`.
 *
 * Credential / base-URL resolution: see rest-helper.ts.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { ghFetch } from "./rest-helper";

interface MatchResumeBody {
  match_score?: number;
  score?: number;
  overallMatchScore?: { score?: number };
  overallFit?: {
    verdict?: string;
    hiringRecommendation?: string;
    summary?: string;
  };
  verdict?: string;
  summary?: string;
  [k: string]: unknown;
}

export const gohireMatchResumeApi = defineTool({
  name: "gohireMatchResumeApi",
  description:
    "Call GoHire POST /match-resume to score a resume against a job description. " +
    "REQUIRED FIELDS: { resume: string, jd: string } — both plain-text full-body strings " +
    "(NOT field references, NOT URLs). " +
    "Returns a normalised envelope { matchScore, verdict, hiringRecommendation, summary, raw }.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const raw = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const body: Record<string, unknown> = { ...raw };
    if (!body.resume) {
      body.resume =
        raw.resume_text ?? raw.candidate_resume ?? raw.resume_body ?? raw.candidateResume;
    }
    if (!body.jd) {
      body.jd =
        raw.jd_text ?? raw.job_description ?? raw.jobDescription ?? raw.jd_body;
    }
    if (typeof body.resume !== "string" || typeof body.jd !== "string") {
      throw new Error(
        "gohireMatchResumeApi: required string fields `resume` and `jd` missing — provide both as plain-text full bodies.",
      );
    }
    const res = await ghFetch<MatchResumeBody>(ctx, "POST", "/match-resume", {
      resume: body.resume,
      jd: body.jd,
    });
    if (!res.ok) {
      throw new Error(
        `gohireMatchResumeApi: ${res.message} — body=${JSON.stringify(res.errorBody)}`,
      );
    }

    // Tolerate either a `{ data: {...} }` envelope or a flat body, then
    // coalesce the score/verdict from the shapes GoHire-style ATSes use.
    const envelope = (res.data ?? {}) as Record<string, unknown>;
    const upstream = (
      envelope.data && typeof envelope.data === "object" ? envelope.data : envelope
    ) as MatchResumeBody;

    const matchScore =
      upstream.overallMatchScore?.score ??
      (typeof upstream.match_score === "number" ? upstream.match_score : null) ??
      (typeof upstream.score === "number" ? upstream.score : null);
    const normalized = {
      matchScore,
      verdict: upstream.overallFit?.verdict ?? upstream.verdict ?? null,
      hiringRecommendation: upstream.overallFit?.hiringRecommendation ?? null,
      summary: upstream.overallFit?.summary ?? upstream.summary ?? null,
      raw: upstream,
    };

    return {
      data: normalized,
      meta: {
        provider: "gohire",
        endpoint: "POST /match-resume",
        upstreamStatus: res.status,
      },
    };
  },
});
