import { and, desc, eq } from "drizzle-orm";
import {
  deployments,
  eventTypes,
  getDb,
  workflowVersions,
  workflows,
} from "@agentic/db";
import type {
  AgentAuthoringStep,
  AgentAuthoringTool,
  AgentNameAvailabilityResponse,
  AgentModelSelection,
  DeployAuthoredAgentBody,
  DeployAuthoredAgentResponse,
  GenerateAgentPromptBody,
  GenerateAgentPromptResponse,
} from "@agentic/contracts";
import {
  validateJsonSchemaDocument,
  WorkflowManifestSchema,
  type AgentSpec,
  type WorkflowManifest,
} from "@agentic/runtime";
import { getLLMGateway } from "./llm";
import { commit, type AuditCtx, type TenantCtx } from "./manifest-import";
import {
  isInngestFunctionRegistered,
  listInngestFunctionIds,
} from "./inngest-registry";
import {
  getGlobalToolCatalogEntry,
  globalToolExecutionPolicy,
  listGlobalTools,
} from "@agentic/tools";
import {
  buildAgentArchetypeRuntime,
  getAgentArchetypeSpec,
  resolveAgentModelSelection,
} from "./agent-archetypes";

const PROMPT_DESIGNER_SYSTEM = `You are a senior agent architect. Turn the supplied agent specification into a production-grade system prompt for an autonomous workflow agent.

Return only the final system prompt, with no preface and no Markdown code fence. Make it specific to the supplied description rather than generic boilerplate. The prompt must clearly define:
- role, mission, scope, and completion criteria;
- available event inputs and how to handle missing or malformed data;
- a concrete step-by-step operating procedure;
- when and how each declared tool may be used, including validation of tool results;
- required output quality and emitted-event expectations;
- safety, privacy, tenant isolation, and non-fabrication guardrails;
- error recovery, uncertainty handling, and when to request human review.

The runtime, not the chat user, constructs the trigger-event envelope. The
agent receives the selected trigger name and stable identifiers together with
the user's exact chat message. Describe validation against the supplied
runtime_event_contract. Never instruct the user to wrap their request in JSON,
repeat the trigger name, or manually provide runtime-owned identifiers.

Do not invent credentials, private data, tools, or business rules that are not present in the specification. Treat the description as the source of domain requirements.`;

function stripOuterCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i,
  );
  return (match?.[1] ?? trimmed).trim();
}

export async function generateAgentSystemPrompt(
  input: GenerateAgentPromptBody,
  ctx: TenantCtx,
): Promise<GenerateAgentPromptResponse> {
  const gateway = getLLMGateway();
  const modelSelection = resolveAgentModelSelection({
    template: input.template,
    description: input.description,
    provider: input.provider,
    model: input.model,
    defaultProvider: gateway.defaultProvider,
    defaultModel: gateway.defaultModel,
  });
  const archetype = getAgentArchetypeSpec(input.template);
  const promptActors = input.steps?.some((step) => step.type === "logic")
    ? input.steps.some((step) => step.type === "manual")
      ? input.template === "human"
        ? ["Human", "Agent"]
        : ["Agent", "Human"]
      : ["Agent"]
    : [archetype.actor];
  const promptTools = input.tools.map(canonicalizeKnownToolEntry);
  for (const toolName of archetype.defaultTools) {
    if (!promptTools.some((tool) => tool.name === toolName)) {
      promptTools.push(defaultToolEntry(toolName));
    }
  }
  const response = await gateway.chat({
    provider: modelSelection.provider,
    model: modelSelection.model,
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    purpose: "agent-authoring",
    routing: { taskType: "agent.author" },
    maxTokens: 2_400,
    messages: [
      { role: "system", content: PROMPT_DESIGNER_SYSTEM },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: "generate_agent_system_prompt",
            tenant: ctx.tenantSlug,
            agent: {
              name: input.name,
              title: input.title,
              description: input.description,
              actor: promptActors,
              template: input.template,
              archetype,
              ...(input.template === "rag"
                ? { search_mode: input.searchMode ?? "deep_research" }
                : {}),
              trigger_events: input.triggers,
              emitted_events: input.emits,
              steps: input.steps,
              tools: promptTools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.input_schema,
              })),
            },
            runtime_event_contract: {
              description:
                "The platform supplies this object automatically for every trigger. The chat user supplies only their natural-language request and authored structured inputs.",
              fields: {
                event_type: "Selected authored trigger name.",
                event_name: "Alias of event_type for explicit event identity.",
                event_id: "Unique persisted event id.",
                request_id:
                  "Caller request id when provided, otherwise a stable runtime correlation id.",
                run_id: "Unique run id when the invocation has reserved a run.",
                session_id:
                  "Conversation session id when invoked from Test Lab chat.",
                correlation_id: "Stable trace correlation id.",
                prompt: "The user's exact current chat message.",
                input: "Alias of prompt for conversational agents.",
                context:
                  "Caller context when supplied, otherwise the exact current chat message.",
                subject: "Optional workflow subject.",
              },
              authoring_rules: [
                "Treat runtime fields as already present; do not ask the user to type them.",
                "Validate that event_type is one of the declared trigger_events.",
                "Use prompt/input as the current user request and context as supporting task context.",
              ],
            },
          },
          null,
          2,
        ),
      },
    ],
  });
  const systemPrompt = stripOuterCodeFence(response.text);
  if (systemPrompt.length < 40) {
    throw new Error(
      "prompt_generation_empty: the selected model returned no usable system prompt",
    );
  }
  return {
    systemPrompt,
    provider: response.provider,
    model: response.model,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    modelSelection: {
      ...modelSelection,
      provider: response.provider,
      model: response.model,
    },
  };
}

