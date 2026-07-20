/**
 * candidateDedupLookup — shared recruitment tenant tool (migrated from the old
 * candidate-identity-agent / CandidateDedup production agent).
 *
 * Given the parsed resume (from the previous `parseResumeApi` step), it does
 * three-tier candidate de-duplication against a tenant-scoped registry
 * and a "one recruiter per candidate" ownership lock. The 3-tier identity
 * decision is the pure `selectDedup` (see dedup-logic.ts); this wrapper is the
 * I/O: extract identity → look up → decide → register a new candidate.
 *
 * Storage: the existing tenant-scoped `agent_memory_long` KV table (no schema
 * migration). Strong indexes are phone and name+email; the six-field index is
 * only a review hint and never aliases a new resume to an old candidate id.
 *
 * Failure semantics: fail closed. A tenant/DB/registry error is not evidence
 * that the person is new, so the tool throws and the runtime fails/retries the
 * step. A candidate id is returned only after every identity index row has
 * committed successfully.
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { getDb, agentMemoryLong, tenants, eq, and } from "@agentic/db";
import {
  normPhone,
  normEmail,
  normGender,
  normGraduationYear,
  normIdentityText,
  normName,
  hasCompleteSixFields,
  resolveLockedRecruiterOwner,
  resolveRecruiterOwner,
  selectDedup,
  type DedupInput,
  type DedupMatch,
} from "./dedup-logic";
import { type RaasPgSession, withRaasPgConnection } from "./raas-pg";
import { profileEnvironmentValue } from "./profile-config";

const AGENT_KEY = "candidateDedupLookup";
const SUBJECT = "registry";

const NAME_KEYS = ["name", "full_name", "candidate_name", "fullName", "姓名"];
const PHONE_KEYS = [
  "phone",
  "mobile",
  "tel",
  "phone_number",
  "phoneNumber",
  "手机号",
  "手机",
];
const EMAIL_KEYS = ["email", "mail", "e_mail", "邮箱"];
const GENDER_KEYS = ["gender", "sex", "性别"];
const SCHOOL_KEYS = [
  "school",
  "school_name",
  "schoolName",
  "institution",
  "university",
  "college",
  "学校",
  "院校",
];
const MAJOR_KEYS = [
  "major",
  "field",
  "field_of_study",
  "fieldOfStudy",
  "specialization",
  "专业",
];
const DEGREE_KEYS = [
  "degree",
  "education_level",
  "educationLevel",
  "highest_degree",
  "highestDegree",
  "学历",
  "学位",
];
const GRADUATION_YEAR_KEYS = [
  "graduationYear",
  "graduation_year",
  "graduationDate",
  "graduation_date",
  "endYear",
  "end_year",
  "endDate",
  "end_date",
  "毕业时间",
  "毕业年份",
];
const EDUCATION_KEYS = [
  "education_history",
  "educationHistory",
  "educations",
  "education",
];

function newCandidateId(): string {
  return "cand-" + randomUUID().replace(/-/g, "").slice(0, 12);
}

function compositeIndexKey(prefix: string, fields: string[]): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(fields))
    .digest("hex");
  return `${prefix}:${digest}`;
}

/** Collect the objects worth searching for candidate identity, most-specific
 *  first: the parse result (lastResult, incl. its `.data`), then the trigger
 *  payload. */
function identitySources(ctx: ToolContext): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(v as Record<string, unknown>);
      const data = (v as Record<string, unknown>).data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        out.push(data as Record<string, unknown>);
      }
    }
  };
  push(ctx.lastResult);
  push(ctx.event?.data);
  return out;
}

/** First non-empty string found under any alias across the sources. */
function pick(sources: Record<string, unknown>[], keys: string[]): string {
  for (const src of sources) {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
      if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
  }
  return "";
}

function nestedObjectSources(
  sources: Record<string, unknown>[],
  keys: string[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const source of sources) {
    for (const key of keys) {
      const value = source[key];
      const values = Array.isArray(value) ? value : [value];
      for (const entry of values) {
        if (entry && typeof entry === "object" && !Array.isArray(entry)) {
          out.push(entry as Record<string, unknown>);
        }
      }
    }
  }
  return out;
}

