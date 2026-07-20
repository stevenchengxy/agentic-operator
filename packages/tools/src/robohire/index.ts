/**
 * @agentic/tools/robohire — first-party RoboHire.io REST wrappers.
 *
 * Every tool in this module is a thin wrapper around an
 * the configured RoboHire-compatible `/api/v1/*` endpoint. Auth + base URL resolve via
 * `rhFetch` in `rest-helper.ts`. A confirmed per-tenant profile must provide
 * `api_key_env` and `base_url_env`; literal values and implicit endpoint
 * fallbacks are rejected.
 *
 * These tools are registered into `globalToolRegistry` (see
 * `../registry.ts`) so any tenant's manifest can call them by name with
 * no TypeScript code change — drop the tool name into `tool_use[]` and
 * bind both environment references via `config`.
 */

export { matchResumeApi } from "./match-resume";
export {
  parseResumeApi,
  ParseResumeApiError,
  type ParseResumeFailureCode,
  type ParseResumeFailureKind,
} from "./parse-resume";
export { parseJdApi } from "./parse-jd";
export { generateJdApi, GenerateJdApiError } from "./generate-jd";
export {
  inviteCandidateApi,
  InviteCandidateApiError,
  prepareInviteCandidateRequest,
  type InviteCandidateFailureCode,
  type PreparedInvitation,
  type RoboHireInviteCandidateRequest,
} from "./invite-candidate";
export { robohireHealthApi } from "./health";
export { rhFetch } from "./rest-helper";
export type {
  RoboHireResponse,
  RoboHireError,
  RoboHireToolConfig,
} from "./rest-helper";

export {
  extractCandidateExpectation,
  formatCandidatePreferences,
  type CandidateExpectationNested,
} from "./candidate-preferences";
