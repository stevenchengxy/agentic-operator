/**
 * External write-through for the six-agent RAAS-v1 recruitment pipeline.
 *
 * The implementation is shared by explicitly registered recruitment tenants.
 * Each registry binds a reviewed tenant/integration profile; the tool never
 * grants itself to a tenant by interpreting Action prose. Each workflow binds
 * a phase in tool_use.config and places this
 * action after its final business result is known but before runtime emit.
 * Configured targets are fail-closed: a PG/Allmeta error rejects the step, so
 * no event can claim an entity exists when the corresponding write failed.
 *
 * Target gates come only from the reviewed profile's `*_env` references and
 * `target_mode`; literal endpoints/credentials and package-owned env names are
 * not accepted.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { withRaasPgTransaction, type RaasPgSession } from "./raas-pg";

export const RAAS_PERSISTENCE_PHASES = [
  "job_posting",
  "candidate_resume",
  "candidate_match",
  "interview",
] as const;
export type RaasPersistencePhase = (typeof RAAS_PERSISTENCE_PHASES)[number];

export interface PersistenceIds {
  job_posting_id?: string;
  candidate_id?: string;
  resume_id?: string;
  candidate_match_result_id?: string;
  interview_record_id?: string;
  communication_log_id?: string;
  application_id?: string;
}

export interface AllmetaWrite {
  label: string;
  payload: Record<string, unknown>;
}

export interface PersistenceAdapters {
  postgres?: (args: {
    connectionString: string;
    phase: RaasPersistencePhase;
    snapshot: Record<string, unknown>;
    ids: PersistenceIds;
  }) => Promise<Partial<PersistenceIds>>;
  allmeta?: (args: {
    baseUrl: string;
    apiKey: string;
    domain: string;
    timeoutMs: number;
    write: AllmetaWrite;
  }) => Promise<void>;
  /** Test seam for the separate, best-effort failure-state transaction. */
  resumeUploadFailure?: (args: {
    connectionString: string;
    uploadId: string;
    errorMessage: string;
  }) => Promise<void>;
}

export interface PersistExternalArgs {
  tenantSlug: string;
  phase: RaasPersistencePhase;
  snapshot: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  /** Reviewed, non-secret integration profile. Values ending in Env are env
   * variable names, never credentials or URLs. */
  profile?: {
    targetMode?: "postgres" | "allmeta" | "both";
    postgresUrlEnv?: string;
    allmetaBaseUrlEnv?: string;
    allmetaApiKeyEnv?: string;
    allmetaDomainId?: string;
    enabledEnv?: string;
    timeoutMs?: number;
  };
}

export interface PersistenceReceipt {
  enabled: boolean;
  phase: RaasPersistencePhase;
  postgres: "written" | "disabled";
  allmeta: "written" | "disabled";
  ids: PersistenceIds;
  skipped_reason?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const stringValue = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const numberValue = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

function firstString(
  snapshot: Record<string, unknown>,
  keys: string[],
): string {
  const roots: Record<string, unknown>[] = [snapshot];
  const nested = [snapshot.data, snapshot.payload, snapshot.__raas];
  for (const value of nested) {
    const record = asRecord(value);
    if (record) roots.push(record);
  }
  for (const root of roots) {
    for (const key of keys) {
      const value = stringValue(root[key]);
      if (value) return value;
    }
  }
  return "";
}

function firstValue(
  snapshot: Record<string, unknown>,
  keys: string[],
): unknown {
  const roots = [
    snapshot,
    asRecord(snapshot.data),
    asRecord(snapshot.payload),
  ].filter((value): value is Record<string, unknown> => value !== null);
  for (const root of roots) {
    for (const key of keys) {
      if (root[key] !== undefined && root[key] !== null) return root[key];
    }
  }
  return undefined;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => stringValue(item))
      .filter((item): item is string => item.length > 0);
  }
  if (value && typeof value === "object") {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const child of Object.values(value as Record<string, unknown>)) {
      for (const item of stringArray(child)) {
        if (!seen.has(item)) {
          seen.add(item);
          result.push(item);
        }
      }
    }
    return result;
  }
  const single = stringValue(value);
  return single ? [single] : [];
}

function jsonString(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return "null";
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

type CandidateMatchRuntimeShape = {
  total_weighted_score?: unknown;
  skills_score?: unknown;
  experience_score?: unknown;
  experience_assessment?: unknown;
  matched_skills?: unknown;
  missing_skills?: unknown;
  must_have_analysis?: unknown;
  nice_to_have_analysis?: unknown;
  advantages?: unknown;
  disadvantages?: unknown;
  ai_summary?: unknown;
  final_recommendation?: unknown;
};

export interface NormalizedCandidateMatch {
  score: number | null;
  educationScore: number | null;
  skillsScore: number | null;
  projectExperienceScore: number | null;
  stabilityScore: number | null;
  experienceScore: number | null;
  experienceAssessment: string | null;
  matchedSkills: string[];
  missingSkills: string[];
  mustHaveAnalysis: unknown;
  niceToHaveAnalysis: unknown;
  advantages: string[];
  disadvantages: string[];
  aiSummary: string | null;
  finalRecommendation: string | null;
  dimensionScores: Record<string, number> | null;
  coreTags: string[];
  experienceYears: number | null;
  starRating: number | null;
  qualificationRetained: boolean | null;
}

function nestedRecord(
  root: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  return root ? asRecord(root[key]) : null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))];
}

function namedItems(value: unknown, keys: string[]): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(
    value.flatMap((item) => {
      if (typeof item === "string") return [item];
      const row = asRecord(item);
      if (!row) return [];
      for (const key of keys) {
        const found = stringValue(row[key]);
        if (found) return [found];
      }
      return [];
    }),
  );
}

function numericRecord(value: unknown): Record<string, number> | null {
  const row = asRecord(value);
  if (!row) return null;
  const output: Record<string, number> = {};
  for (const [key, item] of Object.entries(row)) {
    const parsed = numberValue(item);
    if (parsed !== null) output[key] = parsed;
  }
  return Object.keys(output).length > 0 ? output : null;
}

/**
 * Flatten RoboHire's current Shape-D response and older normalized shapes
 * into the partner schema. Keeping this deterministic prevents a retry with
 * a shallower provider envelope from silently erasing useful match evidence.
 */