export class DuplicateAuthoredAgentError extends Error {
  constructor(
    public readonly field: "name" | "id",
    public readonly value: string,
  ) {
    super(`agent ${field} already exists: ${value}`);
    this.name = "DuplicateAuthoredAgentError";
  }
}

export class AuthoredAgentPersistenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthoredAgentPersistenceError";
  }
}

export class AuthoredAgentRuntimeError extends Error {
  constructor(public readonly functionId: string) {
    super(
      `deployed manifest but runtime function ${functionId} is not registered`,
    );
    this.name = "AuthoredAgentRuntimeError";
  }
}

export class InvalidAuthoredToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthoredToolError";
  }
}

export function validateToolBindings(
  input: DeployAuthoredAgentBody,
  ctx: TenantCtx,
): void {
  const catalog = new Map(listGlobalTools().map((tool) => [tool.name, tool]));
  const tenantKeyPrefix = ctx.tenantSlug
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_");
  for (const tool of input.toolUse) {
    const entry = catalog.get(tool.name);
    if (!entry) {
      throw new InvalidAuthoredToolError(`unknown_tool: ${tool.name}`);
    }
    const effectiveSchema = canonicalizeKnownToolEntry(tool).input_schema ?? {};
    const schemaIssues = validateJsonSchemaDocument(
      effectiveSchema,
      `/tool_use/${tool.name}/input_schema`,
    ).filter((issue) => issue.severity === "error");
    if (schemaIssues.length > 0) {
      throw new InvalidAuthoredToolError(
        `invalid_tool_schema: ${tool.name}: ${schemaIssues
          .slice(0, 3)
          .map((issue) => `${issue.path}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    const config = tool.config;
    if (!config) continue;
    const allowedKeys = new Set(Object.keys(entry.configSchema ?? {}));
    for (const key of Object.keys(config)) {
      if (!allowedKeys.has(key)) {
        throw new InvalidAuthoredToolError(
          `unknown_tool_config: ${tool.name}.${key}`,
        );
      }
    }
    if (
      Object.keys(config).some((key) =>
        /^(?:api[_-]?key|password|secret|token|authorization)$/i.test(key),
      )
    ) {
      throw new InvalidAuthoredToolError(
        `literal_secret_forbidden: ${tool.name} credentials must use a tenant integration or tenant-scoped *_env binding`,
      );
    }
    for (const [key, envName] of Object.entries(config)) {
      if (!key.endsWith("_env") || typeof envName !== "string") continue;
      if (
        !envName.startsWith(`TENANT_${tenantKeyPrefix}_`) &&
        !envName.startsWith(`${tenantKeyPrefix}_`)
      ) {
        throw new InvalidAuthoredToolError(
          `tenant_secret_scope: ${tool.name}.${key} must be prefixed for tenant ${ctx.tenantSlug}`,
        );
      }
    }
    const headers = config.default_headers;
    if (headers && typeof headers === "object" && !Array.isArray(headers)) {
      for (const key of Object.keys(headers as Record<string, unknown>)) {
        if (/authorization|api[-_]?key/i.test(key)) {
          throw new InvalidAuthoredToolError(
            `literal_secret_forbidden: ${tool.name}.default_headers cannot bind credential headers`,
          );
        }
      }
    }
    if (tool.name === "http.fetch" && !config.allow_host) {
      throw new InvalidAuthoredToolError(
        "http_host_allowlist_required: http.fetch bindings must declare config.allow_host",
      );
    }
    if (tool.name === "ontology.query" && config.base_url) {
      if (
        typeof config.username_env !== "string" ||
        typeof config.password_env !== "string"
      ) {
        throw new InvalidAuthoredToolError(
          "tenant_secret_scope: ontology.query base_url requires explicit tenant-scoped username_env and password_env bindings",
        );
      }
    }
    if (tool.name === "search.web" && config.base_url) {
      if (typeof config.api_key_env !== "string") {
        throw new InvalidAuthoredToolError(
          "tenant_secret_scope: search.web base_url requires an explicit tenant-scoped api_key_env binding",
        );
      }
    }
  }
}

function agentId(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])(\d+)/g, "$1-$2")
    .replace(/(\d+)([A-Za-z])/g, "$1-$2")
    .toLowerCase();
}

