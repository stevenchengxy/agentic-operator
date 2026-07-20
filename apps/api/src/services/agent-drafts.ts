import { createHash } from "node:crypto";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import {
  agentDraftRevisions,
  agentDrafts,
  agents,
  agentVersions,
  deployments,
  eventListeners,
  eventTypes,
  getDb,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  AgentDefinitionV2Schema,
  type AgentDefinitionV2,
  type AgentDraftRecord,
  type AgentDraftRevision,
  type AgentDraftSummary,
  type AgentEditorResponse,
  type AgentDefinitionDiffEntry,
  type AgentValidationIssue,
  type AgentValidationResult,
  type AgentVersionDetail,
  type AgentVersionDiffResponse,
  type GenerateDraftInstructionsBody,
  type GenerateDraftInstructionsResponse,
  type WorkflowAgentPromptBody,
  type WorkflowAgentPromptResponse,
  type ListAgentVersionsResponse,
  type PublishAgentDraftBody,
  type PublishAgentDraftResponse,
  normalizeAgentDefinition,
} from "@agentic/contracts";
import { listGlobalTools } from "@agentic/tools";
import {
  resolveRestrictedJsonPath,
  validateAgentUserPromptTemplate,
  validateJsonSchemaDocument,
} from "@agentic/runtime";
import type { AuthedContext } from "../plugins/auth";
import { getLLMGateway } from "./llm";
import { BlockingIssuesError, commit, type AuditCtx } from "./manifest-import";
import { isInngestFunctionRegistered } from "./inngest-registry";

type DraftRow = typeof agentDrafts.$inferSelect;
type AgentRow = typeof agents.$inferSelect;
type AgentIdentity = Pick<
  AgentRow,
  "id" | "kebabId" | "name" | "title" | "actor" | "kind"
>;

export function definitionHash(definition: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalizeJson(definition)))
    .digest("hex")}`;
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalizeJson(nested)]),
  );
}

function validationIssues(row: DraftRow): AgentValidationIssue[] {
  if (!Array.isArray(row.validationJson)) return [];
  return row.validationJson as AgentValidationIssue[];
}

function draftSummary(row: DraftRow): AgentDraftSummary {
  return {
    id: row.id,
    tenantId: row.tenantId,
    workflowId: row.workflowId,
    agentId: row.agentId,
    baseAgentVersionId: row.baseAgentVersionId,
    baseWorkflowVersionId: row.baseWorkflowVersionId,
    definitionHash: row.contentHash,
    schemaVersion: 2,
    revision: row.revision,
    validationStatus: row.validationStatus,
    validatedHash: row.validatedHash,
    createdBy: row.createdBy,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function draftRecord(row: DraftRow): AgentDraftRecord {
  return {
    ...draftSummary(row),
    definition: AgentDefinitionV2Schema.parse(row.definitionJson),
    validation: {
      status: row.validationStatus,
      validatedHash: row.validatedHash,
      issues: validationIssues(row),
    },
  };
}

function draftRevisionRecord(
  row: typeof agentDraftRevisions.$inferSelect,
): AgentDraftRevision {
  return {
    id: row.id,
    draftId: row.draftId,
    revision: row.revision,
    definition: AgentDefinitionV2Schema.parse(row.definitionJson),
    definitionHash: row.contentHash,
    schemaVersion: 2,
    reason: row.reason,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}

export class AgentStudioNotFoundError extends Error {
  constructor(public readonly resource: "agent" | "draft" | "version") {
    super(`${resource} not found`);
    this.name = "AgentStudioNotFoundError";
  }
}

export class AgentStudioWorkflowNotFoundError extends Error {
  constructor(public readonly workflowSlug: string) {
    super(`workflow not found: ${workflowSlug}`);
    this.name = "AgentStudioWorkflowNotFoundError";
  }
}

export class DraftBaseWorkflowVersionError extends Error {
  constructor(
    public readonly versionId: string,
    public readonly reason:
      | "not_found"
      | "workflow_mismatch"
      | "agent_mismatch",
  ) {
    super(
      "base workflow version is not valid for the selected workflow and agent",
    );
    this.name = "DraftBaseWorkflowVersionError";
  }
}

export class DraftRevisionConflictError extends Error {
  constructor(public readonly current: AgentDraftRecord) {
    super("draft revision conflict");
    this.name = "DraftRevisionConflictError";
  }
}

export class DraftPublishConflictError extends Error {
  constructor(
    public readonly baseWorkflowVersionId: string | null,
    public readonly liveWorkflowVersionId: string | null,
  ) {
    super("the live version of this agent changed after the draft was created");
    this.name = "DraftPublishConflictError";
  }
}

export class DraftValidationError extends Error {
  constructor(public readonly validation: AgentValidationResult) {
    super("draft has blocking validation issues");
    this.name = "DraftValidationError";
  }
}

export class DraftImpactConfirmationError extends Error {
  constructor(public readonly impacts: string[]) {
    super("publishing this draft requires explicit impact confirmation");
    this.name = "DraftImpactConfirmationError";
  }
}

export class DraftIdentityError extends Error {
  constructor(
    public readonly expectedId: string,
    public readonly receivedId: string,
  ) {
    super(
      `agent id is immutable after creation (expected '${expectedId}', received '${receivedId}')`,
    );
    this.name = "DraftIdentityError";
  }
}

export class AgentStudioReadOnlyError extends Error {
  constructor(public readonly reason: "code_agent" | "archived_agent") {
    super(
      reason === "code_agent"
        ? "code-defined agents cannot be converted or published as manifest agents in place"
        : "archived agents cannot be edited or published",
    );
    this.name = "AgentStudioReadOnlyError";
  }
}

function assertManifestAgentEditable(agent: AgentRow): void {
  if (agent.lifecycle === "archived") {
    throw new AgentStudioReadOnlyError("archived_agent");
  }
  if (agent.kind !== "manifest") {
    throw new AgentStudioReadOnlyError("code_agent");
  }
}

function assertDraftIdentity(
  definition: AgentDefinitionV2,
  agent: AgentRow,
): void {
  if (definition.id !== agent.kebabId) {
    throw new DraftIdentityError(agent.kebabId, definition.id);
  }
}

function compatibilityExtensions(
  value: unknown,
  mode: "v1" | "historical" | "generated" | "code",
  source: string,
): Record<string, unknown> {
  const current =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    ...current,
    compatibility_mode: current.compatibility_mode ?? mode,
    compatibility_source: source,
  };
}

/** Normalize legacy JSON while anchoring it to the immutable DB identity. */
export function normalizeAgentDefinitionForIdentity(
  input: unknown,
  agent: AgentIdentity,
  compatibility?: {
    mode: "v1" | "historical" | "generated" | "code";
    source: string;
  },
): AgentDefinitionV2 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("legacy agent definition must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  const actor = Array.isArray(raw.actor)
    ? raw.actor
    : raw.actor === "Agent" || raw.actor === "Human"
      ? [raw.actor]
      : [agent.actor];
  const definition = normalizeAgentDefinition({
    ...raw,
    id:
      raw.id === undefined || raw.id === null || raw.id === ""
        ? agent.kebabId
        : raw.id,
    name:
      raw.name === undefined || raw.name === null || raw.name === ""
        ? agent.name
        : raw.name,
    title:
      raw.title === undefined || raw.title === null || raw.title === ""
        ? (agent.title ?? agent.name)
        : raw.title,
    actor,
    ...(compatibility
      ? {
          extensions: compatibilityExtensions(
            raw.extensions,
            compatibility.mode,
            compatibility.source,
          ),
        }
      : {}),
  });
  if (definition.id !== agent.kebabId) {
    throw new DraftIdentityError(agent.kebabId, definition.id);
  }
  return definition;
}

/** Safe editable starting point when no historical definition can be found. */
export function synthesizeAgentDefinition(
  agent: AgentIdentity,
  triggers: string[] = [],
): AgentDefinitionV2 {
  const human = agent.actor === "Human";
  const title = agent.title ?? agent.name;
  return AgentDefinitionV2Schema.parse({
    id: agent.kebabId,
    name: agent.name,
    title,
    description: human
      ? `Collect a human response for ${title}.`
      : `Complete requests handled by ${title}.`,
    actor: [agent.actor],
    template: human ? "human" : "blank",
    trigger: [...new Set(triggers)],
    inputs: [
      {
        id: "prompt",
        label: human ? "Task request" : "Request",
        description: human
          ? "Describe the decision or work the operator must complete."
          : "Describe what you want the agent to do.",
        kind: "prompt",
        required: true,
        schema: { type: "string", minLength: 1 },
        sensitivity: "none",
      },
      {
        id: "payload",
        label: "Additional information",
        description: "Optional structured context from an event, API, or form.",
        kind: "value",
        required: false,
        schema: { type: "object" },
        default: {},
        sensitivity: "none",
      },
    ],
    ontology_instructions: human
      ? undefined
      : `You are ${title}. Complete the user's request using only the supplied information. If required information is missing, explain what is needed. Return a concise result that matches the declared output.`,
    user_prompt_template: "Additional information:\n{{json inputs.payload}}",
    tool_use: [],
    actions: [
      human
        ? {
            id: "complete-task",
            order: "1",
            name: "completeTask",
            description: "Ask an operator to complete the requested work.",
            type: "manual",
            task_type: "review",
            awaiting_role: "operator",
          }
        : {
            id: "complete-request",
            order: "1",
            name: "completeRequest",
            description: "Use the AI model to complete the request.",
            type: "logic",
          },
    ],
    outputs: [
      {
        id: "result",
        label: "Result",
        description: "The completed result returned by this agent.",
        required: true,
        schema: {},
        sensitivity: "none",
      },
    ],
    output_config: {
      format: "json",
      strict: false,
      repair_attempts: 0,
      unwrap_single_output: false,
      artifact: {
        filename: "output.json",
        persist_individual_outputs: false,
        persist_run_input: true,
        persist_run_record: true,
        persist_raw_response: false,
      },
    },
    triggered_event: [],
    generated: true,
    prompt_provenance: { mode: "imported" },
    extensions: compatibilityExtensions(
      undefined,
      "generated",
      "agent-identity",
    ),
  });
}

