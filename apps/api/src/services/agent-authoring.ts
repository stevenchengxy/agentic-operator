import { and, desc, eq } from "drizzle-orm";
import {
  deployments,
  eventTypes,
  getDb,
  workflowVersions,
  workflows,
} from "@agentic/db";
import type {
  DeployAuthoredAgentBody,
  DeployAuthoredAgentResponse,
  GenerateAgentPromptBody,
  GenerateAgentPromptResponse,
} from "@agentic/contracts";
import {
  WorkflowManifestSchema,
  type AgentSpec,
  type WorkflowManifest,
} from "@agentic/runtime";
import { getLLMGateway } from "./llm";
import {
  commit,
  type AuditCtx,
  type TenantCtx,
} from "./manifest-import";
import {
  isInngestFunctionRegistered,
  listInngestFunctionIds,
} from "./inngest-registry";
import { listGlobalTools } from "@agentic/tools";

const PROMPT_DESIGNER_SYSTEM = `You are a senior agent architect. Turn the supplied agent specification into a production-grade system prompt for an autonomous workflow agent.

Return only the final system prompt, with no preface and no Markdown code fence. Make it specific to the supplied description rather than generic boilerplate. The prompt must clearly define:
- role, mission, scope, and completion criteria;
- available event inputs and how to handle missing or malformed data;
- a concrete step-by-step operating procedure;
- when and how each declared tool may be used, including validation of tool results;
- required output quality and emitted-event expectations;
- safety, privacy, tenant isolation, and non-fabrication guardrails;
- error recovery, uncertainty handling, and when to request human review.

Do not invent credentials, private data, tools, or business rules that are not present in the specification. Treat the description as the source of domain requirements.`;

function stripOuterCodeFence(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  return (match?.[1] ?? trimmed).trim();
}

export async function generateAgentSystemPrompt(
  input: GenerateAgentPromptBody,
  ctx: TenantCtx,
): Promise<GenerateAgentPromptResponse> {
  const gateway = getLLMGateway();
  const response = await gateway.chat({
    provider: input.provider,
    model: input.model,
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    temperature: 0.2,
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
              actor: input.actor,
              template: input.template,
              workflow_stage: input.stage,
              trigger_events: input.triggers,
              emitted_events: input.emits,
              tools: input.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.input_schema,
              })),
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
    super(`deployed manifest but runtime function ${functionId} is not registered`);
    this.name = "AuthoredAgentRuntimeError";
  }
}

export class InvalidAuthoredToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthoredToolError";
  }
}

function validateToolBindings(input: DeployAuthoredAgentBody, ctx: TenantCtx): void {
  const catalog = new Map(listGlobalTools().map((tool) => [tool.name, tool]));
  const tenantKeyPrefix = ctx.tenantSlug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  for (const tool of input.toolUse) {
    const entry = catalog.get(tool.name);
    if (!entry) {
      throw new InvalidAuthoredToolError(`unknown_tool: ${tool.name}`);
    }
    const config = tool.config;
    if (!config) continue;
    const allowedKeys = new Set(Object.keys(entry.configSchema ?? {}));
    for (const key of Object.keys(config)) {
      if (!allowedKeys.has(key)) {
        throw new InvalidAuthoredToolError(`unknown_tool_config: ${tool.name}.${key}`);
      }
    }
    if ("api_key" in config) {
      throw new InvalidAuthoredToolError(
        `literal_secret_forbidden: ${tool.name}.api_key must use a tenant integration or tenant-scoped api_key_env`,
      );
    }
    const envName = config.api_key_env;
    if (
      typeof envName === "string" &&
      !envName.startsWith(`TENANT_${tenantKeyPrefix}_`) &&
      !envName.startsWith(`${tenantKeyPrefix}_`)
    ) {
      throw new InvalidAuthoredToolError(
        `tenant_secret_scope: ${tool.name}.api_key_env must be prefixed for tenant ${ctx.tenantSlug}`,
      );
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
  }
}

function agentId(stage: number, name: string): string {
  const kebab = name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Za-z])(\d+)/g, "$1-$2")
    .replace(/(\d+)([A-Za-z])/g, "$1-$2")
    .toLowerCase();
  return `${stage}-${kebab}`;
}

function loadLiveManifest(ctx: TenantCtx): WorkflowManifest {
  const row = getDb()
    .select({ manifest: workflowVersions.manifestJson })
    .from(deployments)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, deployments.versionId),
    )
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

function toManifestAgent(input: DeployAuthoredAgentBody): AgentSpec {
  const id = agentId(input.stage, input.name);
  const actionName = `${input.name}${input.actor === "Human" ? "Review" : "Execute"}`;
  const selectedTools = [...input.toolUse];
  if (
    input.actor === "Human" &&
    !selectedTools.some((tool) => tool.name.toLowerCase().includes("taskdefinition"))
  ) {
    selectedTools.push({
      name: "taskDefinition",
      description: "Defines the operator task created by this human-review step.",
      input_schema: { type: "object", additionalProperties: true },
    });
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
    actor: [input.actor],
    trigger: input.triggers,
    actions: [
      {
        order: "1",
        name: actionName,
        description: input.description,
        type: input.actor === "Human" ? "manual" : "logic",
        ...(input.actor === "Human" ? { task_type: "approval" } : {}),
        retries: input.retries,
        timeout_s: input.timeoutS,
      },
    ],
    triggered_event: input.emits,
    ontology_instructions: input.systemPrompt,
    tool_use: selectedTools,
    typescript_code: input.typescriptCode,
    generated: input.actor === "Agent",
    provider: input.provider,
    model: input.model,
    retries: input.retries,
    timeout_s: input.timeoutS,
    concurrency: {
      enabled: true,
      max_concurrent_executions: input.concurrency,
    },
    template: input.template,
    stage: input.stage,
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
    const current = loadLiveManifest(ctx);
    const authored = toManifestAgent(input);
    const duplicateName = current.find(
      (agent) => agent.name.toLowerCase() === authored.name.toLowerCase(),
    );
    if (duplicateName) {
      throw new DuplicateAuthoredAgentError("name", authored.name);
    }
    if (current.some((agent) => agent.id === authored.id)) {
      throw new DuplicateAuthoredAgentError("id", authored.id);
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

    if (!committed.file_written || committed.file_written.startsWith("(failed:")) {
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
      },
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
