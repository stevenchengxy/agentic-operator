/**
 * Ontology + manifest loader.
 *
 * Per RF-1.4: each tenant's ontology lives in `models/<tenant-slug>-v<n>/`
 * and ships 5 files. Two are runtime-load-bearing (workflow + actions); the
 * other three are pass-through metadata served via the api.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  WorkflowManifestCompatSchema,
  type AgentDefinitionV2,
  ReasoningConfigSchema,
  TextVerbositySchema,
  ProviderIdSchema,
} from "@agentic/contracts";

export const ActorEnum = z.enum(["Agent", "Human"]);
/**
 * P1-RT-03: `condition` / `delay` / `subflow` are first-class step types.
 *   - `condition` evaluates a JS-ish expression against ctx and returns
 *     { evaluated: boolean, condition: string }; downstream branching is
 *     wired by register.ts.
 *   - `delay` sleeps for `delay_ms` then resolves; in production this
 *     becomes `step.sleep(...)` so Inngest handles the durable timer.
 *   - `subflow` is a placeholder that records which child agent name to
 *     fan-out to; register.ts owns the actual subflow event emission.
 */
export const StepTypeEnum = z.enum([
  "tool",
  "logic",
  "manual",
  "condition",
  "delay",
  "subflow",
]);

export const ActionSchema = z
  .object({
    id: z.string().optional(),
    order: z.string(),
    name: z.string(),
    description: z.string().optional().default(""),
    type: StepTypeEnum,
    action_prompt: z.string().optional(),
    provider: ProviderIdSchema.optional(),
    model: z.string().trim().min(1).max(240).optional(),
    reasoning: ReasoningConfigSchema.optional(),
    verbosity: TextVerbositySchema.optional(),
    store: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().max(1_000_000).optional(),
    tool: z.string().optional(),
    condition: z.string().optional(),
    true_action_id: z.string().optional(),
    false_action_id: z.string().optional(),
    task_type: z.string().optional(),
    form_schema: z.record(z.string(), z.unknown()).optional(),
    awaiting_role: z.string().optional(),
    retries: z.number().int().nonnegative().optional(),
    timeout_s: z.number().int().positive().optional(),
    // P1-RT-03 fields for the new step types.
    delay_ms: z.number().int().nonnegative().optional(),
    subflow: z.string().optional(),
    subflow_input: z.record(z.string(), z.unknown()).optional(),
    wait_policy: z.enum(["wait", "detach"]).optional(),
    input_mapping: z.record(z.string(), z.unknown()).optional(),
    output_mapping: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();
export type ActionSpec = z.infer<typeof ActionSchema>;

/** Canonical entry for `agent.tool_use[*]`. */
export const ToolUseEntrySchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    input_schema: z.unknown().optional(),
    /**
     * Per-tenant tool configuration. Lifted into `ToolContext.config` at
     * dispatch time so global tools (RoboHire wrappers, fs.* family, etc.)
     * can be specialised per tenant without code changes. Example:
     *
     *   "tool_use": [
     *     { "name": "parseResumeApi",
     *       "config": { "api_key_env": "TENANT_X_RH_KEY",
     *                   "timeout_ms": 60000 } },
     *     { "name": "fs.readFromInbox",
     *       "config": { "subdir": "resumes", "max_bytes": 5242880 } }
     *   ]
     *
     * The shape is intentionally `Record<string, unknown>` — each tool
     * documents the keys it honours. The runtime never inspects this map.
     */
    config: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

/**
 * Coerce empty-string values to undefined for the optional string slots that
 * legacy fixtures sometimes serialized as `""`. Without this, downstream
 * code that does `if (a.ontology_instructions)` works fine, but anything that
 * asserts `.toBeUndefined()` (and the lint that validates non-empty strings)
 * sees `""` and rejects it. The DESIGN-A audit calls this out in §3.1.
 */
const emptyStringToUndef = z
  .union([z.string(), z.undefined()])
  .transform((v) => (v === "" ? undefined : v))
  .optional();

/**
 * Agent Studio's v2 contract uses `null` as the explicit "disabled" value
 * for schedule fields. Bare-array manifests still pass through the legacy
 * runtime parser during import, so accept that v2 sentinel here as well as
 * the legacy empty string. Both normalize to an omitted schedule.
 */
const disabledScheduleToUndef = z
  .union([z.string(), z.null(), z.undefined()])
  .transform((v) => (v === "" || v === null ? undefined : v))
  .optional();

/**
 * Tolerant `tool_use` schema: accepts either an array of canonical entries
 * OR a legacy empty string (coerced to undefined). Any other shape is
 * rejected so we catch authoring mistakes. The inner `.transform(() => undefined)`
 * already converts the `""` branch to `undefined`, so the union output is
 * `Entry[] | undefined` — no need for an outer transform.
 */
const toolUseSchema = z
  .union([
    z.array(ToolUseEntrySchema),
    z.literal("").transform(() => undefined),
  ])
  .optional();

// `.passthrough()` is load-bearing: on-disk `workflow_v*.json` carries
// optional fields (`cron`, `model`, `timeout_s`, …) that aren't part of
// the runtime contract but ARE part of the editor-facing manifest. Stripping
// them would silently drop authoring metadata — TC-33's "preserves every
// raw-JSON key" assertion guards against that regression. The 4 fields the
// editor cares about (input_data/ontology_instructions/tool_use/typescript_code)
// are now declared explicitly so empty-string coercion + tool_use shape
// validation actually run.
const LegacyAgentSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional().default(""),
    actor: z.array(ActorEnum).min(1),
    trigger: z.array(z.string()),
    actions: z.array(ActionSchema),
    triggered_event: z.array(z.string()),
    input_data: z.record(z.string(), z.unknown()).optional(),
    ontology_instructions: emptyStringToUndef,
    tool_use: toolUseSchema,
    typescript_code: emptyStringToUndef,
    /**
     * Opt-in marker for agents authored by the deploy wizard. Generated
     * agents use `ontology_instructions` as their complete system prompt and
     * the runtime-provided generic user turn, so they do not require a
     * tenant-specific TypeScript `definePrompt` implementation.
     */
    generated: z.boolean().optional(),
    // Scheduled-trigger fields. Declared explicitly so that legacy manifests
    // serialising `""` as the placeholder coerce to `undefined`; otherwise
    // `.passthrough()` would let the raw empty string flow through and the
    // scheduler would try (and fail) to parse it as a cron expression.
    // Real cron strings like "0 9 * * *" pass through unchanged because
    // `disabledScheduleToUndef` only intercepts empty-string/null sentinels.
    cron: disabledScheduleToUndef,
    cron_timezone: disabledScheduleToUndef,
  })
  .passthrough();

