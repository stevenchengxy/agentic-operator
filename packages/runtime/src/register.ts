/**
 * registerAgent — turns an AgentSpec into an Inngest function tied to a tenant.
 *
 * Per DESIGN.md §5:
 *   - One Inngest function per (tenant, agent).
 *   - Function ID: `${tenantSlug}.${agentName}`.
 *   - Concurrency key: `event.data.subject` (one run per subject in flight).
 *   - Retries: 3 (Inngest default).
 *   - Triggers: each trigger event name namespaced with `${tenantSlug}/`.
 *
 * The handler:
 *   1. Allocates a run ID + correlation ID (correlation propagates through chains).
 *   2. Inserts a `runs` row with status=running, then `steps` rows per action.
 *   3. Calls runAction() inside step.run() so retries are durable.
 *   4. After all steps, picks an emitted event (first item in `triggered_event`),
 *      inserts an outbound `events` row, appends to the ledger, sends to Inngest.
 *   5. Updates the run with status=ok + emitted_event_id.
 */

import { inngest } from "./client";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runAction } from "./step-engine";
import { appendToLedger } from "./event-ledger";
import {
  buildCanonicalEventPayload,
  stripPrivateEventMetadata,
} from "./event-envelope";
import { writeRunLog } from "./log-writer";
import {
  createFilesystemArtifactSink,
  persistTerminalRunArtifacts,
  writeArtifact,
  type RuntimeArtifactSink,
  type RuntimePersistedArtifact,
} from "./artifacts";
import {
  AgentInputValidationError,
  OutputSchemaValidationError,
  bindTriggerInputs,
  canonicalJson,
  normalizeAgentForExecution,
  parseValidateAndRepairOutput,
  resolveAgentEmissions,
  validateAgentInputs,
} from "./agent-execution";
import {
  createFilteredTraceSink,
  type RuntimeTraceSink,
} from "./execution-trace";
import { correlationFromEvent, withCorrelation } from "./correlation";
import type { ActionSpec, AgentSpec } from "./manifest";
import { makeId } from "@agentic/shared";
import {
  agents,
  agentVersions,
  events,
  runs,
  steps,
  tasks as tasksTable,
  artifacts,
  runEmittedEvents,
  runTraceEvents,
  getDb,
} from "@agentic/db";
import { eq, and, desc } from "drizzle-orm";

import type { TenantRegistry } from "@agentic/agent-kit";
import type { InngestFunction } from "inngest";
import { getRuntimeMetrics } from "./llm-host";
import {
  mergeUsageAttribution,
  type UsageAttribution,
} from "@agentic/llm-gateway";
import {
  privateUsageAttributionMetadata,
  usageAttributionFromDeliveryData,
} from "./usage-attribution-envelope";
import type {
  AgentRunRecord,
  ProviderId,
  RunArtifactMetadata,
  RunEmittedEvent,
  WorkflowManualTaskResolution,
} from "@agentic/contracts";
import { WorkflowManualTaskResolutionSchema } from "@agentic/contracts";

export interface RegisterContext {
  tenantId: string;
  tenantSlug: string;
  workflowVersionId: string;
  /**
   * Tenant-specific tools + prompts loaded from the optional
   * `@tenants/<slug>` package. Resolved before generic @agentic/tools so
   * manifest action.name → tenant impl when present, generic when absent.
   */
  tenantRegistry?: TenantRegistry;
  /** Optional override; defaults to the runtime DB trace sink. */
  traceSink?: RuntimeTraceSink;
  /** Optional tenant-authorized artifact service for this run. */
  artifactSinkFactory?: (context: {
    tenantId: string;
    runId: string;
  }) => RuntimeArtifactSink;
}

export function buildManualTaskPayload(input: {
  agent: Pick<AgentSpec, "name">;
  action: ActionSpec;
  subject: string | null;
  preparedContext: unknown;
}): Record<string, unknown> {
  return {
    agentName: input.agent.name,
    actionName: input.action.name,
    description: input.action.description,
    subject: input.subject,
    condition: input.action.condition ?? null,
    preparedContext: input.preparedContext ?? null,
    formSchema: input.action.form_schema ?? null,
    awaitingRole: input.action.awaiting_role ?? "operator",
  };
}

export type ManualTaskDecision = "approve" | "reject" | "supplement";
export type ManualTaskOutcome = "approved" | "rejected" | "supplemented";

export type ManualTaskResolution = WorkflowManualTaskResolution;

/**
 * Turn the resume event into the stable value exposed to later actions,
 * output validation, artifacts, and authored event bindings. A rejection is
 * a successful operator decision, not an infrastructure failure, so callers
 * can finalize and fan out it exactly like approve/supplement.
 */
export function buildManualTaskResolution(input: {
  taskId: string;
  decision?: unknown;
  payload?: unknown;
}): ManualTaskResolution {
  const decision = input.decision ?? "approve";
  if (
    decision !== "approve" &&
    decision !== "reject" &&
    decision !== "supplement"
  ) {
    throw new Error(`invalid manual task decision: ${String(decision)}`);
  }
  const outcome: ManualTaskOutcome =
    decision === "approve"
      ? "approved"
      : decision === "reject"
        ? "rejected"
        : "supplemented";
  return WorkflowManualTaskResolutionSchema.parse({
    task_id: input.taskId,
    status: "resolved",
    decision,
    outcome,
    payload: input.payload ?? null,
  });
}

/**
 * AR-GAP-13 / UC-V11-25 — boot-time validation that every `logic` action
 * in a manifest has a matching tenant `definePrompt`.
 *
 * Tech-design (`docs/tech-design/ar-tool.md` § "Option B — strict") chose
 * refuse-to-boot over runtime graceful-degradation: without a tenant
 * prompt the step engine used to ship the bare
 * `${action.name}: ${action.description}` line as the LLM user message.
 * For RAAS that means streaming a Chinese description to whatever model
 * is fronting the gateway — almost never what the workflow author
 * intended. Better to fail loud at boot.
 */
export interface MissingPromptRef {
  agentName: string;
  actionName: string;
  description: string;
}

export function findMissingTenantPrompts(args: {
  manifest: ReadonlyArray<AgentSpec>;
  tenantRegistry?: TenantRegistry;
}): MissingPromptRef[] {
  const prompts = args.tenantRegistry?.prompts ?? {};
  const missing: MissingPromptRef[] = [];
  for (const agent of args.manifest) {
    // Wizard-authored agents intentionally carry their full prompt in the
    // manifest and use the runtime's generic user turn. Preserve strict
    // tenant-prompt validation for every hand-authored agent.
    if ((agent as { generated?: boolean }).generated) continue;
    for (const action of agent.actions) {
      if (action.type !== "logic") continue;
      if (prompts[action.name]) continue;
      missing.push({
        agentName: agent.name,
        actionName: action.name,
        description: action.description,
      });
    }
  }
  return missing;
}

/**
 * Format `findMissingTenantPrompts` output for the boot log. The shape is
 * deliberately operator-readable (not stack-trace style) — engineers
 * paste it straight into a follow-up "implement these prompts" ticket.
 */
export function formatMissingPromptsError(
  tenantSlug: string,
  missing: MissingPromptRef[],
): string {
  if (missing.length === 0) return `[tenant ${tenantSlug}] no missing prompts`;
  const lines = [
    `[tenant ${tenantSlug}] boot failed — ${missing.length} logic action(s) have no tenant definePrompt:`,
    ...missing.map(
      (m) =>
        `  - ${m.agentName} · ${m.actionName}: ${truncateForLog(m.description)}`,
    ),
    "",
    `To fix: add tenant prompts under tenants/${tenantSlug}/prompts/ and re-export them from`,
    `the TenantRegistry.prompts map. Until then, this tenant's Inngest functions WILL NOT register;`,
    `other tenants continue to boot.`,
  ];
  return lines.join("\n");
}