export function normalizeCandidateMatchSnapshot(
  snapshot: Record<string, unknown>,
): NormalizedCandidateMatch {
  const provider =
    asRecord(snapshot.data) ?? asRecord(snapshot.raw) ?? snapshot;
  const inner = asRecord(provider.data) ?? provider;
  const matchAnalysis = nestedRecord(inner, "matchAnalysis");
  const technical = nestedRecord(matchAnalysis, "technicalSkills");
  const experience = nestedRecord(matchAnalysis, "experienceLevel");
  const education = nestedRecord(matchAnalysis, "education");
  const projectExperience = nestedRecord(matchAnalysis, "projectExperience");
  const stability = nestedRecord(matchAnalysis, "stability");
  const mustHave =
    inner.mustHaveAnalysis ?? firstValue(snapshot, ["must_have_analysis"]);
  const niceToHave =
    inner.niceToHaveAnalysis ?? firstValue(snapshot, ["nice_to_have_analysis"]);
  const mustHaveRecord = asRecord(mustHave);
  const niceToHaveRecord = asRecord(niceToHave);
  const mustEvaluation = nestedRecord(mustHaveRecord, "candidateEvaluation");
  const niceEvaluation = nestedRecord(niceToHaveRecord, "candidateEvaluation");
  const overall = nestedRecord(inner, "overallMatchScore");
  const overallFit = nestedRecord(inner, "overallFit");
  const breakdown = nestedRecord(overall, "breakdown");

  const matchedSkills = uniqueStrings([
    ...namedItems(firstValue(snapshot, ["matched_skills"]), ["skill", "name"]),
    ...namedItems(technical?.matchedSkills, ["skill", "name"]),
    ...namedItems(mustEvaluation?.matchedSkills, ["skill", "name"]),
    ...namedItems(niceEvaluation?.matchedSkills, ["skill", "name"]),
  ]);
  const missingSkills = uniqueStrings([
    ...namedItems(firstValue(snapshot, ["missing_skills"]), ["skill", "name"]),
    ...namedItems(technical?.missingSkills, ["skill", "name"]),
    ...namedItems(mustEvaluation?.missingSkills, ["skill", "name"]),
  ]);
  const matchedExperiences = uniqueStrings([
    ...namedItems(mustEvaluation?.matchedExperiences, [
      "candidateEvidence",
      "experience",
      "description",
    ]),
    ...namedItems(niceEvaluation?.matchedExperiences, [
      "candidateEvidence",
      "experience",
      "description",
    ]),
  ]);

  const summaryParts = uniqueStrings([
    stringValue(mustHaveRecord?.gapAnalysis),
    stringValue(niceToHaveRecord?.competitiveAdvantage),
  ]);
  const score =
    numberValue(
      firstValue(snapshot, [
        "match_score",
        "matchScore",
        "matching_score",
        "total_weighted_score",
      ]),
    ) ?? numberValue(overall?.score);
  const explicitAdvantages = namedItems(
    firstValue(snapshot, ["advantages", "matched_reason_highlights"]),
    ["skill", "name", "description"],
  );
  const explicitDisadvantages = namedItems(
    firstValue(snapshot, ["disadvantages"]),
    ["skill", "name", "description"],
  );
  const explicitDimensions = numericRecord(
    firstValue(snapshot, ["dimension_scores"]),
  );
  const dimensions: Record<string, number> = {};
  const dimensionCandidates: Array<[string, unknown]> = [
    ["skill", breakdown?.skillMatchScore ?? technical?.score],
    ["experience", breakdown?.experienceScore ?? experience?.score],
    ["potential", breakdown?.potentialScore],
    ["domain", nestedRecord(matchAnalysis, "domainKnowledge")?.score],
    ["soft", nestedRecord(matchAnalysis, "softSkills")?.score],
    ["education", education?.score],
    ["stability", stability?.score],
  ];
  for (const [key, value] of dimensionCandidates) {
    const parsed = numberValue(value);
    if (parsed !== null) dimensions[key] = parsed;
  }

  const explicitCoreTags = stringArray(
    firstValue(snapshot, ["core_tags", "coreTags"]),
  );
  const disqualified = mustHaveRecord?.disqualified;
  const qualificationValue = firstValue(snapshot, ["qualification_retained"]);
  return {
    score,
    educationScore:
      numberValue(firstValue(snapshot, ["education_score"])) ??
      numberValue(education?.score),
    skillsScore:
      numberValue(firstValue(snapshot, ["skills_score"])) ??
      numberValue(breakdown?.skillMatchScore) ??
      numberValue(technical?.score) ??
      numberValue(mustHaveRecord?.mustHaveScore),
    projectExperienceScore:
      numberValue(firstValue(snapshot, ["project_experience_score"])) ??
      numberValue(projectExperience?.score),
    stabilityScore:
      numberValue(firstValue(snapshot, ["stability_score"])) ??
      numberValue(stability?.score),
    experienceScore:
      numberValue(firstValue(snapshot, ["experience_score"])) ??
      numberValue(breakdown?.experienceScore) ??
      numberValue(experience?.score),
    experienceAssessment:
      firstString(snapshot, ["experience_assessment"]) ||
      stringValue(experience?.assessment) ||
      (matchedExperiences.length > 0 ? matchedExperiences.join("；") : null),
    matchedSkills,
    missingSkills,
    mustHaveAnalysis: mustHave ?? null,
    niceToHaveAnalysis: niceToHave ?? null,
    advantages:
      explicitAdvantages.length > 0 ? explicitAdvantages : matchedSkills,
    disadvantages:
      explicitDisadvantages.length > 0 ? explicitDisadvantages : missingSkills,
    aiSummary:
      firstString(snapshot, ["summary", "ai_summary", "overall_fit_summary"]) ||
      stringValue(overallFit?.summary) ||
      (summaryParts.length > 0 ? summaryParts.join("\n\n") : null),
    finalRecommendation:
      firstString(snapshot, [
        "hiringRecommendation",
        "final_recommendation",
        "recommendation",
      ]) ||
      stringValue(overallFit?.hiringRecommendation) ||
      null,
    dimensionScores:
      explicitDimensions ??
      (Object.keys(dimensions).length > 0 ? dimensions : null),
    coreTags:
      explicitCoreTags.length > 0
        ? uniqueStrings(explicitCoreTags)
        : matchedSkills.slice(0, 6),
    experienceYears: numberValue(firstValue(snapshot, ["experience_years"])),
    starRating: numberValue(firstValue(snapshot, ["star_rating"])),
    qualificationRetained:
      typeof qualificationValue === "boolean"
        ? qualificationValue
        : typeof disqualified === "boolean"
          ? !disqualified
          : null,
  };
}

export function candidateMatchRichness(
  row: CandidateMatchRuntimeShape | null | undefined,
): number {
  if (!row) return 0;
  let score = 0;
  if (row.total_weighted_score != null) score += 3;
  if (row.skills_score != null) score += 1;
  if (row.experience_score != null) score += 1;
  if (stringValue(row.experience_assessment)) score += 1;
  if (stringArray(row.matched_skills).length > 0) score += 1;
  if (stringArray(row.missing_skills).length > 0) score += 1;
  if (row.must_have_analysis != null) score += 2;
  if (row.nice_to_have_analysis != null) score += 2;
  if (stringArray(row.advantages).length > 0) score += 1;
  if (stringArray(row.disadvantages).length > 0) score += 1;
  if (stringValue(row.ai_summary)) score += 2;
  if (stringValue(row.final_recommendation)) score += 1;
  return score;
}