export interface AuthoritativeStrongLookupRequest {
  phone: string;
  name: string;
  email: string;
  lookupPhone: boolean;
  lookupNameEmail: boolean;
}

export interface AuthoritativeStrongLookups {
  byPhone: DedupMatch | null;
  byNameEmail: DedupMatch | null;
}

export interface CandidateDedupDependencies {
  authoritativeLookup?: (
    request: AuthoritativeStrongLookupRequest,
  ) => Promise<AuthoritativeStrongLookups>;
  /** Resolved by the trusted profile wrapper; never a literal in config. */
  connectionString?: string;
}

interface AuthoritativeCandidateRow {
  candidate_id: unknown;
  name: unknown;
  mobile: unknown;
  mobile_normalized: unknown;
  email: unknown;
  employee_id: unknown;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function uniqueAuthoritativeMatch(
  rows: AuthoritativeCandidateRow[],
  signal: "phone" | "name+email",
): DedupMatch | null {
  const matches = new Map<string, DedupMatch>();
  for (const row of rows) {
    const candidateId = nonEmptyString(row.candidate_id);
    if (!candidateId) {
      throw new Error(
        `[candidateDedupLookup] RAAS candidate row matched ${signal} without candidate_id`,
      );
    }
    const owner = nonEmptyString(row.employee_id) || null;
    const previous = matches.get(candidateId);
    if (previous?.owner && owner && previous.owner !== owner) {
      throw new Error(
        `[candidateDedupLookup] RAAS candidate '${candidateId}' has conflicting owners for ${signal}`,
      );
    }
    matches.set(candidateId, {
      candidateId,
      owner: previous?.owner ?? owner,
    });
  }
  if (matches.size > 1) {
    throw new Error(
      `[candidateDedupLookup] ambiguous RAAS ${signal} match resolves to multiple candidates: ${[
        ...matches.keys(),
      ].join(", ")}`,
    );
  }
  return matches.values().next().value ?? null;
}

/**
 * Read the authoritative RAAS candidate pool using the same strict strong
 * rules as the local registry. SQL only prefilters; JS normalization performs
 * the final comparison so a broad database predicate cannot merge people.
 */
export async function lookupAuthoritativeStrongCandidates(
  client: RaasPgSession,
  request: AuthoritativeStrongLookupRequest,
): Promise<AuthoritativeStrongLookups> {
  let byPhone: DedupMatch | null = null;
  let byNameEmail: DedupMatch | null = null;

  if (request.lookupPhone) {
    if (!request.phone) {
      throw new Error(
        "[candidateDedupLookup] authoritative phone lookup requested without a normalized phone",
      );
    }
    const result = await client.query<AuthoritativeCandidateRow>(
      `SELECT candidate_id, name, mobile, mobile_normalized, email, employee_id
         FROM candidate
        WHERE RIGHT(
                regexp_replace(COALESCE(mobile_normalized, ''), '[^0-9]', '', 'g'),
                $2::integer
              ) = $1
           OR RIGHT(
                regexp_replace(COALESCE(mobile, ''), '[^0-9]', '', 'g'),
                $2::integer
              ) = $1`,
      [request.phone, request.phone.length],
    );
    const exactRows = result.rows.filter(
      (row) =>
        normPhone(row.mobile_normalized) === request.phone ||
        normPhone(row.mobile) === request.phone,
    );
    byPhone = uniqueAuthoritativeMatch(exactRows, "phone");
  }

  if (request.lookupNameEmail) {
    if (!request.name || !request.email) {
      throw new Error(
        "[candidateDedupLookup] authoritative name+email lookup requested without both normalized fields",
      );
    }
    const result = await client.query<AuthoritativeCandidateRow>(
      `SELECT candidate_id, name, mobile, mobile_normalized, email, employee_id
         FROM candidate
        WHERE lower(btrim(email)) = $1`,
      [request.email],
    );
    const exactRows = result.rows.filter(
      (row) =>
        normName(row.name) === request.name &&
        normEmail(row.email) === request.email,
    );
    byNameEmail = uniqueAuthoritativeMatch(exactRows, "name+email");
  }

  return { byPhone, byNameEmail };
}

async function defaultAuthoritativeLookup(
  request: AuthoritativeStrongLookupRequest,
  connectionString: string,
): Promise<AuthoritativeStrongLookups> {
  if (!connectionString.trim()) {
    throw new Error(
      "[candidateDedupLookup] a reviewed postgres_url_env profile is required when a strong identity misses the local registry",
    );
  }
  try {
    return await withRaasPgConnection(connectionString, (client) =>
      lookupAuthoritativeStrongCandidates(client, request),
    );
  } catch (error) {
    throw new Error(
      `[candidateDedupLookup] authoritative RAAS candidate lookup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

function decodeRegistryMatch(valueJson: string, key: string): DedupMatch {
  let parsed: { candidateId?: unknown; owner?: unknown };
  try {
    parsed = JSON.parse(valueJson) as {
      candidateId?: unknown;
      owner?: unknown;
    };
  } catch (error) {
    throw new Error(`[candidateDedupLookup] corrupt registry row for ${key}`, {
      cause: error,
    });
  }
  if (typeof parsed.candidateId !== "string" || !parsed.candidateId.trim()) {
    throw new Error(
      `[candidateDedupLookup] registry row for ${key} has no candidateId`,
    );
  }
  return {
    candidateId: parsed.candidateId,
    owner: typeof parsed.owner === "string" ? parsed.owner : null,
  };
}

export async function runCandidateDedupLookup(
  ctx: ToolContext,
  dependencies: CandidateDedupDependencies = {},
) {
  // Carry-forward fields for routeResumeProcessed: echo the parsed resume (this
  // step's ctx.lastResult IS the parseResumeApi output), the resume id, and the
  // job_requisition_id, so RESUME_PROCESSED carries what matchResume needs.
  const parsedResume = ctx.lastResult;
  const resumeText =
    typeof parsedResume === "string"
      ? parsedResume
      : JSON.stringify(
          (parsedResume && typeof parsedResume === "object"
            ? ((parsedResume as Record<string, unknown>).data ?? parsedResume)
            : parsedResume) ?? {},
        );
  const evData = (ctx.event?.data ?? {}) as Record<string, unknown>;
  const jobReqId =
    typeof evData.job_requisition_id === "string"
      ? evData.job_requisition_id
      : "";
  const eventResumeId =
    typeof evData.resume_id === "string" ? evData.resume_id : "";
  const sources = identitySources(ctx);
  const educationSources = nestedObjectSources(sources, EDUCATION_KEYS);
  const profileSources = [...sources, ...educationSources];
  const name = pick(sources, NAME_KEYS);
  const phone = pick(sources, PHONE_KEYS);
  const email = pick(sources, EMAIL_KEYS);
  const gender = pick(profileSources, GENDER_KEYS);
  const school = pick(profileSources, SCHOOL_KEYS);
  const major = pick(profileSources, MAJOR_KEYS);
  const degree = pick(profileSources, DEGREE_KEYS);
  const graduationYear = pick(profileSources, GRADUATION_YEAR_KEYS);
  const requestingRecruiter = resolveRecruiterOwner(
    sources,
    ctx.config?.default_recruiter,
  );
  const eventLockedOwner = resolveLockedRecruiterOwner(sources);

  const nPhone = normPhone(phone);
  const nEmail = normEmail(email);
  const nName = normName(name);
  const nGender = normGender(gender);
  const nSchool = normIdentityText(school);
  const nMajor = normIdentityText(major);
  const nDegree = normIdentityText(degree);
  const nGraduationYear = normGraduationYear(graduationYear);
  const dedupInput: DedupInput = {
    phone: nPhone,
    email: nEmail,
    name: nName,
    gender: nGender,
    school: nSchool,
    major: nMajor,
    degree: nDegree,
    graduationYear: nGraduationYear,
    owner: requestingRecruiter,
  };
  const phoneKey = nPhone ? `phone:${nPhone}` : "";
  const nameEmailKey =
    nName && nEmail ? compositeIndexKey("name-email", [nName, nEmail]) : "";
  const sixFieldsKey = hasCompleteSixFields(dedupInput)
    ? compositeIndexKey("six-fields", [
        nName,
        nGender,
        nSchool,
        nMajor,
        nDegree,
        nGraduationYear,
      ])
    : "";
  if (!phoneKey && !nameEmailKey && !sixFieldsKey) {
    throw new Error(
      `[candidateDedupLookup] ${ctx.tenantSlug}: no usable name, phone, or email combination; expected phone, name+email, or all six weak-match fields`,
    );
  }

  const db = getDb();
  const tenantRow = db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, ctx.tenantSlug))
    .all()[0];
  if (!tenantRow) {
    throw new Error(
      `[candidateDedupLookup] unknown tenant slug=${ctx.tenantSlug}; dedup cannot be tenant-scoped`,
    );
  }
  const tenantId = tenantRow.id;

  const lookup = (key: string): DedupMatch | null => {
    const row = db
      .select({ v: agentMemoryLong.valueJson })
      .from(agentMemoryLong)
      .where(
        and(
          eq(agentMemoryLong.tenantId, tenantId),
          eq(agentMemoryLong.agentName, AGENT_KEY),
          eq(agentMemoryLong.subject, SUBJECT),
          eq(agentMemoryLong.key, key),
        ),
      )
      .all()[0];
    if (!row) return null;
    return decodeRegistryMatch(row.v, key);
  };

  let byNameEmail = nameEmailKey ? lookup(nameEmailKey) : null;
  if (!byNameEmail && nName && nEmail) {
    // Read compatibility for rows written before the composite index was
    // introduced. Neither legacy key is trusted alone: both must resolve to
    // the same candidate before this can count as rule 2.
    const legacyEmail = lookup(`email:${nEmail}`);
    const legacyName = lookup(`name:${nName}`);
    if (
      legacyEmail &&
      legacyName &&
      legacyEmail.candidateId === legacyName.candidateId
    ) {
      if (
        legacyEmail.owner &&
        legacyName.owner &&
        legacyEmail.owner !== legacyName.owner
      ) {
        throw new Error(
          `[candidateDedupLookup] legacy name/email indexes disagree on owner for ${legacyEmail.candidateId}`,
        );
      }
      byNameEmail = {
        candidateId: legacyEmail.candidateId,
        owner: legacyEmail.owner ?? legacyName.owner ?? null,
      };
    }
  }

  const lookups: {
    byPhone: DedupMatch | null;
    byNameEmail: DedupMatch | null;
    bySixFields: DedupMatch | null;
  } = {
    byPhone: phoneKey ? lookup(phoneKey) : null,
    byNameEmail,
    bySixFields: sixFieldsKey ? lookup(sixFieldsKey) : null,
  };

  const assertStrongMatchesAgree = () => {
    const matchedIds = new Set(
      [lookups.byPhone, lookups.byNameEmail]
        .map((match) => match?.candidateId)
        .filter((id): id is string => Boolean(id)),
    );
    if (matchedIds.size > 1) {
      throw new Error(
        `[candidateDedupLookup] conflicting identity indexes resolve to multiple candidates: ${[
          ...matchedIds,
        ].join(", ")}`,
      );
    }
  };
  assertStrongMatchesAgree();

  // The local registry is a cache, not the source of truth. If the highest
  // applicable local strong tier misses, resolve that tier (and the next
  // unresolved tier) against RAAS PostgreSQL before declaring a new person.
  // A local phone hit already resolves the highest tier and needs no fallback.
  const lookupPhone = Boolean(nPhone && !lookups.byPhone);
  const lookupNameEmail = Boolean(
    !lookups.byPhone && nName && nEmail && !lookups.byNameEmail,
  );
  if (lookupPhone || lookupNameEmail) {
    const request: AuthoritativeStrongLookupRequest = {
      phone: nPhone,
      name: nName,
      email: nEmail,
      lookupPhone,
      lookupNameEmail,
    };
    const authoritativeLookup =
      dependencies.authoritativeLookup ??
      ((input: AuthoritativeStrongLookupRequest) =>
        defaultAuthoritativeLookup(input, dependencies.connectionString ?? ""));
    const authoritative = await authoritativeLookup(request);
    if (lookupPhone) lookups.byPhone = authoritative.byPhone;
    if (lookupNameEmail) {
      lookups.byNameEmail = authoritative.byNameEmail;
    }
    assertStrongMatchesAgree();
  }

  // An explicit lock snapshot is newer and more authoritative than a cached
  // candidate owner. Apply it to strong matches only; weak identity evidence
  // is never allowed to enforce another person's lock.
  if (eventLockedOwner) {
    if (lookups.byPhone) {
      lookups.byPhone = { ...lookups.byPhone, owner: eventLockedOwner };
    }
    if (lookups.byNameEmail) {
      lookups.byNameEmail = {
        ...lookups.byNameEmail,
        owner: eventLockedOwner,
      };
    }
  }

  const selected = selectDedup(dedupInput, lookups);
  const eventLockConflict = Boolean(
    eventLockedOwner &&
    requestingRecruiter &&
    eventLockedOwner !== requestingRecruiter,
  );
  const verdict = {
    ...selected,
    lockConflict: selected.lockConflict || eventLockConflict,
  };

  let candidateId = verdict.sameAsCandidateId;
  const registryRecord = (id: string, registeredOwner: string | null): string =>
    JSON.stringify({
      candidateId: id,
      owner: registeredOwner,
      name,
      phone: nPhone,
      email: nEmail,
      gender: nGender,
      school: nSchool,
      major: nMajor,
      degree: nDegree,
      graduationYear: nGraduationYear,
    });

  /**
   * Insert missing strong cache indexes without ever overwriting another
   * candidate. The read-check and inserts share one SQLite transaction, so a
   * concurrent winner either has the same candidate id or aborts this run.
   */
  const writeRegistryIndexes = (
    id: string,
    registeredOwner: string | null,
    includeWeakIndex: boolean,
  ) => {
    const record = registryRecord(id, registeredOwner);
    const strongKeys = [`candidate:${id}`, phoneKey, nameEmailKey].filter(
      Boolean,
    );
    db.transaction((tx) => {
      for (const key of strongKeys) {
        const existing = tx
          .select({ v: agentMemoryLong.valueJson })
          .from(agentMemoryLong)
          .where(
            and(
              eq(agentMemoryLong.tenantId, tenantId),
              eq(agentMemoryLong.agentName, AGENT_KEY),
              eq(agentMemoryLong.subject, SUBJECT),
              eq(agentMemoryLong.key, key),
            ),
          )
          .all()[0];
        if (existing) {
          const match = decodeRegistryMatch(existing.v, key);
          if (match.candidateId !== id) {
            throw new Error(
              `[candidateDedupLookup] refusing to backfill ${key}: local index belongs to '${match.candidateId}', authoritative candidate is '${id}'`,
            );
          }
          continue;
        }
        tx.insert(agentMemoryLong)
          .values({
            tenantId,
            agentName: AGENT_KEY,
            subject: SUBJECT,
            key,
            valueJson: record,
          })
          .run();
      }
      if (includeWeakIndex && sixFieldsKey) {
        tx.insert(agentMemoryLong)
          .values({
            tenantId,
            agentName: AGENT_KEY,
            subject: SUBJECT,
            key: sixFieldsKey,
            valueJson: record,
          })
          .onConflictDoNothing()
          .run();
      }
    });
  };

  if (verdict.isNew) {
    candidateId = newCandidateId();
    // A strong-index race aborts the whole registration. On retry the
    // winning durable row will be read and returned as the existing match.
    // The weak index intentionally keeps its first review target: a weak hit
    // creates a new candidate and must not replace/alias that target.
    writeRegistryIndexes(
      candidateId,
      eventLockedOwner || requestingRecruiter || null,
      true,
    );
  } else if (candidateId) {
    const strongMatch =
      verdict.tier === "phone" ? lookups.byPhone : lookups.byNameEmail;
    // Cache the authoritative/local strong resolution for subsequent runs.
    // Existing rows for the same id remain untouched; only absent aliases
    // (for example a PG-only phone match) are added.
    writeRegistryIndexes(
      candidateId,
      (strongMatch?.owner ?? eventLockedOwner ?? requestingRecruiter) || null,
      false,
    );
  }

  if (!candidateId) {
    throw new Error(
      "[candidateDedupLookup] dedup completed without a durable candidate id",
    );
  }

  const strongMatch =
    verdict.tier === "phone"
      ? lookups.byPhone
      : verdict.tier === "name_email"
        ? lookups.byNameEmail
        : null;
  const authoritativeOwner =
    eventLockedOwner ||
    strongMatch?.owner ||
    (verdict.isNew ? requestingRecruiter : "");

  return {
    data: {
      candidate_id: candidateId,
      same_as_candidate_id: verdict.sameAsCandidateId,
      matched_candidate_id: verdict.matchedCandidateId,
      is_new: verdict.isNew,
      tier: verdict.tier,
      needs_review: verdict.needsReview,
      lock_conflict: verdict.lockConflict,
      locked_by_employee_id: authoritativeOwner || null,
      requesting_recruiter_id: requestingRecruiter || null,
      name,
      phone: nPhone,
      email: nEmail,
      gender: nGender,
      school: nSchool,
      major: nMajor,
      degree: nDegree,
      graduation_year: nGraduationYear,
      // carry-forward for routeResumeProcessed → matchResume. Never invent
      // a resume id here; only a source-system id may cross that boundary.
      resume: resumeText,
      resume_id: eventResumeId,
      job_requisition_id: jobReqId,
      job_requisition_ids: Array.isArray(evData.job_requisition_ids)
        ? evData.job_requisition_ids
        : [],
    },
  };
}

export const candidateDedupLookup = defineTool({
  name: "candidateDedupLookup",
  description:
    "Candidate de-duplication + one-recruiter-per-candidate lock for RAAS. " +
    "Reads the parsed resume identity from the previous " +
    "parseResumeApi step, matches against the tenant's local registry and " +
    "authoritative RAAS PostgreSQL candidate pool " +
    "(phone > name+email > six-field review tiers), registers a new candidate " +
    "when no strong match exists, " +
    "and reports {candidate_id, is_new, tier, needs_review, lock_conflict}. " +
    "Fails closed when tenant-scoped storage or authoritative identity data is unavailable.",
  factory: {
    category: "candidate-identity",
    sideEffect: "dual",
    operation: "read_write",
    effectScope: "external",
    sandboxPolicy: "requires_attempt_grant",
    configSchema: {
      tenant_slug: { type: "string", required: true },
      postgres_url_env: {
        type: "string",
        required: true,
        description: "Server env name for authoritative RAAS candidate lookup.",
      },
    },
    capabilities: [
      {
        systems: ["RAAS_System"],
        kinds: ["database"],
        roles: ["read", "lookup"],
        operations: [
          "candidate.identity_lookup",
          "candidate.deduplicate",
          "read",
        ],
        objectTypes: ["Candidate", "Resume"],
        probeRequired: true,
      },
      {
        systems: ["AO_Internal"],
        kinds: ["internal_store", "database"],
        roles: ["write", "lock"],
        operations: ["candidate.registry_upsert", "candidate.lock"],
        objectTypes: ["Candidate", "Candidate_Identity_Result", "Employee"],
        probeRequired: true,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    // No probeSafety declaration is intentional: the current registry has no
    // trusted cleanup + absence-readback adapter, so write probes stay blocked.
    source: {
      modulePath:
        "packages/recruitment-capabilities/src/tools/candidate-dedup.ts",
      exportName: "candidateDedupLookup",
    },
  },
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const connectionString = profileEnvironmentValue(ctx, "postgres_url_env", {
      label: "candidateDedupLookup",
      required: false,
    });
    return runCandidateDedupLookup(ctx, {
      connectionString,
    });
  },
});