function completeActionlessCompatibilityDefinition(
  definition: AgentDefinitionV2,
): AgentDefinitionV2 {
  if (definition.actions.length > 0) return definition;
  const human = definition.actor.includes("Human");
  const generatedFields = Array.isArray(
    definition.extensions?.compatibility_generated_fields,
  )
    ? definition.extensions.compatibility_generated_fields.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  return AgentDefinitionV2Schema.parse({
    ...definition,
    generated: true,
    ontology_instructions:
      human || definition.ontology_instructions?.trim()
        ? definition.ontology_instructions
        : `You are ${definition.title ?? definition.name}. Complete the user's request using only the supplied information. If required information is missing, explain what is needed. Return a result that matches the declared output.`,
    actions: [
      human
        ? {
            id: "complete-task",
            order: "1",
            name: "completeTask",
            description: "Ask an operator to complete the requested work.",
            type: "manual",
            task_type: "review",
            awaiting_role: "operator",
          }
        : {
            id: "complete-request",
            order: "1",
            name: "completeRequest",
            description: "Use the AI model to complete the request.",
            action_prompt:
              "Complete the requested work and return the declared outputs.",
            type: "logic",
          },
    ],
    extensions: {
      ...definition.extensions,
      compatibility_generated_fields: [
        ...new Set([...generatedFields, "actions"]),
      ],
    },
  });
}

function agentPredicate(ref: string) {
  return or(eq(agents.id, ref), eq(agents.kebabId, ref), eq(agents.name, ref))!;
}

export function findStudioAgent(
  ctx: Pick<AuthedContext, "tenantId">,
  ref: string,
): AgentRow | null {
  const row = getDb()
    .select({ agent: agents })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(and(eq(workflows.tenantId, ctx.tenantId), agentPredicate(ref)))
    .limit(1)
    .all()[0];
  return row?.agent ?? null;
}

function findStudioAgentById(
  ctx: Pick<AuthedContext, "tenantId">,
  agentId: string,
): AgentRow | null {
  const row = getDb()
    .select({ agent: agents })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(and(eq(workflows.tenantId, ctx.tenantId), eq(agents.id, agentId)))
    .limit(1)
    .all()[0];
  return row?.agent ?? null;
}

function findStudioWorkflow(
  ctx: Pick<AuthedContext, "tenantId">,
  slug: string,
): typeof workflows.$inferSelect | null {
  return (
    getDb()
      .select()
      .from(workflows)
      .where(
        and(eq(workflows.tenantId, ctx.tenantId), eq(workflows.slug, slug)),
      )
      .limit(1)
      .all()[0] ?? null
  );
}

function findStudioAgentInWorkflow(
  ctx: Pick<AuthedContext, "tenantId">,
  ref: string,
  workflowId: string,
): AgentRow | null {
  const row = getDb()
    .select({ agent: agents })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .where(
      and(
        eq(workflows.tenantId, ctx.tenantId),
        eq(workflows.id, workflowId),
        agentPredicate(ref),
      ),
    )
    .limit(1)
    .all()[0];
  return row?.agent ?? null;
}

function resolveStudioAgent(
  ctx: Pick<AuthedContext, "tenantId">,
  ref: string,
  workflowSlug?: string,
): AgentRow | null {
  if (!workflowSlug) return findStudioAgent(ctx, ref);
  const workflow = findStudioWorkflow(ctx, workflowSlug);
  if (!workflow) throw new AgentStudioWorkflowNotFoundError(workflowSlug);
  return findStudioAgentInWorkflow(ctx, ref, workflow.id);
}

function assertBaseWorkflowVersionContext(
  ctx: Pick<AuthedContext, "tenantId">,
  versionId: string,
  agent: Pick<AgentRow, "workflowId" | "kebabId" | "name">,
): void {
  const version = getDb()
    .select({
      workflowId: workflowVersions.workflowId,
      manifest: workflowVersions.manifestJson,
    })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(workflowVersions.id, versionId),
        eq(workflows.tenantId, ctx.tenantId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!version) {
    throw new DraftBaseWorkflowVersionError(versionId, "not_found");
  }
  if (version.workflowId !== agent.workflowId) {
    throw new DraftBaseWorkflowVersionError(versionId, "workflow_mismatch");
  }
  if (!findRawAgent(version.manifest, agent)) {
    throw new DraftBaseWorkflowVersionError(versionId, "agent_mismatch");
  }
}

interface LiveAgentSnapshot {
  agentVersionId: string;
  workflowVersionId: string;
  version: string;
  definition: AgentDefinitionV2;
  definitionHash: string;
  publishedAt: Date | null;
  manifest: unknown;
}

interface LiveWorkflowSnapshot {
  workflowVersionId: string;
  version: string;
  manifest: unknown;
}

function getLiveWorkflowSnapshot(
  ctx: Pick<AuthedContext, "tenantId">,
  workflowId: string,
): LiveWorkflowSnapshot | null {
  return (
    getDb()
      .select({
        workflowVersionId: workflowVersions.id,
        version: workflowVersions.version,
        manifest: workflowVersions.manifestJson,
      })
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
          eq(workflows.id, workflowId),
        ),
      )
      .orderBy(desc(deployments.deployedAt))
      .limit(1)
      .all()[0] ?? null
  );
}

function getLatestWorkflowSnapshot(
  ctx: Pick<AuthedContext, "tenantId">,
  workflowId: string,
): LiveWorkflowSnapshot | null {
  return (
    getDb()
      .select({
        workflowVersionId: workflowVersions.id,
        version: workflowVersions.version,
        manifest: workflowVersions.manifestJson,
      })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(
        and(eq(workflows.tenantId, ctx.tenantId), eq(workflows.id, workflowId)),
      )
      .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
      .limit(1)
      .all()[0] ?? null
  );
}

function getAuthoringWorkflowSnapshot(
  ctx: Pick<AuthedContext, "tenantId">,
  workflowId: string,
): LiveWorkflowSnapshot | null {
  return (
    getLiveWorkflowSnapshot(ctx, workflowId) ??
    getLatestWorkflowSnapshot(ctx, workflowId)
  );
}