function truncateForLog(s: string, max = 100): string {
  const trimmed = s.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function createDbTraceSink(tenantId: string): RuntimeTraceSink {
  return {
    append(event) {
      const db = getDb();
      const latest = db
        .select({ seq: runTraceEvents.seq })
        .from(runTraceEvents)
        .where(eq(runTraceEvents.runId, event.runId))
        .orderBy(desc(runTraceEvents.seq))
        .limit(1)
        .all()[0];
      db.insert(runTraceEvents)
        .values({
          id: makeId("trc"),
          tenantId,
          runId: event.runId,
          stepId: event.stepId ?? null,
          parentId: event.parentId ?? null,
          seq: (latest?.seq ?? 0) + 1,
          kind: event.kind,
          level: event.level,
          name: event.name,
          status: event.status,
          startedAt: event.startedAt ?? null,
          endedAt: event.endedAt ?? null,
          durationMs: event.durationMs ?? null,
          summary: event.summary ?? null,
          dataJson: event.data ?? null,
          artifactId: event.artifactId ?? null,
          visibility: event.visibility,
        })
        .run();
    },
  };
}

/**
 * Generic events fan out to every function sharing their trigger. An
 * agent-scoped publish stamps `__invokedAgent`; sibling subscribers must
 * acknowledge the event without allocating a run. Unscoped events preserve
 * the original fanout behavior.
 */
export function eventTargetsAgent(
  data: Record<string, unknown>,
  agentName: string,
): boolean {
  const target = data.__invokedAgent;
  return typeof target !== "string" || target === "" || target === agentName;
}

/**
 * Add transport-only metadata to a canonical downstream payload. Keeping
 * this boundary explicit guarantees that stripping private keys from the
 * delivered data reproduces the exact object persisted in the event ledger.
 */
export function buildManifestEventDeliveryData(args: {
  logicalPayload: Record<string, unknown>;
  eventId: string;
  correlationId: string;
  usageAttribution?: UsageAttribution;
}): Record<string, unknown> {
  return {
    ...withCorrelation(args.correlationId, {
      ...stripPrivateEventMetadata(args.logicalPayload),
      __triggerEventId: args.eventId,
    }),
    ...privateUsageAttributionMetadata(args.usageAttribution),
  };
}

type RunInvocationSource =
  | "studio"
  | "event"
  | "api"
  | "replay"
  | "demo";

function runInvocationSource(value: string | undefined): RunInvocationSource {
  switch (value) {
    case "studio":
    case "api":
    case "replay":
    case "demo":
      return value;
    default:
      return "event";
  }
}

export interface ResolvedAgentConcurrency {
  limit: number;
  key: string;
}

/**
 * Compile Studio concurrency settings into Inngest's expression language.
 * Only simple event-data JSON paths are accepted; this keeps authored values
 * data-only and prevents arbitrary expression injection.
 */
export function resolveAgentConcurrency(
  agent: unknown,
  tenantSlug: string,
): ResolvedAgentConcurrency | undefined {
  const config =
    agent && typeof agent === "object"
      ? (
          agent as {
            concurrency?: {
              enabled?: boolean;
              max_concurrent_executions?: number;
              key?: string;
            };
          }
        ).concurrency
      : undefined;
  if (config?.enabled === false) return undefined;
  if (
    config?.max_concurrent_executions !== undefined &&
    (!Number.isInteger(config.max_concurrent_executions) ||
      config.max_concurrent_executions < 1 ||
      config.max_concurrent_executions > 1_000)
  ) {
    throw new TypeError(
      "concurrency.max_concurrent_executions must be an integer from 1 to 1000",
    );
  }
  const path = config?.key?.trim() || "$.subject";
  if (!/^\$(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.test(path)) {
    throw new TypeError(
      `concurrency.key must be a restricted event-data path such as '$.subject' or '$.inputs.candidate.id'`,
    );
  }
  const eventExpression = `event.data.${path.slice(2)}`;
  return {
    limit:
      typeof config?.max_concurrent_executions === "number"
        ? config.max_concurrent_executions
        : 8,
    key: `${JSON.stringify(`${tenantSlug}:`)} + ${eventExpression}`,
  };
}

export function resolveAgentTriggerNames(agent: {
  name: string;
  trigger: string[];
  cron?: string | null;
}): string[] {
  if (agent.trigger.length > 0) return [...agent.trigger];
  return typeof agent.cron === "string" && agent.cron.trim().length > 0
    ? [`__schedule.${agent.name}`]
    : [];
}

export function registerAgent(
  agent: AgentSpec,
  ctx: RegisterContext,
): InngestFunction.Any | null {
  const tenantSlug = ctx.tenantSlug;
  const fnId = `${tenantSlug}.${agent.name}`;
  const observability =
    normalizeAgentForExecution(agent).definition.observability;
  const traceSinkForRun = (): RuntimeTraceSink =>
    createFilteredTraceSink(ctx.traceSink ?? createDbTraceSink(ctx.tenantId), {
      traceLevel: observability?.trace_level,
      reasoningSummary: observability?.reasoning_summary,
    });
  const definitionHash = `sha256:${createHash("sha256")
    .update(canonicalJson(agent))
    .digest("hex")}`;

  const triggerNames = resolveAgentTriggerNames(agent);
  // No event or schedule trigger (e.g. manualEntry) → no Inngest function.
  if (triggerNames.length === 0) {
    return null;
  }

  const triggers = triggerNames.map((t) => ({
    event: `${tenantSlug}/${t}` as `${string}/${string}`,
  }));

  const concurrency = resolveAgentConcurrency(agent, tenantSlug);

  return inngest.createFunction(
    {
      id: fnId,
      name: agent.title ?? agent.name,
      // Every enabled key is tenant-prefixed. The default is subject; Studio
      // may author a restricted event-data path, or disable this limit.
      ...(concurrency ? { concurrency } : {}),
      retries: Math.min(
        20,
        Math.max(
          0,
          Math.floor((agent as AgentSpec & { retries?: number }).retries ?? 3),
        ),
      ) as
        | 0
        | 1
        | 2
        | 3
        | 4
        | 5
        | 6
        | 7
        | 8
        | 9
        | 10
        | 11
        | 12
        | 13
        | 14
        | 15
        | 16
        | 17
        | 18
        | 19
        | 20,
      // Operator kill switch (POST /v1/runs/:id/cancel). The route emits
      // `${tenantSlug}/run.cancel` carrying { runId, subject }. We match on
      // subject because the runId is allocated *inside* the function (the
      // triggering event doesn't know it yet, and Inngest's `cancelOn.if`
      // can only compare values already present on the trigger envelope).
      // Cancellation remains subject-scoped even when an authored
      // concurrency key uses another field. Trade-off: multiple in-flight
      // runs sharing a subject are cancelled together, the safer kill-switch
      // posture.
      cancelOn: [
        {
          event: `${tenantSlug}/run.cancel` as `${string}/${string}`,
          if: `async.data.subject == event.data.subject`,
        },
      ],
      // v4: triggers moved into opts (was a separate 2nd arg in v3)
      triggers,
    },
    async ({ event, step, logger }) => {
      const deliveryData = (event.data ?? {}) as Record<string, unknown>;
      if (!eventTargetsAgent(deliveryData, agent.name)) {
        return {
          skipped: true,
          reason: "targeted_event_for_another_agent",
          targetAgent: deliveryData.__invokedAgent,
        };
      }
      const subject =
        typeof deliveryData.subject === "string" ? deliveryData.subject : null;
      const triggerEventId =
        typeof deliveryData.__triggerEventId === "string"
          ? deliveryData.__triggerEventId
          : null;
      // Event Tester plumbing: the publish route stamps `__test: true` on the
      // Inngest envelope when the caller opted in. We propagate that into
      // `runs.isTest` so test traffic from operator publishes is filterable
      // and never pollutes production observability (PRD G5, NFR-7). The
      // legacy spelling is `__test`; downstream actions should not read it
      // directly — runs.isTest is the source of truth.
      const isTest = deliveryData.__test === true;
      const deliveredUsageAttribution = usageAttributionFromDeliveryData(
        deliveryData,
        ctx.tenantId,
      );

      // step.run memoizes results across Inngest replays. Wrap correlation +
      // run-row allocation so identical IDs are reused on every replay, and
      // we never create duplicate runs rows.
      const init = await step.run("init", async () => {
        const cid = correlationFromEvent(event);
        const rid = makeId("run");
        const db = getDb();
        const usageAttribution = mergeUsageAttribution(
          deliveredUsageAttribution,
          {
            billingAccountId: ctx.tenantId,
            correlationId: cid,
            invocationSource: runInvocationSource(
              deliveredUsageAttribution.invocationSource,
            ),
          },
        );

        // Resolve through the exact workflow version. `kebab_id` is only
        // unique within a workflow, so a global lookup could attach this run
        // to another tenant that happens to use the same stage/id.
        const resolvedAgent = db
          .select({ agent: agents, agentVersion: agentVersions })
          .from(agentVersions)
          .innerJoin(agents, eq(agents.id, agentVersions.agentId))
          .where(
            and(
              eq(agentVersions.workflowVersionId, ctx.workflowVersionId),
              eq(agents.kebabId, agent.id),
            ),
          )
          .all()[0];
        if (!resolvedAgent) {
          throw new Error(
            `[runtime] agent kebab_id=${agent.id} not found for workflow_version=${ctx.workflowVersionId} — bootstrap must run before functions register`,
          );
        }
        const agentRow = resolvedAgent.agent;
        const agentVersionRow = resolvedAgent.agentVersion;

        const startedAt = Date.now();
        db.insert(runs)
          .values({
            id: rid,
            tenantId: ctx.tenantId,
            agentId: agentRow.id,
            agentVersionId: agentVersionRow?.id ?? null,
            triggerEventId,
            status: "running",
            startedAt: new Date(startedAt),
            correlationId: cid,
            subject,
            isTest,
            invocationSource: runInvocationSource(
              usageAttribution.invocationSource,
            ),
            requestId: usageAttribution.requestId,
            interactionId: usageAttribution.interactionId,
            productSurface: usageAttribution.productSurface,
            productAction: usageAttribution.productAction,
            requestedBy:
              usageAttribution.actorType === "user"
                ? usageAttribution.actorId
                : undefined,
            definitionHash,
            outputValid: null,
            sideEffectMode: isTest ? "suppressed" : "live",
            logPath: null,
          })
          .run();
        try {
          const sink = traceSinkForRun();
          await sink.append({
            runId: rid,
            kind: "run",
            level: "minimal",
            name: "run.start",
            status: "running",
            startedAt: new Date(startedAt),
            summary: `Started ${isTest ? "test" : "event"} run for ${agent.name}`,
            data: {
              agentName: agent.name,
              eventName: event.name,
              definitionHash,
              testRun: isTest,
            },
            visibility: "user",
          });
        } catch (err) {
          logger.warn("run.start trace failed", { err: String(err) });
        }
        // run.start is logged HERE, inside the memoized `init` step, so an
        // Inngest replay/retry (the handler body re-runs, but step.run
        // returns its cached result without re-executing this callback)
        // doesn't append a duplicate `run.start` line to the file log.
        try {
          await writeRunLog(
            { tenantSlug, runId: rid, correlationId: cid },
            "INFO",
            "run.start",
            { agent: agent.name, event: event.name, subject: subject ?? "—" },
          );
        } catch (err) {
          logger.warn("run.start log failed", { err: String(err) });
        }
        return {
          runId: rid,
          correlationId: cid,
          agentDbId: agentRow.id,
          agentVersionId: agentVersionRow.id,
          startedAt,
        };
      });

      const runId = init.runId;
      const correlationId = init.correlationId;
      const usageAttribution = mergeUsageAttribution(
        deliveredUsageAttribution,
        {
          billingAccountId: ctx.tenantId,
          correlationId,
          invocationSource: runInvocationSource(
            deliveredUsageAttribution.invocationSource,
          ),
        },
      );
      const startedAtMs = init.startedAt;
      const startedAt = new Date(startedAtMs);
      const db = getDb();
      const bareEventName = event.name.startsWith(`${tenantSlug}/`)
        ? event.name.slice(tenantSlug.length + 1)
        : event.name;
      const deliveredEventId =
        typeof (event as { id?: unknown }).id === "string"
          ? (event as { id: string }).id
          : typeof deliveryData.event_id === "string" &&
              deliveryData.event_id.trim().length > 0
            ? deliveryData.event_id
            : makeId("evt");
      // Keep routing/control fields on the Inngest envelope, but expose only
      // the canonical logical event to validation, prompts, tools, and run
      // artifacts. Canonical ingress payloads round-trip unchanged here;
      // older direct Inngest/schedule events gain the same identity contract.
      const data = buildCanonicalEventPayload({
        eventName: bareEventName,
        eventId: triggerEventId ?? deliveredEventId,
        correlationId,
        subject,
        payload: deliveryData,
      });

      const logCtx = {
        tenantSlug,
        runId,
        correlationId,
      };
      const traceSink = traceSinkForRun();
      const artifactSink = ctx.artifactSinkFactory?.({
        tenantId: ctx.tenantId,
        runId,
      });
      const terminalArtifactSink =
        artifactSink ?? createFilesystemArtifactSink(runId);

      // Best-effort run-log writer. A logging IO failure must NEVER abort a
      // real agent run (matches emitStepLog in step-engine.ts). Every call
      // below is made from INSIDE a step.run() block so Inngest memoizes it —
      // replays/retries return the cached step result without re-running the
      // body, so the file log gets exactly one line per real execution
      // instead of one-per-replay (the prior bug).
      const safeRunLog = async (
        level: "INFO" | "WARN" | "ERROR",
        evt: string,
        fields: Record<string, unknown>,
      ): Promise<void> => {
        try {
          await writeRunLog(logCtx, level, evt, fields);
        } catch (err) {
          logger.warn("run-log write failed", { event: evt, err: String(err) });
        }
      };

      // run.start is logged inside the memoized `init` step above; this
      // Inngest logger line is replay-safe on its own.
      logger.info("run.start", { runId, agent: agent.name, event: event.name });

      let tokensIn = 0;
      let tokensOut = 0;
      let lastModel: string | null = null;
      let lastProvider: string | null = null;
      let lastOutputValid: boolean | null = null;
      let lastRawResponse: string | undefined;
      let lastResult: unknown = null;
      let executionInputs: Record<string, unknown> = data;
      const usesV2Definition =
        normalizeAgentForExecution(agent).compatibilityMode === "v2";
      let inputValid = !usesV2Definition;

      await ensureRunNotCancelled("before-input-validation");

      if (usesV2Definition) {
        try {
          executionInputs = await step.run("validate-inputs", async () => {
            const bound = bindTriggerInputs(agent, {
              name: event.name.replace(`${tenantSlug}/`, ""),
              data,
              subject,
            });
            const validated = validateAgentInputs(agent, bound);
            try {
              await traceSink.append({
                runId,
                kind: "input",
                level: "standard",
                name: "input.validation",
                status: "ok",
                summary: `Validated ${Object.keys(validated.values).length} named input(s)`,
                data: { inputIds: Object.keys(validated.values) },
                visibility: "user",
              });
            } catch (err) {
              logger.warn("input.validation trace failed", {
                err: String(err),
              });
            }
            return validated.values;
          });
          inputValid = true;
        } catch (error) {
          if (error instanceof AgentInputValidationError) {
            try {
              await traceSink.append({
                runId,
                kind: "input",
                level: "minimal",
                name: "input.validation",
                status: "failed",
                summary: "Named input validation failed before execution",
                data: { issues: error.issues },
                visibility: "user",
              });
            } catch {
              // The original validation error is the operator-facing cause.
            }
            await failRun(runId, error.message, startedAt, error.code);
          }
          throw error;
        }
      }

      for (let i = 0; i < agent.actions.length; i++) {
        const action = agent.actions[i]!;
        const ord = i + 1;
        await ensureRunNotCancelled(`before-action-${ord}`);

        if (action.type === "manual") {
          // Human-in-the-loop step (DESIGN.md §10):
          //   1) create task row inside step.run (memoized)
          //   2) waitForEvent("task.resolved") with matched taskId
          //   3) close step row with resolution
          const initStep = await step.run(`init-task-${ord}`, async () => {
            const sid = makeId("stp");
            const tid = makeId("tsk");
            const sStarted = Date.now();
            const dbInner = getDb();
            dbInner
              .insert(steps)
              .values({
                id: sid,
                runId,
                ord,
                name: action.name,
                type: action.type,
                status: "running",
                startedAt: new Date(sStarted),
              })
              .run();
            dbInner
              .insert(tasksTable)
              .values({
                id: tid,
                tenantId: ctx.tenantId,
                runId,
                type: action.task_type ?? action.name,
                title: `${agent.title ?? agent.name} · ${action.name}`,
                awaitingRole: action.awaiting_role ?? "operator",
                priority: "medium",
                status: "open",
                // A preceding logic/tool step often prepares the decision
                // brief. Persist it on the task so the operator sees the
                // evidence that caused the HITL checkpoint.
                payloadJson: buildManualTaskPayload({
                  agent,
                  action,
                  subject,
                  preparedContext: lastResult,
                }) as never,
              } as never)
              .run();
            return { stepId: sid, taskId: tid, sStarted };
          });

          // P5-TEN-01 — pin the predicate to the issuing tenant so a leaked
          // taskId in another tenant cannot resume this run. tasks.ts:resolve
          // now includes auth.tenantId in the event payload.
          const resolved = await step.waitForEvent(`wait-task-${ord}`, {
            event: "task.resolved",
            if: `async.data.taskId == "${initStep.taskId}" && async.data.tenantId == "${ctx.tenantId}"`,
            timeout: "7d",
          });

          if (!resolved) {
            // Timeout — mark task + step + run as failed.
            await step.run(`timeout-task-${ord}`, async () => {
              const dbInner = getDb();
              dbInner
                .update(steps)
                .set({
                  status: "failed",
                  error: "task timeout",
                  endedAt: new Date(),
                })
                .where(eq(steps.id, initStep.stepId))
                .run();
              dbInner
                .update(tasksTable)
                .set({ status: "snoozed" })
                .where(eq(tasksTable.id, initStep.taskId))
                .run();
            });
            await failRun(
              runId,
              `task ${initStep.taskId} timed out`,
              startedAt,
            );
            throw new Error("task timeout");
          }

          const resolutionEvent = (resolved.data ?? {}) as {
            taskId: string;
            decision?: unknown;
            payload?: unknown;
          };
          const resolution = buildManualTaskResolution({
            taskId: initStep.taskId,
            decision: resolutionEvent.decision,
            payload: resolutionEvent.payload,
          });

          await step.run(`close-task-${ord}`, async () => {
            const dbInner = getDb();
            const sEnded = Date.now();
            dbInner
              .update(steps)
              .set({
                // Human rejection is a valid domain outcome. Runtime failure
                // is reserved for timeouts/invalid events/infrastructure.
                status: "ok",
                endedAt: new Date(sEnded),
                durationMs: sEnded - initStep.sStarted,
              })
              .where(eq(steps.id, initStep.stepId))
              .run();
            dbInner
              .update(tasksTable)
              .set({
                status: "resolved",
                resolvedAt: new Date(sEnded),
                resolutionJson: resolution as never,
              })
              .where(eq(tasksTable.id, initStep.taskId))
              .run();
            // Domain outcome remains visible even though the durable step
            // completed successfully. Keep this inside the memoized block so
            // replays cannot duplicate log/trace audit evidence.
            await safeRunLog(
              resolution.decision === "reject" ? "WARN" : "INFO",
              "step.ok",
              {
                name: action.name,
                type: action.type,
                taskId: initStep.taskId,
                decision: resolution.decision,
                outcome: resolution.outcome,
              },
            );
            try {
              await traceSink.append({
                runId,
                stepId: initStep.stepId,
                kind: "step",
                level: "minimal",
                name: "manual.resolved",
                status: "ok",
                endedAt: new Date(sEnded),
                durationMs: sEnded - initStep.sStarted,
                summary: `Operator ${resolution.outcome} the manual task`,
                data: {
                  taskId: initStep.taskId,
                  decision: resolution.decision,
                  outcome: resolution.outcome,
                },
                visibility: "user",
              });
            } catch (err) {
              logger.warn("manual.resolved trace failed", {
                err: String(err),
              });
            }
          });

          // Every manual outcome has one stable output shape. Later actions,
          // strict output validation, artifacts, and emitted-event bindings
          // all consume this exact resolution envelope.
          lastResult = resolution;
          if (resolution.decision === "reject") {
            // A reject terminates remaining work, but intentionally proceeds
            // through output validation, artifact persistence, and every
            // authored emitted event below.
            break;
          }
          continue;
        }

        // tool | logic: atomic step.run with auto-managed step row.
        const stepOutcome = await step.run(action.name, async () => {
          const sid = makeId("stp");
          const sStarted = Date.now();
          const dbInner = getDb();
          dbInner
            .insert(steps)
            .values({
              id: sid,
              runId,
              ord,
              name: action.name,
              type: action.type,
              status: "running",
              startedAt: new Date(sStarted),
            })
            .run();

          try {
            const res = await runAction({
              // Thread the runId so the step engine can append tool-call +
              // tool-error + llm-call lines to THIS run's log file (the
              // portal Logs view tails it over SSE). The durable step id,
              // ordinal and trace sink also let the engine persist structured
              // model/tool/validation evidence and I/O refs.
              runId,
              stepId: sid,
              stepOrd: ord,
              trace: traceSink,
              finalOutput: i === agent.actions.length - 1,
              ctx: {
                agentName: agent.name,
                actionName: action.name,
                subject: subject ?? undefined,
                correlationId,
                tenantSlug,
                event: {
                  name: event.name,
                  data: {
                    ...data,
                    ...(usesV2Definition ? { inputs: executionInputs } : {}),
                  },
                },
                lastResult,
              },
              action,
              // Hand the step engine the slots it needs for prompt assembly
              // AND the tool-use loop. `tool_use` is the canonical roster
              // of advertised tools — the engine cross-references each
              // entry against `tenantRegistry.tools` before passing it to
              // the LLM, so a stale declaration silently no-ops instead of
              // crashing.
              agent: { ...agent, tenantId: ctx.tenantId },
              tenantRegistry: ctx.tenantRegistry,
              autoResolveManual: true,
              usageAttribution,
            });
            const sEnded = Date.now();
            dbInner
              .update(steps)
              .set({
                status: res.ok ? "ok" : "failed",
                endedAt: new Date(sEnded),
                durationMs: sEnded - sStarted,
                provider: res.provider ?? null,
                model: res.model ?? null,
                tokensIn: res.tokensIn ?? null,
                tokensOut: res.tokensOut ?? null,
                inputRef: res.outputArtifact
                  ? res.outputArtifact.replace(/-output\.json$/, "-input.json")
                  : null,
                outputRef: res.outputArtifact ?? null,
              })
              .where(eq(steps.id, sid))
              .run();
            // Summarise the tool fan-out so the step.ok run-log line carries
            // model + tool counts without re-reading the engine's per-tool
            // lines.
            const traces = Array.isArray(
              (res.meta as { toolCalls?: unknown } | undefined)?.toolCalls,
            )
              ? (
                  res.meta as {
                    toolCalls: Array<{ name: string; isError: boolean }>;
                  }
                ).toolCalls
              : [];
            // step.ok logged HERE, inside the memoized step.run block, so an
            // Inngest replay/retry doesn't append a duplicate line. Success
            // path only — a non-ok result is handled by the failRun branch
            // outside, and a thrown step by step.fail in the catch below.
            if (res.ok) {
              await safeRunLog("INFO", "step.ok", {
                name: action.name,
                type: action.type,
                duration: sEnded - sStarted + "ms",
                tokens_in: res.tokensIn ?? 0,
                tokens_out: res.tokensOut ?? 0,
                ...(res.model ? { model: res.model } : {}),
                ...(res.provider ? { provider: res.provider } : {}),
                tool_calls: traces.length,
                tool_errors: traces.filter((t) => t.isError).length,
              });
            }
            return {
              ok: res.ok,
              data: res.data,
              tokensIn: res.tokensIn ?? 0,
              tokensOut: res.tokensOut ?? 0,
              durationMs: sEnded - sStarted,
              model: res.model ?? null,
              provider: res.provider ?? null,
              toolCallCount: traces.length,
              toolErrorCount: traces.filter((t) => t.isError).length,
              outputValid:
                typeof res.meta?.outputValid === "boolean"
                  ? res.meta.outputValid
                  : null,
              rawResponse:
                typeof res.meta?.rawResponse === "string"
                  ? res.meta.rawResponse
                  : undefined,
              errorCode:
                typeof res.meta?.error === "string"
                  ? res.meta.error
                  : undefined,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            dbInner
              .update(steps)
              .set({
                status: "failed",
                endedAt: new Date(),
                durationMs: Date.now() - sStarted,
                error: message,
              })
              .where(eq(steps.id, sid))
              .run();
            // Surface the thrown step to the run log. Previously a step that
            // threw (vs. returned ok=false) only left a failed `steps` row +
            // an Inngest error — nothing in the operator-facing run log until
            // the run-level `run.end status=failed` line. Logged here, inside
            // step.run, so it fires exactly once per real execution. Via
            // safeRunLog so a log IO failure can't mask the original `err`.
            await safeRunLog("ERROR", "step.fail", {
              name: action.name,
              type: action.type,
              ord,
              error: message,
            });
            throw err;
          }
        });

        // Failed model turns still consumed tokens and can carry the raw
        // response needed for terminal diagnostics. Capture this evidence
        // before branching into failRun.
        tokensIn += stepOutcome.tokensIn;
        tokensOut += stepOutcome.tokensOut;
        lastModel = stepOutcome.model ?? lastModel;
        lastProvider = stepOutcome.provider ?? lastProvider;
        lastOutputValid = stepOutcome.outputValid ?? lastOutputValid;
        lastRawResponse = stepOutcome.rawResponse ?? lastRawResponse;
        lastResult = stepOutcome.data;

        if (!stepOutcome.ok) {
          await failRun(
            runId,
            `step ${action.name} returned ok=false${
              stepOutcome.errorCode ? ` (${stepOutcome.errorCode})` : ""
            }`,
            startedAt,
            stepOutcome.errorCode,
          );
          throw new Error(`step ${action.name} failed`);
        }
        if (action.type === "condition") {
          const evaluated =
            stepOutcome.data !== null &&
            typeof stepOutcome.data === "object" &&
            (stepOutcome.data as { evaluated?: unknown }).evaluated === true;
          const conditionAction = action as {
            true_action_id?: unknown;
            false_action_id?: unknown;
          };
          const target = evaluated
            ? conditionAction.true_action_id
            : conditionAction.false_action_id;
          if (typeof target === "string" && target.length > 0) {
            const targetIndex = agent.actions.findIndex(
              (candidate) =>
                ((candidate as { id?: unknown }).id ?? candidate.name) ===
                target,
            );
            if (targetIndex <= i) {
              await failRun(
                runId,
                `condition ${action.name} selected invalid target ${target}`,
                startedAt,
                "condition_target_invalid",
              );
              throw new Error(
                `condition target '${target}' must be a later action`,
              );
            }
            i = targetIndex - 1;
          }
        }
        // (step.ok is written inside the memoized step.run block above.)
      }

      await ensureRunNotCancelled("before-output-validation");
      if (usesV2Definition && lastOutputValid !== true) {
        try {
          const finalValidation = await step.run(
            "validate-final-output",
            async () =>
              parseValidateAndRepairOutput({
                definition: agent,
                candidate: lastResult,
                trace: traceSink,
                runId,
              }),
          );
          lastResult = finalValidation.value;
          lastOutputValid = finalValidation.valid;
          lastRawResponse = finalValidation.rawResponse;
        } catch (error) {
          if (error instanceof OutputSchemaValidationError) {
            lastOutputValid = false;
            lastRawResponse = error.invalidResponse;
            await failRun(runId, error.message, startedAt, error.code);
          }
          throw error;
        }
      }

      await ensureRunNotCancelled("before-finalize");

      // Persist the exact output, map every v2 emission, persist run-record,
      // and only then mark success. The whole body is memoized by Inngest.
      const finalize = await step.run("finalize", async () => {
        const dbInner = getDb();
        const endedAtMs = Date.now();
        const endedAt = new Date(endedAtMs);
        const statusAtFinalize = dbInner
          .select({ status: runs.status })
          .from(runs)
          .where(eq(runs.id, runId))
          .limit(1)
          .all()[0]?.status;
        if (statusAtFinalize === "cancelled") {
          return {
            cancelled: true,
            emittedEventId: null,
            endedAtMs,
            emissions: [],
          };
        }
        if (statusAtFinalize !== "running") {
          throw new Error(
            `run_terminal_transition_conflict: expected running, found ${statusAtFinalize ?? "missing"}`,
          );
        }
        const outputFilename =
          (
            agent as AgentSpec & {
              output_config?: { artifact?: { filename?: string } };
            }
          ).output_config?.artifact?.filename ?? "output.json";

        let persistedOutput: RuntimePersistedArtifact;
        let outputArtifactId: string | null;
        try {
          persistedOutput = await terminalArtifactSink.persist({
            role: "output",
            logicalName: outputFilename,
            contentType: "application/json",
            payload: lastResult,
          });
          outputArtifactId = registerPersistedArtifact(persistedOutput);
        } catch (error) {
          const message = `artifact_persistence_failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          dbInner
            .update(runs)
            .set({
              status: "failed",
              endedAt,
              durationMs: endedAtMs - startedAtMs,
              outputValid: false,
              errorMessage: message,
            })
            .where(eq(runs.id, runId))
            .run();
          throw new Error(message);
        }
        let persistedRawResponse: RuntimePersistedArtifact | null = null;
        let rawResponseArtifactId: string | null = null;
        const persistRawResponse =
          (
            agent as AgentSpec & {
              output_config?: {
                artifact?: { persist_raw_response?: boolean };
              };
            }
          ).output_config?.artifact?.persist_raw_response === true;
        if (persistRawResponse && lastRawResponse !== undefined) {
          try {
            persistedRawResponse = await terminalArtifactSink.persist({
              role: "raw_response",
              logicalName: "raw-response.txt",
              contentType: "text/plain; charset=utf-8",
              payload: lastRawResponse,
            });
            rawResponseArtifactId =
              registerPersistedArtifact(persistedRawResponse);
          } catch (error) {
            const message = `artifact_persistence_failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
            dbInner
              .update(runs)
              .set({
                status: "failed",
                endedAt,
                durationMs: endedAtMs - startedAtMs,
                errorMessage: message,
              })
              .where(eq(runs.id, runId))
              .run();
            throw new Error(message);
          }
        }

        const resolvedEmissions = resolveAgentEmissions({
          definition: agent,
          inputs: executionInputs,
          outputs: lastResult,
          source: {
            agentName: agent.name,
            runId,
            subject,
            correlationId,
          },
          suppress: isTest,
        });
        const finalizedEmissions: Array<{
          name: string;
          eventId: string | null;
          payload: Record<string, unknown>;
          outputPortIds: string[];
          suppressed: boolean;
        }> = [];
        const emittedRecordRows: RunEmittedEvent[] = [];

        for (const emission of resolvedEmissions) {
          if (emission.suppressed) {
            finalizedEmissions.push({ ...emission, eventId: null });
            await safeRunLog("INFO", "event.suppressed", {
              name: emission.name,
              reason: "test_mode",
            });
            try {
              await traceSink.append({
                runId,
                kind: "event",
                level: "standard",
                name: emission.name,
                status: "skipped",
                summary: `Suppressed downstream event '${emission.name}' in test mode`,
                data: { outputPortIds: emission.outputPortIds },
                visibility: "user",
              });
            } catch {
              // Event persistence remains authoritative when trace is absent.
            }
            continue;
          }

          const eventId = makeId("evt");
          const emittedAt = new Date();
          const logicalPayload = buildCanonicalEventPayload({
            eventName: emission.name,
            eventId,
            correlationId,
            subject,
            payload: emission.payload,
          });
          const payloadRef = await appendToLedger(tenantSlug, {
            id: eventId,
            name: emission.name,
            subject: subject ?? undefined,
            data: logicalPayload,
            ts: emittedAt.getTime(),
          });
          dbInner
            .insert(events)
            .values({
              id: eventId,
              tenantId: ctx.tenantId,
              name: emission.name,
              sourceAgentId: init.agentDbId,
              subject,
              payloadRef,
            })
            .run();
          const outputPortIds =
            emission.outputPortIds.length > 0 ? emission.outputPortIds : ["*"];
          for (const outputPortId of outputPortIds) {
            const linkId = makeId("ree");
            dbInner
              .insert(runEmittedEvents)
              .values({
                id: linkId,
                tenantId: ctx.tenantId,
                runId,
                eventId,
                outputPortId,
                createdAt: emittedAt,
              })
              .run();
            emittedRecordRows.push({
              id: linkId,
              eventId,
              eventName: emission.name,
              outputPortId,
              createdAt: emittedAt,
            });
          }
          finalizedEmissions.push({
            ...emission,
            payload: logicalPayload,
            eventId,
          });
          await safeRunLog("INFO", "event.emit", {
            name: emission.name,
            event_id: eventId,
            output_ports: outputPortIds,
          });
          try {
            await traceSink.append({
              runId,
              kind: "event",
              level: "standard",
              name: emission.name,
              status: "ok",
              summary: `Prepared downstream event '${emission.name}'`,
              data: { eventId, outputPortIds },
              visibility: "user",
            });
          } catch {
            // Event row + ledger are the durable source of truth.
          }
        }

        const outputMetadata = outputArtifactId
          ? toRunArtifactMetadata(outputArtifactId, persistedOutput, endedAt)
          : null;
        const rawResponseMetadata =
          rawResponseArtifactId && persistedRawResponse
            ? toRunArtifactMetadata(
                rawResponseArtifactId,
                persistedRawResponse,
                endedAt,
              )
            : null;
        const runRecord: AgentRunRecord = {
          schemaVersion: 1,
          runId,
          tenantId: ctx.tenantId,
          agentId: init.agentDbId,
          status: "ok",
          invocationSource: "event",
          target: {
            kind: "live",
            agentVersionId: init.agentVersionId,
          },
          definitionHash,
          sessionId: null,
          correlationId,
          subject,
          validation: {
            inputValid: true,
            outputValid: lastOutputValid,
            issues: [],
          },
          artifacts: [outputMetadata, rawResponseMetadata].filter(
            (value): value is RunArtifactMetadata => value !== null,
          ),
          emittedEvents: emittedRecordRows,
          model:
            lastProvider || lastModel
              ? {
                  ...(lastProvider
                    ? { provider: lastProvider as ProviderId }
                    : {}),
                  ...(lastModel ? { model: lastModel } : {}),
                  tokensIn,
                  tokensOut,
                }
              : undefined,
          timing: {
            queuedAt: null,
            startedAt,
            endedAt,
            durationMs: endedAtMs - startedAtMs,
          },
          error: null,
        };
        let runRecordArtifactId: string | null;
        try {
          const persistedRunRecord = await terminalArtifactSink.persist({
            role: "run_record",
            logicalName: "run-record.json",
            contentType: "application/json",
            payload: runRecord,
          });
          runRecordArtifactId = registerPersistedArtifact(persistedRunRecord);
        } catch (error) {
          const message = `artifact_persistence_failed: ${
            error instanceof Error ? error.message : String(error)
          }`;
          dbInner
            .update(runs)
            .set({
              status: "failed",
              endedAt,
              durationMs: endedAtMs - startedAtMs,
              errorMessage: message,
            })
            .where(eq(runs.id, runId))
            .run();
          throw new Error(message);
        }

        // Existing consumers still expect run-output.json. Keep the legacy
        // envelope as a compatibility artifact while output.json remains the
        // exact authored shape.
        try {
          const legacyPath = await writeArtifact(runId, "run-output.json", {
            run_id: runId,
            agent: agent.name,
            title: agent.title ?? agent.name,
            tenant: tenantSlug,
            status: "ok",
            trigger: { name: event.name, subject, data },
            output: lastResult,
            emitted_events: finalizedEmissions.map((item) => item.name),
            tokens: {
              in: tokensIn,
              out: tokensOut,
              provider: lastProvider,
              model: lastModel,
            },
            started_at: startedAt.toISOString(),
            ended_at: endedAt.toISOString(),
          });
          const legacySize = (await stat(legacyPath)).size;
          dbInner
            .insert(artifacts)
            .values({
              id: makeId("art"),
              tenantId: ctx.tenantId,
              runId,
              kind: "application/json",
              role: "other",
              logicalName: "run-output.json",
              contentType: "application/json",
              path: legacyPath,
              size: legacySize,
            })
            .run();
        } catch (error) {
          logger.warn("legacy run-output artifact failed", {
            err: String(error),
          });
        }

        const emittedEventId =
          finalizedEmissions.find((item) => item.eventId)?.eventId ?? null;
        const completed = dbInner
          .update(runs)
          .set({
            status: "ok",
            endedAt,
            durationMs: endedAtMs - startedAtMs,
            tokensIn,
            tokensOut,
            model: lastModel,
            outputValid: lastOutputValid,
            emittedEventId,
          })
          .where(and(eq(runs.id, runId), eq(runs.status, "running")))
          .run();
        if (completed.changes !== 1) {
          const currentStatus = dbInner
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, runId))
            .limit(1)
            .all()[0]?.status;
          if (currentStatus === "cancelled") {
            return {
              cancelled: true,
              emittedEventId: null,
              endedAtMs,
              emissions: [],
            };
          }
          throw new Error(
            `run_terminal_transition_conflict: expected running, found ${currentStatus ?? "missing"}`,
          );
        }
        try {
          await traceSink.append({
            runId,
            kind: "artifact",
            level: "standard",
            name: "terminal.artifacts",
            status: "ok",
            endedAt,
            summary: "Persisted mandatory output.json and run-record.json",
            data: {
              outputArtifactId,
              runRecordArtifactId,
              rawResponseArtifactId,
            },
            visibility: "user",
          });
          await traceSink.append({
            runId,
            kind: "run",
            level: "minimal",
            name: "run.end",
            status: "ok",
            startedAt,
            endedAt,
            durationMs: endedAtMs - startedAtMs,
            summary: "Agent run completed successfully",
            data: {
              emittedEventCount: finalizedEmissions.filter(
                (item) => item.eventId,
              ).length,
              suppressedEventCount: finalizedEmissions.filter(
                (item) => item.suppressed,
              ).length,
            },
            visibility: "user",
          });
        } catch {
          // Terminal DB state and artifacts must not be rolled back by trace IO.
        }

        // UC-V11-22 / AR-GAP-07 / PF-GAP-08 — Prometheus `runs_total`
        // bump for the manifest engine. Lives inside this `step.run`
        // block so Inngest replays don't double-count: step results are
        // memoized, so the .inc only fires on the actual execution.
        // The metrics registry is injected at api boot via
        // `setRuntimeMetrics()`; missing in tests/standalone callers, in
        // which case we silently skip.
        const m = getRuntimeMetrics();
        if (m) {
          m.runs.inc({
            tenant: tenantSlug,
            agent: agent.name,
            model: lastModel ?? "unknown",
            status: "ok",
          });
          m.runDuration?.observe(endedAtMs - startedAtMs, {
            tenant: tenantSlug,
            agent: agent.name,
          });
        }
        // run.end logged inside this memoized block so replays don't append
        // a duplicate terminal line.
        await safeRunLog("INFO", "run.end", {
          status: "ok",
          duration: endedAtMs - startedAtMs + "ms",
          emitted:
            finalizedEmissions
              .filter((item) => item.eventId)
              .map((item) => item.name)
              .join(",") || "—",
        });
        return {
          cancelled: false,
          emittedEventId,
          endedAtMs,
          emissions: finalizedEmissions,
        };
      });

      if (finalize.cancelled) {
        await ensureRunNotCancelled("during-finalize");
        throw new Error("run_cancelled during finalize");
      }

      // The actual inngest.send must be outside step.run (step results are
      // memoized; sending an event inside a step would re-send on replay).
      // We use step.sendEvent which is Inngest's idempotent send primitive.
      // The event.emit + run.end LOG lines were already written inside the
      // memoized `finalize` step above, so they aren't duplicated here.
      for (let index = 0; index < finalize.emissions.length; index += 1) {
        const emission = finalize.emissions[index]!;
        if (!emission.eventId || emission.suppressed) continue;
        await step.sendEvent(`emit.${index}.${emission.name}`, {
          name: `${tenantSlug}/${emission.name}` as `${string}/${string}`,
          data: buildManifestEventDeliveryData({
            logicalPayload: emission.payload,
            eventId: emission.eventId,
            correlationId,
            usageAttribution,
          }),
        });
      }

      return {
        ok: true,
        runId,
        emittedEventId: finalize.emittedEventId,
        emittedEventIds: finalize.emissions
          .map((item: { eventId: string | null }) => item.eventId)
          .filter((id: string | null): id is string => Boolean(id)),
      };

      function registerPersistedArtifact(
        persisted: RuntimePersistedArtifact,
      ): string | null {
        if (artifactSink) return persisted.id ?? null;
        if (!persisted.path) {
          throw new Error(
            `artifact_persistence_failed: '${persisted.logicalName}' has no storage path`,
          );
        }
        const artifactId = persisted.id ?? makeId("art");
        getDb()
          .insert(artifacts)
          .values({
            id: artifactId,
            tenantId: ctx.tenantId,
            runId,
            stepId: persisted.stepId ?? null,
            kind: persisted.contentType,
            role: persisted.role,
            logicalName: persisted.logicalName,
            contentType: persisted.contentType,
            sha256: persisted.sha256,
            schemaId: persisted.schemaId ?? null,
            metadataJson: (persisted.metadata ?? null) as never,
            redacted: persisted.redacted,
            retentionUntil: persisted.retentionUntil ?? null,
            path: persisted.path,
            size: persisted.size,
          })
          .run();
        return artifactId;
      }

      function toRunArtifactMetadata(
        id: string,
        persisted: RuntimePersistedArtifact,
        createdAt: Date,
      ): RunArtifactMetadata {
        return {
          id,
          runId,
          stepId: persisted.stepId ?? null,
          role: persisted.role,
          logicalName: persisted.logicalName,
          contentType: persisted.contentType,
          size: persisted.size,
          sha256: persisted.sha256,
          schemaId: persisted.schemaId ?? null,
          metadata: persisted.metadata ?? null,
          redacted: persisted.redacted,
          createdAt,
          retentionUntil: persisted.retentionUntil ?? null,
        };
      }

      async function ensureRunNotCancelled(checkpoint: string): Promise<void> {
        const current = getDb()
          .select()
          .from(runs)
          .where(eq(runs.id, runId))
          .limit(1)
          .all()[0];
        if (!current || current.status !== "cancelled") return;

        await step.run(`finalize-cancel-${runId}`, async () =>
          persistCancelledRun(current, checkpoint),
        );

        throw new Error(`run_cancelled at ${checkpoint}`);
      }

      async function persistCancelledRun(
        current: typeof runs.$inferSelect,
        checkpoint: string,
      ): Promise<void> {
        const ended = current.endedAt ?? new Date();
        const terminalMessage = current.errorMessage ?? "cancelled_by_operator";
        const cancelledRecord: AgentRunRecord = {
          schemaVersion: 1,
          runId,
          tenantId: ctx.tenantId,
          agentId: init.agentDbId,
          status: "cancelled",
          invocationSource: "event",
          target: {
            kind: "live",
            agentVersionId: init.agentVersionId,
          },
          definitionHash,
          sessionId: null,
          correlationId,
          subject,
          validation: {
            inputValid,
            outputValid: lastOutputValid,
            issues: [],
          },
          artifacts: [],
          emittedEvents: [],
          model:
            lastProvider || lastModel
              ? {
                  ...(lastProvider
                    ? { provider: lastProvider as ProviderId }
                    : {}),
                  ...(lastModel ? { model: lastModel } : {}),
                  tokensIn,
                  tokensOut,
                }
              : undefined,
          timing: {
            queuedAt: null,
            startedAt,
            endedAt: ended,
            durationMs: Math.max(0, ended.getTime() - startedAtMs),
          },
          error: { code: "run_cancelled", message: terminalMessage },
        };
        try {
          // A cancellation can win while success/failure evidence is being
          // written. Replace any stale terminal envelope so run-record.json
          // always agrees with the authoritative cancelled DB status.
          getDb()
            .delete(artifacts)
            .where(
              and(
                eq(artifacts.runId, runId),
                eq(artifacts.logicalName, "run-record.json"),
              ),
            )
            .run();
          const persisted = await persistTerminalRunArtifacts({
            record: cancelledRecord,
            sink: terminalArtifactSink,
          });
          registerPersistedArtifact(persisted.runRecord);
        } catch (error) {
          logger.warn("cancelled run-record persistence failed", {
            runId,
            err: String(error),
          });
        }

        getDb()
          .update(runs)
          .set({
            endedAt: ended,
            durationMs: Math.max(0, ended.getTime() - startedAtMs),
            tokensIn,
            tokensOut,
            model: lastModel,
            outputValid: lastOutputValid,
            errorMessage: terminalMessage,
          })
          .where(and(eq(runs.id, runId), eq(runs.status, "cancelled")))
          .run();
        try {
          await traceSink.append({
            runId,
            kind: "run",
            level: "minimal",
            name: "run.cancel",
            status: "ok",
            startedAt,
            endedAt: ended,
            durationMs: Math.max(0, ended.getTime() - startedAtMs),
            summary: "Agent run cancelled by operator",
            data: { checkpoint },
            visibility: "user",
          });
          await writeRunLog(logCtx, "WARN", "run.end", {
            status: "cancelled",
            checkpoint,
          });
        } catch (error) {
          logger.warn("run.cancel trace/log failed", { err: String(error) });
        }
      }

      async function failRun(
        rid: string,
        message: string,
        started: Date,
        errorCode?: string,
      ): Promise<void> {
        // UC-V11-35 / PF-GAP-15 — wrap the run-status flip in `step.run`
        // so Inngest's exactly-once contract serializes it with any
        // concurrent retry. Without the wrapper, a flake between the
        // failure detection and the DB write could fire `failRun` twice
        // (once per replay), tombstoning a run that the retry actually
        // recovered.
        await step.run(`finalize-fail-${rid}`, async () => {
          const ended = new Date();
          const statusBeforeFailure = db
            .select()
            .from(runs)
            .where(eq(runs.id, rid))
            .limit(1)
            .all()[0];
          if (statusBeforeFailure?.status === "cancelled") {
            await persistCancelledRun(
              statusBeforeFailure,
              "during-failure-finalization",
            );
            return;
          }
          if (
            !statusBeforeFailure ||
            statusBeforeFailure.status !== "running"
          ) {
            throw new Error(
              `run_terminal_transition_conflict: expected running, found ${statusBeforeFailure?.status ?? "missing"}`,
            );
          }
          let terminalMessage = message;
          const failureArtifacts: RunArtifactMetadata[] = [];
          const persistRawResponse =
            (
              agent as AgentSpec & {
                output_config?: {
                  artifact?: { persist_raw_response?: boolean };
                };
              }
            ).output_config?.artifact?.persist_raw_response === true;
          if (persistRawResponse && lastRawResponse !== undefined) {
            try {
              const persistedRawResponse = await terminalArtifactSink.persist({
                role: "raw_response",
                logicalName: "raw-response.txt",
                contentType: "text/plain; charset=utf-8",
                payload: lastRawResponse,
              });
              const artifactId =
                registerPersistedArtifact(persistedRawResponse);
              if (artifactId) {
                failureArtifacts.push(
                  toRunArtifactMetadata(
                    artifactId,
                    persistedRawResponse,
                    ended,
                  ),
                );
              }
            } catch (error) {
              terminalMessage = `${terminalMessage}; artifact_persistence_failed: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }
          const failedRecord: AgentRunRecord = {
            schemaVersion: 1,
            runId: rid,
            tenantId: ctx.tenantId,
            agentId: init.agentDbId,
            status: "failed",
            invocationSource: "event",
            target: {
              kind: "live",
              agentVersionId: init.agentVersionId,
            },
            definitionHash,
            sessionId: null,
            correlationId,
            subject,
            validation: {
              inputValid: errorCode !== "input_schema_invalid",
              outputValid: errorCode === "output_schema_invalid" ? false : null,
              issues: [],
            },
            artifacts: failureArtifacts,
            emittedEvents: [],
            model:
              lastProvider || lastModel
                ? {
                    ...(lastProvider
                      ? { provider: lastProvider as ProviderId }
                      : {}),
                    ...(lastModel ? { model: lastModel } : {}),
                    tokensIn,
                    tokensOut,
                  }
                : undefined,
            timing: {
              queuedAt: null,
              startedAt: started,
              endedAt: ended,
              durationMs: ended.getTime() - started.getTime(),
            },
            error: {
              ...(errorCode ? { code: errorCode } : {}),
              message: terminalMessage,
            },
          };
          try {
            const persisted = await persistTerminalRunArtifacts({
              record: failedRecord,
              sink: terminalArtifactSink,
            });
            registerPersistedArtifact(persisted.runRecord);
          } catch (error) {
            terminalMessage = `${terminalMessage}; artifact_persistence_failed: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
          const failed = db
            .update(runs)
            .set({
              status: "failed",
              endedAt: ended,
              durationMs: ended.getTime() - started.getTime(),
              tokensIn,
              tokensOut,
              model: lastModel,
              outputValid: errorCode === "output_schema_invalid" ? false : null,
              errorMessage: terminalMessage,
            })
            .where(and(eq(runs.id, rid), eq(runs.status, "running")))
            .run();
          if (failed.changes !== 1) {
            const current = db
              .select()
              .from(runs)
              .where(eq(runs.id, rid))
              .limit(1)
              .all()[0];
            if (current?.status === "cancelled") {
              await persistCancelledRun(current, "during-failure-finalization");
              return;
            }
            throw new Error(
              `run_terminal_transition_conflict: expected running, found ${current?.status ?? "missing"}`,
            );
          }

          // UC-V11-22 / AR-GAP-07 — `runs_total{status="failed"}` so the
          // dashboards see manifest-engine failures, not just code-agent
          // failures (which already bump from BaseAgent.run).
          const m = getRuntimeMetrics();
          if (m) {
            m.runs.inc({
              tenant: tenantSlug,
              agent: agent.name,
              model: lastModel ?? "unknown",
              status: "failed",
            });
          }
          // run.end (failed) logged inside this memoized block so a replay
          // doesn't append a duplicate terminal line, and via try/catch so a
          // log IO failure can't mask the run failure being recorded.
          try {
            await traceSink.append({
              runId: rid,
              kind: "run",
              level: "minimal",
              name: "run.end",
              status: "failed",
              startedAt: started,
              endedAt: ended,
              durationMs: ended.getTime() - started.getTime(),
              summary: "Agent run failed",
              data: {
                ...(errorCode ? { code: errorCode } : {}),
                message: terminalMessage,
              },
              visibility: "user",
            });
            await writeRunLog(logCtx, "ERROR", "run.end", {
              status: "failed",
              error: terminalMessage,
            });
          } catch (err) {
            logger.warn("run.end(failed) log failed", { err: String(err) });
          }
        });
      }
    },
  );
}
