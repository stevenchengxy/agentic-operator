/**
 * registerAgent — turns an AgentSpec into an Inngest function tied to a tenant.
 *
 * Per DESIGN.md §5:
 *   - One Inngest function per (tenant, agent).
 *   - Function ID: `${tenantSlug}.${agentName}` unless the tenant's transport
 *     adapter explicitly owns a legacy external id mapping.
 *   - Concurrency key: `event.data.subject` (one run per subject in flight).
 *   - Retries: manifest `retries` (0–10) when declared, else 3 (Inngest default).
 *   - Triggers: tenant-namespaced by default, or projected by the selected
 *     tenant transport adapter when it owns an external wire contract.
 *
 * The handler:
 *   1. Allocates a run ID + correlation ID (correlation propagates through chains).
 *   2. Inserts a `runs` row with status=running, then `steps` rows per action.
 *   3. Calls runAction() inside step.run() so retries are durable.
 *   4. After all steps, picks an emitted event (first item in `triggered_event`),
 *      inserts an outbound `events` row, appends to the ledger, sends to Inngest.
 *   5. Updates the run with status=ok + emitted_event_id.
 */

import { createHash } from "node:crypto";

import { appIdForTenant, getTenantInngest } from "./client";
import { runAction, type LlmTurnTrace, type StepOutput } from "./step-engine";
import {
  codeActExecutionReceiptFromMeta,
  type CodeActExecutionReceipt,
  type CodeActIsolation,
} from "./codeact-receipt";
import {
  foreachStepId,
  materializeForeach,
  resolveConditionPath,
  runSequentialForeach,
  stableStepId,
  shouldSkip,
  softInvoke,
  type GateState,
} from "./action-plan";
import { selectEmittedEvents, type EmitIntent } from "./emit-select";
import { appendToLedger } from "./event-ledger";
import { publish } from "./broadcast";
import { writeArtifact } from "./artifacts";
import { logPathFor, writeRunLog } from "./log-writer";
import { correlationFromEvent, withCorrelation } from "./correlation";
import {
  flattenActionSpecs,
  type ActionSpec,
  type AgentSpec,
  type FactoryInputBinding,
} from "./manifest";
import {
  InputBindingResolutionError,
  applyHumanInputResult,
  applyObjectLookupResult,
  initializeInputBindings,
  prepareObjectLookupArguments,
  resolveAvailableStepOutputBindings,
  unresolvedRequiredInputBindings,
  type RuntimeInputBindingIssue,
} from "./input-bindings";
import {
  classifyActionFailure,
  failureForDisposition,
  isNonRetriableFailure,
  type ActionFailureResolution,
  type RuntimeOnErrorPolicy,
} from "./error-policy";
import { makeId, materializeInvokePayload } from "@agentic/shared";
import {
  agents,
  agentVersions,
  events,
  eventStore,
  llmTurns,
  runs,
  steps,
  tasks as tasksTable,
  workflows,
  getDb,
} from "@agentic/db";
import { eq, and } from "drizzle-orm";

/**
 * #W0 — is raw LLM-turn capture enabled? Default ON. Set
 * AGENTIC_CAPTURE_LLM_TURNS to a falsy value (`0`/`false`/`no`/`off`) to stop
 * persisting the model's response/reasoning text (e.g. for PII-sensitive
 * deployments); token counts on `steps`/`llm_calls` are unaffected.
 */
