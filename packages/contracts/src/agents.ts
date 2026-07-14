import { z } from "zod";
import { ProviderIdSchema } from "./llm";

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
  type: z.enum(["tool", "logic", "manual"]),
  condition: z.string().optional(),
  task_type: z.string().optional(),
});
export type ActionSpec = z.infer<typeof ActionSpec>;

export const AgentSpec = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string().optional(),
  description: z.string().optional().default(""),
  actor: z.array(ActorEnum).min(1),
  trigger: z.array(z.string()),
  actions: z.array(ActionSpec),
  triggered_event: z.array(z.string()),
});
export type AgentSpec = z.infer<typeof AgentSpec>;

export const WorkflowManifest = z.array(AgentSpec);
export type WorkflowManifest = z.infer<typeof WorkflowManifest>;

export const ManifestUploadBody = z.object({
  manifest: WorkflowManifest,
  actions: z.array(z.record(z.string(), z.unknown())).optional(),
  note: z.string().max(500).optional(),
  workflowSlug: z.string().optional(),
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

// ─── Agent authoring / deploy wizard ──────────────────────────────────────

const AuthoringAgentName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[a-z][A-Za-z0-9]*$/,
    "name must be lower camelCase (letters and numbers only)",
  );

const AuthoringEventName = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(
    /^[A-Z][A-Z0-9_.:-]*$/,
    "event names must start with A-Z and contain only A-Z, 0-9, _, ., :, or -",
  );

export const AgentAuthoringTool = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2_000).optional(),
    input_schema: z.record(z.string(), z.unknown()).optional(),
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type AgentAuthoringTool = z.infer<typeof AgentAuthoringTool>;

export const AgentTemplate = z.enum([
  "blank",
  "classify",
  "extract",
  "rag",
  "loop",
  "human",
]);
export type AgentTemplate = z.infer<typeof AgentTemplate>;

/** Shared context sent to the LLM prompt generator. */
export const GenerateAgentPromptBody = z.object({
  name: AuthoringAgentName,
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(10).max(8_000),
  actor: ActorEnum.default("Agent"),
  template: AgentTemplate.default("blank"),
  stage: z.number().int().min(0).max(99).default(0),
  triggers: z.array(AuthoringEventName).max(50).default([]),
  emits: z.array(AuthoringEventName).max(50).default([]),
  tools: z.array(AgentAuthoringTool).max(50).default([]),
  provider: ProviderIdSchema.optional(),
  model: z.string().trim().min(1).max(240).optional(),
});
export type GenerateAgentPromptBody = z.infer<typeof GenerateAgentPromptBody>;

export const GenerateAgentPromptResponse = z.object({
  systemPrompt: z.string().min(40).max(16 * 1024),
  provider: ProviderIdSchema,
  model: z.string(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
});
export type GenerateAgentPromptResponse = z.infer<
  typeof GenerateAgentPromptResponse
>;

/**
 * A single-agent deploy request. The API converts this authoring shape into
 * the canonical runtime manifest, merges it into the live workflow, persists
 * a new workflow version, and hot-swaps the Inngest function registry.
 */
export const DeployAuthoredAgentBody = GenerateAgentPromptBody.omit({
  tools: true,
  triggers: true,
}).extend({
  // An Inngest function with no trigger is not registered. The deploy
  // endpoint therefore makes this invariant explicit instead of reporting a
  // successful deployment that can never run.
  triggers: z.array(AuthoringEventName).min(1).max(50),
  // The runtime currently emits the first declared event. Keep the deploy
  // contract honest until branching/multi-emit semantics are implemented.
  emits: z.array(AuthoringEventName).max(1),
  systemPrompt: z.string().trim().min(40).max(16 * 1024),
  toolUse: z.array(AgentAuthoringTool).max(50).default([]),
  retries: z.number().int().min(0).max(10).default(3),
  timeoutS: z.number().int().min(1).max(3_600).default(120),
  concurrency: z.number().int().min(1).max(100).default(8),
  typescriptCode: z.string().max(64 * 1024).optional(),
});
export type DeployAuthoredAgentBody = z.infer<typeof DeployAuthoredAgentBody>;

export const DeployAuthoredAgentResponse = z.object({
  agent: z.object({
    id: z.string(),
    name: z.string(),
    title: z.string(),
  }),
  workflowVersionId: z.string(),
  version: z.string(),
  deploymentId: z.string(),
  fileWritten: z.string(),
  events: z.object({
    created: z.array(AuthoringEventName),
  }),
  runtime: z.object({
    functionId: z.string(),
    registered: z.literal(true),
    functionCount: z.number().int().nonnegative(),
  }),
});
export type DeployAuthoredAgentResponse = z.infer<
  typeof DeployAuthoredAgentResponse
>;

export const AgentDetail = z.object({
  id: z.string(),
  kebabId: z.string(),
  name: z.string(),
  title: z.string().nullable(),
  actor: ActorEnum,
  triggers: z.array(z.string()),
  triggeredEvents: z.array(z.string()),
  actions: z.array(ActionSpec),
  workflowSlug: z.string(),
  workflowVersion: z.string(),
});
export type AgentDetail = z.infer<typeof AgentDetail>;
