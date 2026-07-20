/**
 * @tenants/northwind — full-stack AI engineer hiring workflow.
 *
 * Three-agent chain:
 *
 *   HIRING_REQUIREMENT_SUBMITTED
 *      ↓ jdAuthorAgent (authorJD prompt + writeJdToDisk)
 *   JD_DRAFTED
 *      ↓ (operator publishes CANDIDATE_BATCH_SUBMITTED with the new
 *         jd_text + an array of candidate resumes; not auto-chained
 *         so the operator stays in the loop)
 *   CANDIDATE_BATCH_SUBMITTED
 *      ↓ batchMatchAgent (batchMatchResumes prompt + matchResumeApi × N)
 *   BATCH_MATCH_COMPLETED
 *      ↓ reportAgent (buildReport prompt + writeReportToDisk)
 *   REPORT_GENERATED
 *
 * Tools surface:
 *   - Custom: writeJdToDisk, writeReportToDisk (in `./tools/`)
 *   - Shared with @tenants/robohire: matchResumeApi, parseJdApi,
 *     inviteCandidateApi, robohireHealthApi — re-exported here so the
 *     manifest's `tool_use[]` advertises them under their canonical names.
 * Skills: jd-authoring, match-rubric, report-template (under `./skills/`).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { TenantRegistry } from "@agentic/agent-kit";
import { loadSkillsFromDirectory } from "@agentic/skills";

// Reuse the live RoboHire REST tools from @tenants/robohire — same
// implementation, same env contract (ROBOHIRE_API_KEY). parseResumeApi
// was added 2026-05-27 so the new resumeIntakeAgent can hand a PDF off
// to the upstream parser without re-implementing the wrapper.
import {
  matchResumeApi,
  parseJdApi,
  parseResumeApi,
  inviteCandidateApi,
  robohireHealthApi,
} from "@tenants/robohire";

import { writeJdToDisk } from "./tools/write-jd-to-disk";
import { writeReportToDisk } from "./tools/write-report-to-disk";
import { readResumeFromDisk } from "./tools/read-resume-from-disk";

import { authorJD } from "./prompts/author-jd";
import { batchMatchResumes } from "./prompts/batch-match";
import { buildReport } from "./prompts/build-report";
import { intakeAndParseResume } from "./prompts/intake-resume";

const here = dirname(fileURLToPath(import.meta.url));

const tools: TenantRegistry["tools"] = {
  // Tenant-native side-effect tools.
  writeJdToDisk,
  writeReportToDisk,
  readResumeFromDisk,
  // Reused RoboHire REST surface (matchResumeApi is the workhorse;
  // parseResumeApi feeds resumeIntakeAgent).
  matchResumeApi,
  parseJdApi,
  parseResumeApi,
  inviteCandidateApi,
  robohireHealthApi,
};

const prompts: TenantRegistry["prompts"] = {
  authorJD,
  batchMatchResumes,
  buildReport,
  intakeAndParseResume,
};

const skills = loadSkillsFromDirectory(join(here, "skills"));

const registry: TenantRegistry = { tools, prompts, skills };
export default registry;