/** Find the most resume-like nested object without depending on one provider envelope. */
export function parsedResume(
  snapshot: Record<string, unknown>,
): Record<string, unknown> {
  const queue: unknown[] = [
    snapshot.resume,
    snapshot.parsed,
    snapshot.parsed_resume,
    snapshot.data,
    snapshot,
  ];
  const seen = new Set<object>();
  let best: Record<string, unknown> = {};
  let bestScore = -1;
  const resumeKeys = [
    "name",
    "phone",
    "mobile",
    "email",
    "experience",
    "work_history",
    "education",
    "skills",
    "rawText",
  ];

  while (queue.length > 0 && seen.size < 32) {
    const value = parseMaybeJson(queue.shift());
    const record = asRecord(value);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    const score = resumeKeys.reduce(
      (total, key) => total + (record[key] !== undefined ? 1 : 0),
      0,
    );
    if (score > bestScore) {
      best = record;
      bestScore = score;
    }
    for (const key of ["data", "result", "resume", "parsed", "candidate"]) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return best;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

/** Stable UUID-shaped identifier for retries where the partner supplied no id. */
export function stableUuid(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function requireField(value: string, label: string): string {
  if (!value) {
    throw new Error(`persistRaasEntities: ${label} is required`);
  }
  return value;
}

function initialIds(
  tenantSlug: string,
  phase: RaasPersistencePhase,
  snapshot: Record<string, unknown>,
): PersistenceIds {
  const candidateId = firstString(snapshot, ["candidate_id", "candidateId"]);
  const jr = firstString(snapshot, [
    "job_requisition_id",
    "jobRequisitionId",
    "requisition_id",
    ...(phase === "job_posting" ? ["entity_id", "__subject"] : []),
  ]);
  const correlation = firstString(snapshot, [
    "correlation_id",
    "__correlationId",
    "__runtime_correlation_id",
  ]);
  const resumeKey = firstString(snapshot, [
    "resume_id",
    "resumeId",
    "upload_id",
    "object_key",
    "resume_file_path",
    "file_path",
    "filename",
    "file_name",
    "sha256",
    "file_sha256",
  ]);
  const base: PersistenceIds = {
    candidate_id: candidateId || undefined,
    application_id:
      firstString(snapshot, ["application_id", "applicationId"]) || undefined,
  };

  switch (phase) {
    case "job_posting":
      return {
        ...base,
        job_posting_id:
          firstString(snapshot, ["external_job_posting_id"]) ||
          stableUuid(`${tenantSlug}:job-posting:${jr}`),
      };
    case "candidate_resume":
      requireField(candidateId, "candidate_id");
      requireField(
        resumeKey,
        "resume identity (resume_id/upload_id/object_key/path/hash)",
      );
      return {
        ...base,
        resume_id:
          firstString(snapshot, ["resume_id", "resumeId"]) ||
          stableUuid(`${tenantSlug}:resume:${candidateId}:${resumeKey}`),
      };
    case "candidate_match":
      return {
        ...base,
        candidate_match_result_id:
          firstString(snapshot, [
            "candidate_match_result_id",
            "candidateMatchResultId",
          ]) || stableUuid(`${tenantSlug}:match:${candidateId}:${jr}`),
      };
    case "interview":
      return {
        ...base,
        interview_record_id:
          firstString(snapshot, ["interview_record_id"]) ||
          stableUuid(
            `${tenantSlug}:interview:${correlation}:${candidateId}:${jr}`,
          ),
        communication_log_id:
          firstString(snapshot, ["communication_log_id"]) ||
          stableUuid(
            `${tenantSlug}:communication:${correlation}:${candidateId}:${jr}`,
          ),
      };
  }
}

function enabledSetting(
  env: NodeJS.ProcessEnv,
  enabledEnv?: string,
): boolean | "auto" {
  if (!enabledEnv?.trim()) return "auto";
  const raw = env[enabledEnv]?.trim().toLowerCase();
  if (!raw) return "auto";
  if (["0", "false", "off", "no"].includes(raw)) return false;
  if (["1", "true", "on", "yes"].includes(raw)) return true;
  throw new Error(`persistRaasEntities: ${enabledEnv} must be 0/1/false/true`);
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function referencedEnvironmentValue(
  env: NodeJS.ProcessEnv,
  envName: string | undefined,
  label: string,
  required: boolean,
): string {
  const name = envName?.trim() ?? "";
  if (!name) {
    if (!required) return "";
    throw new Error(
      `persistRaasEntities: ${label} environment reference is required`,
    );
  }
  if (!ENV_NAME.test(name)) {
    throw new Error(
      `persistRaasEntities: ${label} must be a valid environment variable name`,
    );
  }
  const value = env[name]?.trim() ?? "";
  if (!value && required) {
    throw new Error(
      `persistRaasEntities: environment reference ${name} is not configured`,
    );
  }
  return value;
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      "persistRaasEntities: profile timeoutMs must be a positive integer",
    );
  }
  return parsed;
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function markCandidateResumeFailureBestEffort(
  args: PersistExternalArgs,
  connectionString: string,
  adapters: PersistenceAdapters,
  error: unknown,
): Promise<void> {
  if (args.phase !== "candidate_resume" || !connectionString) return;
  const uploadId = firstString(args.snapshot, ["upload_id", "uploadId"]);
  if (!uploadId) return;

  const writer = adapters.resumeUploadFailure ?? markResumeUploadFailed;
  try {
    await writer({
      connectionString,
      uploadId,
      errorMessage: messageFromError(error),
    });
  } catch {
    // Match the legacy save-candidate catch path: failure-state persistence is
    // best effort and must never replace the original candidate/resume error.
  }
}

export async function persistRaasExternal(
  args: PersistExternalArgs,
  adapters: PersistenceAdapters = {},
): Promise<PersistenceReceipt> {
  if (!args.tenantSlug.trim()) {
    throw new Error("persistRaasEntities: tenantSlug is required");
  }
  const env = args.env ?? process.env;
  const profile = args.profile;
  const enabled = enabledSetting(env, profile?.enabledEnv);
  const wantsPostgres =
    !profile?.targetMode || profile.targetMode !== "allmeta";
  const wantsAllmeta =
    !profile?.targetMode || profile.targetMode !== "postgres";
  const connectionString = profile
    ? referencedEnvironmentValue(
        env,
        profile.postgresUrlEnv,
        "postgresUrlEnv",
        Boolean(profile.targetMode && wantsPostgres),
      )
    : "";
  const allmetaBase = (
    profile
      ? referencedEnvironmentValue(
          env,
          profile.allmetaBaseUrlEnv,
          "allmetaBaseUrlEnv",
          Boolean(profile.targetMode && wantsAllmeta),
        )
      : ""
  ).replace(/\/+$/, "");
  const allmetaKey = profile
    ? referencedEnvironmentValue(
        env,
        profile.allmetaApiKeyEnv,
        "allmetaApiKeyEnv",
        Boolean(profile.targetMode && wantsAllmeta),
      )
    : "";

  if (enabled === false) {
    return {
      enabled: false,
      phase: args.phase,
      postgres: "disabled",
      allmeta: "disabled",
      ids: initialIds(args.tenantSlug, args.phase, args.snapshot),
    };
  }
  if (allmetaBase && !allmetaKey) {
    throw new Error(
      "persistRaasEntities: Allmeta base URL is configured but its API key is missing",
    );
  }
  if (!allmetaBase && allmetaKey) {
    throw new Error(
      "persistRaasEntities: Allmeta API key is configured but its base URL is missing",
    );
  }
  if (enabled === true && !connectionString && !allmetaBase) {
    throw new Error(
      "persistRaasEntities: persistence is enabled but no reviewed target profile is configured",
    );
  }

  let ids: PersistenceIds;
  try {
    ids = initialIds(args.tenantSlug, args.phase, args.snapshot);
  } catch (error) {
    await markCandidateResumeFailureBestEffort(
      args,
      connectionString,
      adapters,
      error,
    );
    throw error;
  }
  if (
    args.phase === "interview" &&
    firstValue(args.snapshot, ["success"]) === false &&
    (!firstString(args.snapshot, ["candidate_id", "candidateId"]) ||
      !firstString(args.snapshot, ["job_requisition_id", "jobRequisitionId"]))
  ) {
    // An unaddressable bad request still needs to reach the FAILED event so
    // operators can repair the publisher. There is no valid business entity
    // that PG/Allmeta could safely mutate.
    return {
      enabled: false,
      phase: args.phase,
      postgres: "disabled",
      allmeta: "disabled",
      ids,
      skipped_reason: "unaddressable_invitation_failure",
    };
  }
  if (connectionString) {
    const pgWriter = adapters.postgres ?? persistPostgres;
    try {
      const persisted = await pgWriter({
        connectionString,
        phase: args.phase,
        snapshot: args.snapshot,
        ids,
      });
      ids = { ...ids, ...persisted };
    } catch (error) {
      await markCandidateResumeFailureBestEffort(
        args,
        connectionString,
        adapters,
        error,
      );
      throw error;
    }
  }

  if (allmetaBase) {
    const domain = profile?.allmetaDomainId?.trim() || "";
    if (!domain) {
      throw new Error(
        "persistRaasEntities: allmetaDomainId is required when Allmeta persistence is enabled",
      );
    }
    const timeoutMs = positiveTimeout(profile?.timeoutMs, 8_000);
    const writer = adapters.allmeta ?? postAllmeta;
    for (const write of buildAllmetaWrites(args.phase, args.snapshot, ids)) {
      await writer({
        baseUrl: allmetaBase,
        apiKey: allmetaKey,
        domain,
        timeoutMs,
        write,
      });
    }
  }

  return {
    enabled: Boolean(connectionString || allmetaBase),
    phase: args.phase,
    postgres: connectionString ? "written" : "disabled",
    allmeta: allmetaBase ? "written" : "disabled",
    ids,
  };
}

async function postAllmeta(args: {
  baseUrl: string;
  apiKey: string;
  domain: string;
  timeoutMs: number;
  write: AllmetaWrite;
}): Promise<void> {
  const url =
    `${args.baseUrl}/api/v1/ontology/instances/${encodeURIComponent(args.write.label)}` +
    `?domain=${encodeURIComponent(args.domain)}&validate=strict`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        ...args.write.payload,
        domainId: args.domain,
      }),
      signal: AbortSignal.timeout(args.timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `persistRaasEntities: Allmeta ${args.write.label} request failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `persistRaasEntities: Allmeta ${args.write.label} returned HTTP ${response.status}: ${body.slice(0, 300)}`,
    );
  }
}

async function persistPostgres(args: {
  connectionString: string;
  phase: RaasPersistencePhase;
  snapshot: Record<string, unknown>;
  ids: PersistenceIds;
}): Promise<Partial<PersistenceIds>> {
  return withRaasPgTransaction(args.connectionString, (client) =>
    persistPostgresWithSession(client, args.phase, args.snapshot, args.ids),
  );
}

async function markResumeUploadFailed(args: {
  connectionString: string;
  uploadId: string;
  errorMessage: string;
}): Promise<void> {
  await withRaasPgTransaction(args.connectionString, async (client) => {
    await failResumeUploadRuntimeWithSession(
      client,
      args.uploadId,
      args.errorMessage,
    );
  });
}

/**
 * Advance partner's upload state after the candidate/resume transaction fails.
 * A missing partner-owned row is intentionally a no-op.
 */
export async function failResumeUploadRuntimeWithSession(
  client: RaasPgSession,
  uploadId: string,
  errorMessage: string,
): Promise<boolean> {
  const normalizedUploadId = uploadId.trim();
  if (!normalizedUploadId) return false;
  const result = await client.query(
    `UPDATE resume_upload_runtime SET
        status        = 'failed',
        error_message = $2,
        updated_at    = NOW()
      WHERE upload_id = $1`,
    [normalizedUploadId, errorMessage.slice(0, 1000)],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Exported contract seam for SQL-level tests; production wraps it in a tx. */
export async function persistPostgresWithSession(
  client: RaasPgSession,
  phase: RaasPersistencePhase,
  snapshot: Record<string, unknown>,
  ids: PersistenceIds,
): Promise<Partial<PersistenceIds>> {
  switch (phase) {
    case "job_posting":
      return persistJobPostingPg(client, snapshot, ids);
    case "candidate_resume":
      return persistCandidateResumePg(client, snapshot, ids);
    case "candidate_match":
      return persistCandidateMatchPg(client, snapshot, ids);
    case "interview":
      return persistInterviewPg(client, snapshot, ids);
  }
}

async function persistJobPostingPg(
  client: RaasPgSession,
  snapshot: Record<string, unknown>,
  ids: PersistenceIds,
): Promise<Partial<PersistenceIds>> {
  const jr = requireField(
    firstString(snapshot, [
      "job_requisition_id",
      "jobRequisitionId",
      "entity_id",
      "__subject",
    ]),
    "job_requisition_id",
  );
  const requisition = await client.query<{
    client_id: string | null;
    client_job_title: string | null;
    job_requisition_specification_id: string | null;
  }>(
    `SELECT
        COALESCE(r.client_id, s.client_id) AS client_id,
        r.client_job_title,
        r.job_requisition_specification_id
      FROM job_requisition r
      LEFT JOIN job_requisition_specification s
        ON s.job_requisition_specification_id = r.job_requisition_specification_id
      WHERE r.job_requisition_id = $1
      LIMIT 1`,
    [jr],
  );
  const requisitionRow = requisition.rows[0];
  if (!requisitionRow) {
    throw new Error(
      `persistRaasEntities: RAAS JobRequisition '${jr}' does not exist`,
    );
  }
  const clientId = requireField(
    firstString(snapshot, ["client_id", "clientId"]) ||
      stringValue(requisitionRow.client_id),
    "client_id for RAAS JobPosting",
  );
  const title = requireField(
    firstString(snapshot, ["title", "posting_title", "job_title"]) ||
      stringValue(requisitionRow.client_job_title),
    "title for RAAS JobPosting",
  );
  const description = firstString(snapshot, [
    "jd_content",
    "posting_description",
    "description",
  ]);
  const keywords = stringArray(
    firstValue(snapshot, ["keywords", "search_keywords", "key_words"]),
  ).slice(0, 5);
  const requisitionPatches: Array<{
    column: string;
    value: unknown;
    cast?: string;
  }> = [];
  const addTextPatch = (column: string, keys: string[]) => {
    const value = firstString(snapshot, keys);
    if (value) requisitionPatches.push({ column, value });
  };
  const addNumberPatch = (column: string, keys: string[]) => {
    const value = numberValue(firstValue(snapshot, keys));
    if (value !== null) requisitionPatches.push({ column, value });
  };
  const addJsonArrayPatch = (column: string, keys: string[]) => {
    const values = stringArray(firstValue(snapshot, keys));
    if (values.length > 0) {
      requisitionPatches.push({
        column,
        value: JSON.stringify(values),
        cast: "::jsonb",
      });
    }
  };
  addJsonArrayPatch("must_have_skills", ["must_have_skills", "must_have"]);
  addJsonArrayPatch("nice_to_have_skills", [
    "nice_to_have_skills",
    "nice_to_have_list",
  ]);
  addTextPatch("negative_requirement", ["negative_requirement"]);
  addTextPatch("language_requirements", ["language_requirements"]);
  addTextPatch("expected_level", ["expected_level", "experienceLevel"]);
  addTextPatch("degree_requirement", ["degree_requirement", "education"]);
  addTextPatch("education_requirement", ["education_requirement"]);
  addNumberPatch("work_years", ["work_years"]);
  addTextPatch("interview_mode", ["interview_mode"]);
  addTextPatch("recruitment_type", ["recruitment_type", "employmentType"]);
  addTextPatch("qualifications", ["qualifications"]);
  addTextPatch("hard_requirements", ["hardRequirements", "hard_requirements"]);
  addTextPatch("nice_to_have", ["niceToHave", "nice_to_have"]);
  addTextPatch("interview_requirements", [
    "interviewRequirements",
    "interview_requirements",
  ]);
  addTextPatch("evaluation_rules", ["evaluationRules", "evaluation_rules"]);
  addTextPatch("benefits", ["benefits"]);
  addNumberPatch("headcount", ["headcount"]);
  if (requisitionPatches.length > 0) {
    const setClause = requisitionPatches
      .map(
        (patch, index) => `${patch.column} = $${index + 2}${patch.cast ?? ""}`,
      )
      .join(", ");
    await client.query(
      `UPDATE job_requisition
          SET ${setClause}, updated_at = NOW()
        WHERE job_requisition_id = $1`,
      [jr, ...requisitionPatches.map((patch) => patch.value)],
    );
  }
  const existing = await client.query<{ job_posting_id: string }>(
    `SELECT job_posting_id FROM job_posting
      WHERE job_requisition_id = $1
      ORDER BY published_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [jr],
  );
  const id =
    existing.rows[0]?.job_posting_id ??
    requireField(ids.job_posting_id ?? "", "job_posting_id");
  if (existing.rows[0]) {
    await client.query(
      `UPDATE job_posting SET
          posting_title = $2,
          posting_description = $3,
          search_keywords = $4::text[],
          publish_status = 'pending',
          updated_at = NOW()
        WHERE job_posting_id = $1`,
      [id, title, description || null, keywords],
    );
  } else {
    await client.query(
      `INSERT INTO job_posting (
          job_posting_id, job_requisition_id, client_id,
          posting_title, posting_description, search_keywords,
          status, publish_status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6::text[], 'draft', 'pending', NOW(), NOW())`,
      [id, jr, clientId, title, description || null, keywords],
    );
  }
  const specificationId = stringValue(
    requisitionRow.job_requisition_specification_id,
  );
  if (specificationId) {
    // Match the partner JD-sync state machine: generating a posting moves only
    // a still-draft specification into HSM review.  The compare-and-set keeps
    // retries idempotent and never rewinds a later approved/rejected state.
    await client.query(
      `UPDATE job_requisition_specification
          SET status = 'pending_publish', updated_at = NOW()
        WHERE job_requisition_specification_id = $1
          AND status = 'draft'`,
      [specificationId],
    );
  }
  return { job_posting_id: id };
}

async function persistCandidateResumePg(
  client: RaasPgSession,
  snapshot: Record<string, unknown>,
  ids: PersistenceIds,
): Promise<Partial<PersistenceIds>> {
  const candidateId = requireField(
    ids.candidate_id ?? firstString(snapshot, ["candidate_id"]),
    "candidate_id",
  );
  const resumeId = requireField(ids.resume_id ?? "", "resume_id");
  const bucket = requireField(
    firstString(snapshot, ["bucket", "bucket_name"]),
    "bucket",
  );
  const objectKey = requireField(
    firstString(snapshot, ["object_key"]),
    "object_key",
  );
  const parsed = parsedResume(snapshot);
  const name =
    firstString(parsed, ["name", "full_name", "candidate_name"]) ||
    firstString(snapshot, ["name", "candidate_name"]) ||
    "未命名候选人";
  const phone = firstString(parsed, ["phone", "mobile", "phoneNumber"]);
  const normalizedPhone = phone.replace(/\D/g, "") || null;
  const email = firstString(parsed, ["email"]);
  const skills = stringArray(parsed.skills);
  const languages = stringArray(parsed.languages);
  const employeeId = firstString(snapshot, [
    "locked_by_employee_id",
    "employee_id",
    "operator_id",
  ]);
  const sourcingChannel =
    firstString(snapshot, ["sourcing_channel_id"]) || "02001034";
  const existingCandidate = await client.query<{ candidate_id: string }>(
    "SELECT candidate_id FROM candidate WHERE candidate_id = $1 LIMIT 1",
    [candidateId],
  );
  if (existingCandidate.rows[0]) {
    await client.query(
      `UPDATE candidate SET
          name = COALESCE(NULLIF($2, ''), name),
          mobile = COALESCE(NULLIF($3, ''), mobile),
          mobile_normalized = COALESCE($4, mobile_normalized),
          email = COALESCE(NULLIF($5, ''), email),
          skills = CASE WHEN cardinality($6::text[]) > 0 THEN $6::text[] ELSE skills END,
          languages = CASE WHEN cardinality($7::text[]) > 0 THEN $7::text[] ELSE languages END,
          employee_id = COALESCE(NULLIF($8, ''), employee_id),
          sourcing_channel_id = COALESCE(NULLIF($9, ''), sourcing_channel_id),
          data_source = COALESCE(data_source, 'agentic_operator'),
          status = COALESCE(status, 'active'),
          updated_at = NOW()
        WHERE candidate_id = $1`,
      [
        candidateId,
        name,
        phone,
        normalizedPhone,
        email,
        skills,
        languages,
        employeeId,
        sourcingChannel,
      ],
    );
  } else {
    await client.query(
      `INSERT INTO candidate (
          candidate_id, name, mobile, mobile_normalized, email,
          skills, languages, employee_id, sourcing_channel_id,
          data_source, status, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6::text[], $7::text[], $8, $9,
          'agentic_operator', 'active', NOW(), NOW()
        )`,
      [
        candidateId,
        name,
        phone || null,
        normalizedPhone,
        email || null,
        skills,
        languages,
        employeeId || null,
        sourcingChannel,
      ],
    );
  }

  const existingResume = await client.query<{ resume_id: string }>(
    `SELECT resume_id FROM resume
      WHERE resume_id = $1 OR (candidate_id = $2 AND object_key = $3)
      ORDER BY CASE WHEN resume_id = $1 THEN 0 ELSE 1 END
      LIMIT 1`,
    [resumeId, candidateId, objectKey],
  );
  const persistedResumeId = existingResume.rows[0]?.resume_id ?? resumeId;
  const rawText = firstString(parsed, [
    "rawText",
    "raw_text",
    "parsed_content",
  ]);
  const summary = firstString(parsed, ["summary"]);
  const certifications = stringArray(parsed.certifications);
  const workHistory =
    firstValue(parsed, ["experience", "work_history", "workExperience"]) ?? [];
  const education =
    firstValue(parsed, ["education", "education_history"]) ?? [];
  const projects = firstValue(parsed, ["projects", "project_history"]) ?? [];
  const filename = firstString(snapshot, [
    "filename",
    "file_name",
    "resume_filename",
  ]);
  const size = numberValue(
    firstValue(snapshot, ["size", "file_size", "remote_size"]),
  );
  if (existingResume.rows[0]) {
    await client.query(
      `UPDATE resume SET
          raw_parse_result = $2::jsonb,
          parsed_content = $3,
          summary = $4,
          skills_extracted = $5::text[],
          languages = $6::text[],
          certifications = $7::text[],
          work_history = $8::jsonb,
          education_history = $9::jsonb,
          project_history = $10::jsonb,
          parse_status = 'completed',
          parse_error = NULL,
          updated_at = NOW()
        WHERE resume_id = $1`,
      [
        persistedResumeId,
        jsonString(parsed),
        rawText || null,
        summary || null,
        skills,
        languages,
        certifications,
        jsonString(workHistory),
        jsonString(education),
        jsonString(projects),
      ],
    );
  } else {
    await client.query(
      `INSERT INTO resume (
          resume_id, candidate_id, file_name, file_size,
          bucket_name, object_key, raw_parse_result, parsed_content, summary,
          skills_extracted, languages, certifications,
          work_history, education_history, project_history,
          uploaded_by, parse_status, uploaded_at, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7::jsonb, $8, $9,
          $10::text[], $11::text[], $12::text[],
          $13::jsonb, $14::jsonb, $15::jsonb,
          $16, 'completed', NOW(), NOW(), NOW()
        )`,
      [
        persistedResumeId,
        candidateId,
        filename || null,
        size,
        bucket,
        objectKey,
        jsonString(parsed),
        rawText || null,
        summary || null,
        skills,
        languages,
        certifications,
        jsonString(workHistory),
        jsonString(education),
        jsonString(projects),
        employeeId || null,
      ],
    );
  }
  await client.query(
    "UPDATE candidate SET latest_resume_id = $2, updated_at = NOW() WHERE candidate_id = $1",
    [candidateId, persistedResumeId],
  );
  const uploadId = firstString(snapshot, ["upload_id", "uploadId"]);
  if (uploadId) {
    // Keep this in the same transaction as Candidate + Resume. RAAS owns row
    // creation, so an absent runtime row is deliberately not inserted here.
    await client.query(
      `UPDATE resume_upload_runtime SET
          status        = 'completed',
          candidate_id  = $1,
          resume_id     = $2,
          error_message = NULL,
          updated_at    = NOW()
        WHERE upload_id = $3`,
      [candidateId, persistedResumeId, uploadId],
    );
  }
  return { candidate_id: candidateId, resume_id: persistedResumeId };
}

async function persistCandidateMatchPg(
  client: RaasPgSession,
  snapshot: Record<string, unknown>,
  ids: PersistenceIds,
): Promise<Partial<PersistenceIds>> {
  const candidateId = requireField(
    ids.candidate_id ?? firstString(snapshot, ["candidate_id"]),
    "candidate_id",
  );
  const jr = requireField(
    firstString(snapshot, ["job_requisition_id", "jobRequisitionId"]),
    "job_requisition_id",
  );
  const normalized = normalizeCandidateMatchSnapshot(snapshot);
  const score = normalized.score;
  if (score === null)
    throw new Error("persistRaasEntities: match_score is required");
  const posting = await client.query<{
    job_posting_id: string;
    client_id: string;
  }>(
    `SELECT job_posting_id, client_id FROM job_posting
      WHERE job_requisition_id = $1
      ORDER BY published_at DESC NULLS LAST, created_at DESC
      LIMIT 1`,
    [jr],
  );
  const postingRow = posting.rows[0];
  if (!postingRow) {
    throw new Error(
      `persistRaasEntities: RAAS JobPosting for job_requisition_id '${jr}' does not exist`,
    );
  }
  const existing = await client.query<{ candidate_match_result_id: string }>(
    `SELECT candidate_match_result_id FROM candidate_match_result
      WHERE candidate_id = $1 AND job_requisition_id = $2
      ORDER BY updated_at DESC LIMIT 1`,
    [candidateId, jr],
  );
  const runtime = await client.query<
    CandidateMatchRuntimeShape & { candidate_match_result_id: string }
  >(
    `SELECT candidate_match_result_id, total_weighted_score, skills_score,
            experience_score, experience_assessment,
            matched_skills, missing_skills,
            must_have_analysis, nice_to_have_analysis,
            advantages, disadvantages, ai_summary, final_recommendation
       FROM candidate_match_result_runtime_state
      WHERE candidate_id = $1 AND job_requisition_id = $2
      ORDER BY updated_at DESC LIMIT 1`,
    [candidateId, jr],
  );
  const id =
    existing.rows[0]?.candidate_match_result_id ??
    runtime.rows[0]?.candidate_match_result_id ??
    requireField(
      ids.candidate_match_result_id ?? "",
      "candidate_match_result_id",
    );
  const selector = firstString(snapshot, ["_emit"]);
  const verdict = firstString(snapshot, ["verdict", "overall_fit_verdict"]);
  const summary =
    normalized.aiSummary ||
    firstString(snapshot, ["decision_reason", "overall_fit_summary"]);
  const recommendation =
    normalized.finalRecommendation ||
    (selector === "MATCH_PASSED_NO_INTERVIEW"
      ? "direct_recommend"
      : selector === "MATCH_PASSED_NEED_INTERVIEW"
        ? "need_interview"
        : "failed");
  const matchStatus =
    selector === "MATCH_FAILED"
      ? "failed"
      : selector === "MATCH_PASSED_NO_INTERVIEW"
        ? "tentative"
        : "matched";
  const incomingRuntime: CandidateMatchRuntimeShape = {
    total_weighted_score: score,
    skills_score: normalized.skillsScore,
    experience_score: normalized.experienceScore,
    experience_assessment: normalized.experienceAssessment,
    matched_skills: normalized.matchedSkills,
    missing_skills: normalized.missingSkills,
    must_have_analysis: normalized.mustHaveAnalysis,
    nice_to_have_analysis: normalized.niceToHaveAnalysis,
    advantages: normalized.advantages,
    disadvantages: normalized.disadvantages,
    ai_summary: summary || null,
    final_recommendation: recommendation,
  };
  const existingRichness = candidateMatchRichness(runtime.rows[0]);
  if (
    existingRichness > 0 &&
    candidateMatchRichness(incomingRuntime) < existingRichness
  ) {
    return {
      candidate_match_result_id: id,
      job_posting_id: postingRow.job_posting_id,
    };
  }

  if (runtime.rows[0]) {
    await client.query(
      `UPDATE candidate_match_result_runtime_state SET
          job_posting_id = $2,
          client_id = $3,
          education_score = $4,
          skills_score = $5,
          project_experience_score = $6,
          stability_score = $7,
          experience_score = $8,
          experience_assessment = $9,
          total_weighted_score = $10,
          matched_skills = $11::jsonb,
          missing_skills = $12::jsonb,
          must_have_analysis = $13::jsonb,
          nice_to_have_analysis = $14::jsonb,
          star_rating = $15,
          qualification_retained = $16,
          advantages = $17::jsonb,
          disadvantages = $18::jsonb,
          ai_summary = $19,
          final_recommendation = $20,
          raw_llm_response = $21::jsonb,
          updated_at = NOW()
        WHERE candidate_match_result_id = $1`,
      [
        id,
        postingRow.job_posting_id,
        postingRow.client_id,
        normalized.educationScore,
        normalized.skillsScore,
        normalized.projectExperienceScore,
        normalized.stabilityScore,
        normalized.experienceScore,
        normalized.experienceAssessment,
        score,
        jsonString(normalized.matchedSkills),
        jsonString(normalized.missingSkills),
        jsonString(normalized.mustHaveAnalysis),
        jsonString(normalized.niceToHaveAnalysis),
        normalized.starRating,
        normalized.qualificationRetained,
        jsonString(normalized.advantages),
        jsonString(normalized.disadvantages),
        summary || null,
        recommendation,
        jsonString(snapshot),
      ],
    );
  } else {
    await client.query(
      `INSERT INTO candidate_match_result_runtime_state (
          candidate_match_result_id, candidate_id, job_requisition_id,
          job_posting_id, client_id,
          education_score, skills_score, project_experience_score,
          stability_score, experience_score, experience_assessment,
          total_weighted_score, matched_skills, missing_skills,
          must_have_analysis, nice_to_have_analysis,
          star_rating, qualification_retained,
          advantages, disadvantages,
          ai_summary, final_recommendation, raw_llm_response,
          created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9, $10, $11,
          $12, $13::jsonb, $14::jsonb,
          $15::jsonb, $16::jsonb, $17, $18,
          $19::jsonb, $20::jsonb,
          $21, $22, $23::jsonb,
          NOW(), NOW()
        )`,
      [
        id,
        candidateId,
        jr,
        postingRow.job_posting_id,
        postingRow.client_id,
        normalized.educationScore,
        normalized.skillsScore,
        normalized.projectExperienceScore,
        normalized.stabilityScore,
        normalized.experienceScore,
        normalized.experienceAssessment,
        score,
        jsonString(normalized.matchedSkills),
        jsonString(normalized.missingSkills),
        jsonString(normalized.mustHaveAnalysis),
        jsonString(normalized.niceToHaveAnalysis),
        normalized.starRating,
        normalized.qualificationRetained,
        jsonString(normalized.advantages),
        jsonString(normalized.disadvantages),
        summary || null,
        recommendation,
        jsonString(snapshot),
      ],
    );
  }
  if (existing.rows[0]) {
    await client.query(
      `UPDATE candidate_match_result SET
          job_posting_id = $2,
          match_score = $3,
          match_reason = $4,
          match_status = $5,
          dimension_scores = $6::jsonb,
          core_tags = $7::jsonb,
          experience_years = $8,
          updated_at = NOW()
        WHERE candidate_match_result_id = $1`,
      [
        id,
        postingRow.job_posting_id,
        score,
        summary || verdict || null,
        matchStatus,
        jsonString(normalized.dimensionScores),
        jsonString(normalized.coreTags),
        normalized.experienceYears,
      ],
    );
  } else {
    await client.query(
      `INSERT INTO candidate_match_result (
          candidate_match_result_id, candidate_id, job_requisition_id,
          job_posting_id, match_score, match_reason, match_status,
          dimension_scores, core_tags, experience_years,
          created_by, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8::jsonb, $9::jsonb, $10,
          'ai_engine', NOW(), NOW()
        )`,
      [
        id,
        candidateId,
        jr,
        postingRow.job_posting_id,
        score,
        summary || verdict || null,
        matchStatus,
        jsonString(normalized.dimensionScores),
        jsonString(normalized.coreTags),
        normalized.experienceYears,
      ],
    );
  }
  return {
    candidate_match_result_id: id,
    job_posting_id: postingRow.job_posting_id,
  };
}

function invitationReceiptRoots(
  snapshot: Record<string, unknown>,
): Record<string, unknown>[] {
  const rawReceipt = asRecord(parseMaybeJson(firstValue(snapshot, ["raw"])));
  return [
    snapshot,
    asRecord(snapshot.data),
    asRecord(snapshot.payload),
    rawReceipt,
    asRecord(rawReceipt?.data),
  ].filter((value): value is Record<string, unknown> => value !== null);
}

function invitationReceiptValue(
  snapshot: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const root of invitationReceiptRoots(snapshot)) {
    for (const key of keys) {
      if (root[key] !== undefined && root[key] !== null) return root[key];
    }
  }
  return undefined;
}

