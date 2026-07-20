import { z } from "zod";

export const ActorEnum = z.enum(["Agent", "Human"]);

export const AgentKindEnum = z.enum(["manifest", "code"]);
export type AgentKindValue = z.infer<typeof AgentKindEnum>;

export const ListAgentRow = z.object({
  id: z.string(),
  kebabId: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  actor: ActorEnum,
  kind: AgentKindEnum,
  enabled: z.boolean(),
  runCount: z.number(),
  errorCount: z.number(),
  lastRunAt: z.coerce.date().nullable(),
});
export type ListAgentRow = z.infer<typeof ListAgentRow>;

export const ActionSpec = z.object({
  order: z.string(),
  name: z.string(),
  description: z.string().optional().default(""),
  type: z.enum([
    "tool",
    "logic",
    "manual",
    "condition",
    "delay",
    "subflow",
    "invoke",
    "foreach",
    "emit",
  ]),
  condition: z.string().optional(),
  task_type: z.string().optional(),
}).passthrough();
export type ActionSpec = z.infer<typeof ActionSpec>;

/** Canonical manifest entry for a tool available to an agent. Unknown
 * per-tool metadata is intentionally preserved during upload and readback. */
export const AgentToolUseSpec = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.unknown().optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type AgentToolUseSpec = z.infer<typeof AgentToolUseSpec>;

export const AgentSpec = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional().default(""),
  actor: z.array(ActorEnum).min(1),
  trigger: z.array(z.string()),
  actions: z.array(ActionSpec),
  triggered_event: z.array(z.string()),
  input_data: z.record(z.string(), z.unknown()).optional(),
  ontology_instructions: z.string().optional(),
  tool_use: z.array(AgentToolUseSpec).optional(),
  typescript_code: z.string().optional(),
}).passthrough();
export type AgentSpec = z.infer<typeof AgentSpec>;

export const WorkflowManifest = z.array(AgentSpec);
export type WorkflowManifest = z.infer<typeof WorkflowManifest>;

export const ManifestUploadBody = z.object({
  manifest: WorkflowManifest,
  actions: z.array(z.record(z.string(), z.unknown())).optional(),
  note: z.string().max(500).optional(),
  workflowSlug: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "workflowSlug contains unsupported characters")
    .optional(),
});
export type ManifestUploadBody = z.infer<typeof ManifestUploadBody>;

export const ManifestDiff = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  modified: z.array(z.string()),
  prior_version: z.string().nullable(),
});
export type ManifestDiff = z.infer<typeof ManifestDiff>;

export const ManifestUploadResponse = z.object({
  workflow_version_id: z.string(),
  version: z.string(),
  diff: ManifestDiff,
  note: z.string(),
});

export const AgentDetail = z.object({
  id: z.string(),
  kebabId: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  actor: ActorEnum,
  kind: AgentKindEnum,
  enabled: z.boolean(),
  triggers: z.array(z.string()),
  triggeredEvents: z.array(z.string()),
  actions: z.array(ActionSpec),
  workflowSlug: z.string(),
  /** Null means that this agent has no version referenced by a live
   * deployment. It must not silently fall back to an undeployed draft. */
  workflowVersion: z.string().nullable(),
  input_data: z.record(z.string(), z.unknown()).nullable(),
  ontology_instructions: z.string().nullable(),
  tool_use: z.array(AgentToolUseSpec).nullable(),
  typescript_code: z.string().nullable(),
  /** True only when no valid deployed agent-version manifest is available.
   * Individual optional slots above can still be null on a valid manifest. */
  sourceUnavailable: z.boolean(),
  deployedSource: z
    .object({
      deploymentId: z.string(),
      deploymentTarget: z.enum(["workflow", "agent", "code_agent"]),
      deployedAt: z.coerce.date(),
      agentVersionId: z.string(),
      workflowVersionId: z.string(),
      storage: z.literal("agent_versions.manifest_json"),
    })
    .nullable(),
});
export type AgentDetail = z.infer<typeof AgentDetail>;
