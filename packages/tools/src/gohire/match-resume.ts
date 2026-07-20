/**
 * gohireMatchResumeApi — POST {base}/match-resume on the GoHire ATS API.
 * Canonical implementation for the recruitment match call; the legacy
 * `matchResumeApi` / `gohire.matchResume` names alias here.
 *
 * Tolerant input handling so an LLM (or a `type:"tool"` manifest action) can
 * pass the resume + JD as plain strings under any of the common field names,
 * plus the candidate's own expectations as `candidatePreferences`.
 *
 * DEPTH QUIRK (ported from the battle-tested RoboHire wrapper): the vendor
 * wraps the analysis under an envelope —
 *   { success: true, data: { overallMatchScore, overallFit, ... }, requestId, savedAs }
 * A normalizer that reads `body.overallMatchScore` directly is one level too
 * shallow and silently returns `matchScore: null` for every candidate. This
 * handler unwraps the `data` envelope (tolerating the flat shape too) and
 * coalesces every score/verdict key variant the vendor has shipped.
 *
 * Returns the same normalised envelope as the RoboHire wrapper —
 * { matchScore, verdict, hiringRecommendation, summary, data, requestId,
 *   savedAs, raw } — so a tenant can switch ATS providers without changing a
 * downstream prompt that reads `matchScore` / `verdict`.
 *
 * Credential / base-URL resolution: see rest-helper.ts.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { ghFetch } from "./rest-helper";

interface MatchResumeBody {
  match_results?: unknown;
  overall_status?: string;
  matchScore?: number;
  match_score?: number;
  overall_match_score?: number;
  score?: number;
  overallMatchScore?: { score?: number } | number;
  recommendation?: string;
  verdict?: string;
  summary?: string;
  overallFit?: {
    verdict?: string;
    hiringRecommendation?: string;
    summary?: string;
  };
  [k: string]: unknown;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstFiniteNumber(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export const gohireMatchResumeApi = defineTool({
  name: "gohireMatchResumeApi",
  description:
    "Call GoHire POST /match-resume to score a resume against a job description. " +
    "REQUIRED FIELDS: { resume: string, jd: string } — both plain-text full-body strings " +
    "(NOT field references, NOT URLs). " +
    "Returns a normalised envelope { matchScore, verdict, hiringRecommendation, summary, data, requestId, savedAs, raw }.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const raw = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const body: Record<string, unknown> = { ...raw };
    if (!body.resume) {
      body.resume =
        raw.resume_text ??
        raw.candidate_resume ??
        raw.resume_body ??
        raw.candidateResume;
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
    // Candidate's OWN job-seeking expectations (期望职位/城市/薪资/工作模式) — the
    // ontology's Candidate_Expectation. The vendor accepts them as a free-form
    // `candidatePreferences` string; empty/absent means score on resume-vs-JD
    // facts only.
    const preferencesRaw =
      raw.candidatePreferences ?? raw.candidate_preferences;
    const candidatePreferences =
      typeof preferencesRaw === "string" && preferencesRaw.trim()
        ? preferencesRaw.trim()
        : null;
    const res = await ghFetch<MatchResumeBody>(ctx, "POST", "/match-resume", {
      resume: body.resume,
      jd: body.jd,
      ...(candidatePreferences ? { candidatePreferences } : {}),
    });
    if (!res.ok) {
      throw new Error(
        `gohireMatchResumeApi: ${res.message} — body=${JSON.stringify(res.errorBody)}`,
      );
    }

    // Unwrap the `data` envelope (see module docs) — reading one level too
    // shallow silently yields matchScore:null for every candidate.
    const envelope = (res.data ?? {}) as Record<string, unknown>;
    const upstream = (
      envelope.data && typeof envelope.data === "object"
        ? envelope.data
        : envelope
    ) as MatchResumeBody & { score?: number; verdict?: string };

    // The vendor has returned both its detailed Shape-D response and a compact
    // response over time. Preserve the detailed body verbatim while exposing
    // one stable score/summary surface for deterministic routing.
    const overallMatchScore = upstream.overallMatchScore;
    const matchScore = firstFiniteNumber(
      typeof overallMatchScore === "object"
        ? overallMatchScore?.score
        : overallMatchScore,
      upstream.matchScore,
      upstream.match_score,
      upstream.overall_match_score,
      upstream.score,
    );
    const normalized = {
      matchScore,
      verdict: upstream.overallFit?.verdict ?? upstream.verdict ?? null,
      hiringRecommendation:
        upstream.overallFit?.hiringRecommendation ??
        upstream.recommendation ??
        null,
      summary: upstream.overallFit?.summary ?? upstream.summary ?? null,
      // Match the legacy function's event contract: `data` is the exact,
      // unwrapped vendor analysis and the request metadata stays alongside
      // it for persistence, tracing and the legacy Inngest projection.
      data: upstream,
      requestId: firstString(envelope.requestId, envelope.request_id),
      savedAs: firstString(envelope.savedAs, envelope.saved_as),
      // Keep the existing alias so non-RAAS consumers do not break.
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