function invitationScalarIdentifier(
  snapshot: Record<string, unknown>,
  keys: string[],
): string | number | null {
  for (const root of invitationReceiptRoots(snapshot)) {
    for (const key of keys) {
      const value = root[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
  }
  return null;
}

function invitationRawNotes(snapshot: Record<string, unknown>): string {
  const explicit = invitationReceiptValue(snapshot, [
    "raw_interview_notes",
    "rawInterviewNotes",
  ]);
  if (typeof explicit === "string" && explicit.trim()) return explicit.trim();
  if (explicit !== undefined && explicit !== null) return jsonString(explicit);

  const notes = {
    invite_request_id:
      stringValue(
        invitationReceiptValue(snapshot, [
          "request_id",
          "requestId",
          "robohire_request_id",
        ]),
      ) || null,
    invite_user_id: invitationScalarIdentifier(snapshot, [
      "gohire_user_id",
      "user_id",
      "userId",
    ]),
    invite_request_introduction_id:
      stringValue(
        invitationReceiptValue(snapshot, [
          "request_introduction_id",
          "requestIntroductionId",
        ]),
      ) || null,
    invite_gohire_job_id: invitationScalarIdentifier(snapshot, [
      "gohire_job_id",
      "gohireJobId",
    ]),
    invite_reused: invitationReceiptValue(snapshot, ["reused"]) === true,
    invite_qrcode_url:
      stringValue(
        invitationReceiptValue(snapshot, [
          "qrcode_url",
          "qr_code_url",
          "qrcodeUrl",
        ]),
      ) || null,
    invite_login_url:
      stringValue(
        invitationReceiptValue(snapshot, [
          "login_url",
          "loginUrl",
          "meeting_link",
        ]),
      ) || null,
    invite_message:
      stringValue(
        invitationReceiptValue(snapshot, ["message", "error_message"]),
      ) || null,
  };
  return jsonString(notes);
}

async function persistInterviewPg(
  client: RaasPgSession,
  snapshot: Record<string, unknown>,
  _ids: PersistenceIds,
): Promise<Partial<PersistenceIds>> {
  const upstreamSuccess = firstValue(snapshot, ["success"]);
  const correlation = firstString(snapshot, [
    "correlation_id",
    "__correlationId",
    "__runtime_correlation_id",
  ]);
  if (upstreamSuccess === false) {
    // A failure can predate creation of an interview_invitation row (for
    // example thin-event backfill failure). The emitted failure remains the
    // reconciliation source in that case.
    if (!correlation) return {};
    const failed = await client.query(
      `UPDATE interview_invitation SET
          status = 'failed',
          error_message = $2,
          failed_at = NOW(),
          updated_at = NOW()
        WHERE correlation_id = $1
        RETURNING interview_invitation_id`,
      [
        correlation,
        firstString(snapshot, ["message", "error", "error_message"]) ||
          "RoboHire invitation failed",
      ],
    );
    if ((failed.rowCount ?? 0) === 0) {
      throw new Error(
        `persistRaasEntities: RAAS interview_invitation correlation_id '${correlation}' does not exist`,
      );
    }
    return {};
  }
  requireField(correlation, "correlation_id for RAAS interview_invitation");
  const loginUrl = firstString(snapshot, ["login_url", "loginUrl"]);
  const qrcodeUrl = firstString(snapshot, [
    "qrcode_url",
    "qr_code_url",
    "qrcodeUrl",
  ]);
  const gohireUserId = invitationScalarIdentifier(snapshot, [
    "gohire_user_id",
    "user_id",
    "userId",
  ]);
  const requestIntroductionId = firstString(snapshot, [
    "request_introduction_id",
    "requestIntroductionId",
  ]);
  const explicitInviteLog = firstValue(snapshot, ["gohire_invite_log"]);
  const rawInviteReceipt = firstValue(snapshot, ["raw"]);
  const gohireInviteLog =
    explicitInviteLog !== undefined
      ? jsonString(explicitInviteLog)
      : rawInviteReceipt !== undefined
        ? jsonString(rawInviteReceipt)
        : jsonString(snapshot);
  const updated = await client.query(
    `UPDATE interview_invitation SET
        status = 'sent',
        login_url = $2,
        qrcode_url = $3,
        gohire_user_id = $4,
        request_introduction_id = $5,
        gohire_invite_log = $6,
        sent_at = NOW(),
        updated_at = NOW()
      WHERE correlation_id = $1
      RETURNING interview_invitation_id, application_id`,
    [
      correlation,
      loginUrl || null,
      qrcodeUrl || null,
      gohireUserId ?? null,
      requestIntroductionId || null,
      gohireInviteLog,
    ],
  );
  if ((updated.rowCount ?? 0) === 0) {
    throw new Error(
      `persistRaasEntities: RAAS interview_invitation correlation_id '${correlation}' does not exist`,
    );
  }
  const row = updated.rows[0] as Record<string, unknown> | undefined;
  return {
    application_id: stringValue(row?.application_id) || undefined,
  };
}

export function buildAllmetaWrites(
  phase: RaasPersistencePhase,
  snapshot: Record<string, unknown>,
  ids: PersistenceIds,
): AllmetaWrite[] {
  const candidateId = firstString(snapshot, ["candidate_id", "candidateId"]);
  const jr = firstString(snapshot, [
    "job_requisition_id",
    "jobRequisitionId",
    "requisition_id",
    ...(phase === "job_posting" ? ["entity_id", "__subject"] : []),
  ]);
  const parsed = parsedResume(snapshot);
  const timestamp =
    firstString(snapshot, ["received_at", "receivedAt", "timestamp"]) ||
    new Date().toISOString();

  if (phase === "job_posting") {
    requireField(jr, "job_requisition_id");
    const id = requireField(ids.job_posting_id ?? "", "job_posting_id");
    const title = requireField(
      firstString(snapshot, ["title", "posting_title", "job_title"]),
      "title for Allmeta Job_Posting",
    );
    const responsibilities = firstValue(snapshot, ["responsibilities"]);
    const mustHave = firstValue(snapshot, ["must_have", "must_have_skills"]);
    return [
      {
        label: "Job_Posting",
        payload: compact({
          job_posting_id: id,
          job_requisition_id: [jr],
          sourcing_channel_id: [],
          recruiter_employee_id:
            firstString(snapshot, ["recruiter_employee_id", "employee_id"]) ||
            null,
          title,
          responsibility: Array.isArray(responsibilities)
            ? stringArray(responsibilities).join("\n")
            : firstString(snapshot, ["responsibility", "job_responsibility"]),
          requirement: Array.isArray(mustHave)
            ? stringArray(mustHave).join("\n")
            : firstString(snapshot, ["requirement", "job_requirement"]),
          key_words: stringArray(
            firstValue(snapshot, ["keywords", "search_keywords", "key_words"]),
          ),
          type: firstString(snapshot, ["employmentType", "job_type", "type"]),
          recruitment_type: firstString(snapshot, ["recruitment_type"]),
          work_years: numberValue(firstValue(snapshot, ["work_years"])),
          age_range: firstString(snapshot, ["age_range"]),
          degree_requirement: firstString(snapshot, [
            "degree_requirement",
            "education",
          ]),
          education_requirement: firstString(snapshot, [
            "education_requirement",
          ]),
          city: stringArray(firstValue(snapshot, ["city", "location"])),
          work_address: stringArray(firstValue(snapshot, ["work_address"])),
          salary_range: firstString(snapshot, [
            "salary_range",
            "compensation",
            "salaryText",
          ]),
          publish_time: timestamp,
          publish_status: "pending",
        }),
      },
    ];
  }

  if (phase === "candidate_resume") {
    requireField(candidateId, "candidate_id");
    const resumeId = requireField(ids.resume_id ?? "", "resume_id");
    const experience = firstValue(parsed, [
      "experience",
      "work_history",
      "workExperience",
    ]);
    const education = firstValue(parsed, ["education", "education_history"]);
    const projects = firstValue(parsed, ["projects", "project_history"]);
    return [
      {
        label: "Candidate",
        payload: compact({
          candidate_id: candidateId,
          employee_id:
            firstString(snapshot, ["locked_by_employee_id", "employee_id"]) ||
            null,
          name:
            firstString(parsed, ["name", "candidate_name"]) ||
            firstString(snapshot, ["name", "candidate_name"]) ||
            "未命名候选人",
          phone:
            firstString(parsed, ["phone", "mobile", "phoneNumber"]) || null,
          email: firstString(parsed, ["email"]) || null,
          gender: firstString(parsed, ["gender"]) || null,
          birth_date: firstString(parsed, ["birthDate", "birth_date"]) || null,
          address:
            firstString(parsed, ["address", "currentLocation", "location"]) ||
            null,
          highest_acquired_degree:
            firstString(parsed, ["highestDegree", "highest_acquired_degree"]) ||
            null,
          work_years: numberValue(
            firstValue(parsed, ["workYears", "experienceYears", "work_years"]),
          ),
        }),
      },
      {
        label: "Resume",
        payload: compact({
          resume_id: resumeId,
          candidate_id: candidateId,
          job_requisition_id: jr ? [jr] : [],
          experience: jsonString(experience ?? []),
          projects: jsonString(projects ?? []),
          education: jsonString(education ?? []),
          languages: jsonString(firstValue(parsed, ["languages"]) ?? []),
          file_path:
            firstString(snapshot, [
              "object_key",
              "resume_file_path",
              "file_path",
            ]) || null,
          is_original: true,
          skills: stringArray(firstValue(parsed, ["skills"])),
          certifications: jsonString(
            firstValue(parsed, ["certifications"]) ?? [],
          ),
          summary: firstString(parsed, ["summary"]) || null,
          employee_id: firstString(snapshot, ["employee_id"]) || null,
          created_time: timestamp,
          updated_time: timestamp,
        }),
      },
    ];
  }

  if (phase === "candidate_match") {
    requireField(candidateId, "candidate_id");
    requireField(jr, "job_requisition_id");
    const score = numberValue(
      firstValue(snapshot, ["match_score", "matchScore", "matching_score"]),
    );
    if (score === null)
      throw new Error("persistRaasEntities: match_score is required");
    return [
      {
        label: "Candidate_Match_Result",
        payload: compact({
          candidate_match_result_id: requireField(
            ids.candidate_match_result_id ?? "",
            "candidate_match_result_id",
          ),
          client_id: firstString(snapshot, ["client_id"]) || null,
          candidate_id: candidateId,
          job_position_id: jr,
          overall_match_score: score,
          overall_fit_verdict:
            firstString(snapshot, [
              "verdict",
              "overall_fit_verdict",
              "_emit",
            ]) || null,
          overall_fit_summary:
            firstString(snapshot, [
              "summary",
              "decision_reason",
              "overall_fit_summary",
            ]) || null,
          overall_match_grade:
            firstString(snapshot, ["overall_match_grade", "grade"]) || null,
        }),
      },
    ];
  }

  requireField(candidateId, "candidate_id");
  requireField(jr, "job_requisition_id");
  const upstreamSuccess = firstValue(snapshot, ["success"]);
  const message =
    firstString(snapshot, ["body", "content", "invitation", "message"]) ||
    jsonString(snapshot);
  const communication: AllmetaWrite = {
    label: "Communication_Log",
    payload: compact({
      communication_log_id: requireField(
        ids.communication_log_id ?? "",
        "communication_log_id",
      ),
      application_id: ids.application_id || undefined,
      message_sender:
        firstString(snapshot, ["recruiter_id", "employee_id"]) ||
        "AO.InterviewInviter",
      message_receiver:
        firstString(snapshot, ["candidate_email", "email", "to"]) ||
        candidateId,
      interaction_type: "面试邀请",
      message_content: message,
      content_summary:
        upstreamSuccess === false ? "面试邀请发送失败" : "AI 面试邀请已发送",
      timestamp,
    }),
  };
  if (upstreamSuccess === false) return [communication];
  return [
    communication,
    {
      label: "Interview_Record",
      payload: compact({
        interview_record_id: requireField(
          ids.interview_record_id ?? "",
          "interview_record_id",
        ),
        interview_model_id:
          firstString(snapshot, ["interview_model_id", "model_id"]) || null,
        application_id: ids.application_id || undefined,
        interviewer_employee_id:
          firstString(snapshot, ["interviewer_employee_id", "recruiter_id"]) ||
          null,
        interview_type:
          firstString(snapshot, ["interview_type", "interviewType"]) ||
          "我司面试",
        interview_round: firstString(snapshot, ["interview_round"]) || "一面",
        duration_minutes:
          numberValue(
            invitationReceiptValue(snapshot, [
              "duration_minutes",
              "interview_duration_minutes",
              "job_interview_duration",
              "interview_duration",
              "durationMinutes",
              "jobInterviewDuration",
            ]),
          ) ?? 30,
        interview_mode:
          stringValue(
            invitationReceiptValue(snapshot, [
              "interview_mode",
              "interviewMode",
            ]),
          ) || "AI视频面试",
        recording_url:
          firstString(snapshot, ["login_url", "loginUrl", "meeting_link"]) ||
          null,
        raw_interview_notes: invitationRawNotes(snapshot),
      }),
    },
  ];
}

export function snapshotFromContext(ctx: ToolContext): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {
    ...(ctx.event?.data ?? {}),
  };
  const previous = asRecord(ctx.lastResult);
  if (previous) Object.assign(snapshot, previous);
  snapshot.__runtime_correlation_id = ctx.correlationId;
  snapshot.__subject = ctx.subject ?? "";
  return snapshot;
}

export const persistRaasEntities = defineTool({
  name: "persistRaasEntities",
  description:
    "Write the current recruitment business result to configured RAAS Postgres " +
    "and/or Allmeta before the runtime emits its event. Tenant-gated, " +
    "idempotent by business key, and fail-closed for every configured target. " +
    "Config: { phase: job_posting|candidate_resume|candidate_match|interview }.",
  factory: {
    category: "raas-persistence",
    sideEffect: "write",
    operation: "write",
    effectScope: "external",
    sandboxPolicy: "requires_attempt_grant",
    configSchema: {
      tenant_slug: { type: "string", required: true },
      phase: {
        type: "string",
        required: true,
        allowedValues: [...RAAS_PERSISTENCE_PHASES],
      },
      target_mode: {
        type: "string",
        required: true,
        allowedValues: ["postgres", "allmeta", "both"],
      },
      postgres_url_env: {
        type: "string",
        description: "Server env name for RAAS PostgreSQL.",
      },
      allmeta_base_url_env: {
        type: "string",
        description: "Server env name for the Allmeta API base URL.",
      },
      allmeta_api_key_env: {
        type: "string",
        description: "Server env name for the Allmeta API key.",
      },
      allmeta_domain_id: {
        type: "string",
        description:
          "Exact Allmeta instance domain confirmed by the integration profile.",
      },
      timeout_ms: {
        type: "integer",
        default: 8000,
        description: "Allmeta request timeout in milliseconds.",
      },
    },
    configContract: {
      requiredUnless: [
        {
          keys: ["postgres_url_env"],
          unless: { key: "target_mode", equals: "allmeta" },
        },
        {
          keys: [
            "allmeta_base_url_env",
            "allmeta_api_key_env",
            "allmeta_domain_id",
          ],
          unless: { key: "target_mode", equals: "postgres" },
        },
      ],
    },
    capabilities: [
      {
        systems: ["RAAS_System"],
        kinds: ["database"],
        roles: ["write", "persist"],
        operations: [
          "entity.sync",
          "candidate.save",
          "candidate_match.sync",
          "job_posting.sync",
          "interview.sync",
          "write",
        ],
        objectTypes: [
          "Job_Posting",
          "Job_Requisition",
          "Candidate",
          "Resume",
          "Application",
          "Candidate_Match_Result",
          "Interview_Record",
          "Communication_Log",
        ],
        probeRequired: true,
      },
      {
        systems: ["Allmeta_Ontology_System"],
        kinds: ["graph_db", "ontology"],
        roles: ["write", "mirror"],
        operations: ["instance.mirror", "write"],
        objectTypes: [
          "Job_Posting",
          "Job_Requisition",
          "Candidate",
          "Resume",
          "Candidate_Match_Result",
          "Interview_Record",
        ],
        probeRequired: true,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    // No cleanup/absence adapter is registered, therefore a live write probe
    // remains needs_config even after credentials are supplied.
    source: {
      modulePath:
        "packages/recruitment-capabilities/src/tools/raas-persistence.ts",
      exportName: "persistRaasEntities",
    },
  },
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const phaseValue = ctx.config?.phase;
    const parsed = z.enum(RAAS_PERSISTENCE_PHASES).safeParse(phaseValue);
    if (!parsed.success) {
      throw new Error(
        `persistRaasEntities: invalid config.phase ${JSON.stringify(phaseValue)}`,
      );
    }
    const snapshot = snapshotFromContext(ctx);
    const receipt = await persistRaasExternal({
      tenantSlug: ctx.tenantSlug,
      phase: parsed.data,
      snapshot,
      profile: {
        ...(ctx.config?.target_mode === "postgres" ||
        ctx.config?.target_mode === "allmeta" ||
        ctx.config?.target_mode === "both"
          ? { targetMode: ctx.config.target_mode }
          : {}),
        postgresUrlEnv:
          typeof ctx.config?.postgres_url_env === "string"
            ? ctx.config.postgres_url_env
            : undefined,
        allmetaBaseUrlEnv:
          typeof ctx.config?.allmeta_base_url_env === "string"
            ? ctx.config.allmeta_base_url_env
            : undefined,
        allmetaApiKeyEnv:
          typeof ctx.config?.allmeta_api_key_env === "string"
            ? ctx.config.allmeta_api_key_env
            : undefined,
        allmetaDomainId:
          typeof ctx.config?.allmeta_domain_id === "string"
            ? ctx.config.allmeta_domain_id
            : undefined,
        timeoutMs:
          typeof ctx.config?.timeout_ms === "number"
            ? ctx.config.timeout_ms
            : undefined,
      },
    });
    // Pass through the completed business result, including any deterministic
    // selector.  External IDs override local placeholders so the emitted event
    // references exactly what was persisted.
    return {
      data: {
        ...(asRecord(ctx.lastResult) ?? {}),
        ...receipt.ids,
        _persistence: receipt,
      },
    };
  },
});