export function getLiveAgentSnapshot(
  ctx: Pick<AuthedContext, "tenantId">,
  agentId: string,
): LiveAgentSnapshot | null {
  const db = getDb();
  const row = db
    .select({
      agentVersionId: agentVersions.id,
      workflowVersionId: workflowVersions.id,
      version: workflowVersions.version,
      definition: agentVersions.manifestJson,
      contentHash: agentVersions.contentHash,
      publishedAt: agentVersions.publishedAt,
      manifest: workflowVersions.manifestJson,
      agentKebabId: agents.kebabId,
      agentName: agents.name,
      agentTitle: agents.title,
      agentActor: agents.actor,
      agentKind: agents.kind,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .innerJoin(
      agentVersions,
      eq(agentVersions.workflowVersionId, workflowVersions.id),
    )
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
        eq(workflows.tenantId, ctx.tenantId),
        eq(agentVersions.agentId, agentId),
        eq(agents.kind, "manifest"),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .limit(1)
    .all()[0];
  if (row) {
    const identity: AgentIdentity = {
      id: agentId,
      kebabId: row.agentKebabId,
      name: row.agentName,
      title: row.agentTitle,
      actor: row.agentActor,
      kind: row.agentKind,
    };
    let definition: AgentDefinitionV2 | null = null;
    try {
      definition = normalizeAgentDefinitionForIdentity(
        row.definition,
        identity,
      );
    } catch {
      const exact = findRawAgent(row.manifest, {
        kebabId: row.agentKebabId,
        name: row.agentName,
      });
      if (!exact) return null;
      definition = normalizeAgentDefinitionForIdentity(exact, identity, {
        mode: "v1",
        source: "live-workflow-manifest",
      });
    }
    if (!definition) return null;
    return {
      agentVersionId: row.agentVersionId,
      workflowVersionId: row.workflowVersionId,
      version: row.version,
      definition,
      definitionHash: row.contentHash ?? definitionHash(definition),
      publishedAt: row.publishedAt,
      manifest: row.manifest,
    };
  }

  // Older imports could create the workflow/agent identity and a live
  // workflow version without materialising every corresponding
  // agent_versions row. Agent Studio needs a real immutable version id for
  // draft bases and pinned runs, so repair that legacy gap lazily from the
  // exact live workflow manifest. This is deterministic and protected by the
  // existing (agent_id, workflow_version_id) unique index.
  const legacy = db
    .select({
      workflowVersionId: workflowVersions.id,
      version: workflowVersions.version,
      workflowCreatedAt: workflowVersions.createdAt,
      manifest: workflowVersions.manifestJson,
      deployedAt: deployments.deployedAt,
      agentKebabId: agents.kebabId,
      agentName: agents.name,
      agentTitle: agents.title,
      agentActor: agents.actor,
      agentKind: agents.kind,
    })
    .from(deployments)
    .innerJoin(workflowVersions, eq(workflowVersions.id, deployments.versionId))
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .innerJoin(agents, eq(agents.workflowId, workflows.id))
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
        eq(workflows.tenantId, ctx.tenantId),
        eq(agents.id, agentId),
        eq(agents.kind, "manifest"),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .limit(1)
    .all()[0];
  if (legacy) {
    const rawDefinition = findRawAgent(legacy.manifest, {
      kebabId: legacy.agentKebabId,
      name: legacy.agentName,
    });
    if (rawDefinition) {
      const definition = normalizeAgentDefinitionForIdentity(
        rawDefinition,
        {
          id: agentId,
          kebabId: legacy.agentKebabId,
          name: legacy.agentName,
          title: legacy.agentTitle,
          actor: legacy.agentActor,
          kind: legacy.agentKind,
        },
        { mode: "v1", source: "live-workflow-manifest" },
      );
      const contentHash = definitionHash(definition);
      const versionId = makeId("agv");
      db.insert(agentVersions)
        .values({
          id: versionId,
          agentId,
          workflowVersionId: legacy.workflowVersionId,
          manifestJson: definition as unknown as object,
          definitionSchemaVersion: 2,
          contentHash,
          publishedAt: legacy.deployedAt,
          changeNote: "Agent Studio compatibility snapshot",
          createdAt: legacy.workflowCreatedAt,
          updatedAt: legacy.deployedAt,
        })
        .onConflictDoNothing()
        .run();
      const repaired = db
        .select({
          id: agentVersions.id,
          contentHash: agentVersions.contentHash,
          publishedAt: agentVersions.publishedAt,
        })
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.agentId, agentId),
            eq(agentVersions.workflowVersionId, legacy.workflowVersionId),
          ),
        )
        .limit(1)
        .all()[0];
      if (repaired) {
        return {
          agentVersionId: repaired.id,
          workflowVersionId: legacy.workflowVersionId,
          version: legacy.version,
          definition,
          definitionHash: repaired.contentHash ?? contentHash,
          publishedAt: repaired.publishedAt,
          manifest: legacy.manifest,
        };
      }
    }
  }

  // Code deployments point directly at agent_versions rather than at a
  // workflow version. Expose a normalized, read-only compatibility view, but
  // never publish it as a manifest because code behavior cannot be inferred.
  const code = db
    .select({
      agentVersionId: agentVersions.id,
      workflowVersionId: workflowVersions.id,
      version: workflowVersions.version,
      definition: agentVersions.manifestJson,
      contentHash: agentVersions.contentHash,
      publishedAt: agentVersions.publishedAt,
      deployedAt: deployments.deployedAt,
      manifest: workflowVersions.manifestJson,
      agentKebabId: agents.kebabId,
      agentName: agents.name,
      agentTitle: agents.title,
      agentActor: agents.actor,
      agentKind: agents.kind,
    })
    .from(deployments)
    .innerJoin(agentVersions, eq(agentVersions.id, deployments.versionId))
    .innerJoin(agents, eq(agents.id, agentVersions.agentId))
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, agentVersions.workflowVersionId),
    )
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(deployments.tenantId, ctx.tenantId),
        eq(deployments.target, "code_agent"),
        eq(deployments.status, "live"),
        eq(workflows.tenantId, ctx.tenantId),
        eq(agentVersions.agentId, agentId),
        eq(agents.kind, "code"),
      ),
    )
    .orderBy(desc(deployments.deployedAt))
    .limit(1)
    .all()[0];
  const codeVersion =
    code ??
    db
      .select({
        agentVersionId: agentVersions.id,
        workflowVersionId: workflowVersions.id,
        version: workflowVersions.version,
        definition: agentVersions.manifestJson,
        contentHash: agentVersions.contentHash,
        publishedAt: agentVersions.publishedAt,
        deployedAt: agentVersions.publishedAt,
        manifest: workflowVersions.manifestJson,
        agentKebabId: agents.kebabId,
        agentName: agents.name,
        agentTitle: agents.title,
        agentActor: agents.actor,
        agentKind: agents.kind,
      })
      .from(agentVersions)
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .innerJoin(
        workflowVersions,
        eq(workflowVersions.id, agentVersions.workflowVersionId),
      )
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(
        and(
          eq(workflows.tenantId, ctx.tenantId),
          eq(agentVersions.agentId, agentId),
          eq(agents.kind, "code"),
        ),
      )
      .orderBy(desc(agentVersions.createdAt), desc(agentVersions.id))
      .limit(1)
      .all()[0];
  if (!codeVersion) return null;
  const definition = normalizeAgentDefinitionForIdentity(
    codeVersion.definition,
    {
      id: agentId,
      kebabId: codeVersion.agentKebabId,
      name: codeVersion.agentName,
      title: codeVersion.agentTitle,
      actor: codeVersion.agentActor,
      kind: codeVersion.agentKind,
    },
    { mode: "code", source: "code-agent-metadata" },
  );
  return {
    agentVersionId: codeVersion.agentVersionId,
    workflowVersionId: codeVersion.workflowVersionId,
    version: codeVersion.version,
    definition,
    definitionHash: codeVersion.contentHash ?? definitionHash(definition),
    publishedAt: codeVersion.publishedAt ?? codeVersion.deployedAt,
    manifest: codeVersion.manifest,
  };
}

interface LegacyDefinitionSource {
  definition: AgentDefinitionV2;
  agentVersionId: string | null;
  workflowVersionId: string | null;
}

function getLatestLegacyDefinitionSource(
  ctx: Pick<AuthedContext, "tenantId">,
  agent: AgentRow,
): LegacyDefinitionSource | null {
  let partial: LegacyDefinitionSource | null = null;
  const preferRunnable = (
    candidate: LegacyDefinitionSource,
  ): LegacyDefinitionSource | null => {
    if (candidate.definition.actions.length > 0) return candidate;
    partial ??= candidate;
    return null;
  };
  const versionRows = getDb()
    .select({
      agentVersionId: agentVersions.id,
      workflowVersionId: workflowVersions.id,
      definition: agentVersions.manifestJson,
      workflowManifest: workflowVersions.manifestJson,
    })
    .from(agentVersions)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, agentVersions.workflowVersionId),
    )
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(workflows.tenantId, ctx.tenantId),
        eq(workflows.id, agent.workflowId),
        eq(agentVersions.agentId, agent.id),
      ),
    )
    .orderBy(
      desc(agentVersions.createdAt),
      desc(workflowVersions.createdAt),
      desc(agentVersions.id),
    )
    .all();

  for (const row of versionRows) {
    try {
      const candidate = {
        definition: normalizeAgentDefinitionForIdentity(row.definition, agent, {
          mode: "historical",
          source: "historical-agent-version",
        }),
        agentVersionId: row.agentVersionId,
        workflowVersionId: row.workflowVersionId,
      };
      const runnable = preferRunnable(candidate);
      if (runnable) return runnable;
    } catch {
      const exact = findRawAgent(row.workflowManifest, agent);
      if (!exact) continue;
      try {
        const candidate = {
          definition: normalizeAgentDefinitionForIdentity(exact, agent, {
            mode: "historical",
            source: "historical-workflow-manifest",
          }),
          agentVersionId: row.agentVersionId,
          workflowVersionId: row.workflowVersionId,
        };
        const runnable = preferRunnable(candidate);
        if (runnable) return runnable;
      } catch {
        // Continue to an older unambiguous snapshot.
      }
    }
  }

  const workflowRows = getDb()
    .select({
      workflowVersionId: workflowVersions.id,
      manifest: workflowVersions.manifestJson,
      actions: workflowVersions.actionsJson,
    })
    .from(workflowVersions)
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(workflows.tenantId, ctx.tenantId),
        eq(workflows.id, agent.workflowId),
      ),
    )
    .orderBy(desc(workflowVersions.createdAt), desc(workflowVersions.id))
    .all();

  for (const row of workflowRows) {
    const candidates: Array<{
      value: Record<string, unknown> | null;
      source: string;
    }> = [
      {
        value: findRawAgent(row.manifest, agent),
        source: "historical-workflow-manifest",
      },
      {
        value: findRawAgent(row.actions, agent),
        source: "legacy-action-catalog",
      },
    ];
    for (const candidate of candidates) {
      if (!candidate.value) continue;
      try {
        const source = {
          definition: normalizeAgentDefinitionForIdentity(
            candidate.value,
            agent,
            { mode: "historical", source: candidate.source },
          ),
          agentVersionId: null,
          workflowVersionId: row.workflowVersionId,
        };
        const runnable = preferRunnable(source);
        if (runnable) return runnable;
      } catch {
        // Try the next unambiguous compatibility source.
      }
    }
  }

  return partial;
}

function compatibilityTriggers(agentId: string): string[] {
  return getDb()
    .select({ name: eventListeners.eventName })
    .from(eventListeners)
    .where(eq(eventListeners.agentId, agentId))
    .all()
    .map((row) => row.name)
    .sort();
}

function getLatestDraftRow(tenantId: string, agentId: string): DraftRow | null {
  return (
    getDb()
      .select()
      .from(agentDrafts)
      .where(
        and(
          eq(agentDrafts.tenantId, tenantId),
          eq(agentDrafts.agentId, agentId),
          isNull(agentDrafts.deletedAt),
        ),
      )
      .orderBy(desc(agentDrafts.updatedAt))
      .limit(1)
      .all()[0] ?? null
  );
}

export function getDraft(
  ctx: Pick<AuthedContext, "tenantId">,
  draftId: string,
): AgentDraftRecord {
  const row = getDb()
    .select()
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.tenantId, ctx.tenantId),
        eq(agentDrafts.id, draftId),
        isNull(agentDrafts.deletedAt),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) throw new AgentStudioNotFoundError("draft");
  return draftRecord(row);
}

