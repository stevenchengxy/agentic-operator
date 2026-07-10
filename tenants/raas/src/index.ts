/**
 * @tenants/raas — RAAS tenant code package.
 *
 * Bootstrap auto-discovers this package because the tenant slug "raas" matches
 * a `models/<slug>/` folder. Anything exported here becomes available to the
 * step engine when running RAAS agents:
 *
 *   - `tools`   — manifest action `{ "type": "tool", "name": "X" }` resolves
 *                 to `tools.X` before falling back to generic @agentic/tools
 *   - `prompts` — manifest action `{ "type": "logic", "name": "Y" }` resolves
 *                 to `prompts.Y` before falling back to the auto-built
 *                 `<name>: <description>` prompt
 *
 * To add a new tool/prompt: create a file under `src/tools/` or `src/prompts/`,
 * call `defineTool({...})` / `definePrompt({...})`, then register here.
 *
 * Pure-declarative agents (no custom code) need no entry here — the JSON
 * manifest alone is sufficient.
 */

import type { TenantRegistry } from "@agentic/agent-kit";
import { pingProbe } from "./tools/ping-probe";
import {
  parseResumeApi,
  matchResumeApi,
  inviteCandidateApi,
  parseJdApi,
  robohireHealthApi,
} from "@agentic/tools/robohire";
import { candidateDedupLookup } from "./tools/candidate-dedup";
import { foldRuleDecisionTool } from "./tools/fold-rule-decision";
import { sendInvitationEmail } from "./tools/send-invitation-email";
import { raasPrompts } from "./prompts";

const tools: TenantRegistry["tools"] = {
  // The action.name in workflow_v1.json maps here. pingProbe targets the
  // first action of syncFromClientSystem ("monitorAndFetchRequirement") so
  // a SCHEDULED_SYNC trigger exercises the tenant resolver end-to-end.
  monitorAndFetchRequirement: pingProbe,

  // Agent migration (招聘-v1): re-export the first-party RoboHire REST tools
  // into the RAAS tenant registry. Required because the LLM tool-use ADVERTISE
  // loop only reads `tenantRegistry.tools` (step-engine.ts:222) — a global tool
  // listed in an agent's `tool_use[]` is silently dropped from the model's tool
  // set unless it lives here. Mirrors tenants/robohire/src/index.ts. Pure
  // descriptors; creds/base-url resolve per-call via tool_use[].config or
  // ROBOHIRE_* env (rest-helper).
  parseResumeApi,
  matchResumeApi,
  inviteCandidateApi,
  parseJdApi,
  robohireHealthApi,

  // RAAS-specific: SQLite-backed candidate dedup + recruiter lock (migrated
  // from the old CandidateDedup agent). Resolves as the processResume action
  // `candidateDedupLookup`.
  candidateDedupLookup,

  // RuleCheck: deterministic fail-closed fold (the verdict the LLM must NOT own).
  foldRuleDecision: foldRuleDecisionTool,

  // InterviewInviter: real email delivery (RoboHire only generates the body).
  sendInvitationEmail,
};

// Wave 4.5 — every `logic` action in models/RAAS-v1/workflow_v1.json must
// have a matching definePrompt or the tenant refuses to boot
// (`findMissingTenantPrompts` in packages/runtime/src/register.ts).
const prompts: TenantRegistry["prompts"] = raasPrompts;

const registry: TenantRegistry = { tools, prompts };
export default registry;