function loadLiveManifest(ctx: TenantCtx): WorkflowManifest {
  const row = getDb()
    .select({ manifest: workflowVersions.manifestJson })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
        eq(workflows.tenantId, ctx.tenantId),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .limit(1)
    .all()[0];
  if (!row) return WorkflowManifestSchema.parse([]);
  return WorkflowManifestSchema.parse(row.manifest);
}

type AuthoredAgentIdentityConflict = NonNullable<
  AgentNameAvailabilityResponse["conflict"]
>;

function findAuthoredAgentIdentityConflict(
  current: WorkflowManifest,
  name: string,
  id: string,
): AuthoredAgentIdentityConflict | null {
  if (
    current.some((agent) => agent.name.toLowerCase() === name.toLowerCase())
  ) {
    return { field: "name", value: name };
  }
  return current.some((agent) => agent.id === id)
    ? { field: "id", value: id }
    : null;
}

/**
 * Check the exact identity constraints enforced by deploy without mutating
 * the manifest. This is advisory UX validation; deploy repeats the check
 * under its tenant lock so concurrent submissions remain safe.
 */
export function getAuthoredAgentNameAvailability(
  name: string,
  ctx: TenantCtx,
): AgentNameAvailabilityResponse {
  const id = agentId(name);
  const current = loadLiveManifest(ctx);
  const conflict = findAuthoredAgentIdentityConflict(current, name, id);
  return { name, id, available: conflict === null, conflict };
}

const DEFAULT_TOOL_INPUT_SCHEMAS: Record<string, Record<string, unknown>> = {
  "search.web": {
    type: "object",
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 2_000 },
      max_results: { type: "integer", minimum: 1, maximum: 20 },
      search_depth: { type: "string", enum: ["basic", "advanced"] },
      include_raw_content: { type: "boolean" },
      include_domains: { type: "array", items: { type: "string" } },
      exclude_domains: { type: "array", items: { type: "string" } },
      time_range: { type: "string" },
    },
    additionalProperties: false,
  },
  "ontology.query": {
    type: "object",
    required: ["operation"],
    properties: {
      operation: {
        type: "string",
        enum: ["search_nodes", "get_node", "neighbors", "find_paths", "schema"],
      },
      query: { type: "string" },
      id: { type: "string" },
      start_id: { type: "string" },
      end_id: { type: "string" },
      max_depth: { type: "integer", minimum: 1, maximum: 4 },
      labels: { type: "array", items: { type: "string" } },
      properties: { type: "array", items: { type: "string" } },
      relationship_types: { type: "array", items: { type: "string" } },
      neighbor_labels: { type: "array", items: { type: "string" } },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    additionalProperties: false,
  },
};

function defaultToolEntry(name: string): AgentAuthoringTool {
  const catalog = getGlobalToolCatalogEntry(name);
  if (!catalog)
    throw new InvalidAuthoredToolError(`unknown_default_tool: ${name}`);
  return {
    name,
    description: catalog.description ?? catalog.summary,
    input_schema: DEFAULT_TOOL_INPUT_SCHEMAS[name] ?? {
      type: "object",
      additionalProperties: true,
    },
  };
}

function canonicalizeKnownToolEntry(
  tool: AgentAuthoringTool,
): AgentAuthoringTool {
  const canonicalSchema = DEFAULT_TOOL_INPUT_SCHEMAS[tool.name];
  return canonicalSchema
    ? { ...tool, input_schema: structuredClone(canonicalSchema) }
    : tool;
}

/**
 * Attach the reviewed execution-policy triple for a tool, sourced from the
 * global registry and converted to the manifest's snake_case shape. The
 * manifest schema requires this on every tool of a generated agent, and the
 * step engine reconciles the declared triple against the live registry before
 * dispatch (reviewedExecutionPolicy) — so the policy MUST come from the
 * registry, never be hand-authored, or dispatch throws on the mismatch. A tool
 * whose registry entry carries no reviewed policy fails closed here rather than
 * emitting an undeclared/unsafe tool binding.
 */