export function getAgentEditor(
  ctx: AuthedContext,
  agentRef: string,
  requestedDraftId?: string,
): AgentEditorResponse {
  // A handoff URL carries both the human-readable agent ref and an immutable
  // draft id. Resolve the tenant-owned draft first so duplicate kebab ids in
  // different workflows cannot make an arbitrary tenant-wide lookup select
  // the wrong agent.
  const requestedDraft = requestedDraftId
    ? getDraft(ctx, requestedDraftId)
    : null;
  const agent = requestedDraft
    ? findStudioAgentById(ctx, requestedDraft.agentId)
    : findStudioAgent(ctx, agentRef);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  if (
    requestedDraft &&
    (requestedDraft.workflowId !== agent.workflowId ||
      (agentRef !== agent.id &&
        agentRef !== agent.kebabId &&
        agentRef !== agent.name))
  ) {
    throw new AgentStudioNotFoundError("draft");
  }
  const live = getLiveAgentSnapshot(ctx, agent.id);
  let selectedDraft = requestedDraft
    ? requestedDraft
    : (() => {
        const row = getLatestDraftRow(ctx.tenantId, agent.id);
        return row ? draftRecord(row) : null;
      })();
  if (selectedDraft && selectedDraft.agentId !== agent.id) {
    throw new AgentStudioNotFoundError("draft");
  }
  // Materialize a safe current-format draft only when an editable manifest
  // agent has no live definition at all. The draft remains unvalidated and
  // unpublished so an operator must review it before it can affect runtime.
  if (
    !requestedDraftId &&
    !live &&
    !selectedDraft &&
    agent.kind === "manifest" &&
    agent.lifecycle !== "archived"
  ) {
    selectedDraft = createAgentDraft(ctx, agent.id, {});
  }
  const studioRunnable =
    agent.kind === "manifest" &&
    agent.lifecycle !== "archived" &&
    Boolean(live || selectedDraft);
  return {
    agent: {
      id: agent.id,
      kebabId: agent.kebabId,
      name: agent.name,
      title: agent.title,
      actor: agent.actor,
      kind: agent.kind,
      enabled: agent.enabled,
      lifecycle: agent.lifecycle,
    },
    live: live
      ? {
          agentVersionId: live.agentVersionId,
          workflowVersionId: live.workflowVersionId,
          version: live.version,
          definition: live.definition,
          definitionHash: live.definitionHash,
          publishedAt: live.publishedAt,
        }
      : null,
    draft: selectedDraft,
    capabilities: {
      canEdit: agent.kind === "manifest" && agent.lifecycle !== "archived",
      canRun: studioRunnable,
      canPublish: agent.kind === "manifest" && agent.lifecycle !== "archived",
    },
  };
}

