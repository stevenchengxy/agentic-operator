/**
 * @tenants/zhaopin — 招聘-v1 tenant code package.
 *
 * A FAITHFUL 1:1 migration of the old AO "招聘-v1" 6-agent recruitment pipeline
 * into this runtime. Bootstrap auto-discovers this package because the tenant
 * slug "zhaopin" matches the `models/zhaopin-v1/` folder. The display name is
 * "招聘-v1" (set in packages/db/src/seed.ts; slug must stay lowercase-Latin).
 *
 *   - `tools`   — manifest `{ "type": "tool", "name": "X" }` actions AND any
 *                 tool advertised to the LLM via an agent's `tool_use[]` resolve
 *                 to `tools.X` here. (The LLM tool-use loop reads ONLY this map,
 *                 so the RoboHire REST tools MUST be re-exported here even though
 *                 they are also global.)
 *   - `prompts` — `{ "type": "logic", "name": "Y" }` actions resolve to
 *                 `prompts.Y`. Every logic action in the manifest must have one
 *                 or the tenant refuses to boot (`findMissingTenantPrompts`).
 *
 * The 6 agents (deployed-aligned triggers → emits):
 *   4    createJD                     REQUIREMENT_LOGGED|CLARIFICATION_READY|JD_REJECTED → JD_GENERATED
 *   9-1  processResume                RESUME_DOWNLOADED → RESUME_PROCESSED|RESUME_LOCKED_CONFLICT
 *   10-3 ruleCheckForCandidateIdentity CANDIDATE_IDENTITY_REQUESTED → CANDIDATE_IDENTITY_CHECKED
 *   10-1 ruleCheckForMatchResume      RESUME_PROCESSED → MATCH_RULE_CHECK_PASSED|FAILED  (the gate)
 *   10-2 matchResume                  MATCH_RULE_CHECK_PASSED → MATCH_PASSED_NEED_INTERVIEW|FAILED
 *   11-1 inviteInternalInterview      INTERVIEW_INVITATION_REQUESTED → INTERVIEW_INVITATION_SENT|FAILED
 */

import type { TenantRegistry } from "@agentic/agent-kit";
import {
  generateJdApi,
  parseResumeApi,
  matchResumeApi,
  inviteCandidateApi,
} from "@agentic/tools/robohire";
import {
  persistRuleCheckAudit,
  recordsUpsert,
} from "@agentic/tools/records";
import { fetchActionRules } from "@agentic/tools/ontology";
import { foldRuleDecisionTool } from "./tools/fold-rule-decision";
import { evaluateMatchRules } from "./tools/evaluate-match-rules";
import { loadMatchInputs } from "./tools/load-match-inputs";
import { zhaopinPrompts } from "./prompts";
import { zhaopinReasoningConfig } from "./reasoning-config";
import { zhaopinLegacyRaasEventAdapter } from "./event-adapter";
import { zhaopinReadFromInbox } from "./tools/read-from-inbox";
import { createRecruitmentRaasCapabilityPack } from "@agentic/recruitment-capabilities";

const recruitmentCapabilities = createRecruitmentRaasCapabilityPack({
  tenantSlug: "zhaopin",
  reasoning: zhaopinReasoningConfig,
  // Compatibility for the already-reviewed hand-authored zhaopin manifest.
  // Generated tenants do not receive defaults and must bind profiles.
  trustedDefaults: {
    loadRaasRequirement: {
      tenant_slug: "zhaopin",
      postgres_url_env: "RAAS_POSTGRES_URL",
    },
    persistJd: { tenant_slug: "zhaopin" },
    persistRaasEntities: {
      tenant_slug: "zhaopin",
      postgres_url_env: "RAAS_POSTGRES_URL",
      allmeta_base_url_env: "ALLMETA_BASE_URL",
      allmeta_api_key_env: "ALLMETA_API_KEY",
      allmeta_domain_id: "Agents-generation",
    },
    routeResumeProcessed: { tenant_slug: "zhaopin" },
    candidateDedupLookup: {
      tenant_slug: "zhaopin",
      postgres_url_env: "RAAS_POSTGRES_URL",
    },
    loadRaasRuleContext: {
      tenant_slug: "zhaopin",
      postgres_url_env: "RAAS_POSTGRES_URL",
    },
    "reasoning.evaluateRules": {
      tenant_slug: "zhaopin",
      domainId: zhaopinReasoningConfig.ontology.domainId,
    },
  },
});

