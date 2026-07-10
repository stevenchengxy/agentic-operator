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
 *   10-3 ruleCheckForCandidateIdentity RESUME_PROCESSED → CANDIDATE_IDENTITY_CHECKED  (audit-only)
 *   10-1 ruleCheckForMatchResume      RESUME_PROCESSED → MATCH_RULE_CHECK_PASSED|FAILED  (the gate)
 *   10-2 matchResume                  MATCH_RULE_CHECK_PASSED → MATCH_PASSED_NEED_INTERVIEW|NO_INTERVIEW|FAILED
 *   11-1 inviteInternalInterview      INTERVIEW_INVITATION_REQUESTED → INTERVIEW_INVITATION_SENT|FAILED
 */

import type { TenantRegistry } from "@agentic/agent-kit";
import {
  parseResumeApi,
  matchResumeApi,
  inviteCandidateApi,
} from "@agentic/tools/robohire";
import { recordsUpsert } from "@agentic/tools/records";
import { candidateDedupLookup } from "./tools/candidate-dedup";
import { foldRuleDecisionTool } from "./tools/fold-rule-decision";
import { evaluateMatchRules } from "./tools/evaluate-match-rules";
import { routeResumeProcessed } from "./tools/route-resume-processed";
import { persistJdTool } from "./tools/jd-store";
import { sendInvitationEmail } from "./tools/send-invitation-email";
import { zhaopinPrompts } from "./prompts";

const tools: TenantRegistry["tools"] = {
  // First-party RoboHire REST tools (re-exported into the tenant registry so
  // the LLM tool-use ADVERTISE loop can see matchResumeApi / inviteCandidateApi
  // — it reads only `tenantRegistry.tools`). Creds/base-url resolve per-call via
  // tool_use[].config (api_key_env=ROBOHIRE_API_KEY) or ROBOHIRE_* env.
  parseResumeApi, // 9-1 processResume: RoboHire /parse-resume
  matchResumeApi, // 10-2 matchResume: RoboHire /match-resume (advertised to decideMatchOutcome)
  inviteCandidateApi, // 11-1: RoboHire /invite-candidate (advertised to generateInterviewInvitation)

  // 9-1 processResume + 10-3 dedup: SQLite-backed candidate dedup + recruiter
  // lock (name+phone+email; soft-fail → never throws).
  candidateDedupLookup,

  // 9-1 processResume FINAL step: deterministic RESUME_PROCESSED assembler —
  // carries candidate_id/resume/resume_id/job_requisition_id/jd forward (via
  // the carry-forward envelope) so matchResume gets {resume, jd} with no LLM,
  // and routes _emit by lock_conflict.
  routeResumeProcessed,

  // 4 createJD FINAL step: persist the JD by job_requisition_id to the tenant
  // JD store so matchResume can retrieve it (new-arch JD instance store).
  persistJd: persistJdTool,

  // 10-1 ruleCheckForMatchResume: LIVE-rule gate. ontology.fetchActionRules
  // (global) pulls the executor=Agent rules from Allmeta RAAS-v1; evaluateMatchRules
  // stamps a deterministic pass/fail status per rule from candidate signals
  // (fail-closed on any restricted employer/nationality OR an Allmeta outage);
  // foldRuleDecision folds → MATCH_RULE_CHECK_PASSED|FAILED (the verdict the LLM
  // must NOT own).
  evaluateMatchRules,
  foldRuleDecision: foldRuleDecisionTool,

  // 11-1 inviteInternalInterview: real invite delivery (RoboHire only generates
  // the body); soft-fails if no transport is configured.
  sendInvitationEmail,

  // Durable business-record persistence (candidate / resume / match / comms) —
  // new-arch replacement for the old AO's Neo4j / RAAS-PG instance write-back.
  // Global tool, re-exported here for advertise-loop parity.
  "records.upsert": recordsUpsert,
};

const prompts: TenantRegistry["prompts"] = zhaopinPrompts;

const registry: TenantRegistry = { tools, prompts };
export default registry;