export function createAgentDraft(
  ctx: AuthedContext,
  agentRef: string,
  input: {
    definition?: AgentDefinitionV2;
    workflowSlug?: string;
    baseAgentVersionId?: string;
    baseWorkflowVersionId?: string;
  },
): AgentDraftRecord {
  const agent = resolveStudioAgent(ctx, agentRef, input.workflowSlug);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  assertManifestAgentEditable(agent);

  if (input.baseWorkflowVersionId) {
    assertBaseWorkflowVersionContext(ctx, input.baseWorkflowVersionId, agent);
  }

  if (
    !input.definition &&
    !input.baseAgentVersionId &&
    !input.baseWorkflowVersionId
  ) {
    const existing = getLatestDraftRow(ctx.tenantId, agent.id);
    if (existing) return draftRecord(existing);
  }

  const live = getLiveAgentSnapshot(ctx, agent.id);
  const historical =
    !input.definition && !live
      ? getLatestLegacyDefinitionSource(ctx, agent)
      : null;
  const authoringWorkflow = getAuthoringWorkflowSnapshot(ctx, agent.workflowId);
  const parsedDefinition = AgentDefinitionV2Schema.parse(
    input.definition ??
      live?.definition ??
      historical?.definition ??
      synthesizeAgentDefinition(agent, compatibilityTriggers(agent.id)),
  );
  const definition =
    historical && !input.definition && !live
      ? completeActionlessCompatibilityDefinition(parsedDefinition)
      : parsedDefinition;
  assertDraftIdentity(definition, agent);
  const now = new Date();
  const id = makeId("agd");
  getDb()
    .insert(agentDrafts)
    .values({
      id,
      tenantId: ctx.tenantId,
      workflowId: agent.workflowId,
      agentId: agent.id,
      baseAgentVersionId:
        input.baseAgentVersionId ??
        live?.agentVersionId ??
        historical?.agentVersionId ??
        null,
      baseWorkflowVersionId:
        input.baseWorkflowVersionId ??
        authoringWorkflow?.workflowVersionId ??
        live?.workflowVersionId ??
        historical?.workflowVersionId ??
        null,
      definitionJson: definition as unknown as object,
      schemaVersion: 2,
      contentHash: definitionHash(definition),
      revision: 1,
      validationStatus: "unvalidated",
      validationJson: [],
      validatedHash: null,
      createdBy: null,
      updatedBy: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return getDraft(ctx, id);
}

export function createNewAgentDraft(
  ctx: AuthedContext,
  definitionInput: AgentDefinitionV2,
  requestedWorkflowSlug?: string,
  baseWorkflowVersionId?: string,
): AgentDraftRecord {
  const definition = AgentDefinitionV2Schema.parse(definitionInput);
  const db = getDb();
  const workflowSlug = requestedWorkflowSlug ?? `${ctx.tenantSlug}-default`;
  let workflow = findStudioWorkflow(ctx, workflowSlug);
  if (!workflow && requestedWorkflowSlug) {
    throw new AgentStudioWorkflowNotFoundError(requestedWorkflowSlug);
  }

  const duplicate = requestedWorkflowSlug
    ? (findStudioAgentInWorkflow(ctx, definition.id, workflow!.id) ??
      findStudioAgentInWorkflow(ctx, definition.name, workflow!.id))
    : (findStudioAgent(ctx, definition.id) ??
      findStudioAgent(ctx, definition.name));
  if (duplicate) {
    throw new Error(`agent_conflict:${duplicate.kebabId}`);
  }

  if (!workflow) {
    const id = makeId("wf");
    db.insert(workflows)
      .values({
        id,
        tenantId: ctx.tenantId,
        slug: workflowSlug,
        name: workflowSlug,
      })
      .run();
    workflow = db
      .select()
      .from(workflows)
      .where(eq(workflows.id, id))
      .all()[0]!;
  }

  if (baseWorkflowVersionId) {
    assertBaseWorkflowVersionContext(ctx, baseWorkflowVersionId, {
      workflowId: workflow.id,
      kebabId: definition.id,
      name: definition.name,
    });
  }

  const agentId = makeId("agt");
  const now = new Date();
  db.insert(agents)
    .values({
      id: agentId,
      tenantId: ctx.tenantId,
      workflowId: workflow.id,
      kebabId: definition.id,
      name: definition.name,
      title: definition.title ?? definition.name,
      actor: definition.actor.includes("Human") ? "Human" : "Agent",
      kind: "manifest",
      enabled: false,
      lifecycle: "draft",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  return createAgentDraft(ctx, agentId, {
    definition,
    workflowSlug: requestedWorkflowSlug,
    baseWorkflowVersionId,
  });
}

export function patchAgentDraft(
  ctx: Pick<AuthedContext, "tenantId">,
  draftId: string,
  expectedRevision: number,
  definitionInput: AgentDefinitionV2,
): AgentDraftRecord {
  const current = getDraft(ctx, draftId);
  if (current.revision !== expectedRevision) {
    throw new DraftRevisionConflictError(current);
  }
  const definition = AgentDefinitionV2Schema.parse(definitionInput);
  const agent = findStudioAgent(ctx, current.agentId);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  assertDraftIdentity(definition, agent);
  const nextHash = definitionHash(definition);
  if (nextHash === current.definitionHash) return current;
  const now = new Date();
  const result = getDb()
    .update(agentDrafts)
    .set({
      definitionJson: definition as unknown as object,
      contentHash: nextHash,
      revision: current.revision + 1,
      validationStatus:
        current.validationStatus === "valid" ? "stale" : "unvalidated",
      validationJson: [],
      validatedHash: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(agentDrafts.tenantId, ctx.tenantId),
        eq(agentDrafts.id, draftId),
        eq(agentDrafts.revision, expectedRevision),
        isNull(agentDrafts.deletedAt),
      ),
    )
    .run();
  if (result.changes !== 1) {
    throw new DraftRevisionConflictError(getDraft(ctx, draftId));
  }
  return getDraft(ctx, draftId);
}

export function deleteAgentDraft(
  ctx: Pick<AuthedContext, "tenantId">,
  draftId: string,
): void {
  getDraft(ctx, draftId);
  getDb()
    .update(agentDrafts)
    .set({ deletedAt: new Date(), updatedAt: new Date() })
    .where(
      and(eq(agentDrafts.tenantId, ctx.tenantId), eq(agentDrafts.id, draftId)),
    )
    .run();
}

function inspectSchema(
  schema: unknown,
  path: string,
  issues: AgentValidationIssue[],
  depth = 0,
): void {
  if (depth > 24) {
    issues.push({
      path,
      code: "schema_depth_exceeded",
      severity: "error",
      message: "JSON Schema nesting exceeds the supported depth of 24",
    });
    return;
  }
  if (!schema || typeof schema !== "object") return;
  if (Array.isArray(schema)) {
    schema.forEach((value, index) =>
      inspectSchema(value, `${path}/${index}`, issues, depth + 1),
    );
    return;
  }
  const record = schema as Record<string, unknown>;
  if (
    typeof record.$ref === "string" &&
    /^(https?:|file:)/i.test(record.$ref)
  ) {
    issues.push({
      path: `${path}/$ref`,
      code: "remote_schema_ref",
      severity: "error",
      message: "Remote and filesystem JSON Schema references are not allowed",
    });
  }
  for (const [key, value] of Object.entries(record)) {
    inspectSchema(
      value,
      `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      issues,
      depth + 1,
    );
  }
}

const FORBIDDEN_EXPRESSION_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

function validateTemplateExpressions(
  template: string,
  path: string,
  roots: Set<string>,
  issues: AgentValidationIssue[],
  knownInputs?: Set<string>,
  knownOutputs?: Set<string>,
  allowRootOnly = false,
): void {
  const tokenPattern = /{{([\s\S]*?)}}/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(template))) {
    const expression = match[1]!.trim().replace(/^json\s+/, "");
    const segments = expression.split(".");
    if (
      segments.length < (allowRootOnly ? 1 : 2) ||
      !roots.has(segments[0] ?? "") ||
      segments.some(
        (segment) =>
          !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment) ||
          FORBIDDEN_EXPRESSION_SEGMENTS.has(segment),
      )
    ) {
      issues.push({
        path,
        code: "template_expression_forbidden",
        severity: "error",
        message: `Unsupported template expression '{{${match[1]}}}'`,
      });
      continue;
    }
    if (
      segments[0] === "inputs" &&
      knownInputs &&
      !knownInputs.has(segments[1]!)
    ) {
      issues.push({
        path,
        code: "template_input_unknown",
        severity: "error",
        message: `Template references undeclared input '${segments[1]}'`,
      });
    }
    if (
      segments[0] === "outputs" &&
      knownOutputs &&
      !knownOutputs.has(segments[1]!)
    ) {
      issues.push({
        path,
        code: "template_output_unknown",
        severity: "error",
        message: `Template references undeclared output '${segments[1]}'`,
      });
    }
  }
  const withoutTokens = template.replace(tokenPattern, "");
  if (withoutTokens.includes("{{") || withoutTokens.includes("}}")) {
    issues.push({
      path,
      code: "template_syntax_invalid",
      severity: "error",
      message: "Template contains an unclosed or unmatched expression",
    });
  }
}

function validateActionMapping(
  mapping: Record<string, unknown> | undefined,
  path: string,
  allowedRoots: Set<string>,
  issues: AgentValidationIssue[],
): void {
  if (!mapping) return;
  for (const [field, raw] of Object.entries(mapping)) {
    const fieldPath = `${path}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (FORBIDDEN_EXPRESSION_SEGMENTS.has(field)) {
      issues.push({
        path: fieldPath,
        code: "action_mapping_key_forbidden",
        severity: "error",
        message: `Action mapping key '${field}' is forbidden`,
      });
      continue;
    }
    const record =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const candidatePath =
      typeof raw === "string" && raw.startsWith("$")
        ? raw
        : record && typeof record.path === "string"
          ? record.path
          : null;
    if (candidatePath) {
      try {
        resolveRestrictedJsonPath({}, candidatePath);
        const root = candidatePath.match(/^\$\.([A-Za-z_][A-Za-z0-9_-]*)/)?.[1];
        if (root && !allowedRoots.has(root)) {
          throw new TypeError(
            `mapping path root '${root}' is not available here`,
          );
        }
      } catch (error) {
        issues.push({
          path: fieldPath,
          code: "action_mapping_path_invalid",
          severity: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (record && typeof record.template === "string") {
      validateTemplateExpressions(
        record.template,
        fieldPath,
        allowedRoots,
        issues,
        undefined,
        undefined,
        true,
      );
    }
  }
}

function conditionExpressionIsSupported(expression: string): boolean {
  const trimmed = expression.trim();
  if (/^(?:true|false)$/i.test(trimmed)) return true;
  const supported =
    /^(lastResult|inputs|event)((?:\.[A-Za-z_][A-Za-z0-9_-]*)*)(?:\s*(?:==|!=|>=|<=|>|<)\s*(?:null|true|false|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'[^']*'))?$/.exec(
      trimmed,
    );
  if (!supported) return false;
  return !(supported[2] ?? "")
    .split(".")
    .filter(Boolean)
    .some((segment) => FORBIDDEN_EXPRESSION_SEGMENTS.has(segment));
}

export function validateDefinition(definitionInput: unknown): {
  definition: AgentDefinitionV2 | null;
  issues: AgentValidationIssue[];
} {
  const parsed = AgentDefinitionV2Schema.safeParse(definitionInput);
  if (!parsed.success) {
    return {
      definition: null,
      issues: parsed.error.issues.map((issue) => ({
        path: `/${issue.path.map(String).join("/")}`,
        code: "definition_invalid",
        severity: "error" as const,
        message: issue.message,
      })),
    };
  }
  const definition = parsed.data;
  const issues: AgentValidationIssue[] = [];
  definition.inputs.forEach((port, index) => {
    const path = `/inputs/${index}/schema`;
    inspectSchema(port.schema, path, issues);
    issues.push(...validateJsonSchemaDocument(port.schema, path));
  });
  definition.outputs.forEach((port, index) => {
    const path = `/outputs/${index}/schema`;
    inspectSchema(port.schema, path, issues);
    issues.push(...validateJsonSchemaDocument(port.schema, path));
  });
  const filename = definition.output_config.artifact.filename;
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename === "." ||
    filename === ".."
  ) {
    issues.push({
      path: "/output_config/artifact/filename",
      code: "unsafe_artifact_filename",
      severity: "error",
      message:
        "Artifact filename must be a leaf filename without path segments",
    });
  }

  const knownInputs = new Set(definition.inputs.map((port) => port.id));
  const knownOutputs = new Set(definition.outputs.map((port) => port.id));
  issues.push(...validateAgentUserPromptTemplate(definition));

  for (const [eventName, bindings] of Object.entries(
    definition.trigger_bindings ?? {},
  )) {
    if (!definition.trigger.includes(eventName)) {
      issues.push({
        path: `/trigger_bindings/${eventName}`,
        code: "trigger_binding_event_unknown",
        severity: "error",
        message: `Trigger binding references undeclared event '${eventName}'`,
      });
    }
    for (const [inputId, binding] of Object.entries(bindings)) {
      if (!knownInputs.has(inputId)) {
        issues.push({
          path: `/trigger_bindings/${eventName}/${inputId}`,
          code: "trigger_binding_input_unknown",
          severity: "error",
          message: `Trigger binding references undeclared input '${inputId}'`,
        });
      }
      if ("path" in binding && typeof binding.path === "string") {
        try {
          resolveRestrictedJsonPath({}, binding.path);
        } catch (error) {
          issues.push({
            path: `/trigger_bindings/${eventName}/${inputId}/path`,
            code: "trigger_binding_path_invalid",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if ("template" in binding && typeof binding.template === "string") {
        validateTemplateExpressions(
          binding.template,
          `/trigger_bindings/${eventName}/${inputId}/template`,
          new Set(["event", "run"]),
          issues,
        );
      }
    }
  }

  for (const [eventName, bindings] of Object.entries(
    definition.output_bindings ?? {},
  )) {
    if (!definition.triggered_event.includes(eventName)) {
      issues.push({
        path: `/output_bindings/${eventName}`,
        code: "output_binding_event_unknown",
        severity: "error",
        message: `Output binding references undeclared event '${eventName}'`,
      });
    }
    for (const [field, binding] of Object.entries(bindings)) {
      if (
        "input" in binding &&
        typeof binding.input === "string" &&
        !knownInputs.has(binding.input)
      ) {
        issues.push({
          path: `/output_bindings/${eventName}/${field}/input`,
          code: "output_binding_input_unknown",
          severity: "error",
          message: `Output binding references undeclared input '${binding.input}'`,
        });
      }
      if (
        "output" in binding &&
        typeof binding.output === "string" &&
        !knownOutputs.has(binding.output)
      ) {
        issues.push({
          path: `/output_bindings/${eventName}/${field}/output`,
          code: "output_binding_output_unknown",
          severity: "error",
          message: `Output binding references undeclared output '${binding.output}'`,
        });
      }
      if ("path" in binding && typeof binding.path === "string") {
        try {
          resolveRestrictedJsonPath({}, binding.path);
        } catch (error) {
          issues.push({
            path: `/output_bindings/${eventName}/${field}/path`,
            code: "output_binding_path_invalid",
            severity: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if ("template" in binding && typeof binding.template === "string") {
        validateTemplateExpressions(
          binding.template,
          `/output_bindings/${eventName}/${field}/template`,
          new Set(["inputs", "outputs", "run"]),
          issues,
          knownInputs,
          knownOutputs,
        );
      }
    }
  }

  const knownTools = new Set<string>();
  for (const tool of listGlobalTools()) {
    knownTools.add(tool.name);
    for (const alias of tool.aliases ?? []) knownTools.add(alias);
  }
  definition.tool_use.forEach((tool, index) => {
    if (!knownTools.has(tool.name)) {
      issues.push({
        path: `/tool_use/${index}/name`,
        code: "tool_not_in_global_catalog",
        severity: "warning",
        message: `Tool '${tool.name}' must be provided by a tenant or MCP registry at runtime`,
      });
    }
    const configText = JSON.stringify(tool.config ?? {});
    if (
      /"(?:api[_-]?key|authorization|token|secret)"\s*:\s*"(?!\$\{|env:|secret:)[^\"]+"/i.test(
        configText,
      )
    ) {
      issues.push({
        path: `/tool_use/${index}/config`,
        code: "literal_secret_forbidden",
        severity: "error",
        message:
          "Tool configuration must reference a tenant secret instead of containing a literal credential",
      });
    }
    if (tool.input_schema) {
      const schemaPath = `/tool_use/${index}/input_schema`;
      inspectSchema(tool.input_schema, schemaPath, issues);
      issues.push(...validateJsonSchemaDocument(tool.input_schema, schemaPath));
    }
  });

  const toolAllowList = new Set(definition.tool_use.map((tool) => tool.name));
  const actionIds = new Set<string>();
  const actionOrders = new Set<string>();
  definition.actions.forEach((action, index) => {
    const actionId = action.id ?? action.name;
    if (actionIds.has(actionId)) {
      issues.push({
        path: `/actions/${index}/id`,
        code: "action_id_duplicate",
        severity: "error",
        message: `Action id '${actionId}' is duplicated`,
      });
    }
    actionIds.add(actionId);
    if (actionOrders.has(action.order)) {
      issues.push({
        path: `/actions/${index}/order`,
        code: "action_order_duplicate",
        severity: "error",
        message: `Action order '${action.order}' is duplicated`,
      });
    }
    actionOrders.add(action.order);
    if (action.type === "tool") {
      const toolName = action.tool ?? action.name;
      if (!toolAllowList.has(toolName)) {
        issues.push({
          path: `/actions/${index}/tool`,
          code: "action_tool_not_allowed",
          severity: "error",
          message: `Direct tool action '${action.name}' must reference a tool in tool_use[]`,
        });
      }
    }
    if (action.type === "condition") {
      if (!action.condition?.trim()) {
        issues.push({
          path: `/actions/${index}/condition`,
          code: "condition_expression_required",
          severity: "error",
          message: "Condition actions require an expression",
        });
      } else if (!conditionExpressionIsSupported(action.condition)) {
        issues.push({
          path: `/actions/${index}/condition`,
          code: "condition_expression_unsupported",
          severity: "error",
          message:
            "Condition must use true/false or a restricted inputs, event, or lastResult comparison",
        });
      }
      for (const [field, target] of [
        ["true_action_id", action.true_action_id],
        ["false_action_id", action.false_action_id],
      ] as const) {
        if (
          target &&
          !definition.actions.some(
            (candidate) => (candidate.id ?? candidate.name) === target,
          )
        ) {
          issues.push({
            path: `/actions/${index}/${field}`,
            code: "condition_target_unknown",
            severity: "error",
            message: `Condition target '${target}' does not exist`,
          });
        } else if (target) {
          const targetIndex = definition.actions.findIndex(
            (candidate) => (candidate.id ?? candidate.name) === target,
          );
          if (targetIndex <= index) {
            issues.push({
              path: `/actions/${index}/${field}`,
              code: "condition_backward_target_unsupported",
              severity: "error",
              message:
                "Condition branches must target a later action; use the loop agent template for bounded iteration",
            });
          }
        }
      }
    }
    if (action.type === "subflow" && !action.subflow?.trim()) {
      issues.push({
        path: `/actions/${index}/subflow`,
        code: "subflow_target_required",
        severity: "error",
        message: "Subflow actions require a target agent/event identifier",
      });
    }
    if (action.type === "delay" || action.type === "subflow") {
      issues.push({
        path: `/actions/${index}`,
        code: "action_execution_preview",
        severity: "warning",
        message:
          action.type === "delay"
            ? "Delay is a preview action: its configuration is preserved, but production execution is not yet backed by a durable Inngest timer"
            : "Subflow is a preview action: its target and mappings are preserved, but production execution does not invoke a child workflow yet",
      });
    }
    if (action.form_schema) {
      const schemaPath = `/actions/${index}/form_schema`;
      inspectSchema(action.form_schema, schemaPath, issues);
      issues.push(
        ...validateJsonSchemaDocument(action.form_schema, schemaPath),
      );
    }
    validateActionMapping(
      action.input_mapping,
      `/actions/${index}/input_mapping`,
      new Set(["event", "inputs", "lastResult", "run"]),
      issues,
    );
    validateActionMapping(
      action.output_mapping,
      `/actions/${index}/output_mapping`,
      new Set(["result", "lastResult", "event", "inputs", "run"]),
      issues,
    );
    if (
      action.type !== "logic" &&
      ((action.retries ?? 0) > 0 || action.timeout_s !== undefined)
    ) {
      issues.push({
        path: `/actions/${index}`,
        code: "action_retry_timeout_logic_only",
        severity: "warning",
        message:
          "Per-action retries and timeouts are honored only for LLM/logic steps; side-effecting steps are never retried automatically",
      });
    }
  });

  if (definition.actions.length === 0) {
    issues.push({
      path: "/actions",
      code: "no_actions",
      severity: "error",
      message: "An agent must contain at least one action",
    });
  }
  if (definition.actor.includes("Agent") && !definition.model) {
    issues.push({
      path: "/model",
      code: "model_inherited",
      severity: "info",
      message: "This agent will use the workspace default model",
    });
  }
  if (definition.cron) {
    const cron = definition.cron.trim();
    const fields = cron.split(/\s+/);
    if (!cron.startsWith("@") && (fields.length < 5 || fields.length > 6)) {
      issues.push({
        path: "/cron",
        code: "cron_expression_invalid",
        severity: "error",
        message:
          "Cron must be a supported @schedule or a 5- or 6-field expression",
      });
    }
  }
  if (definition.cron_timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: definition.cron_timezone });
    } catch {
      issues.push({
        path: "/cron_timezone",
        code: "cron_timezone_invalid",
        severity: "error",
        message: `Unknown IANA time zone '${definition.cron_timezone}'`,
      });
    }
  }
  return { definition, issues };
}

export function validateDraft(
  ctx: Pick<AuthedContext, "tenantId">,
  draftId: string,
): { draft: AgentDraftSummary; validation: AgentValidationResult } {
  const current = getDraft(ctx, draftId);
  const checked = validateDefinition(current.definition);
  const hasErrors = checked.issues.some((issue) => issue.severity === "error");
  const validatedAt = new Date();
  const validation: AgentValidationResult = {
    status: hasErrors ? "invalid" : "valid",
    definitionHash: current.definitionHash,
    issues: checked.issues,
    validatedAt,
  };
  getDb()
    .update(agentDrafts)
    .set({
      validationStatus: validation.status,
      validationJson: validation.issues as unknown as object,
      validatedHash: current.definitionHash,
      updatedAt: validatedAt,
    })
    .where(
      and(eq(agentDrafts.tenantId, ctx.tenantId), eq(agentDrafts.id, draftId)),
    )
    .run();
  return {
    draft: draftSummary(getDraftRow(ctx.tenantId, draftId)),
    validation,
  };
}

function getDraftRow(tenantId: string, draftId: string): DraftRow {
  const row = getDb()
    .select()
    .from(agentDrafts)
    .where(
      and(
        eq(agentDrafts.tenantId, tenantId),
        eq(agentDrafts.id, draftId),
        isNull(agentDrafts.deletedAt),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) throw new AgentStudioNotFoundError("draft");
  return row;
}

export function checkpointDraft(
  ctx: Pick<AuthedContext, "tenantId">,
  draftId: string,
  reason: "run" | "checkpoint" | "publish",
): AgentDraftRevision {
  const draft = getDraft(ctx, draftId);
  const existing = getDb()
    .select()
    .from(agentDraftRevisions)
    .where(
      and(
        eq(agentDraftRevisions.tenantId, ctx.tenantId),
        eq(agentDraftRevisions.draftId, draftId),
        eq(agentDraftRevisions.revision, draft.revision),
      ),
    )
    .limit(1)
    .all()[0];
  if (existing) return draftRevisionRecord(existing);
  const id = makeId("agr");
  getDb()
    .insert(agentDraftRevisions)
    .values({
      id,
      tenantId: ctx.tenantId,
      draftId,
      revision: draft.revision,
      definitionJson: draft.definition as unknown as object,
      schemaVersion: 2,
      contentHash: draft.definitionHash,
      reason,
      createdBy: null,
    })
    .onConflictDoNothing()
    .run();
  const row = getDb()
    .select()
    .from(agentDraftRevisions)
    .where(
      and(
        eq(agentDraftRevisions.tenantId, ctx.tenantId),
        eq(agentDraftRevisions.draftId, draftId),
        eq(agentDraftRevisions.revision, draft.revision),
      ),
    )
    .all()[0]!;
  return draftRevisionRecord(row);
}

export function getDraftRevision(
  ctx: Pick<AuthedContext, "tenantId">,
  draftId: string,
  revision?: number,
): AgentDraftRevision {
  const draft = getDraft(ctx, draftId);
  const selectedRevision = revision ?? draft.revision;
  const row = getDb()
    .select()
    .from(agentDraftRevisions)
    .where(
      and(
        eq(agentDraftRevisions.tenantId, ctx.tenantId),
        eq(agentDraftRevisions.draftId, draftId),
        eq(agentDraftRevisions.revision, selectedRevision),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row && selectedRevision === draft.revision) {
    return checkpointDraft(ctx, draftId, "run");
  }
  if (!row) throw new AgentStudioNotFoundError("draft");
  return draftRevisionRecord(row);
}

export async function generateDraftInstructions(
  ctx: AuthedContext,
  draftId: string,
  input: GenerateDraftInstructionsBody,
): Promise<GenerateDraftInstructionsResponse> {
  const draft = getDraft(ctx, draftId);
  return generateInstructionsForDefinition(ctx, draft.definition, input);
}

type InstructionGenerationInput = Pick<
  WorkflowAgentPromptBody,
  "mode" | "instructions" | "selectedText" | "provider" | "model"
>;

/**
 * Shared proposal generator for Agent Studio and the inline workflow editor.
 * The caller owns persistence/apply semantics; this function only returns a
 * redacted, provenance-stamped proposal.
 */
export async function generateInstructionsForDefinition(
  ctx: AuthedContext,
  definition: AgentDefinitionV2,
  input: InstructionGenerationInput,
): Promise<WorkflowAgentPromptResponse> {
  const gateway = getLLMGateway();
  const safeDefinition = promptGenerationContext(definition);
  const response = await gateway.chat({
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
    purpose: "studio.instruction-authoring",
    routing: { taskType: "agent.author" },
    provider: input.provider,
    model: input.model,
    maxTokens: 2_400,
    messages: [
      {
        role: "system",
        content:
          "You are a senior agent architect. Return only improved system instructions. Preserve explicit safety, privacy, output-schema, tool, and human-review constraints. Never invent credentials or tools.",
      },
      {
        role: "user",
        content: JSON.stringify(
          {
            task: input.mode,
            current_instructions: redactLikelySecrets(
              input.instructions ?? definition.ontology_instructions ?? "",
            ),
            selected_text: input.selectedText
              ? redactLikelySecrets(input.selectedText)
              : undefined,
            agent: safeDefinition,
          },
          null,
          2,
        ),
      },
    ],
  });
  const proposedInstructions = response.text
    .trim()
    .replace(/^```(?:markdown|md|text)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  if (!proposedInstructions) throw new Error("prompt_generation_empty");
  return {
    proposedInstructions,
    provenance: {
      mode: "ai-assisted",
      source_hash: definitionHash(definition),
      provider: response.provider,
      model: response.model,
      generated_at: new Date().toISOString(),
      tokens_in: response.tokensIn,
      tokens_out: response.tokensOut,
    },
  };
}

function redactLikelySecrets(value: string): string {
  return value
    .replace(
      /\b(api[_-]?key|authorization|bearer|token|secret|password)\b\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[REDACTED]",
    )
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_KEY]");
}

function promptGenerationContext(definition: AgentDefinitionV2): object {
  return {
    id: definition.id,
    name: definition.name,
    title: definition.title,
    description: definition.description,
    actor: definition.actor,
    trigger: definition.trigger,
    inputs: definition.inputs.map((input) => ({
      id: input.id,
      label: input.label,
      description: input.description,
      kind: input.kind,
      required: input.required,
      schema: input.schema,
      sensitivity: input.sensitivity,
    })),
    outputs: definition.outputs.map((output) => ({
      id: output.id,
      label: output.label,
      description: output.description,
      required: output.required,
      schema: output.schema,
      sensitivity: output.sensitivity,
    })),
    actions: definition.actions.map((action) => ({
      id: action.id,
      order: action.order,
      name: action.name,
      description: action.description,
      type: action.type,
      action_prompt: action.action_prompt,
      tool: action.tool,
    })),
    tool_use: definition.tool_use.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
      configured_keys: Object.keys(tool.config ?? {}).sort(),
    })),
    output_config: definition.output_config,
    triggered_event: definition.triggered_event,
    provider: definition.provider,
    model: definition.model,
    temperature: definition.temperature,
    max_tokens: definition.max_tokens,
    timeout_s: definition.timeout_s,
    retries: definition.retries,
  };
}

function rawManifestAgents(manifest: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(manifest))
    return manifest as Array<Record<string, unknown>>;
  if (
    manifest &&
    typeof manifest === "object" &&
    Array.isArray((manifest as { agents?: unknown }).agents)
  ) {
    return (manifest as { agents: Array<Record<string, unknown>> }).agents;
  }
  return [];
}

function findRawAgent(
  manifest: unknown,
  identity: Pick<AgentRow, "kebabId" | "name">,
): Record<string, unknown> | null {
  const candidates = rawManifestAgents(manifest);
  // Names are not required to be unique inside legacy manifests. Identity is
  // the persisted kebab id; use the name only as a compatibility fallback
  // for very old manifests that did not carry ids.
  const exact = candidates.find(
    (candidate) => candidate.id === identity.kebabId,
  );
  if (exact) return exact;
  // Name fallback is only safe for pre-id manifests. A differently-valued id
  // denotes a different immutable agent identity even if the display/runtime
  // name happens to be reused by a newer workflow version.
  const legacyByName = candidates.filter(
    (candidate) =>
      candidate.name === identity.name &&
      (candidate.id === undefined ||
        candidate.id === null ||
        candidate.id === ""),
  );
  return legacyByName.length === 1 ? legacyByName[0]! : null;
}

/** Replace one immutable agent identity without dropping unrelated agents. */
export function mergeAgentDefinitionIntoManifest(
  manifest: unknown,
  identity: { kebabId: string; name: string },
  definition: AgentDefinitionV2,
): Array<Record<string, unknown>> {
  const merged = rawManifestAgents(manifest).filter((candidate) => {
    const candidateId = candidate.id;
    const isExactIdentity = candidateId === identity.kebabId;
    const isLegacyIdentity =
      (candidateId === undefined ||
        candidateId === null ||
        candidateId === "") &&
      candidate.name === identity.name;
    return !isExactIdentity && !isLegacyIdentity;
  });
  merged.push(definition as unknown as Record<string, unknown>);
  return merged;
}

function ensureEventCatalog(
  ctx: AuthedContext,
  definition: AgentDefinitionV2,
): void {
  const db = getDb();
  for (const name of new Set([
    ...definition.trigger,
    ...definition.triggered_event,
  ])) {
    db.insert(eventTypes)
      .values({
        tenantId: ctx.tenantId,
        name,
        category: "agent",
        description: `Declared by ${definition.title ?? definition.name}.`,
        payloadJson: null,
      })
      .onConflictDoNothing()
      .run();
  }
}

export async function publishDraft(
  ctx: AuthedContext,
  draftId: string,
  input: PublishAgentDraftBody,
  auditCtx?: AuditCtx,
): Promise<PublishAgentDraftResponse> {
  let draft = getDraft(ctx, draftId);
  if (
    draft.validation.status !== "valid" ||
    draft.validation.validatedHash !== draft.definitionHash
  ) {
    const checked = validateDraft(ctx, draftId);
    if (checked.validation.status !== "valid") {
      throw new DraftValidationError(checked.validation);
    }
    draft = getDraft(ctx, draftId);
  }
  const agent = findStudioAgent(ctx, draft.agentId);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  assertManifestAgentEditable(agent);
  assertDraftIdentity(draft.definition, agent);
  const currentLive = getLiveAgentSnapshot(ctx, agent.id);
  const currentWorkflow = getAuthoringWorkflowSnapshot(ctx, agent.workflowId);

  if (currentLive && !input.confirmImpact) {
    const impactSections: Array<[string, unknown, unknown]> = [
      ["inputs", currentLive.definition.inputs, draft.definition.inputs],
      ["outputs", currentLive.definition.outputs, draft.definition.outputs],
      [
        "output policy",
        currentLive.definition.output_config,
        draft.definition.output_config,
      ],
      [
        "triggers",
        {
          trigger: currentLive.definition.trigger,
          bindings: currentLive.definition.trigger_bindings,
          emitted: currentLive.definition.triggered_event,
          outputBindings: currentLive.definition.output_bindings,
        },
        {
          trigger: draft.definition.trigger,
          bindings: draft.definition.trigger_bindings,
          emitted: draft.definition.triggered_event,
          outputBindings: draft.definition.output_bindings,
        },
      ],
      ["tools", currentLive.definition.tool_use, draft.definition.tool_use],
      ["actions", currentLive.definition.actions, draft.definition.actions],
      [
        "runtime",
        {
          provider: currentLive.definition.provider,
          model: currentLive.definition.model,
          temperature: currentLive.definition.temperature,
          max_tokens: currentLive.definition.max_tokens,
          timeout_s: currentLive.definition.timeout_s,
          retries: currentLive.definition.retries,
          concurrency: currentLive.definition.concurrency,
          tool_loop: currentLive.definition.tool_loop,
        },
        {
          provider: draft.definition.provider,
          model: draft.definition.model,
          temperature: draft.definition.temperature,
          max_tokens: draft.definition.max_tokens,
          timeout_s: draft.definition.timeout_s,
          retries: draft.definition.retries,
          concurrency: draft.definition.concurrency,
          tool_loop: draft.definition.tool_loop,
        },
      ],
    ];
    const impacts = impactSections
      .filter(
        ([, before, after]) => definitionHash(before) !== definitionHash(after),
      )
      .map(([name]) => name);
    if (impacts.length > 0) throw new DraftImpactConfirmationError(impacts);
  }

  if (
    draft.baseWorkflowVersionId &&
    currentWorkflow?.workflowVersionId !== draft.baseWorkflowVersionId
  ) {
    const base = getDb()
      .select({ manifest: workflowVersions.manifestJson })
      .from(workflowVersions)
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(
        and(
          eq(workflowVersions.id, draft.baseWorkflowVersionId),
          eq(workflows.tenantId, ctx.tenantId),
        ),
      )
      .limit(1)
      .all()[0];
    const baseAgent = findRawAgent(base?.manifest, agent);
    const currentAgent = findRawAgent(currentWorkflow?.manifest, agent);
    if (definitionHash(baseAgent) !== definitionHash(currentAgent)) {
      throw new DraftPublishConflictError(
        draft.baseWorkflowVersionId,
        currentWorkflow?.workflowVersionId ?? null,
      );
    }
  }

  const revision = checkpointDraft(ctx, draftId, "publish");
  // A brand-new agent has no AgentVersion yet, but its workflow can already
  // contain many live agents. Merge against the live workflow snapshot so
  // publishing the new draft never replaces unrelated definitions.
  const nextAgents = mergeAgentDefinitionIntoManifest(
    currentWorkflow?.manifest,
    agent,
    draft.definition,
  );
  let committed;
  try {
    committed = await commit(
      {
        mode: "commit",
        workflow: nextAgents,
        target: "production",
        confirm_overwrite: true,
        conflict_resolutions: [],
        note:
          input.note ??
          `Agent ${draft.definition.name} published from Agent Studio`,
      },
      ctx,
      auditCtx,
    );
  } catch (error) {
    if (error instanceof BlockingIssuesError) {
      throw new DraftValidationError({
        status: "invalid",
        definitionHash: draft.definitionHash,
        validatedAt: new Date(),
        issues: error.issues.map((issue) => ({
          path: issue.path,
          code: issue.code,
          severity: issue.severity,
          message: issue.message,
        })),
      });
    }
    throw error;
  }

  const publishedAgent = getDb()
    .select({ id: agents.id, versionId: agentVersions.id })
    .from(agents)
    .innerJoin(agentVersions, eq(agentVersions.agentId, agents.id))
    .where(
      and(
        eq(agents.workflowId, draft.workflowId),
        eq(agents.kebabId, draft.definition.id),
        eq(agentVersions.workflowVersionId, committed.workflow_version_id),
      ),
    )
    .limit(1)
    .all()[0];
  if (!publishedAgent) {
    throw new Error("published agent version could not be resolved");
  }
  const now = new Date();
  getDb().transaction(() => {
    getDb()
      .update(agentVersions)
      .set({
        definitionSchemaVersion: 2,
        contentHash: draft.definitionHash,
        publishedAt: now,
        changeNote: input.note ?? null,
        updatedAt: now,
      })
      .where(eq(agentVersions.id, publishedAgent.versionId))
      .run();
    getDb()
      .update(agents)
      .set({
        tenantId: ctx.tenantId,
        name: draft.definition.name,
        title: draft.definition.title ?? draft.definition.name,
        actor: draft.definition.actor.includes("Human") ? "Human" : "Agent",
        lifecycle: "active",
        enabled: true,
        updatedAt: now,
      })
      .where(eq(agents.id, publishedAgent.id))
      .run();
    getDb()
      .update(agentDrafts)
      .set({
        baseAgentVersionId: publishedAgent.versionId,
        baseWorkflowVersionId: committed.workflow_version_id,
        updatedAt: now,
      })
      .where(eq(agentDrafts.id, draftId))
      .run();
  });
  ensureEventCatalog(ctx, draft.definition);
  const functionId = `${ctx.tenantSlug}.${draft.definition.name}`;
  return {
    workflowVersionId: committed.workflow_version_id,
    agentVersionId: publishedAgent.versionId,
    deploymentId: committed.deployment_id,
    version: committed.version,
    draftRevisionId: revision.id,
    definitionHash: draft.definitionHash,
    runtime: {
      functionId,
      registered: isInngestFunctionRegistered(functionId),
    },
  };
}

export function listAgentVersions(
  ctx: Pick<AuthedContext, "tenantId">,
  agentRef: string,
  input: { cursor?: string; limit: number },
): ListAgentVersionsResponse {
  const agent = findStudioAgent(ctx, agentRef);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  const live = getLiveAgentSnapshot(ctx, agent.id);
  let cursorRow: { id: string; createdAt: Date } | null = null;
  if (input.cursor) {
    cursorRow =
      getDb()
        .select({ id: agentVersions.id, createdAt: agentVersions.createdAt })
        .from(agentVersions)
        .where(
          and(
            eq(agentVersions.agentId, agent.id),
            eq(agentVersions.id, input.cursor),
          ),
        )
        .limit(1)
        .all()[0] ?? null;
  }
  const predicates = [eq(agentVersions.agentId, agent.id)];
  if (cursorRow) {
    predicates.push(
      or(
        lt(agentVersions.createdAt, cursorRow.createdAt),
        and(
          eq(agentVersions.createdAt, cursorRow.createdAt),
          lt(agentVersions.id, cursorRow.id),
        ),
      )!,
    );
  }
  const rows = getDb()
    .select({
      id: agentVersions.id,
      agentId: agentVersions.agentId,
      workflowVersionId: agentVersions.workflowVersionId,
      workflowVersion: workflowVersions.version,
      contentHash: agentVersions.contentHash,
      schemaVersion: agentVersions.definitionSchemaVersion,
      changeNote: agentVersions.changeNote,
      createdBy: agentVersions.createdBy,
      publishedAt: agentVersions.publishedAt,
      createdAt: agentVersions.createdAt,
    })
    .from(agentVersions)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, agentVersions.workflowVersionId),
    )
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(and(eq(workflows.tenantId, ctx.tenantId), ...predicates))
    .orderBy(desc(agentVersions.createdAt), desc(agentVersions.id))
    .limit(input.limit + 1)
    .all();
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  return {
    versions: page.map((row) => ({
      id: row.id,
      agentId: row.agentId,
      workflowVersionId: row.workflowVersionId,
      workflowVersion: row.workflowVersion,
      definitionHash: row.contentHash,
      schemaVersion: row.schemaVersion,
      changeNote: row.changeNote,
      createdBy: row.createdBy,
      publishedAt: row.publishedAt,
      createdAt: row.createdAt,
      live: live?.agentVersionId === row.id,
    })),
    nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
  };
}

export function getAgentVersion(
  ctx: Pick<AuthedContext, "tenantId">,
  agentRef: string,
  versionId: string,
): AgentVersionDetail {
  const agent = findStudioAgent(ctx, agentRef);
  if (!agent) throw new AgentStudioNotFoundError("agent");
  const live = getLiveAgentSnapshot(ctx, agent.id);
  const row = getDb()
    .select({
      id: agentVersions.id,
      agentId: agentVersions.agentId,
      workflowVersionId: agentVersions.workflowVersionId,
      workflowVersion: workflowVersions.version,
      definition: agentVersions.manifestJson,
      workflowManifest: workflowVersions.manifestJson,
      contentHash: agentVersions.contentHash,
      schemaVersion: agentVersions.definitionSchemaVersion,
      changeNote: agentVersions.changeNote,
      createdBy: agentVersions.createdBy,
      publishedAt: agentVersions.publishedAt,
      createdAt: agentVersions.createdAt,
    })
    .from(agentVersions)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, agentVersions.workflowVersionId),
    )
    .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
    .where(
      and(
        eq(workflows.tenantId, ctx.tenantId),
        eq(agentVersions.agentId, agent.id),
        eq(agentVersions.id, versionId),
      ),
    )
    .limit(1)
    .all()[0];
  if (!row) throw new AgentStudioNotFoundError("version");
  let definition: AgentDefinitionV2;
  try {
    definition = normalizeAgentDefinitionForIdentity(row.definition, agent);
  } catch {
    const exact = findRawAgent(row.workflowManifest, agent);
    if (!exact) throw new AgentStudioNotFoundError("version");
    definition = normalizeAgentDefinitionForIdentity(exact, agent, {
      mode: "historical",
      source: "historical-workflow-manifest",
    });
  }
  return {
    id: row.id,
    agentId: row.agentId,
    workflowVersionId: row.workflowVersionId,
    workflowVersion: row.workflowVersion,
    definitionHash: row.contentHash,
    schemaVersion: row.schemaVersion,
    changeNote: row.changeNote,
    createdBy: row.createdBy,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    live: live?.agentVersionId === row.id,
    definition,
  };
}

function pointerPart(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function diffJson(
  before: unknown,
  after: unknown,
  path: string,
  changes: AgentDefinitionDiffEntry[],
): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      const child = `${path}/${index}`;
      if (index >= before.length) {
        changes.push({ path: child, kind: "added", after: after[index] });
      } else if (index >= after.length) {
        changes.push({ path: child, kind: "removed", before: before[index] });
      } else {
        diffJson(before[index], after[index], child, changes);
      }
    }
    return;
  }
  const beforeObject =
    before !== null && typeof before === "object" && !Array.isArray(before);
  const afterObject =
    after !== null && typeof after === "object" && !Array.isArray(after);
  if (beforeObject && afterObject) {
    const left = before as Record<string, unknown>;
    const right = after as Record<string, unknown>;
    for (const key of [
      ...new Set([...Object.keys(left), ...Object.keys(right)]),
    ].sort()) {
      const child = `${path}/${pointerPart(key)}`;
      if (!Object.hasOwn(left, key)) {
        changes.push({ path: child, kind: "added", after: right[key] });
      } else if (!Object.hasOwn(right, key)) {
        changes.push({ path: child, kind: "removed", before: left[key] });
      } else {
        diffJson(left[key], right[key], child, changes);
      }
    }
    return;
  }
  changes.push({
    path: path || "/",
    kind: "changed",
    before,
    after,
  });
}

export function diffAgentVersions(
  ctx: Pick<AuthedContext, "tenantId">,
  agentRef: string,
  fromVersionId: string,
  toVersionId: string,
): AgentVersionDiffResponse {
  const from = getAgentVersion(ctx, agentRef, fromVersionId);
  const to = getAgentVersion(ctx, agentRef, toVersionId);
  const changes: AgentDefinitionDiffEntry[] = [];
  diffJson(from.definition, to.definition, "", changes);
  return { from: fromVersionId, to: toVersionId, changes };
}

export function restoreAgentVersion(
  ctx: AuthedContext,
  agentRef: string,
  versionId: string,
): AgentDraftRecord {
  const version = getAgentVersion(ctx, agentRef, versionId);
  return createAgentDraft(ctx, version.agentId, {
    definition: version.definition,
    baseAgentVersionId: versionId,
    baseWorkflowVersionId: version.workflowVersionId,
  });
}