function withReviewedExecutionPolicy(tool: AgentAuthoringTool) {
  const policy = globalToolExecutionPolicy(tool.name);
  if (!policy) {
    throw new InvalidAuthoredToolError(
      `missing_execution_policy: ${tool.name} has no reviewed execution_policy in the global tool registry`,
    );
  }
  return {
    ...tool,
    execution_policy: {
      operation: policy.operation,
      effect_scope: policy.effectScope,
      sandbox_policy: policy.sandboxPolicy,
    },
  };
}

function resolveStepModels(
  input: DeployAuthoredAgentBody,
  selection: AgentModelSelection,
): AgentAuthoringStep[] | undefined {
  if (!input.steps) return undefined;
  const gateway = getLLMGateway();
  return input.steps.map((step) => {
    if (!step.provider || step.model || step.provider === selection.provider) {
      return step;
    }
    const stepSelection = resolveAgentModelSelection({
      template: input.template,
      description: step.description || input.description,
      provider: step.provider,
      defaultProvider: gateway.defaultProvider,
      defaultModel: gateway.defaultModel,
    });
    return { ...step, model: stepSelection.model };
  });
}

export function buildAuthoredManifestAgent(
  input: DeployAuthoredAgentBody,
  modelSelection: AgentModelSelection,
): AgentSpec {
  const id = agentId(input.name);
  const archetype = getAgentArchetypeSpec(input.template);
  const blueprint = buildAgentArchetypeRuntime({
    template: input.template,
    steps: resolveStepModels(input, modelSelection),
    retries: input.retries,
    timeoutS: input.timeoutS,
    searchMode: input.searchMode,
  });
  const hasLogic = blueprint.actions.some((action) => action.type === "logic");
  const hasManual = blueprint.actions.some(
    (action) => action.type === "manual",
  );
  const actors: Array<"Agent" | "Human"> = hasLogic
    ? hasManual
      ? input.template === "human"
        ? ["Human", "Agent"]
        : ["Agent", "Human"]
      : ["Agent"]
    : [archetype.actor];
  const selectedTools = input.toolUse.map(canonicalizeKnownToolEntry);
  for (const toolName of blueprint.defaultTools) {
    if (!selectedTools.some((tool) => tool.name === toolName)) {
      selectedTools.push(defaultToolEntry(toolName));
    }
  }
  for (const action of blueprint.actions) {
    if (action.type !== "tool") continue;
    const toolName = action.tool ?? action.name;
    if (selectedTools.some((tool) => tool.name === toolName)) continue;
    selectedTools.push(defaultToolEntry(toolName));
  }
  const seenTools = new Set<string>();
  for (const tool of selectedTools) {
    const normalized = tool.name.toLowerCase();
    if (seenTools.has(normalized)) {
      throw new Error(`duplicate_tool: ${tool.name}`);
    }
    seenTools.add(normalized);
  }

  return WorkflowManifestSchema.element.parse({
    id,
    name: input.name,
    title: input.title,
    description: input.description,
    actor: actors,
    trigger: input.triggers,
    trigger_bindings: Object.fromEntries(
      input.triggers.map((eventName) => [
        eventName,
        {
          // Leave `prompt` unbound so bindTriggerInputs can preserve an exact
          // chat/user prompt. Non-chat events use the prompt port default.
          payload: { path: "$" },
        },
      ]),
    ),
    inputs: [
      {
        id: "prompt",
        label: "Request",
        description:
          "Natural-language request supplied by chat or synthesized from the trigger event.",
        kind: "prompt",
        required: false,
        schema: { type: "string", minLength: 1 },
        default: `Process the incoming event as ${input.title}.`,
        sensitivity: "none",
      },
      {
        id: "payload",
        label: "Event payload",
        description: "The complete runtime-owned trigger event payload.",
        kind: "value",
        required: false,
        schema: { type: "object" },
        default: {},
        sensitivity: "confidential",
      },
    ],
    user_prompt_template: "Trigger payload:\n{{json inputs.payload}}",
    actions: blueprint.actions,
    outputs: blueprint.outputs,
    output_config: blueprint.outputConfig,
    triggered_event: input.emits,
    ontology_instructions: `${input.systemPrompt}\n\n${blueprint.instructions}`,
    tool_use: selectedTools.map(withReviewedExecutionPolicy),
    typescript_code: input.typescriptCode,
    generated: hasLogic,
    provider: modelSelection.provider,
    model: modelSelection.model,
    temperature: blueprint.temperature,
    retries: input.retries,
    timeout_s: input.timeoutS,
    concurrency: {
      enabled: true,
      max_concurrent_executions: input.concurrency,
    },
    tool_loop: blueprint.toolLoop,
    template: input.template,
    extensions: {
      authored_by: "new-agent-wizard",
      archetype_name: archetype.name,
      model_selection: modelSelection,
      ...(input.template === "rag"
        ? { search_mode: input.searchMode ?? "deep_research" }
        : {}),
    },
  });
}