/**
 * Keep the introspectable v1 object as the compatibility surface used by the
 * generated-schema drift gate. V2 is validated by WorkflowManifestCompatSchema
 * at every disk-loader boundary; passthrough preserves its declared fields.
 */
export const AgentSchema = LegacyAgentSchema;
export type AgentSpec = z.infer<typeof AgentSchema> | AgentDefinitionV2;

export const WorkflowManifestSchema = z.array(AgentSchema);
export type WorkflowManifest = AgentSpec[];

export const ActionsManifestSchema = z.array(z.record(z.string(), z.unknown()));
export type ActionsManifest = z.infer<typeof ActionsManifestSchema>;

/** Per-event metadata for the Events catalog view. Loose schema. */
export const EventCatalogEntry = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    category: z.string().optional(),
    color: z.string().optional(),
    payload: z.unknown().optional(),
  })
  .passthrough();
export const EventCatalogSchema = z.object({
  events: z.array(EventCatalogEntry).optional(),
  metadata: z.unknown().optional(),
});

/** Per-entity metadata from objects.json. */
export const EntityPropertySchema = z
  .object({
    name: z.string(),
    type: z.string().optional(),
    description: z.string().optional(),
    is_foreign_key: z.boolean().optional(),
    references: z.string().optional(),
  })
  .passthrough();
export const EntitySchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    description: z.string().optional(),
    primary_key: z.string().optional(),
    properties: z.array(EntityPropertySchema).optional(),
  })
  .passthrough();
export const ObjectsManifestSchema = z.object({
  payload: z.array(EntitySchema).optional(),
  metadata: z.unknown().optional(),
});

/** Per-rule metadata from rules.json. Pass-through. */
export const RulesManifestSchema = z
  .object({
    payload: z.array(z.unknown()).optional(),
    metadata: z.unknown().optional(),
  })
  .passthrough();

export interface LoadedManifest {
  manifest: WorkflowManifest;
  actionsExt: ActionsManifest;
  manifestPath: string;
  actionsPath: string;
}

export interface LoadedModels extends LoadedManifest {
  events: z.infer<typeof EventCatalogSchema>;
  objects: z.infer<typeof ObjectsManifestSchema>;
  rules: z.infer<typeof RulesManifestSchema>;
  dir: string;
}

