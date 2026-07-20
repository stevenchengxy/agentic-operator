import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scoreFrom(value: Record<string, unknown>): number | null {
  for (const candidate of [
    value.matchScore,
    value.match_score,
    value.overall_match_score,
  ]) {
    if (
      typeof candidate === "number" &&
      Number.isFinite(candidate) &&
      candidate >= 0 &&
      candidate <= 100
    ) {
      return candidate;
    }
  }
  return null;
}

const THRESHOLD_FIELDS = [
  "resume_match_score_threshold",
  "resumeMatchScoreThreshold",
  "match_score_threshold",
  "matchScoreThreshold",
] as const;

function thresholdValues(
  value: unknown,
): Array<{ path: string; value: unknown }> {
  const root = asRecord(value);
  const found: Array<{ path: string; value: unknown }> = [];
  const inspect = (record: Record<string, unknown>, prefix: string) => {
    for (const field of THRESHOLD_FIELDS) {
      if (record[field] !== undefined && record[field] !== null) {
        found.push({ path: `${prefix}${field}`, value: record[field] });
      }
    }
  };
  inspect(root, "");
  for (const field of ["job_requisition", "jobRequisition"] as const) {
    const nested = asRecord(root[field]);
    if (Object.keys(nested).length > 0) inspect(nested, `${field}.`);
  }
  return found;
}

function parseThreshold(value: unknown, path: string): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error(
      `routeMatchOutcome: ${path} must be an explicit number between 0 and 100`,
    );
  }
  return parsed;
}

function matchThreshold(ctx: {
  lastResult?: unknown;
  event?: { data: Record<string, unknown> };
}): number {
  const candidates = [
    ...thresholdValues(ctx.lastResult).map((item) => ({
      ...item,
      path: `lastResult.${item.path}`,
    })),
    ...thresholdValues(ctx.event?.data).map((item) => ({
      ...item,
      path: `event.data.${item.path}`,
    })),
  ];
  if (candidates.length === 0) {
    throw new Error(
      "routeMatchOutcome: resume_match_score_threshold is required from the action input or Job_Requisition; no default threshold is allowed",
    );
  }
  const parsed = candidates.map((item) => ({
    path: item.path,
    value: parseThreshold(item.value, item.path),
  }));
  const unique = [...new Set(parsed.map((item) => item.value))];
  if (unique.length !== 1) {
    throw new Error(
      `routeMatchOutcome: conflicting match thresholds (${parsed
        .map((item) => `${item.path}=${item.value}`)
        .join(", ")})`,
    );
  }
  return unique[0]!;
}

/** Route against the explicit Job_Requisition threshold; never apply a default. */
export const routeMatchOutcome = defineTool({
  name: "routeMatchOutcome",
  description:
    "Deterministically route RoboHire scores against the explicit resume_match_score_threshold carried by the action input/Job_Requisition. Missing, invalid, or conflicting scores/thresholds fail closed; no default is embedded in code.",
  factory: {
    category: "workflow-routing",
    sideEffect: "call",
    operation: "compute",
    effectScope: "none",
    sandboxPolicy: "pure",
    capabilities: [
      {
        systems: ["Agent_Runtime", "AO_Internal"],
        kinds: ["compute", "internal_runtime"],
        roles: ["route", "execute"],
        operations: ["candidate_match.route", "compute"],
        objectTypes: ["Candidate_Match_Result", "Job_Requisition"],
        probeRequired: false,
      },
    ],
    source: {
      modulePath:
        "packages/recruitment-capabilities/src/tools/route-match-outcome.ts",
      exportName: "routeMatchOutcome",
    },
  },
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const previous = asRecord(ctx.lastResult);
    const score = scoreFrom(previous);
    if (score === null) {
      throw new Error(
        "routeMatchOutcome: RoboHire returned no valid 0-100 matchScore",
      );
    }
    const threshold = matchThreshold(ctx);
    const passed = score >= threshold;
    return {
      data: {
        ...previous,
        matchScore: score,
        match_score: score,
        resume_match_score_threshold: threshold,
        _emit: passed ? "MATCH_PASSED_NEED_INTERVIEW" : "MATCH_FAILED",
        decision_reason: passed
          ? `RoboHire score ${score} meets the Job_Requisition interview threshold (>= ${threshold})`
          : `RoboHire score ${score} is below the Job_Requisition interview threshold (< ${threshold})`,
      },
    };
  },
});
