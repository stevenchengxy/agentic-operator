/**
 * @tenants/robohire — the use-case tenant that exercises every new
 * capability shipped in this round:
 *
 *   - Native tools     (REST wrappers in `tools/`) — bridge to the real
 *                       RoboHire.io API. Reads `ROBOHIRE_API_KEY` from env.
 *                       Live surface (probed 2026-05-24): /api/v1/match-resume,
 *                       /parse-resume, /parse-jd, /invite-candidate,
 *                       /evaluate-interview, /health, /stats.
 *   - Skills           (markdown under `skills/`) — progressively-disclosed
 *                       procedural knowledge for sourcing, screening, interview
 *                       planning.
 *   - Prompts          — tenant `definePrompt` for each `logic` action in
 *                       `models/robohire-v1/workflow_v1.json`.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TenantRegistry } from "@agentic/agent-kit";
import { loadSkillsFromDirectory } from "@agentic/skills";

import { matchResumeApi } from "./tools/match-resume";
import { parseResumeApi } from "./tools/parse-resume";
import { parseJdApi } from "./tools/parse-jd";
import { inviteCandidateApi } from "./tools/invite-candidate";
import { robohireHealthApi } from "./tools/health";
import { planCandidateSearch } from "./prompts/sourcing-prompt";
import { screenCandidates } from "./prompts/screening-prompt";
import { matchAndAnalyze } from "./prompts/match-and-analyze";
import { generateInvite } from "./prompts/generate-invite";

const here = dirname(fileURLToPath(import.meta.url));

const tools: TenantRegistry["tools"] = {
  // Real RoboHire.io REST API — picks up creds from ROBOHIRE_API_KEY.
  matchResumeApi,
  parseResumeApi,
  parseJdApi,
  inviteCandidateApi,
  robohireHealthApi,
};

const prompts: TenantRegistry["prompts"] = {
  // V1 sourcer→screener chain (kept so prior runs stay re-runnable).
  planCandidateSearch,
  screenCandidates,
  // V2 match-resume → invite chain — focused use case for the live RoboHire API.
  matchAndAnalyze,
  generateInvite,
};

// Boot-time scan of the skills directory. Returns metadata-only descriptors;
// SKILL.md bodies are loaded on demand by the `skills.load_skill` tool.
const skills = loadSkillsFromDirectory(join(here, "skills"));

const registry: TenantRegistry = { tools, prompts, skills };
export default registry;

/**
 * Named tool re-exports so sibling tenant packages (e.g. `@tenants/northwind`)
 * can compose the same RoboHire REST surface without re-implementing the
 * fetch wrappers. The tools are pure descriptors — sharing them across
 * tenants is safe (each invocation gets its own ToolContext via the
 * step engine).
 */
export {
  matchResumeApi,
  parseResumeApi,
  parseJdApi,
  inviteCandidateApi,
  robohireHealthApi,
};
