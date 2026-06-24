/**
 * Pure candidate-dedup decision logic — migrated from the old
 * candidate-identity-agent (3-tier identity rules). Kept free of DB/IO so it
 * unit-tests in node; the `candidateDedupLookup` tool wraps it with an
 * `agent_memory_long`-backed registry.
 *
 * Tiers (highest confidence first):
 *   1. phone  — normalized mobile exact match (the old IDENTITY-1, phone-primary)
 *   2. email  — email exact match
 *   3. name   — name-only match → flagged needsReview (never auto-merge blindly)
 * No match → a new candidate.
 *
 * Plus the old "one recruiter per candidate" lock: if the matched candidate is
 * owned by a different recruiter than the incoming one, `lockConflict` is set.
 */

export function normPhone(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const digits = raw.replace(/\D+/g, "");
  // Strip a country code (e.g. 86) — CN mobile numbers are 11 digits.
  return digits.length > 11 ? digits.slice(-11) : digits;
}

export function normEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

export function normName(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(/\s+/g, "").toLowerCase() : "";
}

export interface DedupMatch {
  candidateId: string;
  owner?: string | null;
}

export interface DedupInput {
  phone: string;
  email: string;
  name: string;
  owner?: string | null;
}

export interface DedupLookups {
  byPhone?: DedupMatch | null;
  byEmail?: DedupMatch | null;
  byName?: DedupMatch | null;
}

export type DedupTier = "phone" | "email" | "name";

export interface DedupVerdict {
  sameAsCandidateId: string | null;
  tier: DedupTier | null;
  isNew: boolean;
  needsReview: boolean;
  lockConflict: boolean;
}

const NEW_CANDIDATE: DedupVerdict = {
  sameAsCandidateId: null,
  tier: null,
  isNew: true,
  needsReview: false,
  lockConflict: false,
};

export function selectDedup(input: DedupInput, lookups: DedupLookups): DedupVerdict {
  // Tier order: phone > email > name. A lookup only counts if the
  // corresponding incoming field is non-empty (don't merge on a blank key).
  let match: DedupMatch | null | undefined;
  let tier: DedupTier | null = null;
  if (input.phone && lookups.byPhone) {
    match = lookups.byPhone;
    tier = "phone";
  } else if (input.email && lookups.byEmail) {
    match = lookups.byEmail;
    tier = "email";
  } else if (input.name && lookups.byName) {
    match = lookups.byName;
    tier = "name";
  }

  if (!match) return { ...NEW_CANDIDATE };

  const lockConflict = Boolean(
    match.owner && input.owner && match.owner !== input.owner,
  );
  return {
    sameAsCandidateId: match.candidateId,
    tier,
    isNew: false,
    needsReview: tier === "name", // name-only match is low-confidence
    lockConflict,
  };
}