/**
 * Event names in a workflow are enough for dispatch, but catalog-backed UI
 * also needs an `event_types` row. Agent authoring creates a conservative,
 * schema-less catalog entry for names that do not already exist; users can
 * enrich the metadata later without the deploy flow overwriting it.
 */
export function ensureAuthoredEventTypes(
  input: DeployAuthoredAgentBody,
  ctx: TenantCtx,
): string[] {
  const db = getDb();
  const existing = new Set(
    db
      .select({ name: eventTypes.name })
      .from(eventTypes)
      .where(eq(eventTypes.tenantId, ctx.tenantId))
      .all()
      .map((row) => row.name),
  );
  const desired = Array.from(new Set([...input.triggers, ...input.emits]));
  const created = desired.filter((name) => !existing.has(name));
  if (created.length === 0) return created;

  db.transaction(() => {
    for (const name of created) {
      db.insert(eventTypes)
        .values({
          tenantId: ctx.tenantId,
          name,
          category: "agent",
          description: `Created for ${input.title} in the agent deployment wizard.`,
          payloadJson: null,
        })
        .onConflictDoNothing()
        .run();
    }
  });
  return created;
}

const tenantDeployLocks = new Map<string, Promise<void>>();

async function withTenantDeployLock<T>(
  tenantId: string,
  work: () => Promise<T>,
): Promise<T> {
  const prior = tenantDeployLocks.get(tenantId) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(work);
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  tenantDeployLocks.set(tenantId, settled);
  try {
    return await run;
  } finally {
    if (tenantDeployLocks.get(tenantId) === settled) {
      tenantDeployLocks.delete(tenantId);
    }
  }
}

export async function deployAuthoredAgent(
  input: DeployAuthoredAgentBody,
  ctx: TenantCtx,
  auditCtx?: AuditCtx,
): Promise<DeployAuthoredAgentResponse> {
  return withTenantDeployLock(ctx.tenantId, async () => {
    validateToolBindings(input, ctx);
    const gateway = getLLMGateway();
    const modelSelection = resolveAgentModelSelection({
      template: input.template,
      description: input.description,
      provider: input.provider,
      model: input.model,
      defaultProvider: gateway.defaultProvider,
      defaultModel: gateway.defaultModel,
    });
    const current = loadLiveManifest(ctx);
    const authored = buildAuthoredManifestAgent(input, modelSelection);
    const identityConflict = findAuthoredAgentIdentityConflict(
      current,
      authored.name,
      authored.id,
    );
    if (identityConflict) {
      throw new DuplicateAuthoredAgentError(
        identityConflict.field,
        identityConflict.value,
      );
    }
    const next = WorkflowManifestSchema.parse([...current, authored]);
    const committed = await commit(
      {
        mode: "commit",
        workflow: next,
        target: "production",
        confirm_overwrite: false,
        conflict_resolutions: [],
        note: `Agent ${authored.name} deployed from the portal authoring wizard`,
      },
      ctx,
      auditCtx,
    );

    if (
      !committed.file_written ||
      committed.file_written.startsWith("(failed:")
    ) {
      throw new AuthoredAgentPersistenceError(
        `manifest persistence failed: ${committed.file_written || "no file path returned"}`,
      );
    }
    const createdEvents = ensureAuthoredEventTypes(input, ctx);
    const functionId = `${ctx.tenantSlug}.${authored.name}`;
    if (!isInngestFunctionRegistered(functionId)) {
      throw new AuthoredAgentRuntimeError(functionId);
    }
    return {
      agent: {
        id: authored.id,
        name: authored.name,
        title: authored.title ?? authored.name,
        template: input.template,
        provider: modelSelection.provider,
        model: modelSelection.model,
      },
      modelSelection,
      workflowVersionId: committed.workflow_version_id,
      version: committed.version,
      deploymentId: committed.deployment_id,
      fileWritten: committed.file_written,
      events: {
        created: createdEvents,
      },
      runtime: {
        functionId,
        registered: true,
        functionCount: listInngestFunctionIds().length,
      },
    };
  });
}
