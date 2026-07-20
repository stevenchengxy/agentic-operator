/**
 * @agentic/tools/gohire — first-party GoHire ATS REST wrappers.
 *
 * The GoHire counterpart to the `robohire` family: each tool wraps one
 * GoHire endpoint, and auth + base URL resolve via `ghFetch` in
 * `rest-helper.ts`. Unlike RoboHire (env-first), GoHire's normal credential
 * source is the DB-backed integration the operator configures in
 * Settings → Integrations — resolved through the injected
 * `resolveIntegrationCreds` seam (manifest config → DB store → env).
 *
 * Registered into `globalToolRegistry` (see `../registry.ts`) so any
 * tenant's manifest can call them by name — drop the tool name into
 * `tool_use[]`, no TypeScript required.
 */

export { gohireHealthApi } from "./health";
export { gohireMatchResumeApi } from "./match-resume";
export { gohireParseResumeApi } from "./parse-resume";
export { gohireParseJdApi } from "./parse-jd";
export { gohireInviteCandidateApi } from "./invite-candidate";
export { ghFetch, GOHIRE_PROVIDER, GOHIRE_DEFAULT_BASE_URL } from "./rest-helper";
export type {
  GoHireResponse,
  GoHireError,
  GoHireToolConfig,
} from "./rest-helper";