function captureLlmTurns(): boolean {
  const raw = (process.env.AGENTIC_CAPTURE_LLM_TURNS ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

import type {
  TenantEventAdapter,
  TenantRegistry,
  ToolDescriptor,
} from "@agentic/agent-kit";
import type { InngestFunction } from "inngest";
import { getRuntimeMetrics } from "./llm-host";
import { createMemoryHandle } from "./memory";
import { runWithTraceContext } from "./trace-context";
// #COMMS — inter-agent message envelope: carry-forward payload assembler + content-addressed offload.
import {
  assembleEmitPayload,
  mergeStepResults,
  rehydratePayloadAsync,
} from "./message-envelope";
import { makeDurableBlobOffloader, resolveBlobRefAsync } from "./blob-store";
import {
  scheduledAgentTriggerName,
  tenantEventName,
  tenantFunctionId,
} from "./event-name";
import { resolveTenantEventAdapter } from "./event-adapter";
import {
  assertSandboxAttemptDispatchAllowed,
  isFactorySandboxTenant,
} from "./sandbox-mode";
import {
  productionCodeActManifestSha256,
  revalidateProductionGeneratedAgentCapability,
  type ProductionCodeActCapability,
  type ProductionGeneratedAgentAuthorizationRequest,
} from "./production-codeact-authorization";

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
  /**
   * Optional per-registration broker-envelope override. The tenant registry's
   * adapter is used otherwise; ordinary tenants receive the identity adapter.
   */
  eventAdapter?: TenantEventAdapter;
  /**
   * Phase 1a — optional resolver mapping an `invoke` action's target ref (an agent name or
   * Inngest function id) to the registered InngestFunction, so `type:"invoke"` actions can
   * synchronously call a sub-agent via step.invoke. Missing/failed targets are terminal unless
   * the manifest explicitly declares on_error:"soft" with default_result. Wired in bootstrap
   * after all functions are built (so siblings resolve by handler-run time).
   */
  resolveFunction?: (ref: string) => InngestFunction.Any | undefined;
  /**
   * Phase 2 — brain-authored declarative HTTP tools (from factory_tools), built into runtime
   * ToolDescriptors via buildDeclarativeOverlay. Merged into the per-step tenant tool map so the
   * step-engine resolves them (overlay → tenant → global) — this is what makes a tool the brain
   * DECLARED actually INVOKABLE by the deployed agent. Domain-scoped + injected by the api.
   */
  declarativeTools?: Record<string, ToolDescriptor>;
  /** Opaque authority minted from the durable Agent Factory promotion ledger.
   * It is captured by the registered handler and cannot be reconstructed from
   * manifest JSON. Declarative and sandbox agents leave it undefined. */
  productionCodeActCapability?: ProductionCodeActCapability;
  productionCodeActManifestSha256?: string;
  productionCodeActWorkflowManifestSha256?: string;
  /** Opaque promotion authority required for every generated production Agent,
   * including declarative plans. The CodeAct-specific fields above remain the
   * final handler-execution binding for exact code bytes. */
  productionGeneratedAgentCapability?: ProductionCodeActCapability;
  productionGeneratedAgentManifestSha256?: string;
  productionGeneratedWorkflowManifestSha256?: string;
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
    // Generated agents (Agent Factory) supply their own default prompt at runtime — not a missing
    // hand-written prompt, so they never block boot.
    if ((agent as { generated?: boolean }).generated) continue;
    for (const action of flattenActionSpecs(agent.actions)) {
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

/** Inngest accepts a literal 0–20 for `retries`; the manifest caps agents at 10. */
export type FunctionRetryCount = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/**
 * Agent-level retry budget for the Inngest function. The manifest's optional
 * `retries` (AgentSchema, integer 0–10) wins when declared; absence keeps the
 * historical default of 3. Defensively clamped so a value that bypassed schema
 * validation can never exceed Inngest's accepted range. Exported for TC-12.
 */
export function functionRetries(
  agent: Pick<AgentSpec, "retries">,
): FunctionRetryCount {
  const r = agent.retries;
  if (typeof r !== "number" || !Number.isFinite(r)) return 3;
  return Math.min(Math.max(Math.trunc(r), 0), 10) as FunctionRetryCount;
}

interface RuntimeStepOutcome {
  ok: boolean;
  data: unknown;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  model?: string;
  provider?: string;
  meta?: Record<string, unknown>;
}

/** Persist/broadcast only fields authored by the isolated CodeAct runtime.
 * A manifest's `codeExecuted` flag is an execution request and never reaches
 * this mapper. */
function codeActReceiptFields(receipt: CodeActExecutionReceipt) {
  return {
    codeRan: receipt.codeRan,
    codeExecuted: receipt.codeExecuted,
    codeIsolation: receipt.isolation,
    codeSha256: receipt.codeSha256,
    codeAttestation: receipt.attestation,
    codeExecutionFailure: receipt.failure,
  } as const;
}

const codeActRunReceiptSelection = {
  codeRan: runs.codeRan,
  codeExecuted: runs.codeExecuted,
  codeIsolation: runs.codeIsolation,
  codeSha256: runs.codeSha256,
  codeAttestation: runs.codeAttestation,
  codeExecutionFailure: runs.codeExecutionFailure,
} as const;

function storedCodeActReceiptFields(receipt: {
  codeRan: boolean | null;
  codeExecuted: boolean | null;
  codeIsolation: string | null;
  codeSha256: string | null;
  codeAttestation: CodeActExecutionReceipt["attestation"] | null;
  codeExecutionFailure: string | null;
}) {
  const codeIsolation: CodeActIsolation | null =
    receipt.codeIsolation === "worker_thread" ||
    receipt.codeIsolation === "isolated_subprocess" ||
    receipt.codeIsolation === "isolated_container"
      ? receipt.codeIsolation
      : null;
  return {
    ...receipt,
    codeIsolation,
  };
}

class ActionReturnedFailure extends Error {
  readonly output: unknown;

  constructor(actionName: string, output: unknown) {
    super(`action ${actionName} returned ok=false`);
    this.name = "ActionReturnedFailure";
    this.output = output;
  }
}

class RequiredStepEvidenceError extends Error {
  override readonly cause: unknown;

  constructor(label: string, cause: unknown) {
    super(
      `required step evidence '${label}' failed: ${String(
        (cause as { message?: unknown } | null)?.message ?? cause,
      )}`,
    );
    this.name = "RequiredStepEvidenceError";
    this.cause = cause;
  }
}

async function requireStepEvidence<T>(
  label: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RequiredStepEvidenceError(label, error);
  }
}

/** Turn a failed action into either a serializable continue receipt or real
 * Inngest control flow. Terminal becomes NonRetriableError; retry/park keeps
 * the original throwable so the function retry budget remains active. */
function resolveActionFailureOutcome(
  action: ActionSpec,
  failure: unknown,
  partial?: Partial<RuntimeStepOutcome>,
  options?: { reclassifyControlFlow?: boolean },
): RuntimeStepOutcome {
  if (isNonRetriableFailure(failure) && !options?.reclassifyControlFlow)
    throw failure;
  const inherited = (
    failure as ActionReturnedFailure | null
  )?.output as { meta?: { failureResolution?: unknown } } | undefined;
  const inheritedResolution = inherited?.meta?.failureResolution;
  const resolution =
    action.on_error === undefined &&
    inheritedResolution &&
    typeof inheritedResolution === "object" &&
    !Array.isArray(inheritedResolution)
      ? (inheritedResolution as ActionFailureResolution)
      : classifyActionFailure({
          policy: action.on_error as RuntimeOnErrorPolicy,
          failure,
          defaultResult: Object.prototype.hasOwnProperty.call(
            action,
            "default_result",
          )
            ? action.default_result
            : action.on_error === "soft"
              ? null
              : undefined,
        });
  const controlFlowError = failureForDisposition(resolution, failure);
  if (controlFlowError) throw controlFlowError;
  return {
    ok: true,
    data: resolution.defaultResult,
    tokensIn: partial?.tokensIn ?? 0,
    tokensOut: partial?.tokensOut ?? 0,
    durationMs: partial?.durationMs ?? 0,
    meta: {
      ...(partial?.meta ?? {}),
      failureResolution: resolution,
      softFailed: true,
    },
  };
}

/** Foreach is a container boundary: an explicitly declared container policy
 * may catch a terminal child, while an undeclared policy preserves the
 * child's NonRetriable control flow. Exported to keep this critical boundary
 * independently regression-testable. */
export function resolveForeachContainerFailure(
  action: ActionSpec,
  failure: unknown,
): RuntimeStepOutcome {
  return resolveActionFailureOutcome(action, failure, undefined, {
    reclassifyControlFlow: action.on_error !== undefined,
  });
}

function failureResolutionFromOutcome(outcome: {
  meta?: Record<string, unknown>;
}): ActionFailureResolution | undefined {
  const value = outcome.meta?.failureResolution;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ActionFailureResolution)
    : undefined;
}

/** Validate that an ephemeral app can execute only a sandbox-scoped manifest,
 * and that a production tenant can never register a sandbox attempt pointer. */
export function assertFactoryExecutionScope(
  agent: AgentSpec,
  tenantSlug: string,
): void {
  const executionScope = agent.factory_execution_scope;
  if (isFactorySandboxTenant(tenantSlug)) {
    if (!agent.generated || executionScope?.kind !== "sandbox") {
      throw new Error(
        `[runtime] ephemeral sandbox ${tenantSlug} refuses an agent without sandbox execution scope`,
      );
    }
  } else if (executionScope?.kind === "sandbox") {
    throw new Error(
      `[runtime] production tenant ${tenantSlug} refuses sandbox app pointer ${executionScope.attempt_id}`,
    );
  }
  if (
    executionScope &&
    agent.factory_domain_id &&
    executionScope.target_domain_id !== agent.factory_domain_id
  ) {
    throw new Error(
      `[runtime] factory target domain mismatch for ${agent.id}: ${executionScope.target_domain_id} != ${agent.factory_domain_id}`,
    );
  }
}

export function registerAgent(
  agent: AgentSpec,
  ctx: RegisterContext,
): InngestFunction.Any | null {
  const tenantSlug = ctx.tenantSlug;
  assertFactoryExecutionScope(agent, tenantSlug);
  let productionGeneratedAuthorizationRequest:
    | ProductionGeneratedAgentAuthorizationRequest
    | null = null;
  if (agent.generated === true && !isFactorySandboxTenant(tenantSlug)) {
    const agentManifestSha256 = productionCodeActManifestSha256(agent);
    const scope = agent.factory_execution_scope;
    if (
      scope?.kind !== "production" ||
      !agent.factory_domain_id ||
      agent.factory_target_domain_id !== agent.factory_domain_id ||
      scope.target_domain_id !== agent.factory_domain_id ||
      !agent.factory_promotion_version_id ||
      !agent.factory_regression_suite_fingerprint ||
      !ctx.productionGeneratedAgentCapability ||
      ctx.productionGeneratedAgentManifestSha256 !== agentManifestSha256 ||
      !ctx.productionGeneratedWorkflowManifestSha256
    ) {
      throw new Error(
        `[runtime] generated production Agent ${tenantSlug}/${agent.id} has no exact durable Factory promotion capability`,
      );
    }
    const executionKind = agent.codeExecuted === true
      ? "codeact" as const
      : "declarative" as const;
    if (executionKind === "codeact" && !agent.typescript_code) {
      throw new Error(
        `[runtime] generated production CodeAct ${tenantSlug}/${agent.id} has no handler bytes`,
      );
    }
    productionGeneratedAuthorizationRequest = {
      executionKind,
      tenantId: ctx.tenantId,
      tenantSlug,
      domainId: agent.factory_domain_id,
      agentSlug: agent.id,
      promotionVersionId: agent.factory_promotion_version_id,
      regressionSuiteFingerprint:
        agent.factory_regression_suite_fingerprint,
      codeSha256: executionKind === "codeact"
        ? createHash("sha256")
            .update(agent.typescript_code!, "utf8")
            .digest("hex")
        : agentManifestSha256,
      agentManifestSha256,
      workflowManifestSha256:
        ctx.productionGeneratedWorkflowManifestSha256,
    };
  }
  const eventAdapter = resolveTenantEventAdapter(ctx);
  const fnId = tenantFunctionId(tenantSlug, agent.name, eventAdapter);

  // A pure-schedule agent has no business event trigger, but scheduler.ts
  // emits this canonical synthetic event on every cron tick. Registering the
  // matching listener is load-bearing: previously registerAgent returned
  // null here while the cron producer still emitted, creating a convincing
  // but permanently dead schedule.
  const scheduleDeclared = Boolean(agent.cron || agent.cron_env);
  const triggerNames =
    agent.trigger.length > 0
      ? agent.trigger
      : scheduleDeclared
        ? [scheduledAgentTriggerName(agent.name)]
        : [];

  // No event or schedule trigger (e.g. manual-only entry) → no autonomous
  // Inngest function is registered.
  if (triggerNames.length === 0) {
    return null;
  }

  const triggers = triggerNames.map((t) => ({
    event: tenantEventName(tenantSlug, t, eventAdapter) as `${string}/${string}`,
  }));

  // Per review M2: prior to this change `register.ts` hardcoded `limit: 8`
  // and never read `agent.concurrency.max_concurrent_executions`, which made
  // the lint check `concurrency_excess` a no-op (checking dead config). The
  // cap is now honoured at registration time. A missing / disabled
  // `concurrency` block falls back to the historical default of 8.
  const concurrencyConfig = (
    agent as AgentSpec & {
      concurrency?: { enabled?: boolean; max_concurrent_executions?: number };
    }
  ).concurrency;
  const concurrencyCap =
    concurrencyConfig?.enabled !== false &&
    typeof concurrencyConfig?.max_concurrent_executions === "number"
      ? concurrencyConfig.max_concurrent_executions
      : 8;
  const triggerSubjectExpr =
    eventAdapter.subjectExpressions?.trigger ?? "event.data.subject";
  const cancelSubjectExpr =
    eventAdapter.subjectExpressions?.cancel ?? "async.data.subject";

  // One Inngest app per tenant: bind this agent's function to the tenant's own
  // client (`agentic-operator-<slug>`). Normal tenants keep `${slug}.${agent}`;
  // the opted-in zhaopin compatibility app reuses the six old AO function ids
  // so Inngest sees a handler upgrade rather than a duplicate fleet.
  return getTenantInngest(tenantSlug).createFunction(
    {
      id: fnId,
      name: agent.title ?? agent.name,
      // P5-TEN-01 (G7) — concurrency key now composes the tenant slug with
      // the subject. Without the tenant prefix, two tenants whose agents
      // both process subject="REQ-2041" would share the same Inngest slot
      // bucket — one heavy tenant could starve another. With the prefix,
      // each tenant gets its own bucket per subject, and the per-agent
      // `concurrencyCap` only counts that tenant's traffic.
      concurrency: {
        limit: concurrencyCap,
        key: `"${tenantSlug}:" + ${triggerSubjectExpr}`,
      },
      // Per-agent retry budget from the manifest (`retries`, 0–10); defaults
      // to the historical 3 when the agent doesn't declare one.
      retries: functionRetries(agent),
      // Operator kill switch (POST /v1/runs/:id/cancel). The route emits the
      // tenant-adapted `run.cancel` carrying { runId, subject }. We match on
      // subject because the runId is allocated *inside* the function (the
      // triggering event doesn't know it yet, and Inngest's `cancelOn.if`
      // can only compare values already present on the trigger envelope).
      // Subject is the natural correlation: the concurrency key above
      // already serialises one run per (tenant, subject), so a cancel keyed
      // on subject hits exactly the in-flight run the operator clicked
      // Stop on. Trade-off documented in the route handler: if two runs
      // share a subject (rare — concurrency cap > 1 + same key), both are
      // cancelled together. For a kill switch this is the correct safety
      // posture.
      cancelOn: [
        {
          event: tenantEventName(
            tenantSlug,
            "run.cancel",
            eventAdapter,
          ) as `${string}/${string}`,
          if: `${cancelSubjectExpr} == ${triggerSubjectExpr}`,
        },
      ],
      // v4: triggers moved into opts (was a separate 2nd arg in v3)
      triggers,
    },
    async ({ event, step, logger }) => {
      // #COMMS — rehydrate content-addressed blob refs so this run's handlers see REAL values (the
      // wire/storage stayed small; the active run resolves on demand). No-op when there are no refs.
      // Async resolution: local fs first, then the shared backend (#SCALE-BLOB) — so on a multi-
      // instance deploy a blob written by instance A rehydrates on instance B.
      const rehydratedData = await rehydratePayloadAsync(
        (event.data ?? {}) as Record<string, unknown>,
        async (ref) => {
          const resolved = await resolveBlobRefAsync(ref);
          if (resolved == null) {
            throw new Error(
              `Blob ${ref.hash} (${ref.bytes} bytes) is unavailable from both local and configured shared storage`,
            );
          }
          return resolved;
        },
      );
      // Tenant transport concerns terminate here. The generic runtime always
      // operates on canonical flat data and never branches on a business
      // tenant or legacy envelope format.
      const data = eventAdapter.inbound({
        eventName: event.name,
        data: rehydratedData,
      });
      // #COMMS — offloader for oversized OUTBOUND fields (content-addressed, dedup by sha256).
      const durableOffloader = makeDurableBlobOffloader();
      const offloader = durableOffloader.offload;
      const subject = typeof data.subject === "string" ? data.subject : null;
      const triggerEventId =
        typeof data.__triggerEventId === "string"
          ? data.__triggerEventId
          : null;
      // Event Tester plumbing: the publish route stamps `__test: true` on the
      // Inngest envelope when the caller opted in. We propagate that into
      // `runs.isTest` so test traffic from operator publishes is filterable
      // and never pollutes production observability (PRD G5, NFR-7). The
      // legacy spelling is `__test`; downstream actions should not read it
      // directly — runs.isTest is the source of truth.
      const isTest = data.__test === true;

      // step.run memoizes results across Inngest replays. Wrap correlation +
      // run-row allocation so identical IDs are reused on every replay, and
      // we never create duplicate runs rows.
      const init = await step.run("init", async () => {
        if (productionGeneratedAuthorizationRequest) {
          const authorized =
            await revalidateProductionGeneratedAgentCapability(
              ctx.productionGeneratedAgentCapability,
              productionGeneratedAuthorizationRequest,
            );
          if (!authorized) {
            throw new Error(
              `[runtime] generated production Agent authorization is absent or revoked for ${tenantSlug}/${agent.id}`,
            );
          }
        }
        assertSandboxAttemptDispatchAllowed({
          tenantId: ctx.tenantId,
          tenantSlug,
          appId: appIdForTenant(tenantSlug),
          executionScope: agent.factory_execution_scope,
        });
        // Use normalized data, not the raw transport event. A tenant adapter
        // may recover transport-native correlation metadata as __correlationId.
        const cid = correlationFromEvent({ data });
        const rid = makeId("run");
        const db = getDb();

        // Scope the lookup to THIS tenant's workflow. kebab_id is unique only
        // *within* a tenant — two tenants can legitimately reuse the same ids
        // (e.g. raas + zhaopin both ship "10-1"). Matching on kebab_id alone
        // grabbed whichever tenant's row sorted first, mis-attributing the run
        // (and its stats) to the wrong tenant's agent. ctx.tenantId pins it.
        const agentRow = db
          .select()
          .from(agents)
          .innerJoin(workflows, eq(workflows.id, agents.workflowId))
          .where(
            and(
              eq(workflows.tenantId, ctx.tenantId),
              eq(agents.kebabId, agent.id),
            ),
          )
          .all()[0]?.agents;
        if (!agentRow) {
          throw new Error(
            `[runtime] agent kebab_id=${agent.id} (tenant=${ctx.tenantId}) not found in DB — bootstrap must run before functions register`,
          );
        }
        const agentVersionRow = db
          .select()
          .from(agentVersions)
          .where(
            and(
              eq(agentVersions.agentId, agentRow.id),
              eq(agentVersions.workflowVersionId, ctx.workflowVersionId),
            ),
          )
          .all()[0];

        const startedAt = Date.now();
        const runLogPath = logPathFor(
          {
            tenantSlug,
            tenantId: ctx.tenantId,
            runId: rid,
            correlationId: cid,
            agentName: agent.name,
          },
          new Date(startedAt),
        );
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
            logPath: runLogPath,
          })
          .run();
        // Live feed: broadcast run.started so the portal's stream (LIVE pill,
        // dashboards, Logs → live terminal) reflects manifest-agent activity in
        // real time. Inside `init`'s step.run ⇒ exactly-once across replays.
        // Best-effort: a broadcast failure must never abort the run.
        try {
          publish({
            type: "run.started",
            tenantId: ctx.tenantId,
            at: startedAt,
            runId: rid,
            agentName: agent.name,
            triggerEvent: event.name ?? null,
            subject: subject ?? null,
            correlationId: cid,
            testRun: isTest,
          });
        } catch {
          /* broadcast best-effort */
        }
        return {
          runId: rid,
          correlationId: cid,
          agentDbId: agentRow.id,
          startedAt,
          runLogPath,
        };
      });

      const runId = init.runId;
      const correlationId = init.correlationId;
      const startedAtMs = init.startedAt;
      const startedAt = new Date(startedAtMs);
      const db = getDb();

      const logCtx = {
        tenantSlug,
        tenantId: ctx.tenantId,
        runId,
        correlationId,
        agentName: agent.name,
        logPath: init.runLogPath,
      };

      await writeRunLog(logCtx, "INFO", "run.start", {
        agent: agent.name,
        event: event.name,
        subject: subject ?? "—",
      });
      logger.info("run.start", { runId, agent: agent.name, event: event.name });

      // Phase 2 — merge brain-authored declarative tools into the per-step tenant registry so the
      // step-engine resolves them ahead of the global registry. No-op when none are injected.
      const effectiveTenantRegistry =
        ctx.declarativeTools && Object.keys(ctx.declarativeTools).length
          ? {
              ...ctx.tenantRegistry,
              tools: {
                ...(ctx.tenantRegistry?.tools ?? {}),
                ...ctx.declarativeTools,
              },
            }
          : ctx.tenantRegistry;

      // Generated code inside `step.run` can safely use durable DB-backed memory. Durable
      // emit/invoke are orchestrated below via Inngest steps; the removed adapter exposed dead
      // callbacks that only logged or returned null and therefore implied capabilities it did not have.
      const runMemory = createMemoryHandle({
        tenantId: ctx.tenantId,
        agentName: agent.name,
        subject: subject ?? "",
        runId,
      });

      let tokensIn = 0;
      let tokensOut = 0;
      let lastResult: unknown = null;
      // Raw output of every completed action, keyed by manifest `result_key` (the generated
      // plan's stepId). This is the durable in-run dataflow graph; `lastResult` remains only the
      // backwards-compatible adjacent-step view.
      const stepResults: Record<string, unknown> = {};
      // Explicit emit actions and CodeAct handlers can produce more than one intent (especially
      // inside foreach). Preserve declaration order and duplicates; finalization validates every
      // intent against agent.triggered_event before persisting/sending it.
      const emitIntents: EmitIntent[] = [];
      // A continue rule may deliberately suppress the historical implicit
      // `triggered_event[0]` success emit. Explicit emits already produced by
      // prior steps remain durable and are never erased.
      let suppressImplicitEmit = false;
      const applyFailureEmission = (outcome: {
        meta?: Record<string, unknown>;
      }): void => {
        const resolution = failureResolutionFromOutcome(outcome);
        if (!resolution) return;
        if (resolution.suppressEmit) suppressImplicitEmit = true;
        if (!resolution.emitEvent) return;
        const fallbackPayload =
          resolution.defaultResult &&
          typeof resolution.defaultResult === "object" &&
          !Array.isArray(resolution.defaultResult)
            ? (resolution.defaultResult as Record<string, unknown>)
            : { error: resolution.facts };
        emitIntents.push({
          event: resolution.emitEvent,
          payload: { ...fallbackPayload, ...(resolution.emitPayload ?? {}) },
        });
      };
      // #REDESIGN P1b — the REAL model that served this run (last step that reported one), so the run
      // records the actual model instead of a hardcoded "mock-model-v1".
      let runModel: string | null = null;
      // Phase 1a — real branching: a condition step records its boolean here; a downstream
      // action that dependsOn a false condition (or a skipped step) is SKIPPED, not run.
      const gate: GateState = { conditionTrue: {}, skipped: new Set<string>() };

      // #P0-4 — compensation: emit the agent's declared compensation_event ONCE on a hard failure
      // (idempotent step id) so a run that failed after side-effects can be undone downstream (the
      // canonical PAYMENT_INITIATED → PAYMENT_CANCELLED case). No-op when compensation_event is unset.
      const emitCompensation = async (reason: string): Promise<void> => {
        const comp = agent.compensation_event;
        if (!comp) return;
        // #W1-2 — NEVER wrap step.* in try/catch: Inngest orchestrates via control-flow exceptions,
        // and swallowing them can corrupt replay. step.sendEvent is durable + idempotent by its id, so
        // Inngest itself retries transient failures. The run log is also required evidence.
        await step.sendEvent(`compensate.${runId}`, {
          name: tenantEventName(
            tenantSlug,
            comp,
            eventAdapter,
          ) as `${string}/${string}`,
          data: withCorrelation(correlationId, {
            subject: subject ?? undefined,
            source_agent: agent.name,
            source_run: runId,
            __compensation: true,
            reason: reason.slice(0, 200),
          }),
        });
        await writeRunLog(logCtx, "WARN", "run.compensate", {
          event: comp,
          reason: reason.slice(0, 200),
        });
      };

      const factoryInputBindings = (agent.factory_input_bindings ??
        []) as FactoryInputBinding[];
      const factoryToolConfigs = Object.fromEntries(
        (agent.tool_use ?? []).map((entry) => [entry.name, entry.config ?? {}]),
      );
      const initializedBindings = initializeInputBindings(
        factoryInputBindings,
        data,
        {
          toolConfigs: factoryToolConfigs,
          toolProfileRefs: agent.factory_tool_profile_refs ?? {},
          env: process.env,
          eventName: event.name,
        },
      );
      const inputBindingState = initializedBindings.state;
      const boundData = inputBindingState.data;
      const abortForInputBindings = async (
        issues: RuntimeInputBindingIssue[],
      ): Promise<never> => {
        const error = new InputBindingResolutionError(issues);
        await writeRunLog(logCtx, "ERROR", "input.binding-failed", {
          issues: issues.map((entry) => ({
            code: entry.code,
            field: entry.field,
            message: entry.message,
          })),
        });
        await failRun(runId, error.message, startedAt);
        throw error;
      };
      if (initializedBindings.issues.length) {
        await abortForInputBindings(initializedBindings.issues);
      }

      for (let i = 0; i < agent.actions.length; i++) {
        const action = agent.actions[i]!;
        const ord = i + 1;
        const actionKey =
          (action as { result_key?: string }).result_key ?? action.name;
        const availableStepBindings = resolveAvailableStepOutputBindings(
          inputBindingState,
          factoryInputBindings,
          stepResults,
        );
        if (availableStepBindings.length)
          await abortForInputBindings(availableStepBindings);

        const actionBinding = action.input_binding;
        let actionData: Record<string, unknown> = boundData;
        if (actionBinding?.kind === "object_lookup") {
          const prepared = prepareObjectLookupArguments(
            inputBindingState,
            actionBinding,
          );
          if (!prepared.ok) {
            await abortForInputBindings(prepared.issues);
          } else {
            actionData = { ...boundData, ...prepared.arguments };
          }
        }
        // Scope for stable idempotency-keyed step ids + (later) invoke input resolution.
        const stepScope = {
          event: { name: event.name, data: actionData },
          subject: subject ?? undefined,
          lastResult,
          results: stepResults,
        };

        // Phase 1a — dependsOn gating. Skip (don't fail) an action whose gating condition was
        // false or whose dependency was skipped. Backward-compatible: actions with no depends_on
        // never skip, so existing single-path manifests are unaffected.
        const skip = shouldSkip(
          {
            name: actionKey,
            dependsOn: (action as { depends_on?: string[] }).depends_on,
          },
          gate,
        );
        if (skip.skip) {
          gate.skipped.add(actionKey);
          await writeRunLog(logCtx, "INFO", "step.skip", {
            ord,
            name: action.name,
            resultKey: actionKey,
            type: action.type,
            reason: skip.reason,
          });
          continue;
        }

        // Phase 1a — synchronous sub-agent invoke (step.invoke). Failure is terminal by default.
        // Soft continuation is accepted only when the manifest explicitly declares on_error:"soft"
        // AND owns a default_result (also enforced at boot).
        if (action.type === "invoke") {
          const a = action as ActionSpec & {
            invoke?: string;
            invoke_input?: Record<string, unknown>;
            forward_last_result?: boolean;
            forward_results?: boolean;
            timeout_s?: number;
            default_result?: unknown;
          };
          const targetRef = a.invoke ?? "";
          const fn = ctx.resolveFunction?.(targetRef);
          const hasSoftFallback =
            a.on_error === "soft" &&
            Object.prototype.hasOwnProperty.call(a, "default_result");
          if (a.on_error === "soft" && !hasSoftFallback) {
            await failRun(
              runId,
              `invoke ${targetRef || "<missing>"} declares soft failure without default_result`,
              startedAt,
            );
            throw new Error(
              `invoke ${targetRef || "<missing>"}: on_error=soft requires default_result`,
            );
          }
          let invoked: Awaited<ReturnType<typeof softInvoke>>;
          try {
            invoked = await softInvoke(
              async () => {
                if (!fn)
                  throw new Error(
                    `invoke target "${targetRef}" not resolvable`,
                  );
                return await step.invoke(
                  `invoke-${stableStepId(action.name, (action as { idempotency_key_from?: string }).idempotency_key_from, stepScope)}`,
                  {
                    function: fn,
                    data: materializeInvokePayload({
                      eventData: actionData,
                      invokeInput: a.invoke_input,
                      forwardLastResult: a.forward_last_result,
                      forwardResults: a.forward_results,
                      lastResult,
                      results: stepResults,
                      subject,
                      correlationId,
                    }),
                    timeout: a.timeout_s ? `${a.timeout_s}s` : undefined,
                  },
                );
              },
              {
                timeoutMs: a.timeout_s ? a.timeout_s * 1000 : undefined,
                // Classification happens below. Always rethrow here so a
                // ladder (and legacy soft) observes the original typed error.
                onError: "terminal",
              },
            );
          } catch (failure) {
            const handled = resolveActionFailureOutcome(action, failure);
            applyFailureEmission(handled);
            stepResults[actionKey] = handled.data ?? null;
            lastResult = mergeStepResults(lastResult, handled.data ?? null);
            await writeRunLog(logCtx, "WARN", "step.invoke-continue", {
              ord,
              name: action.name,
              resultKey: actionKey,
              target: targetRef,
              classification:
                failureResolutionFromOutcome(handled)?.policyAction,
            });
            continue;
          }
          stepResults[actionKey] = invoked.data ?? null;
          lastResult = mergeStepResults(lastResult, invoked.data ?? null);
          await writeRunLog(
            logCtx,
            invoked.softFailed ? "WARN" : "INFO",
            "step.invoke",
            {
              ord,
              name: action.name,
              resultKey: actionKey,
              target: targetRef,
              softFailed: invoked.softFailed,
              timedOut: invoked.timedOut,
            },
          );
          continue;
        }

        if (action.type === "subflow") {
          // #P1-3 — durable subflow FANOUT. Persist the outbound event and a
          // running step receipt before handing it to Inngest, then mark the
          // step complete only after step.sendEvent succeeds. This makes a
          // broker failure visible as a running/retried step instead of a
          // parent run that falsely claims the child was dispatched.
          const a = action as {
            subflow?: string;
            subflow_input?: Record<string, unknown>;
          };
          const target = (a.subflow ?? "").trim();
          if (!target) {
            const reason = `subflow ${actionKey}: no target event declared`;
            await failRun(runId, reason, startedAt);
            await emitCompensation(reason);
            throw new Error(reason);
          }

          const subflowStepKey = stableStepId(
            action.name,
            (action as { idempotency_key_from?: string }).idempotency_key_from,
            stepScope,
          );
          const subflowPayload = withCorrelation(correlationId, {
            ...(a.subflow_input ?? {}),
            ...(lastResult &&
            typeof lastResult === "object" &&
            !Array.isArray(lastResult)
              ? (lastResult as Record<string, unknown>)
              : {}),
            subject: subject ?? undefined,
            source_agent: agent.name,
            source_run: runId,
          });
          const scheduled = await step.run(
            `subflow.persist.${subflowStepKey}`,
            async () => {
              const dbInner = getDb();
              const scheduledAt = Date.now();
              const emittedEventId = `evt-${runId.replace(/^run-/, "")}-sub-${ord}`;
              const stepId = `stp-${runId.replace(/^run-/, "")}-sub-${ord}`;
              const payloadRef = await appendToLedger(tenantSlug, {
                id: emittedEventId,
                name: target,
                subject: subject ?? undefined,
                data: subflowPayload,
                ts: scheduledAt,
              });
              const inputRef = await requireStepEvidence(
                "subflow input artifact",
                () =>
                  writeArtifact(runId, `step-${ord}-input.json`, {
                    target,
                    payload: subflowPayload,
                  }),
              );
              const payloadJson = (() => {
                const json = JSON.stringify(subflowPayload);
                return json.length > 200_000
                  ? JSON.stringify({
                      __truncated: true,
                      bytes: json.length,
                      head: json.slice(0, 180_000),
                    })
                  : json;
              })();

              let persistedStepId = stepId;
              dbInner.transaction((tx) => {
                const existingEvent = tx
                  .select({ id: events.id })
                  .from(events)
                  .where(eq(events.id, emittedEventId))
                  .get();
                if (!existingEvent) {
                  tx.insert(events)
                    .values({
                      id: emittedEventId,
                      tenantId: ctx.tenantId,
                      name: target,
                      sourceAgentId: init.agentDbId,
                      subject,
                      payloadRef,
                    })
                    .run();
                  tx.insert(eventStore)
                    .values({
                      id: emittedEventId,
                      tenantId: ctx.tenantId,
                      name: target,
                      subject: subject ?? null,
                      sourceRunId: runId,
                      sourceAgent: agent.name,
                      causationId: triggerEventId ?? null,
                      correlationId,
                      payloadJson,
                    })
                    .run();
                }
                const existingStep = tx
                  .select({ id: steps.id, attempts: steps.attempts })
                  .from(steps)
                  .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
                  .get();
                if (existingStep) {
                  persistedStepId = existingStep.id;
                  tx.update(steps)
                    .set({
                      status: "running",
                      attempts: (existingStep.attempts ?? 1) + 1,
                      startedAt: new Date(scheduledAt),
                      endedAt: null,
                      durationMs: null,
                      error: null,
                      inputRef,
                    })
                    .where(eq(steps.id, existingStep.id))
                    .run();
                } else {
                  tx.insert(steps)
                    .values({
                      id: stepId,
                      runId,
                      ord,
                      name: action.name,
                      type: "subflow",
                      status: "running",
                      startedAt: new Date(scheduledAt),
                      attempts: 1,
                      inputRef,
                    })
                    .run();
                }
              });
              await writeRunLog(logCtx, "INFO", "step.subflow.persisted", {
                ord,
                name: action.name,
                target,
                eventId: emittedEventId,
              });
              try {
                publish({
                  type: "event.emitted",
                  tenantId: ctx.tenantId,
                  at: scheduledAt,
                  eventId: emittedEventId,
                  name: target,
                  subject: subject ?? null,
                  sourceRunId: runId,
                });
                publish({
                  type: "run.step.started",
                  tenantId: ctx.tenantId,
                  at: scheduledAt,
                  runId,
                  stepId,
                  ord,
                  name: action.name,
                  stepType: "subflow",
                });
              } catch {
                /* live delivery is best-effort; durable rows are authoritative */
              }
              return { emittedEventId, stepId: persistedStepId, scheduledAt };
            },
          );

          const wireData = eventAdapter.outbound({
            eventId: scheduled.emittedEventId,
            eventName: target,
            payload: subflowPayload,
            subject,
            correlationId,
            sourceAgent: agent.name,
            emittedAt: new Date(scheduled.scheduledAt).toISOString(),
          });
          await step.sendEvent(`subflow.send.${scheduled.emittedEventId}`, {
            name: tenantEventName(
              tenantSlug,
              target,
              eventAdapter,
            ) as `${string}/${string}`,
            data: wireData,
          });

          await step.run(`subflow.complete.${subflowStepKey}`, async () => {
            const completedAt = Date.now();
            const output = {
              emittedEventId: scheduled.emittedEventId,
              target,
              dispatched: true,
            };
            const outputRef = await requireStepEvidence(
              "subflow output artifact",
              () => writeArtifact(runId, `step-${ord}-output.json`, output),
            );
            await requireStepEvidence("subflow completion row", () =>
              getDb()
                .update(steps)
                .set({
                  status: "ok",
                  endedAt: new Date(completedAt),
                  durationMs: completedAt - scheduled.scheduledAt,
                  outputRef,
                })
                .where(eq(steps.id, scheduled.stepId))
                .run(),
            );
            await writeRunLog(logCtx, "INFO", "step.subflow", {
              ord,
              name: action.name,
              target,
              eventId: scheduled.emittedEventId,
            });
            try {
              publish({
                type: "run.step.completed",
                tenantId: ctx.tenantId,
                at: completedAt,
                runId,
                stepId: scheduled.stepId,
                ord,
                name: action.name,
                stepType: "subflow",
                status: "ok",
                durationMs: completedAt - scheduled.scheduledAt,
                provider: null,
                model: null,
                tokensIn: null,
                tokensOut: null,
                error: null,
              });
            } catch {
              /* live delivery is best-effort; durable rows are authoritative */
            }
            return output;
          });
          stepResults[actionKey] = {
            emittedEventId: scheduled.emittedEventId,
            target,
            dispatched: true,
          };
          continue;
        }

        if (action.type === "delay") {
          // A delay is orchestration state, not in-process work. Persist the
          // running step first, let Inngest own the timer, and only then mark
          // completion. setTimeout inside step.run would hold a worker and
          // could be replayed after a crash.
          const delayMs = (action as { delay_ms?: number }).delay_ms;
          if (!(typeof delayMs === "number" && delayMs > 0)) {
            const reason = `delay ${actionKey}: delay_ms must be greater than zero`;
            await failRun(runId, reason, startedAt);
            await emitCompensation(reason);
            throw new Error(reason);
          }
          const delayStepKey = stableStepId(
            action.name,
            (action as { idempotency_key_from?: string }).idempotency_key_from,
            stepScope,
          );
          const scheduled = await step.run(
            `delay.schedule.${delayStepKey}`,
            async () => {
              const dbInner = getDb();
              const scheduledAt = Date.now();
              const proposedStepId = `stp-${runId.replace(/^run-/, "")}-delay-${ord}`;
              const inputRef = await requireStepEvidence(
                "delay input artifact",
                () =>
                  writeArtifact(runId, `step-${ord}-input.json`, {
                    delay_ms: delayMs,
                  }),
              );
              const existing = dbInner
                .select({ id: steps.id, attempts: steps.attempts })
                .from(steps)
                .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
                .get();
              const stepId = existing?.id ?? proposedStepId;
              if (existing) {
                dbInner
                  .update(steps)
                  .set({
                    status: "running",
                    attempts: (existing.attempts ?? 1) + 1,
                    startedAt: new Date(scheduledAt),
                    endedAt: null,
                    durationMs: null,
                    error: null,
                    inputRef,
                  })
                  .where(eq(steps.id, stepId))
                  .run();
              } else {
                dbInner
                  .insert(steps)
                  .values({
                    id: stepId,
                    runId,
                    ord,
                    name: action.name,
                    type: "delay",
                    status: "running",
                    startedAt: new Date(scheduledAt),
                    attempts: 1,
                    inputRef,
                  })
                  .run();
              }
              await writeRunLog(logCtx, "INFO", "step.delay.scheduled", {
                ord,
                name: action.name,
                delayMs,
              });
              try {
                publish({
                  type: "run.step.started",
                  tenantId: ctx.tenantId,
                  at: scheduledAt,
                  runId,
                  stepId,
                  ord,
                  name: action.name,
                  stepType: "delay",
                });
              } catch {
                /* live delivery is best-effort; durable rows are authoritative */
              }
              return { stepId, scheduledAt };
            },
          );

          await step.sleep(`delay.wait.${delayStepKey}`, delayMs);

          const delayResult = await step.run(
            `delay.complete.${delayStepKey}`,
            async () => {
              const completedAt = Date.now();
              const output = { delay_ms: delayMs, sleptMs: delayMs };
              const outputRef = await requireStepEvidence(
                "delay output artifact",
                () => writeArtifact(runId, `step-${ord}-output.json`, output),
              );
              await requireStepEvidence("delay completion row", () =>
                getDb()
                  .update(steps)
                  .set({
                    status: "ok",
                    endedAt: new Date(completedAt),
                    durationMs: completedAt - scheduled.scheduledAt,
                    outputRef,
                  })
                  .where(eq(steps.id, scheduled.stepId))
                  .run(),
              );
              await writeRunLog(logCtx, "INFO", "step.ok", {
                name: action.name,
                type: "delay",
                duration: completedAt - scheduled.scheduledAt + "ms",
              });
              try {
                publish({
                  type: "run.step.completed",
                  tenantId: ctx.tenantId,
                  at: completedAt,
                  runId,
                  stepId: scheduled.stepId,
                  ord,
                  name: action.name,
                  stepType: "delay",
                  status: "ok",
                  durationMs: completedAt - scheduled.scheduledAt,
                  provider: null,
                  model: null,
                  tokensIn: null,
                  tokensOut: null,
                  error: null,
                });
              } catch {
                /* live delivery is best-effort; durable rows are authoritative */
              }
              return output;
            },
          );
          stepResults[actionKey] = delayResult;
          lastResult = mergeStepResults(lastResult, delayResult);
          continue;
        }

        if (action.type === "foreach") {
          try {
          const a = action as typeof action & {
            items_from?: string;
            item_as?: string;
            item_key_from?: string;
            foreach_actions?: typeof agent.actions;
            timeout_s?: number;
          };
          // A foreach timeout is one wall-clock budget for the entire fan-out,
          // not a fresh budget per item. Each body run receives this absolute
          // deadline; its own timeout_s can only shorten it.
          const foreachDeadlineAt = a.timeout_s
            ? Date.now() + a.timeout_s * 1000
            : undefined;
          const collection = resolveConditionPath(
            {
              lastResult,
              results: stepResults,
              event: { name: event.name, data: boundData },
              input: boundData,
            },
            a.items_from ?? "",
          );
          if (!collection.valid || !Array.isArray(collection.value)) {
            const reason = `foreach ${actionKey}: items_from "${a.items_from ?? ""}" did not resolve to an array`;
            throw new Error(reason);
          }
          const materialized = materializeForeach({
            items: collection.value,
            itemAs: a.item_as,
            itemKeyFrom: a.item_key_from ?? "",
          });
          if (!materialized.ok) {
            const reason = `foreach ${actionKey}: ${materialized.error}`;
            throw new Error(reason);
          }

          const foreachFailure: {
            current: { stepId: string; data: unknown } | null;
          } = { current: null };
          const durableActionRuntime = {
            run: (stepId: string, operation: () => Promise<StepOutput>) =>
              step.run(stepId, operation),
            invoke: async (request: {
              stepId: string;
              target: string;
              input: Record<string, unknown>;
              timeoutMs?: number;
            }): Promise<unknown> => {
              const fn = ctx.resolveFunction?.(request.target);
              if (!fn) {
                throw new Error(`invoke target "${request.target}" not resolvable`);
              }
              return step.invoke(`invoke-${request.stepId}`, {
                function: fn,
                data: request.input,
                timeout: request.timeoutMs
                  ? `${Math.max(1, Math.ceil(request.timeoutMs / 1000))}s`
                  : undefined,
              });
            },
          };
          const receipts = await runSequentialForeach(
            materialized.frames,
            async (frame) => {
              if (foreachFailure.current) {
                return {
                  index: frame.index,
                  key: frame.businessKey,
                  stableKey: frame.stableKey,
                  item: frame.item,
                  stepIds: [] as string[],
                  results: {} as Record<string, unknown>,
                  lastResult: frame.item as unknown,
                  skipped: true,
                  reason: "prior foreach item failed terminally",
                };
              }
              let localLast: unknown = frame.item;
              const localResults: Record<string, unknown> = {};
              const localGate: GateState = {
                conditionTrue: {},
                skipped: new Set<string>(),
              };
              const childStepIds: string[] = [];
              for (const child of a.foreach_actions ?? []) {
                const childKey = child.result_key ?? child.name;
                const childStepId = foreachStepId(actionKey, frame, childKey);
                childStepIds.push(childStepId);
                const childSkip = shouldSkip(
                  { name: childKey, dependsOn: child.depends_on },
                  localGate,
                );
                if (childSkip.skip) {
                  localGate.skipped.add(childKey);
                  localResults[childKey] = {
                    skipped: true,
                    reason: childSkip.reason,
                  };
                  continue;
                }

                // Leaf item/body pairs are their own durable Inngest steps.
                // A nested foreach is a container (its descendants own the
                // durable steps), while invoke delegates directly to
                // step.invoke; neither may be nested inside step.run.
                const runChild = async (): Promise<StepOutput> => {
                  try {
                    const output = await runAction({
                      ctx: {
                        agentName: agent.name,
                        actionName: child.name,
                        ontologyActionName: agent.factory_action_name,
                        subject: subject ?? undefined,
                        correlationId,
                        runId,
                        tenantSlug,
                        tenantId: ctx.tenantId,
                        event: {
                          name: event.name,
                          data: {
                            ...boundData,
                            ...frame.locals,
                            _foreach: {
                              parentStepId: actionKey,
                              index: frame.index,
                              key: frame.businessKey,
                              stableKey: frame.stableKey,
                            },
                          },
                        },
                        lastResult: localLast,
                        results: { ...stepResults, ...localResults },
                        locals: frame.locals,
                        memory: runMemory,
                      },
                      action: child,
                      agent: {
                        id: agent.id,
                        name: agent.name,
                        description: agent.description,
                        ontology_instructions: agent.ontology_instructions,
                        generated: (agent as { generated?: boolean }).generated,
                        factoryDomainId: agent.factory_domain_id,
                        factoryExecutionScope: agent.factory_execution_scope,
                        factoryToolProfileRefs: agent.factory_tool_profile_refs,
                        factoryToolReplayRefs: agent.factory_tool_replay_refs,
                        codeExecuted: (agent as { codeExecuted?: boolean })
                          .codeExecuted,
                        typescriptCode: agent.typescript_code,
                        codeAttestation: agent.code_attestation,
                        factoryPromotionVersionId: agent.factory_promotion_version_id,
                        factoryRegressionSuiteFingerprint: agent.factory_regression_suite_fingerprint,
                        productionCodeActCapability:
                          ctx.productionCodeActCapability,
                        productionCodeActManifestSha256:
                          ctx.productionCodeActManifestSha256,
                        productionCodeActWorkflowManifestSha256:
                          ctx.productionCodeActWorkflowManifestSha256,
                        triggeredEvents: agent.triggered_event,
                        tool_use: Array.isArray(agent.tool_use)
                          ? (agent.tool_use as Array<{
                              name: string;
                              description?: string;
                              input_schema?: unknown;
                            }>)
                          : undefined,
                      },
                      tenantRegistry: effectiveTenantRegistry,
                      autoResolveManual: true,
                      memory: runMemory,
                      deadlineAt: foreachDeadlineAt,
                      durableStepId: childStepId,
                      durableActionRuntime,
                    });
                    const codeReceipt = codeActExecutionReceiptFromMeta(
                      output.meta,
                    );
                    if (codeReceipt) {
                      await requireStepEvidence(
                        "foreach CodeAct run receipt",
                        () =>
                          db
                            .update(runs)
                            .set(codeActReceiptFields(codeReceipt))
                            .where(eq(runs.id, runId))
                            .run(),
                      );
                      await requireStepEvidence(
                        "foreach CodeAct receipt log",
                        () =>
                          writeRunLog(
                            logCtx,
                            codeReceipt.codeRan ? "INFO" : "WARN",
                            "codeact.receipt",
                            {
                              step: child.name,
                              step_id: childStepId,
                              ...codeActReceiptFields(codeReceipt),
                              duration_ms: codeReceipt.durationMs,
                            },
                          ),
                      );
                    }
                    // An enclosing foreach deadline is authoritative. A child
                    // soft policy cannot convert expiration of the parent
                    // budget into a success and continue later items.
                    if (
                      !output.ok &&
                      (output.meta as { deadlineSource?: unknown } | undefined)
                        ?.deadlineSource === "parent_deadline"
                    ) {
                      return output;
                    }
                    if (output.ok) return output;
                    const handled = resolveActionFailureOutcome(
                      child,
                      new ActionReturnedFailure(child.name, output),
                      {
                        tokensIn: output.tokensIn ?? 0,
                        tokensOut: output.tokensOut ?? 0,
                        meta: output.meta,
                      },
                    );
                    return { ...handled, type: child.type };
                  } catch (failure) {
                    if (failure instanceof RequiredStepEvidenceError)
                      throw failure;
                    return {
                      ...resolveActionFailureOutcome(child, failure),
                      type: child.type,
                    };
                  }
                };
                const bodyResult =
                  child.type === "foreach" || child.type === "invoke"
                    ? await runChild()
                    : await step.run(childStepId, runChild);

                tokensIn += bodyResult.tokensIn ?? 0;
                tokensOut += bodyResult.tokensOut ?? 0;
                if (bodyResult.model) runModel = bodyResult.model;
                const emitted = (
                  bodyResult.meta as { emitted?: EmitIntent[] } | undefined
                )?.emitted;
                if (Array.isArray(emitted)) emitIntents.push(...emitted);
                if (
                  (bodyResult.meta as { suppressImplicitEmit?: unknown } | undefined)
                    ?.suppressImplicitEmit === true
                ) {
                  suppressImplicitEmit = true;
                }
                applyFailureEmission(bodyResult);

                if (!bodyResult.ok) {
                  foreachFailure.current = {
                    stepId: childStepId,
                    data: bodyResult.data,
                  };
                  break;
                }
                localResults[childKey] = bodyResult.data;
                localLast = mergeStepResults(localLast, bodyResult.data);
                if (child.type === "condition") {
                  localGate.conditionTrue[childKey] = Boolean(
                    (bodyResult.data as { evaluated?: boolean } | null)
                      ?.evaluated,
                  );
                }
              }
              return {
                index: frame.index,
                key: frame.businessKey,
                stableKey: frame.stableKey,
                item: frame.item,
                stepIds: childStepIds,
                results: localResults,
                lastResult: localLast,
              };
            },
          );

          if (foreachFailure.current) {
            const reason = `foreach ${actionKey} body step ${foreachFailure.current.stepId} failed`;
            throw new Error(reason);
          }
          const aggregate = {
            count: receipts.length,
            items: receipts,
            byKey: Object.fromEntries(
              receipts.map((receipt) => [receipt.stableKey, receipt]),
            ),
          };
          stepResults[actionKey] = aggregate;
          lastResult = mergeStepResults(lastResult, aggregate);
          await writeRunLog(logCtx, "INFO", "step.foreach", {
            ord,
            name: action.name,
            resultKey: actionKey,
            count: receipts.length,
            mode: "sequential",
          });
          continue;
          } catch (failure) {
            if (failure instanceof RequiredStepEvidenceError) throw failure;
            const handled = resolveForeachContainerFailure(action, failure);
            applyFailureEmission(handled);
            stepResults[actionKey] = handled.data ?? null;
            lastResult = mergeStepResults(lastResult, handled.data ?? null);
            await writeRunLog(logCtx, "WARN", "step.foreach-continue", {
              ord,
              name: action.name,
              resultKey: actionKey,
              classification:
                failureResolutionFromOutcome(handled)?.policyAction,
            });
            continue;
          }
        }

        if (action.type === "manual") {
          // Human-in-the-loop step (DESIGN.md §10):
          //   1) create task row inside step.run (memoized)
          //   2) waitForEvent("task.resolved") with matched taskId
          //   3) close step row with resolution
          const initStep = await step.run(`init-task-${ord}`, async () => {
            const sid = makeId("stp");
            const tid = makeId("tsk");
            const resumeMarker = `hitl:${ctx.tenantId}:${runId}:${tid}`;
            const sStarted = Date.now();
            const dbInner = getDb();
            // The task, its exact wait step, and the owning run's waiting
            // state form one recovery unit. A crash cannot leave an open task
            // whose parked step/origin cannot be identified.
            dbInner.transaction((tx) => {
              tx.insert(steps)
                .values({
                  id: sid,
                  runId,
                  ord,
                  name: action.name,
                  // invoke steps never reach an insert (handled+continue'd above); cast to the
                  // steps.type column union which predates the "invoke" member.
                  type: action.type as
                    | "tool"
                    | "logic"
                    | "manual"
                    | "condition"
                    | "delay"
                    | "subflow",
                  status: "running",
                  startedAt: new Date(sStarted),
                })
                .run();
              tx.insert(tasksTable)
                .values({
                  id: tid,
                  tenantId: ctx.tenantId,
                  runId,
                  originEventId: triggerEventId,
                  originEventName: event.name ?? null,
                  waitStepId: sid,
                  resumeMarker,
                  resumeState: "pending",
                  type: action.task_type ?? action.name,
                  title: `${agent.title ?? agent.name} · ${action.name}`,
                  priority: "medium",
                  status: "open",
                  payloadJson: {
                    agentName: agent.name,
                    actionName: action.name,
                    description: action.description,
                    subject,
                    condition: action.condition ?? null,
                    ...(actionBinding?.kind === "human_input"
                      ? {
                          inputBinding: {
                            kind: "human_input",
                            field: actionBinding.field,
                            type: actionBinding.type,
                            required: actionBinding.required,
                            prompt: actionBinding.prompt,
                          },
                        }
                      : {}),
                  } as never,
                } as never)
                .run();
              tx.update(runs)
                .set({ status: "waiting" })
                .where(and(eq(runs.id, runId), eq(runs.status, "running")))
                .run();
            });
            try {
              publish({
                type: "run.step.started",
                tenantId: ctx.tenantId,
                at: sStarted,
                runId,
                stepId: sid,
                ord,
                name: action.name,
                stepType: action.type,
              });
              publish({
                type: "task.created",
                tenantId: ctx.tenantId,
                at: sStarted,
                taskId: tid,
                runId,
                taskType: action.task_type ?? action.name,
                title: `${agent.title ?? agent.name} · ${action.name}`,
              });
            } catch {
              /* live delivery is best-effort */
            }
            return { stepId: sid, taskId: tid, resumeMarker, sStarted };
          });

          await writeRunLog(logCtx, "INFO", "step.wait", {
            ord,
            name: action.name,
            taskId: initStep.taskId,
            awaiting: "human",
          });

          // P5-TEN-01 — pin the predicate to the issuing tenant so a leaked
          // taskId in another tenant cannot resume this run. tasks.ts:resolve
          // now includes auth.tenantId in the event payload.
          // Per-tenant app: HITL resume and the resolve route both project
          // `task.resolved` through the same committed TenantEventAdapter.
          // Ordinary tenants therefore use `${slug}/task.resolved`; a tenant
          // that owns a legacy bus may intentionally use another wire name.
          // The tenantId predicate stays as defense-in-depth.
          const resolved = await step.waitForEvent(`wait-task-${ord}`, {
            event: tenantEventName(
              tenantSlug,
              "task.resolved",
              eventAdapter,
            ) as `${string}/${string}`,
            if: `async.data.taskId == "${initStep.taskId}" && async.data.tenantId == "${ctx.tenantId}" && async.data.resumeMarker == "${initStep.resumeMarker}"`,
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
                .set({
                  status: "failed",
                  resumeState: "failed",
                  resumeError: "task_wait_timeout",
                })
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

          const resolution = (resolved.data ?? {}) as {
            taskId: string;
            decision?: string;
            payload?: unknown;
            resumeMarker?: string;
            actorUserId?: string | null;
          };

          if (
            resolution.decision !== "reject" &&
            actionBinding?.kind === "human_input"
          ) {
            const humanIssues = applyHumanInputResult(
              inputBindingState,
              actionBinding,
              resolution.payload,
            );
            if (humanIssues.length) {
              await step.run(`invalid-task-input-${ord}`, async () => {
                const failedAt = new Date();
                const dbInner = getDb();
                dbInner.transaction((tx) => {
                  tx.update(steps)
                    .set({
                      status: "failed",
                      error: humanIssues
                        .map((entry) => entry.message)
                        .join("; "),
                      endedAt: failedAt,
                    })
                    .where(eq(steps.id, initStep.stepId))
                    .run();
                  tx.update(tasksTable)
                    .set({
                      status: "failed",
                      resolvedAt: failedAt,
                      resolvedBy: resolution.actorUserId ?? null,
                      resolutionJson: resolution as never,
                      resumeState: "failed",
                      resumeError: "invalid_human_input",
                    })
                    .where(eq(tasksTable.id, initStep.taskId))
                    .run();
                });
              });
              await abortForInputBindings(humanIssues);
            }
          }

          await step.run(`close-task-${ord}`, async () => {
            const dbInner = getDb();
            const sEnded = Date.now();
            const stepStatus =
              resolution.decision === "reject" ? "failed" : "ok";
            dbInner.transaction((tx) => {
              const taskUpdate = tx
                .update(tasksTable)
                .set({
                  status: "resolved",
                  resolvedAt: new Date(sEnded),
                  resolvedBy: resolution.actorUserId ?? null,
                  resolutionJson: resolution as never,
                  resumeState: "acknowledged",
                  resumeAcknowledgedAt: new Date(sEnded),
                  resumeError: null,
                })
                .where(
                  and(
                    eq(tasksTable.id, initStep.taskId),
                    eq(tasksTable.status, "resolving"),
                    eq(tasksTable.resumeMarker, initStep.resumeMarker),
                  ),
                )
                .run() as { changes?: number };
              if ((taskUpdate.changes ?? 0) !== 1) {
                throw new Error(
                  `task ${initStep.taskId} resume was not durably claimed`,
                );
              }
              tx.update(steps)
                .set({
                  status: stepStatus,
                  endedAt: new Date(sEnded),
                  durationMs: sEnded - initStep.sStarted,
                })
                .where(eq(steps.id, initStep.stepId))
                .run();
              tx.update(runs)
                .set({ status: "running" })
                .where(and(eq(runs.id, runId), eq(runs.status, "waiting")))
                .run();
            });
            try {
              publish({
                type: "run.step.completed",
                tenantId: ctx.tenantId,
                at: sEnded,
                runId,
                stepId: initStep.stepId,
                ord,
                name: action.name,
                stepType: action.type,
                status: stepStatus,
                durationMs: sEnded - initStep.sStarted,
                provider: null,
                model: null,
                tokensIn: null,
                tokensOut: null,
                error: stepStatus === "failed" ? "human rejected" : null,
              });
              publish({
                type: "task.resolved",
                tenantId: ctx.tenantId,
                at: sEnded,
                taskId: initStep.taskId,
                decision: resolution.decision ?? "approve",
              });
            } catch {
              /* live delivery is best-effort */
            }
          });

          if (resolution.decision === "reject") {
            await failRun(runId, "human rejected", startedAt);
            throw new Error("rejected by human");
          }

          const manualResult =
            actionBinding?.kind === "human_input"
              ? { [actionBinding.field]: boundData[actionBinding.field] }
              : (resolution.payload ?? null);
          lastResult = mergeStepResults(lastResult, manualResult);
          stepResults[actionKey] = manualResult;
          await writeRunLog(logCtx, "INFO", "step.ok", {
            name: action.name,
            type: action.type,
            taskId: initStep.taskId,
            decision: resolution.decision ?? "approve",
          });
          continue;
        }

        // tool | logic: atomic step.run with auto-managed step row.
        // Phase 1a — stable, idempotency-keyed Inngest step id. Falls back to the (sanitized)
        // action name when no idempotency_key_from is declared, so existing manifests are unchanged.
        const stepKey = stableStepId(
          action.name,
          (action as { idempotency_key_from?: string }).idempotency_key_from,
          stepScope,
        );
        // Per-step error behavior is resolved inside the durable callback so
        // retry/park throws before the step can be memoized as a success.
        let stepOutcome: RuntimeStepOutcome;
        try {
          stepOutcome = await step.run(stepKey, async () => {
            const sStarted = Date.now();
            const dbInner = getDb();
            // Upsert by (runId, ord). On an Inngest retry the failed body
            // re-executes; reuse the existing row and bump `attempts` instead
            // of inserting a phantom duplicate at the same ord.
            const existing = dbInner
              .select({ id: steps.id, attempts: steps.attempts })
              .from(steps)
              .where(and(eq(steps.runId, runId), eq(steps.ord, ord)))
              .all()[0];
            let sid: string;
            let attempt: number;
            if (existing) {
              sid = existing.id;
              attempt = (existing.attempts ?? 1) + 1;
              dbInner
                .update(steps)
                .set({
                  status: "running",
                  attempts: attempt,
                  startedAt: new Date(sStarted),
                  endedAt: null,
                  durationMs: null,
                  error: null,
                })
                .where(eq(steps.id, sid))
                .run();
            } else {
              sid = makeId("stp");
              attempt = 1;
              dbInner
                .insert(steps)
                .values({
                  id: sid,
                  runId,
                  ord,
                  name: action.name,
                  // invoke steps never reach an insert (handled+continue'd above); cast to the
                  // steps.type column union which predates the "invoke" member.
                  type: action.type as
                    | "tool"
                    | "logic"
                    | "manual"
                    | "condition"
                    | "delay"
                    | "subflow"
                    | "foreach"
                    | "emit"
                    | "decision",
                  status: "running",
                  startedAt: new Date(sStarted),
                  attempts: 1,
                })
                .run();
            }
            await writeRunLog(
              logCtx,
              attempt > 1 ? "WARN" : "DEBUG",
              "step.start",
              {
                ord,
                name: action.name,
                type: action.type,
                attempt,
              },
            );
            try {
              publish({
                type: "run.step.started",
                tenantId: ctx.tenantId,
                at: sStarted,
                runId,
                stepId: sid,
                ord,
                name: action.name,
                stepType: action.type,
              });
            } catch {
              /* broadcast best-effort */
            }

            let codeReceipt: CodeActExecutionReceipt | null = null;
            try {
              // Persist the exact input before invoking any provider/tool.
              // A later output/evidence failure must not leave a real side
              // effect with no record of what initiated it.
              const stepInputRef = await requireStepEvidence(
                "input artifact",
                () =>
                  writeArtifact(runId, `step-${ord}-input.json`, {
                    last_result: lastResult ?? null,
                    trigger_event: event.name,
                    subject: subject ?? null,
                  }),
              );
              await requireStepEvidence("input artifact reference", () =>
                dbInner
                  .update(steps)
                  .set({ inputRef: stepInputRef })
                  .where(eq(steps.id, sid))
                  .run(),
              );

              const res = await runWithTraceContext(
                { correlationId, agentName: agent.name, tenantSlug, runId },
                () =>
                  runAction({
                    ctx: {
                      agentName: agent.name,
                      actionName: action.name,
                      ontologyActionName: agent.factory_action_name,
                      subject: subject ?? undefined,
                      correlationId,
                      runId,
                      tenantSlug,
                      tenantId: ctx.tenantId,
                      event: {
                        name: event.name,
                        data: actionData,
                      },
                      lastResult,
                      results: stepResults,
                      // #P0-1 — durable scoped memory reaches tenant tools (the production code path), not
                      // just generated code. Same handle threaded via StepInput.memory for generated code.
                      memory: runMemory,
                    },
                    action,
                    // Hand the step engine the slots it needs for prompt assembly
                    // AND the tool-use loop. `tool_use` is the canonical roster
                    // of advertised tools — the engine cross-references each
                    // entry against `tenantRegistry.tools` before passing it to
                    // the LLM; stale declarations fail closed.
                    agent: {
                      id: agent.id,
                      name: agent.name,
                      description: agent.description,
                      ontology_instructions: agent.ontology_instructions,
                      generated: (agent as { generated?: boolean }).generated,
                      factoryDomainId: agent.factory_domain_id,
                      factoryExecutionScope: agent.factory_execution_scope,
                      factoryToolProfileRefs: agent.factory_tool_profile_refs,
                      factoryToolReplayRefs: agent.factory_tool_replay_refs,
                      codeExecuted: (agent as { codeExecuted?: boolean })
                        .codeExecuted,
                      typescriptCode: agent.typescript_code,
                      codeAttestation: agent.code_attestation,
                      factoryPromotionVersionId: agent.factory_promotion_version_id,
                      factoryRegressionSuiteFingerprint: agent.factory_regression_suite_fingerprint,
                      productionCodeActCapability:
                        ctx.productionCodeActCapability,
                      productionCodeActManifestSha256:
                        ctx.productionCodeActManifestSha256,
                      productionCodeActWorkflowManifestSha256:
                        ctx.productionCodeActWorkflowManifestSha256,
                      triggeredEvents: agent.triggered_event,
                      tool_use: Array.isArray(agent.tool_use)
                        ? (agent.tool_use as Array<{
                            name: string;
                            description?: string;
                            input_schema?: unknown;
                          }>)
                        : undefined,
                    },
                    tenantRegistry: effectiveTenantRegistry,
                    autoResolveManual: true,
                    // #REDESIGN FU1 — real durable memory for generated-code execution (delivered tier).
                    memory: runMemory,
                  }),
              ); // #SCALE-TRACE — ambient correlationId/agentName/tenantSlug/runId for nested tools/logs
              codeReceipt = codeActExecutionReceiptFromMeta(res.meta);
              if (res.model) runModel = res.model;
              const sEnded = Date.now();
              // Persist provider usage and the runtime-authored receipt as one
              // recovery unit before any later artifact/telemetry sink can
              // fail. Updating the run here (inside the durable step body)
              // makes the receipt replay-safe; finalization must never derive
              // or overwrite it from a fresh in-memory closure.
              await requireStepEvidence(
                "provider usage and CodeAct receipt",
                () =>
                  dbInner.transaction((tx) => {
                    tx.update(steps)
                      .set({
                        provider: res.provider ?? null,
                        model: res.model ?? null,
                        tokensIn: res.tokensIn ?? null,
                        tokensOut: res.tokensOut ?? null,
                        ...(codeReceipt
                          ? codeActReceiptFields(codeReceipt)
                          : {}),
                      })
                      .where(eq(steps.id, sid))
                      .run();
                    if (codeReceipt) {
                      tx.update(runs)
                        .set(codeActReceiptFields(codeReceipt))
                        .where(eq(runs.id, runId))
                        .run();
                    }
                  }),
              );
              if (codeReceipt) {
                await requireStepEvidence("CodeAct receipt log", () =>
                  writeRunLog(
                    logCtx,
                    codeReceipt!.codeRan ? "INFO" : "WARN",
                    "codeact.receipt",
                    {
                      step: action.name,
                      step_id: sid,
                      ...codeActReceiptFields(codeReceipt!),
                      duration_ms: codeReceipt!.durationMs,
                    },
                  ),
                );
              }
              let stepOutputRef: string | undefined;
              let artifactError: unknown;
              try {
                stepOutputRef = await writeArtifact(
                  runId,
                  `step-${ord}-output.json`,
                  res.data ?? null,
                );
              } catch (error) {
                artifactError = error;
              }

              let telemetryError: unknown;
              try {
                // #W0 — persist raw per-turn capture. On an Inngest retry,
                // replace the prior attempt's rows rather than duplicating
                // them. This attempt still runs if the sidecar write failed.
                if (captureLlmTurns()) {
                  const capturedTurns = (
                    res.meta as { turns?: LlmTurnTrace[] } | undefined
                  )?.turns;
                  if (
                    Array.isArray(capturedTurns) &&
                    capturedTurns.length > 0
                  ) {
                    if (attempt > 1) {
                      dbInner
                        .delete(llmTurns)
                        .where(eq(llmTurns.stepId, sid))
                        .run();
                    }
                    dbInner
                      .insert(llmTurns)
                      .values(
                        capturedTurns.map((tn) => ({
                          id: makeId("llt"),
                          tenantId: ctx.tenantId,
                          runId,
                          stepId: sid,
                          ord: tn.ord,
                          promptPreview: tn.promptPreview ?? null,
                          responseText: tn.responseText ?? null,
                          reasoning: tn.reasoning ?? null,
                          toolCallsJson: tn.toolCalls ?? [],
                          provider: tn.provider ?? null,
                          model: tn.model ?? null,
                          tokensIn: tn.tokensIn ?? null,
                          tokensOut: tn.tokensOut ?? null,
                          finishReason: tn.finishReason ?? null,
                          latencyMs: tn.latencyMs ?? null,
                          correlationId,
                        })),
                      )
                      .run();
                  }
                }
              } catch (error) {
                telemetryError = error;
              }
              if (stepOutputRef) {
                await requireStepEvidence("output artifact reference", () =>
                  dbInner
                    .update(steps)
                    .set({ outputRef: stepOutputRef })
                    .where(eq(steps.id, sid))
                    .run(),
                );
              }
              if (artifactError && telemetryError) {
                throw new RequiredStepEvidenceError(
                  "output artifact and llm-turn telemetry",
                  new AggregateError(
                    [artifactError, telemetryError],
                    `Step '${action.name}' output artifact and llm-turn telemetry both failed to persist`,
                  ),
                );
              }
              if (artifactError) {
                throw new RequiredStepEvidenceError(
                  "output artifact",
                  artifactError,
                );
              }
              if (telemetryError) {
                throw new RequiredStepEvidenceError(
                  "llm-turn telemetry",
                  telemetryError,
                );
              }
              // Rich per-call logs so the run viewer reads like Inngest's trace:
              // one llm.call line (provider/model/tokens) + one tool.call line
              // per dispatched tool, before the step.ok summary.
              if (res.provider || res.model) {
                await requireStepEvidence("llm call log", () =>
                  writeRunLog(logCtx, "INFO", "llm.call", {
                    step: action.name,
                    provider: res.provider ?? "—",
                    model: res.model ?? "—",
                    tokens_in: res.tokensIn ?? 0,
                    tokens_out: res.tokensOut ?? 0,
                  }),
                );
              }
              const toolCalls = (
                res.meta as
                  | {
                      toolCalls?: Array<{
                        name: string;
                        isError?: boolean;
                        durationMs?: number;
                      }>;
                    }
                  | undefined
              )?.toolCalls;
              if (Array.isArray(toolCalls)) {
                for (const tc of toolCalls) {
                  await requireStepEvidence(`tool call log '${tc.name}'`, () =>
                    writeRunLog(
                      logCtx,
                      tc.isError ? "ERROR" : "INFO",
                      "tool.call",
                      {
                        step: action.name,
                        tool: tc.name,
                        ok: tc.isError ? false : true,
                        duration: `${tc.durationMs ?? 0}ms`,
                      },
                    ),
                  );
                }
              }
              const returnedError = res.ok
                ? null
                : String(
                    (
                      res.meta as
                        | { message?: unknown; error?: unknown }
                        | undefined
                    )?.message ??
                      (res.meta as { error?: unknown } | undefined)?.error ??
                      `action '${action.name}' returned ok=false`,
                  );
              await requireStepEvidence("terminal step status", () =>
                dbInner
                  .update(steps)
                  .set({
                    status: res.ok ? "ok" : "failed",
                    endedAt: new Date(sEnded),
                    durationMs: sEnded - sStarted,
                    error: returnedError,
                  })
                  .where(eq(steps.id, sid))
                  .run(),
              );
              try {
                publish({
                  type: "run.step.completed",
                  tenantId: ctx.tenantId,
                  at: sEnded,
                  runId,
                  stepId: sid,
                  ord,
                  name: action.name,
                  stepType: action.type,
                  status: res.ok ? "ok" : "failed",
                  durationMs: sEnded - sStarted,
                  provider: res.provider ?? null,
                  model: res.model ?? null,
                  tokensIn: res.tokensIn ?? null,
                  tokensOut: res.tokensOut ?? null,
                  error: returnedError,
                  ...(codeReceipt ? codeActReceiptFields(codeReceipt) : {}),
                });
              } catch {
                /* broadcast best-effort */
              }
              const durableOutcome: RuntimeStepOutcome = {
                ok: res.ok,
                data: res.data,
                tokensIn: res.tokensIn ?? 0,
                tokensOut: res.tokensOut ?? 0,
                durationMs: sEnded - sStarted,
                meta: res.meta,
              };
              return res.ok
                ? durableOutcome
                : resolveActionFailureOutcome(
                    action,
                    new ActionReturnedFailure(action.name, res),
                    durableOutcome,
                  );
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              const failedAt = Date.now();
              let failureStatusError: unknown;
              try {
                await requireStepEvidence("failed terminal step status", () =>
                  dbInner
                    .update(steps)
                    .set({
                      status: "failed",
                      endedAt: new Date(failedAt),
                      durationMs: failedAt - sStarted,
                      error: message,
                    })
                    .where(eq(steps.id, sid))
                    .run(),
                );
              } catch (error) {
                failureStatusError = error;
              }
              // A completion broadcast is only truthful after the
              // authoritative terminal status has been persisted.
              if (!failureStatusError) {
                try {
                  publish({
                    type: "run.step.completed",
                    tenantId: ctx.tenantId,
                    at: failedAt,
                    runId,
                    stepId: sid,
                    ord,
                    name: action.name,
                    stepType: action.type,
                    status: "failed",
                    durationMs: failedAt - sStarted,
                    provider: null,
                    model: null,
                    tokensIn: null,
                    tokensOut: null,
                    error: message,
                    ...(codeReceipt ? codeActReceiptFields(codeReceipt) : {}),
                  });
                } catch {
                  /* broadcast best-effort */
                }
              }
              let failureLogError: unknown;
              try {
                await requireStepEvidence("step failure log", () =>
                  writeRunLog(logCtx, "ERROR", "step.fail", {
                    ord,
                    name: action.name,
                    attempt,
                    error: message,
                  }),
                );
              } catch (error) {
                failureLogError = error;
              }
              if (failureStatusError || failureLogError) {
                const causes = [
                  ...(err instanceof RequiredStepEvidenceError ? [err] : []),
                  ...(failureStatusError ? [failureStatusError] : []),
                  ...(failureLogError ? [failureLogError] : []),
                ];
                throw new RequiredStepEvidenceError(
                  "failed-step evidence",
                  causes.length === 1
                    ? causes[0]
                    : new AggregateError(
                        causes,
                        `Step '${action.name}' failure evidence did not persist`,
                      ),
                );
              }
              // Required evidence failures are runtime failures, never
              // business failures eligible for a manifest soft/default rule.
              if (err instanceof RequiredStepEvidenceError) throw err;
              return resolveActionFailureOutcome(action, err, {
                durationMs: failedAt - sStarted,
              });
            }
          });
        } catch (stepErr) {
          if (stepErr instanceof RequiredStepEvidenceError) {
            await emitCompensation(stepErr.message);
            throw stepErr;
          }
          // Defense in depth for SDK StepError wrappers. Normally the durable
          // callback already classified the failure; if the wrapper reaches
          // this boundary we apply the same deterministic policy once more.
          try {
            stepOutcome = resolveActionFailureOutcome(action, stepErr);
          } catch (controlFlowError) {
            await emitCompensation(
              controlFlowError instanceof Error
                ? controlFlowError.message
                : String(controlFlowError),
            );
            throw controlFlowError;
          }
        }

        applyFailureEmission(stepOutcome);
        const continuedFailure = failureResolutionFromOutcome(stepOutcome);
        if (continuedFailure) {
          await writeRunLog(logCtx, "WARN", "step.error-continue", {
            ord,
            name: action.name,
            kind: continuedFailure.facts.kind,
            code: continuedFailure.facts.code,
            status: continuedFailure.facts.status,
            matchedRule: continuedFailure.matchedRule,
            emitEvent: continuedFailure.emitEvent,
            suppressEmit: continuedFailure.suppressEmit,
          });
        }
        tokensIn += stepOutcome.tokensIn;
        tokensOut += stepOutcome.tokensOut;
        const emitted = (
          stepOutcome.meta as { emitted?: EmitIntent[] } | undefined
        )?.emitted;
        if (Array.isArray(emitted)) emitIntents.push(...emitted);
        if (actionBinding?.kind === "object_lookup") {
          const lookupIssues = applyObjectLookupResult(
            inputBindingState,
            actionBinding,
            stepOutcome.data,
          );
          if (lookupIssues.length) await abortForInputBindings(lookupIssues);
        }
        stepResults[actionKey] = stepOutcome.data;
        lastResult = mergeStepResults(lastResult, stepOutcome.data);

        // Phase 1a — record a condition step's verdict so downstream depends_on actions branch on it.
        if (action.type === "condition") {
          gate.conditionTrue[actionKey] = Boolean(
            (stepOutcome.data as { evaluated?: boolean } | null)?.evaluated,
          );
        }

        // A soft/default policy permits the workflow to continue; it does
        // not retroactively make the underlying action successful. The
        // failed terminal step row + step.error-continue log above are the
        // truthful record, so never append a contradictory step.ok marker.
        if (!continuedFailure) {
          await writeRunLog(logCtx, "INFO", "step.ok", {
            name: action.name,
            type: action.type,
            duration: stepOutcome.durationMs + "ms",
          });
        }
      }

      const finalStepBindingIssues = resolveAvailableStepOutputBindings(
        inputBindingState,
        factoryInputBindings,
        stepResults,
      );
      if (finalStepBindingIssues.length)
        await abortForInputBindings(finalStepBindingIssues);
      const unresolvedBindings = unresolvedRequiredInputBindings(
        inputBindingState,
        factoryInputBindings,
      );
      if (unresolvedBindings.length)
        await abortForInputBindings(unresolvedBindings);

      // Preserve all explicit emit intents (including repeated names from foreach). If no step
      // emitted explicitly, selectEmittedEvents retains the historical exactly-one branch routing.
      const selectedEmits = selectEmittedEvents(
        agent.triggered_event,
        lastResult,
        emitIntents,
        { suppressImplicit: suppressImplicitEmit },
      );
      const outbound = selectedEmits.map((intent) => ({
        intent,
        // An explicit emit payload is authoritative for that event. The incoming envelope is still
        // carried forward, while the aggregate foreach receipt stays internal unless selected.
        assembled: assembleEmitPayload({
          incoming: data,
          lastResult: intent.payload ?? lastResult,
          meta: {
            subject: subject ?? undefined,
            correlationId,
            causationId: triggerEventId ?? correlationId,
            producedBy: agent.name,
            sourceRun: runId,
          },
          contractSchema: agent.factory_output_schema,
          offload: offloader,
        }),
      }));
      for (const item of outbound) {
        const assembled = item.assembled;
        if (
          assembled.carried.length ||
          assembled.offloaded.length ||
          assembled.missing.length
        ) {
          await writeRunLog(
            logCtx,
            assembled.missing.length ? "WARN" : "INFO",
            "emit.envelope",
            {
              event: item.intent.event,
              carried: assembled.carried,
              offloaded: assembled.offloaded,
              missing: assembled.missing,
            },
          );
        }
      }
      const invalidOutbound = outbound.filter(
        (item) => item.assembled.contractErrors.length > 0,
      );
      if (invalidOutbound.length) {
        const failures = invalidOutbound.flatMap((item) =>
          item.assembled.contractErrors.map((error) => ({
            event: item.intent.event,
            field: error.field,
            kind: error.kind,
            expectedType: error.expectedType,
            ...(error.actualType ? { actualType: error.actualType } : {}),
          })),
        );
        await writeRunLog(logCtx, "ERROR", "emit.contract-invalid", {
          failures,
        });
        throw new Error(
          `outbound event contract rejected: ${failures
            .slice(0, 8)
            .map((failure) => `${failure.event}.${failure.field}:${failure.kind}`)
            .join(", ")}`,
        );
      }
      // BlobRefs become durable event truth below. When a shared backend is
      // configured, all referenced bytes must be reachable there before the
      // ledger/event-store rows are committed; otherwise another instance
      // can receive a successful event whose payload is impossible to load.
      await durableOffloader.flush();
      const finalize = await step.run("finalize", async () => {
        const dbInner = getDb();
        const emittedEvents: Array<{
          id: string;
          name: string;
          index: number;
        }> = [];
        for (let index = 0; index < outbound.length; index++) {
          const item = outbound[index]!;
          const emittedEventId = makeId("evt");
          const emittedName = item.intent.event;
          const payload = item.assembled.payload;
          const payloadRef = await appendToLedger(tenantSlug, {
            id: emittedEventId,
            name: emittedName,
            subject: subject ?? undefined,
            data: payload,
            ts: Date.now(),
          });
          dbInner
            .insert(events)
            .values({
              id: emittedEventId,
              tenantId: ctx.tenantId,
              name: emittedName,
              sourceAgentId: init.agentDbId,
              subject,
              payloadRef,
            })
            .run();
          // #P1-1 — mirror into the durable, queryable event store: full assembled payload inline
          // (small thanks to blob offload) + causation lineage, so cross-agent causality is queryable
          // + replay-safe across restarts (unlike the per-instance NDJSON ledger). This is required
          // causality evidence, so insertion failures fail the finalize step.
          dbInner
            .insert(eventStore)
            .values({
              id: emittedEventId,
              tenantId: ctx.tenantId,
              name: emittedName,
              subject: subject ?? null,
              sourceRunId: runId,
              sourceAgent: agent.name,
              causationId: triggerEventId ?? null,
              correlationId,
              payloadJson: (() => {
                const j = JSON.stringify(payload);
                // #W1-14 — no SILENT truncation: oversize payloads store a marker so audits see the cut.
                return j.length > 200_000
                  ? JSON.stringify({
                      __truncated: true,
                      bytes: j.length,
                      head: j.slice(0, 180_000),
                    })
                  : j;
              })(),
            })
            .run();
          emittedEvents.push({ id: emittedEventId, name: emittedName, index });
        }

        // The DB schema keeps one primary emitted_event_id for backwards compatibility. It points
        // to the first event; the complete ordered list lives in events/event_store and is returned.
        const emittedEventId = emittedEvents[0]?.id ?? null;

        const persistedAtMs = Date.now();
        // Persist the output receipt while the run is still in-flight. A broker rejection below must
        // leave the run non-terminal so Inngest can retry the idempotent step.sendEvent operations;
        // declaring status=ok here used to expose a false success before any downstream event was
        // actually accepted.
        dbInner
          .update(runs)
          .set({
            tokensIn,
            tokensOut,
            // #REDESIGN P1b — record the REAL model that served the run (falls back to the run's own
            // recorded model, else the configured default), not a hardcoded "mock-model-v1".
            model: runModel ?? "unknown",
            emittedEventId,
          })
          .where(eq(runs.id, runId))
          .run();
        return { emittedEventId, emittedEvents, persistedAtMs };
      });

      // The actual inngest.send must be outside step.run (step results are
      // memoized; sending an event inside a step would re-send on replay).
      // We use step.sendEvent which is Inngest's idempotent send primitive.
      for (const persisted of finalize.emittedEvents) {
        const item = outbound[persisted.index];
        if (!item) continue;
        const emittedName = persisted.name;
        const emittedEventId = persisted.id;
        const flatWireData = withCorrelation(correlationId, {
          ...item.assembled.payload,
          __triggerEventId: emittedEventId,
        });
        const wireData = eventAdapter.outbound({
          eventId: emittedEventId,
          eventName: emittedName,
          payload: flatWireData,
          subject,
          correlationId,
          sourceAgent: agent.name,
          emittedAt: new Date(finalize.persistedAtMs).toISOString(),
        });
        await step.sendEvent(`emit.${persisted.index}.${emittedEventId}`, {
          id: emittedEventId,
          name: tenantEventName(
            tenantSlug,
            emittedName,
            eventAdapter,
          ) as `${string}/${string}`,
          // #COMMS — the unified, carry-forward, offloaded payload (same object written to the ledger),
          // plus this event's id for downstream lineage.
          data: wireData,
        });
        // Stream/UI evidence is emitted only after the broker accepted the durable send step. The
        // events/event_store rows above are the persisted outbox; they are not delivery proof.
        await step.run(
          `confirm-emit.${persisted.index}.${emittedEventId}`,
          async () => {
            try {
              publish({
                type: "event.emitted",
                tenantId: ctx.tenantId,
                at: Date.now(),
                eventId: emittedEventId,
                name: emittedName,
                subject: subject ?? null,
                sourceRunId: runId,
              });
            } catch {
              /* broadcast best-effort */
            }
            return true;
          },
        );
        await writeRunLog(logCtx, "INFO", "event.emit", {
          name: emittedName,
          event_id: emittedEventId,
          index: persisted.index,
        });
      }

      const completion = await step.run("finalize-dispatched", async () => {
        const dbInner = getDb();
        const endedAtMs = Date.now();
        const updated = dbInner
          .update(runs)
          .set({
            status: "ok",
            endedAt: new Date(endedAtMs),
            durationMs: endedAtMs - startedAtMs,
            tokensIn,
            tokensOut,
            model: runModel ?? "unknown",
            emittedEventId: finalize.emittedEventId,
          })
          .where(and(eq(runs.id, runId), eq(runs.status, "running")))
          .run() as { changes?: number };
        if ((updated.changes ?? 0) !== 1) {
          const current = dbInner
            .select({ status: runs.status })
            .from(runs)
            .where(eq(runs.id, runId))
            .all()[0];
          throw new Error(
            `run ${runId} cannot be completed after event dispatch (current status: ${current?.status ?? "missing"})`,
          );
        }
        const completedReceipt = dbInner
          .select(codeActRunReceiptSelection)
          .from(runs)
          .where(eq(runs.id, runId))
          .all()[0];
        try {
          publish({
            type: "run.completed",
            tenantId: ctx.tenantId,
            at: endedAtMs,
            runId,
            durationMs: endedAtMs - startedAtMs,
            tokensIn,
            tokensOut,
            emittedEventId: finalize.emittedEventId,
            ...(completedReceipt
              ? storedCodeActReceiptFields(completedReceipt)
              : {}),
          });
        } catch {
          /* broadcast best-effort */
        }

        // Completion metrics are terminal evidence too, so they are recorded only after all
        // downstream sends have succeeded and inside a memoized step to avoid replay double-counts.
        const m = getRuntimeMetrics();
        if (m) {
          m.runs.inc({
            tenant: tenantSlug,
            agent: agent.name,
            model: runModel ?? "unknown",
            status: "ok",
          });
          m.runDuration?.observe(endedAtMs - startedAtMs, {
            tenant: tenantSlug,
            agent: agent.name,
          });
        }
        return { endedAtMs };
      });

      await writeRunLog(logCtx, "INFO", "run.end", {
        status: "ok",
        duration: completion.endedAtMs - startedAtMs + "ms",
        emitted:
          finalize.emittedEvents
            .map((item: { name: string }) => item.name)
            .join(",") || "—",
      });

      // #INVOKE-RESULT — a parent step.invoke with forward_last_result:true
      // needs the child's BUSINESS conclusion, not just a delivery receipt:
      // without it the parent's carry-forward loses fields the child minted
      // (e.g. candidate_id from the dedup registry) and downstream
      // write-before-emit gates fail closed. Spread the primary emitted
      // payload flat (envelope `_*` keys stripped; receipt keys stay
      // authoritative last) so mergeStepResults exposes it to the chain.
      const primaryPayload = outbound[0]?.assembled.payload;
      const forwardedResult: Record<string, unknown> = {};
      if (
        primaryPayload &&
        typeof primaryPayload === "object" &&
        !Array.isArray(primaryPayload)
      ) {
        for (const [key, value] of Object.entries(primaryPayload)) {
          if (!key.startsWith("_")) forwardedResult[key] = value;
        }
      }
      return {
        ...forwardedResult,
        ok: true,
        runId,
        emittedEventId: finalize.emittedEventId,
        emittedEventIds: finalize.emittedEvents.map(
          (item: { id: string }) => item.id,
        ),
      };

      async function failRun(
        rid: string,
        message: string,
        started: Date,
      ): Promise<void> {
        // UC-V11-35 / PF-GAP-15 — wrap the run-status flip in `step.run`
        // so Inngest's exactly-once contract serializes it with any
        // concurrent retry. Without the wrapper, a flake between the
        // failure detection and the DB write could fire `failRun` twice
        // (once per replay), tombstoning a run that the retry actually
        // recovered.
        await step.run(`finalize-fail-${rid}`, async () => {
          const ended = new Date();
          db.update(runs)
            .set({
              status: "failed",
              endedAt: ended,
              durationMs: ended.getTime() - started.getTime(),
              errorMessage: message,
            })
            .where(eq(runs.id, rid))
            .run();
          const failedReceipt = db
            .select(codeActRunReceiptSelection)
            .from(runs)
            .where(eq(runs.id, rid))
            .all()[0];
          try {
            publish({
              type: "run.failed",
              tenantId: ctx.tenantId,
              at: ended.getTime(),
              runId: rid,
              errorMessage: message,
              ...(failedReceipt
                ? storedCodeActReceiptFields(failedReceipt)
                : {}),
            });
          } catch {
            /* broadcast best-effort */
          }

          // UC-V11-22 / AR-GAP-07 — `runs_total{status="failed"}` so the
          // dashboards see manifest-engine failures, not just code-agent
          // failures (which already bump from BaseAgent.run).
          const m = getRuntimeMetrics();
          if (m) {
            m.runs.inc({
              tenant: tenantSlug,
              agent: agent.name,
              // #W1-3 — real served model on the failure path too.
              model: runModel ?? "unknown",
              status: "failed",
            });
          }
        });
        await writeRunLog(logCtx, "ERROR", "run.end", {
          status: "failed",
          error: message,
        });
      }
    },
  );
}