/**
 * Resolve a model file in a dir. Accepts the bare name (`workflow.json`),
 * a versioned suffix (`workflow_v1.json`, `workflow_v2.json`, …), and any
 * legacy alias. Returns the first existing path, or null if none.
 */
async function resolveModelFile(
  dir: string,
  candidates: string[],
): Promise<string | null> {
  let allFiles: string[];
  try {
    const { readdir } = await import("node:fs/promises");
    allFiles = await readdir(dir);
  } catch {
    return null;
  }
  for (const c of candidates) {
    if (allFiles.includes(c)) return path.join(dir, c);
  }
  // versioned fallback: <base>_v<N>.json
  for (const c of candidates) {
    const base = c.replace(/\.json$/, "");
    const versioned = allFiles
      .filter((f) => new RegExp(`^${base}_v\\d+(\\.\\d+)*\\.json$`).test(f))
      .sort((a, b) => {
        const readVersion = (file: string): number[] => {
          const match = file.match(/_v(\d+(?:\.\d+)*)\.json$/);
          return (match?.[1] ?? "0").split(".").map(Number);
        };
        const av = readVersion(a);
        const bv = readVersion(b);
        const width = Math.max(av.length, bv.length);
        for (let i = 0; i < width; i += 1) {
          const delta = (bv[i] ?? 0) - (av[i] ?? 0);
          if (delta !== 0) return delta;
        }
        return b.localeCompare(a);
      });
    if (versioned.length > 0) return path.join(dir, versioned[0]!);
  }
  return null;
}

async function readJsonFileOptional<T>(
  filePath: string | null,
  schema: z.ZodType<T>,
  fallback: T,
): Promise<T> {
  if (!filePath) return fallback;
  const raw = JSON.parse(await readFile(filePath, "utf8"));
  return schema.parse(raw);
}

/**
 * Backwards-compat wrapper: loads workflow + actions from a dir.
 * Accepts versioned names (`workflow_v1.json`).
 */
export async function loadManifestFromDisk(
  workflowDir: string,
): Promise<LoadedManifest> {
  const workflowPath = await resolveModelFile(workflowDir, [
    "workflow.json",
    "manifest.json",
  ]);
  if (!workflowPath) {
    throw new Error(`[manifest] no workflow.json found in ${workflowDir}`);
  }
  const actionsPath = await resolveModelFile(workflowDir, ["actions.json"]);
  const rawWorkflow = JSON.parse(
    await readFile(workflowPath, "utf8"),
  ) as unknown;
  // Canonical compatibility validation accepts both v1 bare arrays and the
  // v2 envelope. Keep raw v1 agents on the legacy branch so registration
  // behavior does not change merely because a loader was upgraded.
  const normalized = WorkflowManifestCompatSchema.parse(rawWorkflow);
  // A v1 bare array stays on the legacy runtime branch. A versioned envelope
  // uses the canonical parser's output so defaults and refinements are not
  // accidentally discarded after successful validation.
  const manifest: WorkflowManifest = Array.isArray(rawWorkflow)
    ? WorkflowManifestSchema.parse(rawWorkflow)
    : normalized.agents;
  const actionsExt = await readJsonFileOptional(
    actionsPath,
    ActionsManifestSchema,
    [],
  );
  return {
    manifest,
    actionsExt,
    manifestPath: workflowPath,
    actionsPath: actionsPath ?? path.join(workflowDir, "actions.json"),
  };
}

/**
 * Load all 5 ontology files from a tenant model directory.
 */
export async function loadModelsFromDisk(
  modelDir: string,
): Promise<LoadedModels> {
  const base = await loadManifestFromDisk(modelDir);
  const [eventsPath, objectsPath, rulesPath] = await Promise.all([
    resolveModelFile(modelDir, ["events.json"]),
    resolveModelFile(modelDir, ["objects.json"]),
    resolveModelFile(modelDir, ["rules.json"]),
  ]);
  const [events, objects, rules] = await Promise.all([
    readJsonFileOptional(eventsPath, EventCatalogSchema, { events: [] }),
    readJsonFileOptional(objectsPath, ObjectsManifestSchema, { payload: [] }),
    readJsonFileOptional(rulesPath, RulesManifestSchema, { payload: [] }),
  ]);
  return { ...base, events, objects, rules, dir: modelDir };
}

/**
 * Derive tenant slug from a model folder name.
 *   "RAAS-v1"        → "raas"
 *   "supportflow-v3" → "supportflow"
 *   "finance"        → "finance"
 */
export function tenantSlugFromFolder(folder: string): string {
  return folder.toLowerCase().replace(/-v\d+(\.\d+)*$/i, "");
}
