import { createHash, randomUUID } from "node:crypto";

import { canonicalEvidenceJson } from "./evidence-fingerprint";

export const SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PROTOCOL_VERSION = 1;
export const SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PREFIX = "authorize_sandbox_design_review:v1:";
export const SANDBOX_DESIGN_REVIEW_AUTHORIZATION_CONTEXT_PREFIX = "sandbox_design_review_authorization:v1:";
export const SANDBOX_DESIGN_REVIEW_AUTHORIZATION_DECLINE_PREFIX = "decline_sandbox_design_review:v1:";

/** A review must not survive a server/runtime restart under an unversioned
 * local build. Release builds use their immutable build SHA; local processes
 * use a boot nonce, so restored conversations safely ask for a fresh review. */
const EXECUTION_BUILD_ID =
  process.env.AGENTIC_BUILD_SHA?.trim()
  || process.env.GITHUB_SHA?.trim()
  || process.env.VERCEL_GIT_COMMIT_SHA?.trim()
  || `local-boot:${randomUUID()}`;

export function sandboxDesignReviewSubjectDigest(input: {
  domain: string;
  fingerprint: string;
}): string {
  return createHash("sha256").update(canonicalEvidenceJson({
    protocolVersion: SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PROTOCOL_VERSION,
    executionBuildId: EXECUTION_BUILD_ID,
    domain: input.domain,
    fingerprint: input.fingerprint,
  })).digest("hex");
}