const tools: TenantRegistry["tools"] = {
  ...recruitmentCapabilities,
  "fs.readFromInbox": zhaopinReadFromInbox,
  generateJdApi,

  // First-party RoboHire REST tools (re-exported into the tenant registry so
  // the LLM tool-use ADVERTISE loop can see matchResumeApi / inviteCandidateApi
  // — it reads only `tenantRegistry.tools`). Creds/base-url resolve per-call via
  // tool_use[].config (api_key_env=ROBOHIRE_API_KEY) or ROBOHIRE_* env.
  parseResumeApi, // 9-1 processResume: RoboHire /parse-resume
  matchResumeApi, // 10-2 matchResume: RoboHire /match-resume (advertised to decideMatchOutcome)
  inviteCandidateApi, // 11-1: the single real delivery call

  // Legacy deterministic match-rule tools remain registered for replaying old
  // deployed manifests. New/live manifests call reasoning.evaluateRules.
  evaluateMatchRules,
  foldRuleDecision: foldRuleDecisionTool,

  // 10-2 matchResume step 1: the legacy wire envelope intentionally drops the
  // full resume/JD bodies, so re-materialize them from the mirror PG + JD
  // store using the ids that DO travel (old-AO-faithful pull model).
  loadMatchInputs,

  // 10-1 rule-check FINAL persistence gate. The implementation is globally
  // catalogued for Agent Factory binding, and re-exported here so deployed
  // zhaopin tenant packages keep an explicit runtime capability snapshot.
  persistRuleCheckAudit,

  // 10-3 identity check advertises the live-ontology rule fetch to its logic
  // step; the LLM tool-use loop reads only this map, so the global tool must
  // be re-exported here (same rule as the RoboHire REST tools above).
  "ontology.fetchActionRules": fetchActionRules,

  // Durable business-record persistence (candidate / resume / match / comms) —
  // new-arch replacement for the old AO's Neo4j / RAAS-PG instance write-back.
  // Global tool, re-exported here for advertise-loop parity.
  "records.upsert": recordsUpsert,
};

const prompts: TenantRegistry["prompts"] = zhaopinPrompts;

const registry: TenantRegistry = {
  tools,
  prompts,
  factory: {
    source: {
      kind: "workspace_package",
      id: "@tenants/zhaopin",
      version: "0.1.0",
    },
  },
  // The old RAAS broker envelope is a tenant integration contract, not a
  // generic runtime mode. Normal tenants omit this field and stay identity.
  eventAdapter: zhaopinLegacyRaasEventAdapter,
  // Production rule reasoning is a standalone tenant capability. It does not
  // read or mutate Agent Factory's ontology-domain binding.
  reasoning: zhaopinReasoningConfig,
};
export default registry;

export {
  canonicalizeLegacyRaasInput,
  LEGACY_RAAS_FUNCTION_IDS,
  zhaopinLegacyRaasEventAdapter,
} from "./event-adapter";
export {
  projectLegacyRaasEvent,
  unwrapLegacyRaasEventData,
  wrapLegacyRaasEventData,
  type LegacyRaasMeta,
  type LegacyRaasProjection,
  type LegacyRaasUnwrapOptions,
  type LegacyRaasWireInput,
} from "./legacy-raas-envelope";
export {
  materializeRemoteResume,
  validateRemoteBucket,
  validateRemoteObjectKey,
  RemoteResumeError,
  type RemoteResumeOptions,
} from "./tools/remote-resume";
export { zhaopinReadFromInbox } from "./tools/read-from-inbox";
export {
  createRecruitmentRaasCapabilityPack,
  RECRUITMENT_RAAS_CAPABILITY_NAMES,
  type RecruitmentRaasCapabilityProfile,
} from "@agentic/recruitment-capabilities";

export {
  persistRaasExternal,
  buildAllmetaWrites,
  stableUuid,
  parsedResume,
  normalizeCandidateMatchSnapshot,
  candidateMatchRichness,
  persistPostgresWithSession,
  failResumeUploadRuntimeWithSession,
  snapshotFromContext,
  RAAS_PERSISTENCE_PHASES,
  type PersistenceAdapters,
  type PersistenceIds,
  type PersistenceReceipt,
  type NormalizedCandidateMatch,
  type RaasPersistencePhase,
} from "./tools/raas-persistence";
export {
  readRaasRuleContext,
  type RaasRuleContext,
} from "./tools/raas-rule-context";
