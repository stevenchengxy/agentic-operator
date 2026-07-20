/**
 * Pure candidate identity and ownership decisions for recruitment tenants.
 *
 * The ordering mirrors the legacy candidate-identity rules:
 *   1. exact normalized phone;
 *   2. normalized name + exact normalized email;
 *   3. name + gender + school + major + degree + graduation year.
 *
 * Rules 1 and 2 are strong enough to reuse the existing candidate id. Rule 3
 * is deliberately weak: it exposes the suspected existing candidate for human
 * review, but the incoming resume is registered under a new candidate id.
 */

export function normPhone(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const digits = raw.replace(/\D+/g, "");
  // Strip a country code (for example +86) while preserving CN mobile numbers.
  return digits.length > 11 ? digits.slice(-11) : digits;
}

export function normEmail(raw: unknown): string {
  return typeof raw === "string"
    ? raw.normalize("NFKC").trim().toLowerCase()
    : "";
}

export function normName(raw: unknown): string {
  return typeof raw === "string"
    ? raw.normalize("NFKC").replace(/\s+/g, "").toLowerCase()
    : "";
}

/** Conservative normalization for the four textual fields in the weak rule. */
export function normIdentityText(raw: unknown): string {
  return typeof raw === "string"
    ? raw.normalize("NFKC").replace(/\s+/g, "").toLowerCase()
    : "";
}

export function normGender(raw: unknown): string {
  const value = normIdentityText(raw);
  if (["男", "male", "m", "man"].includes(value)) return "male";
  if (["女", "female", "f", "woman"].includes(value)) return "female";
  return value;
}

export function normGraduationYear(raw: unknown): string {
  if (typeof raw !== "string" && typeof raw !== "number") return "";
  const value = String(raw).normalize("NFKC").trim();
  const year = value.match(/(?:19|20)\d{2}/)?.[0];
  return year ?? normIdentityText(value);
}

export interface DedupMatch {
  candidateId: string;
  owner?: string | null;
}

export interface DedupInput {
  phone: string;
  email: string;
  name: string;
  gender?: string;
  school?: string;
  major?: string;
  degree?: string;
  graduationYear?: string;
  owner?: string | null;
}

export interface DedupLookups {
  byPhone?: DedupMatch | null;
  byNameEmail?: DedupMatch | null;
  bySixFields?: DedupMatch | null;
}

export type DedupTier = "phone" | "name_email" | "six_fields";

export interface DedupVerdict {
  /** Existing id that is safe to reuse. Never populated for the weak rule. */
  sameAsCandidateId: string | null;
  /** Existing candidate suspected by any matched rule, including the weak one. */
  matchedCandidateId: string | null;
  tier: DedupTier | null;
  isNew: boolean;
  needsReview: boolean;
  lockConflict: boolean;
}

const NEW_CANDIDATE: DedupVerdict = {
  sameAsCandidateId: null,
  matchedCandidateId: null,
  tier: null,
  isNew: true,
  needsReview: false,
  lockConflict: false,
};

export function hasCompleteSixFields(input: DedupInput): boolean {
  return Boolean(
    input.name &&
    input.gender &&
    input.school &&
    input.major &&
    input.degree &&
    input.graduationYear,
  );
}

export function selectDedup(
  input: DedupInput,
  lookups: DedupLookups,
): DedupVerdict {
  // Strong rule 1: phone.
  if (input.phone && lookups.byPhone) {
    const match = lookups.byPhone;
    return {
      sameAsCandidateId: match.candidateId,
      matchedCandidateId: match.candidateId,
      tier: "phone",
      isNew: false,
      needsReview: false,
      lockConflict: ownersConflict(match.owner, input.owner),
    };
  }

  // Strong rule 2 requires both fields. Email-only and name-only hits must not
  // reuse a candidate id.
  if (input.name && input.email && lookups.byNameEmail) {
    const match = lookups.byNameEmail;
    return {
      sameAsCandidateId: match.candidateId,
      matchedCandidateId: match.candidateId,
      tier: "name_email",
      isNew: false,
      needsReview: false,
      lockConflict: ownersConflict(match.owner, input.owner),
    };
  }

  // Weak rule 3 identifies a review target only. `isNew` stays true so the
  // wrapper creates a distinct candidate record for the incoming resume.
  if (hasCompleteSixFields(input) && lookups.bySixFields) {
    return {
      sameAsCandidateId: null,
      matchedCandidateId: lookups.bySixFields.candidateId,
      tier: "six_fields",
      isNew: true,
      needsReview: true,
      // A weak identity signal cannot enforce another candidate's owner lock.
      lockConflict: false,
    };
  }

  return { ...NEW_CANDIDATE };
}

function ownersConflict(
  existingOwner: string | null | undefined,
  incomingOwner: string | null | undefined,
): boolean {
  return Boolean(
    existingOwner && incomingOwner && existingOwner !== incomingOwner,
  );
}

const LOCKED_OWNER_KEYS = ["locked_by_employee_id", "lockedByEmployeeId"];
const EMPLOYEE_OWNER_KEYS = ["employee_id", "employeeId"];
const RECRUITER_OWNER_KEYS = [
  "operator_id",
  "operatorId",
  "recruiter_employee_id",
  "recruiterEmployeeId",
  "recruiter_id",
  "recruiterId",
  "owner_recruiter",
  "default_recruiter",
  "recruiter",
  "owner",
];

/**
 * Resolve the recruiter making this upload/request. A lock holder is
 * deliberately excluded: comparing locked_by against itself would hide the
 * exact B-owns/A-uploads conflict this function exists to detect.
 */
export function resolveRecruiterOwner(
  sources: Record<string, unknown>[],
  defaultRecruiter?: unknown,
): string {
  return (
    pickByKeyPriority(sources, EMPLOYEE_OWNER_KEYS) ||
    pickByKeyPriority(sources, RECRUITER_OWNER_KEYS) ||
    nonEmptyString(defaultRecruiter)
  );
}

/** Resolve an explicit authoritative lock holder, independently of caller. */
export function resolveLockedRecruiterOwner(
  sources: Record<string, unknown>[],
): string {
  return pickByKeyPriority(sources, LOCKED_OWNER_KEYS);
}

function pickByKeyPriority(
  sources: Record<string, unknown>[],
  keys: string[],
): string {
  for (const key of keys) {
    for (const source of sources) {
      const value = nonEmptyString(source[key]);
      if (value) return value;
    }
  }
  return "";
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
