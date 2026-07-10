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

import { getTenantInngest } from "./client";
import { runAction, type LlmTurnTrace } from "./step-engine";
import { stableStepId, shouldSkip, softInvoke, type GateState } from "./action-plan";
import { selectEmittedEvent } from "./emit-select";
import { appendToLedger } from "./event-ledger";
import { publish } from "./broadcast";
import { writeArtifact } from "./artifacts";
import { writeRunLog } from "./log-writer";
import { correlationFromEvent, withCorrelation } from "./correlation";
import type { AgentSpec } from "./manifest";
import { makeId } from "@agentic/shared";
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
  const raw = (process.env.AGENTIC_CAPTURE_LLM_TURNS ?? "").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

import type { TenantRegistry, ToolDescriptor } from "@agentic/agent-kit";
import type { InngestFunction } from "inngest";
import { getRuntimeMetrics, getRuntimeGateway } from "./llm-host";
import { globalToolRegistry } from "@agentic/tools";
import { createMemoryHandle } from "./memory";
import { makeDeliveredRuntime } from "./delivered-runtime";
import { runWithTraceContext } from "./trace-context";
// #COMMS — inter-agent message envelope: carry-forward payload assembler + content-addressed offload.
import { assembleEmitPayload, rehydratePayloadAsync } from "./message-envelope";
import { makeBlobOffloader, resolveBlobRefAsync } from "./blob-store";

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
   * Phase 1a — optional resolver mapping an `invoke` action's target ref (an agent name or
   * Inngest function id) to the registered InngestFunction, so `type:"invoke"` actions can
   * synchronously call a sub-agent via step.invoke. When unset (or the target is unknown), an
   * invoke action soft-fails to its `default_result`. Wired in bootstrap after all functions
   * are built (so siblings are resolvable by the time a handler actually runs).
   */
  resolveFunction?: (ref: string) => InngestFunction.Any | undefined;
  /**
   * Phase 2 — brain-authored declarative HTTP tools (from factory_tools), built into runtime
   * ToolDescriptors via buildDeclarativeOverlay. Merged into the per-step tenant tool map so the
   * step-engine resolves them (overlay → tenant → global) — this is what makes a tool the brain
   * DECLARED actually INVOKABLE by the deployed agent. Domain-scoped + injected by the api.
   */
  declarativeTools?: Record<string, ToolDescriptor>;
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

export function registerAgent(
  agent: AgentSpec,
  ctx: RegisterContext,
): InngestFunction.Any | null {
  const tenantSlug = ctx.tenantSlug;
  const fnId = `${tenantSlug}.${agent.name}`;

  // No triggers (e.g. `manualEntry`) → register without an event trigger and
  // skip; the workflow author fires it via an explicit external event.
  if (agent.trigger.length === 0) {
    return null;
  }

  const triggers = agent.trigger.map((t) => ({
    event: `${tenantSlug}/${t}` as `${string}/${string}`,
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

  // One Inngest app per tenant: bind this agent's function to the tenant's own
  // client (`agentic-operator-<slug>`). fnId stays `${slug}.${agent}` — Inngest
  // tracks function history by id, so we keep it stable even though the app id
  // already carries the slug (the external slug becomes
  // `agentic-operator-<slug>-<slug>.<agent>`, redundant but harmless).
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
        key: `"${tenantSlug}:" + event.data.subject`,
      },
      retries: 3,
      // Operator kill switch (POST /v1/runs/:id/cancel). The route emits
      // `${tenantSlug}/run.cancel` carrying { runId, subject }. We match on
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
          event: `${tenantSlug}/run.cancel` as `${string}/${string}`,
          if: `async.data.subject == event.data.subject`,
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
      const data = await rehydratePayloadAsync((event.data ?? {}) as Record<string, unknown>, async (ref) => (await resolveBlobRefAsync(ref)) ?? ref);
      // #COMMS — offloader for oversized OUTBOUND fields (content-addressed, dedup by sha256).
      const offloader = makeBlobOffloader();
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
        const cid = correlationFromEvent(event);
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
            logPath: null,
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
        };
      });

      const runId = init.runId;
      const correlationId = init.correlationId;
      const startedAtMs = init.startedAt;
      const startedAt = new Date(startedAtMs);
      const db = getDb();

      const logCtx = {
        tenantSlug,
        runId,
        correlationId,
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
          ? { ...ctx.tenantRegistry, tools: { ...(ctx.tenantRegistry?.tools ?? {}), ...ctx.declarativeTools } }
          : ctx.tenantRegistry;

      // #REDESIGN FU1 — the DELIVERED-tier AgentRuntime (power-strip contract). register.ts is the
      // delivered adapter: it constructs the SAME `AgentRuntime` socket the CodeAct tier does, backed
      // by durable primitives. `memory` is the REAL createMemoryHandle (persists across runs) and is
      // threaded into generated-code execution below — the one durable capability legal inside a
      // `step.run` body. emit/invoke are the durable ACTION-level ops (register already runs those via
      // step.sendEvent / step.invoke); here they log/resolve for observability + the promotion path
      // (they are NOT invoked from inside a step.run — Inngest forbids nested steps).
      const deliveredRuntime = makeDeliveredRuntime({
        agentName: agent.name,
        tenantSlug,
        correlationId,
        subject: subject ?? undefined,
        memory: createMemoryHandle({ tenantId: ctx.tenantId, agentName: agent.name, subject: subject ?? "", runId }),
        // #AUDIT-FIX(H0 fail-open twin) — 与 codeact.ts 同款：决策核心失败不得伪造 {ok:true}，
        // 返回 _reasonFailed 标记让消费方走失败分支（fail-close）并留日志。
        reason: async (sp, inp) => {
          const gw = getRuntimeGateway();
          if (!gw) {
            try { console.warn("[runtime] reason() 无 LLM 网关——fail-close，不伪造通过"); } catch { /* best-effort */ }
            return { ok: false, _reasonFailed: true, error: "llm_gateway_missing" };
          }
          let failure = "";
          const r = await gw
            .chat({ messages: [{ role: "system", content: sp }, { role: "user", content: JSON.stringify(inp ?? {}) }], tenantSlug })
            .catch((e) => { failure = String((e as Error)?.message ?? e).slice(0, 200); return null; });
          if (!r) {
            try { console.warn(`[runtime] reason() LLM 调用失败——fail-close：${failure}`); } catch { /* best-effort */ }
            return { ok: false, _reasonFailed: true, error: failure || "llm_call_failed" };
          }
          try { return JSON.parse(r.text); } catch { return { text: r.text, ok: true }; }
        },
        toolRun: async (name, toolArgs) => {
          const t = effectiveTenantRegistry?.tools?.[name] ?? globalToolRegistry.get(name);
          if (!t) return { __error: `tool ${name} not registered` };
          try {
            const r = await t.handler({ agentName: agent.name, actionName: name, correlationId, tenantSlug, event: { name, data: (toolArgs ?? {}) as Record<string, unknown> } } as never);
            return (r as { data?: unknown })?.data ?? r;
          } catch (e) { return { __error: (e as Error).message }; }
        },
        emit: (evName, payload) => { void writeRunLog(logCtx, "INFO", "delivered.emit", { event: evName, payload }); },
        invoke: async (ref) => { void ctx.resolveFunction?.(ref); return null; /* durable invoke is a type:"invoke" action; see the loop below */ },
        log: (level, msg, data) => { try { logger[level]?.(msg, data as object) ?? logger.info(msg, data as object); } catch { /* best-effort */ } },
      });

      let tokensIn = 0;
      let tokensOut = 0;
      let lastResult: unknown = null;
      // #REDESIGN P1 — execution receipt. Set true when a logic action's GENERATED CODE actually ran
      // (runGeneratedCode returned non-null); stays false if it fell back to the declarative/prompt
      // path. Persisted to runs.code_ran at finalize so the finish gate can require real execution.
      let codeRan = false;
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
        // Inngest itself retries transient failures — that IS the "best-effort" mechanism. Only the
        // run-log write (a plain fs op) stays best-effort.
        await step.sendEvent(`compensate.${runId}`, {
          name: `${tenantSlug}/${comp}` as `${string}/${string}`,
          data: withCorrelation(correlationId, { subject: subject ?? undefined, source_agent: agent.name, source_run: runId, __compensation: true, reason: reason.slice(0, 200) }),
        });
        await writeRunLog(logCtx, "WARN", "run.compensate", { event: comp, reason: reason.slice(0, 200) }).catch(() => {});
      };

      for (let i = 0; i < agent.actions.length; i++) {
        const action = agent.actions[i]!;
        const ord = i + 1;
        // Scope for stable idempotency-keyed step ids + (later) invoke input resolution.
        const stepScope = {
          event: { name: event.name, data },
          subject: subject ?? undefined,
          lastResult,
        };

        // Phase 1a — dependsOn gating. Skip (don't fail) an action whose gating condition was
        // false or whose dependency was skipped. Backward-compatible: actions with no depends_on
        // never skip, so existing single-path manifests are unaffected.
        const skip = shouldSkip({ name: action.name, dependsOn: (action as { depends_on?: string[] }).depends_on }, gate);
        if (skip.skip) {
          gate.skipped.add(action.name);
          await writeRunLog(logCtx, "INFO", "step.skip", { ord, name: action.name, type: action.type, reason: skip.reason });
          continue;
        }

        // Phase 1a — synchronous sub-agent invoke (step.invoke) with timeout + soft-fail default.
        // Dormant for existing manifests (none declare type:"invoke"). Resolves the target via the
        // optional ctx.resolveFunction; soft-fails to `default_result` when unresolved or on error.
        if (action.type === "invoke") {
          const a = action as { invoke?: string; invoke_input?: Record<string, unknown>; timeout_s?: number; on_error?: "soft" | "terminal"; default_result?: unknown };
          const targetRef = a.invoke ?? "";
          const fn = ctx.resolveFunction?.(targetRef);
          const invoked = await softInvoke(
            async () => {
              if (!fn) throw new Error(`invoke target "${targetRef}" not resolvable`);
              return await step.invoke(`invoke-${stableStepId(action.name, (action as { idempotency_key_from?: string }).idempotency_key_from, stepScope)}`, {
                function: fn,
                data: { ...(a.invoke_input ?? {}), _subject: subject, _correlationId: correlationId },
                timeout: a.timeout_s ? `${a.timeout_s}s` : undefined,
              });
            },
            { timeoutMs: a.timeout_s ? a.timeout_s * 1000 : undefined, onError: a.on_error ?? "soft", fallback: a.default_result },
          );
          if (!invoked.ok && (a.on_error ?? "soft") !== "soft") {
            await failRun(runId, `invoke ${targetRef} failed`, startedAt);
            throw new Error(`invoke ${targetRef} failed`);
          }
          lastResult = invoked.data ?? null;
          await writeRunLog(logCtx, invoked.softFailed ? "WARN" : "INFO", "step.invoke", { ord, name: action.name, target: targetRef, softFailed: invoked.softFailed, timedOut: invoked.timedOut });
          continue;
        }

        if (action.type === "subflow") {
          // #P1-3 — subflow FANOUT: the manifest's `subflow` names a child event; emit it so a sibling
          // agent handles it in parallel. Fire-and-forget (async fanout) — the child's result flows back
          // via ITS own emitted event, not synchronously (that's what `invoke` is for). step.sendEvent is
          // idempotent + runs at the handler top level (not inside step.run), so it's replay-safe.
          const a = action as { subflow?: string; subflow_input?: Record<string, unknown> };
          const target = (a.subflow ?? "").trim();
          if (target) {
            await step.sendEvent(`subflow.${stableStepId(action.name, (action as { idempotency_key_from?: string }).idempotency_key_from, stepScope)}`, {
              name: `${tenantSlug}/${target}` as `${string}/${string}`,
              data: withCorrelation(correlationId, {
                ...(a.subflow_input ?? {}),
                ...(lastResult && typeof lastResult === "object" && !Array.isArray(lastResult) ? (lastResult as Record<string, unknown>) : {}), // #W1-5 arrays would flatten to numeric keys
                subject: subject ?? undefined,
                source_agent: agent.name,
                source_run: runId,
              }),
            });
            await writeRunLog(logCtx, "INFO", "step.subflow", { ord, name: action.name, target });
          } else {
            await writeRunLog(logCtx, "WARN", "step.subflow", { ord, name: action.name, reason: "no subflow target declared" });
          }
          continue;
        }

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
                // invoke steps never reach an insert (handled+continue'd above); cast to the
                // steps.type column union which predates the "invoke" member.
                type: action.type as "tool" | "logic" | "manual" | "condition" | "delay" | "subflow",
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
                priority: "medium",
                status: "open",
                payloadJson: {
                  agentName: agent.name,
                  actionName: action.name,
                  description: action.description,
                  subject,
                  condition: action.condition ?? null,
                } as never,
              } as never)
              .run();
            return { stepId: sid, taskId: tid, sStarted };
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
          // Per-tenant app: HITL resume listens on the tenant-namespaced
          // `${slug}/task.resolved` (the resolve route sends it on the SAME
          // tenant client). With one app per tenant the bare `task.resolved`
          // would not be served by this tenant's app, so the name MUST be
          // namespaced in lockstep with `routes/v1/tasks.ts`. The tenantId
          // predicate stays as defense-in-depth.
          const resolved = await step.waitForEvent(`wait-task-${ord}`, {
            event: `${tenantSlug}/task.resolved` as `${string}/${string}`,
            if: `async.data.taskId == "${initStep.taskId}" && async.data.tenantId == "${ctx.tenantId}"`,
            timeout: "7d",
          });

          if (!resolved) {
            // Timeout — mark task + step + run as failed.
            await step.run(`timeout-task-${ord}`, async () => {
              const dbInner = getDb();
              dbInner
                .update(steps)
                .set({ status: "failed", error: "task timeout", endedAt: new Date() })
                .where(eq(steps.id, initStep.stepId))
                .run();
              dbInner
                .update(tasksTable)
                .set({ status: "snoozed" })
                .where(eq(tasksTable.id, initStep.taskId))
                .run();
            });
            await failRun(runId, `task ${initStep.taskId} timed out`, startedAt);
            throw new Error("task timeout");
          }

          const resolution = (resolved.data ?? {}) as {
            taskId: string;
            decision?: string;
            payload?: unknown;
          };

          await step.run(`close-task-${ord}`, async () => {
            const dbInner = getDb();
            const sEnded = Date.now();
            dbInner
              .update(steps)
              .set({
                status: resolution.decision === "reject" ? "failed" : "ok",
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
          });

          if (resolution.decision === "reject") {
            await failRun(runId, "human rejected", startedAt);
            throw new Error("rejected by human");
          }

          lastResult = resolution.payload ?? null;
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
        const stepKey = stableStepId(action.name, (action as { idempotency_key_from?: string }).idempotency_key_from, stepScope);
        // Phase 1 — per-step failure policy. on_error:"soft" → log + continue with default_result
        // (the createJD fetch-clarifications pattern: a non-critical step that must not break the
        // run). Otherwise a failed step fails the run. "park"/default → Inngest retries (unset).
        const onErr = (action as { on_error?: "soft" | "terminal" }).on_error;
        const softDefault = (action as { default_result?: unknown }).default_result ?? null;
        let stepOutcome: { ok: boolean; data: unknown; tokensIn: number; tokensOut: number; durationMs: number };
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
                type: action.type as "tool" | "logic" | "manual" | "condition" | "delay" | "subflow",
                status: "running",
                startedAt: new Date(sStarted),
                attempts: 1,
              })
              .run();
          }
          await writeRunLog(logCtx, attempt > 1 ? "WARN" : "DEBUG", "step.start", {
            ord,
            name: action.name,
            type: action.type,
            attempt,
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
          } catch {
            /* broadcast best-effort */
          }

          try {
            const res = await runWithTraceContext({ correlationId, agentName: agent.name, tenantSlug, runId }, () => runAction({
              ctx: {
                agentName: agent.name,
                actionName: action.name,
                subject: subject ?? undefined,
                correlationId,
                runId,
                tenantSlug,
                event: {
                  name: event.name,
                  data,
                },
                lastResult,
                // #P0-1 — durable scoped memory reaches tenant tools (the production code path), not
                // just generated code. Same handle threaded via StepInput.memory for generated code.
                memory: deliveredRuntime.memory,
              },
              action,
              // Hand the step engine the slots it needs for prompt assembly
              // AND the tool-use loop. `tool_use` is the canonical roster
              // of advertised tools — the engine cross-references each
              // entry against `tenantRegistry.tools` before passing it to
              // the LLM, so a stale declaration silently no-ops instead of
              // crashing.
              agent: {
                name: agent.name,
                description: agent.description,
                ontology_instructions: agent.ontology_instructions,
                generated: (agent as { generated?: boolean }).generated,
                codeExecuted: (agent as { codeExecuted?: boolean }).codeExecuted,
                typescriptCode: agent.typescript_code,
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
              memory: deliveredRuntime.memory,
            })); // #SCALE-TRACE — ambient correlationId/agentName/tenantSlug/runId for nested tools/logs
            // #REDESIGN P1 — receipt: the generated handler actually executed (didn't fall back).
            if ((res.meta as { codeExecuted?: boolean } | undefined)?.codeExecuted === true) codeRan = true;
            if (res.model) runModel = res.model;
            const sEnded = Date.now();
            // Persist this step's INPUT (what flowed in — the prior step's
            // result + the trigger event) and OUTPUT (what it returned) so the
            // run-detail Timeline/Trace/IO tabs can show real per-step
            // input/output, Inngest-style. Best-effort; mirrors the code
            // engine (run-engine.ts). Inside step.run ⇒ written once per run.
            let stepInputRef: string | null = null;
            let stepOutputRef: string | null = null;
            try {
              stepInputRef = await writeArtifact(runId, `step-${ord}-input.json`, {
                last_result: lastResult ?? null,
                trigger_event: event.name,
                subject: subject ?? null,
              });
              stepOutputRef = await writeArtifact(
                runId,
                `step-${ord}-output.json`,
                res.data ?? null,
              );
            } catch {
              /* artifact write best-effort — never fail the step */
            }
            dbInner
              .update(steps)
              .set({
                status: res.ok ? "ok" : "failed",
                endedAt: new Date(sEnded),
                durationMs: sEnded - sStarted,
                inputRef: stepInputRef,
                outputRef: stepOutputRef,
                provider: res.provider ?? null,
                model: res.model ?? null,
                tokensIn: res.tokensIn ?? null,
                tokensOut: res.tokensOut ?? null,
              })
              .where(eq(steps.id, sid))
              .run();
            // #W0 — persist the raw per-turn LLM capture (response text +
            // reasoning + requested tools) to `llm_turns`, keyed on runId+stepId.
            // Gated + best-effort: a capture failure must never fail the step.
            // Inside step.run ⇒ written exactly once per real execution. On an
            // Inngest retry (attempt>1) we clear the prior attempt's rows first
            // so a retried step doesn't accumulate duplicate turns.
            if (captureLlmTurns()) {
              const capturedTurns = (
                res.meta as { turns?: LlmTurnTrace[] } | undefined
              )?.turns;
              if (Array.isArray(capturedTurns) && capturedTurns.length > 0) {
                try {
                  if (attempt > 1) {
                    dbInner.delete(llmTurns).where(eq(llmTurns.stepId, sid)).run();
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
                } catch {
                  /* capture is a debugging aid, never a correctness gate */
                }
              }
            }
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
                error: null,
              });
            } catch {
              /* broadcast best-effort */
            }
            // Rich per-call logs so the run viewer reads like Inngest's trace:
            // one llm.call line (provider/model/tokens) + one tool.call line
            // per dispatched tool, before the step.ok summary.
            if (res.provider || res.model) {
              await writeRunLog(logCtx, "INFO", "llm.call", {
                step: action.name,
                provider: res.provider ?? "—",
                model: res.model ?? "—",
                tokens_in: res.tokensIn ?? 0,
                tokens_out: res.tokensOut ?? 0,
              });
            }
            const toolCalls = (res.meta as { toolCalls?: Array<{ name: string; isError?: boolean; durationMs?: number }> } | undefined)?.toolCalls;
            if (Array.isArray(toolCalls)) {
              for (const tc of toolCalls) {
                await writeRunLog(logCtx, tc.isError ? "ERROR" : "INFO", "tool.call", {
                  step: action.name,
                  tool: tc.name,
                  ok: tc.isError ? false : true,
                  duration: `${tc.durationMs ?? 0}ms`,
                });
              }
            }
            return {
              ok: res.ok,
              data: res.data,
              tokensIn: res.tokensIn ?? 0,
              tokensOut: res.tokensOut ?? 0,
              durationMs: sEnded - sStarted,
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
            await writeRunLog(logCtx, "ERROR", "step.fail", {
              ord,
              name: action.name,
              attempt,
              error: message,
            });
            throw err;
          }
        });
        } catch (stepErr) {
          // Phase 1 — step.run threw after its own Inngest retries. Honor the per-step policy:
          // soft → log + continue with the default; otherwise fail the run.
          if (onErr === "soft") {
            const errMsg = stepErr instanceof Error ? stepErr.message : String(stepErr);
            await writeRunLog(logCtx, "WARN", "step.soft-fail", { ord, name: action.name, error: errMsg });
            // #SCALE-ANALYSIS — optional agent-aware error reflection (AGENTIC_ERROR_ANALYSIS=1): one
            // memoized LLM pass over the failure so the run log carries a DIAGNOSIS, not just the raw
            // error. Inside its own step.run (we're at handler level here) → replay-safe; best-effort.
            if (process.env.AGENTIC_ERROR_ANALYSIS === "1") {
              try {
                const advice = await step.run(`error-analysis-${ord}`, async () => {
                  const gw = getRuntimeGateway();
                  if (!gw) return null;
                  const r = await gw.chat({ messages: [
                    { role: "system", content: "你是运行时错误分析器。判断这个失败是【业务失败/外部依赖临时故障/输入数据问题/配置问题】哪一类,一句话给处置建议(重试/跳过/修数据/修配置)。只输出一句中文。" },
                    { role: "user", content: `agent=${agent.name} step=${action.name} error=${errMsg.slice(0, 400)} lastResult=${JSON.stringify(lastResult ?? {}).slice(0, 400)}` },
                  ], tenantSlug }).catch(() => null);
                  return r?.text?.slice(0, 300) ?? null;
                });
                if (advice) await writeRunLog(logCtx, "INFO", "step.error-analysis", { ord, name: action.name, advice });
              } catch { /* analysis never affects the run */ }
            }
            lastResult = softDefault;
            continue;
          }
          await emitCompensation(stepErr instanceof Error ? stepErr.message : String(stepErr));
          throw stepErr;
        }

        if (!stepOutcome.ok) {
          if (onErr === "soft") {
            await writeRunLog(logCtx, "WARN", "step.soft-fail", { ord, name: action.name, reason: "ok=false" });
            lastResult = softDefault;
            continue;
          }
          await failRun(runId, "step returned ok=false", startedAt);
          await emitCompensation(`step ${action.name} returned ok=false`);
          throw new Error(`step ${action.name} failed`);
        }
        tokensIn += stepOutcome.tokensIn;
        tokensOut += stepOutcome.tokensOut;
        lastResult = stepOutcome.data;

        // Phase 1a — record a condition step's verdict so downstream depends_on actions branch on it.
        if (action.type === "condition") {
          gate.conditionTrue[action.name] = Boolean((stepOutcome.data as { evaluated?: boolean } | null)?.evaluated);
        }

        await writeRunLog(logCtx, "INFO", "step.ok", {
          name: action.name,
          type: action.type,
          duration: stepOutcome.durationMs + "ms",
        });
      }

      // Emit downstream event + finalize run — wrapped in step.run so it
      // executes once even with Inngest replays.
      //
      // Branch-emit: a forked agent's final step can name which declared
      // `triggered_event` to emit (e.g. MATCH_FAILED vs MATCH_PASSED_*) via an
      // `_emit`/`event`/`next_event` field on its result; validated against the
      // declared list, falling back to [0] for every single-outcome agent.
      const emittedName = selectEmittedEvent(agent.triggered_event, lastResult);
      // #COMMS — assemble the outbound payload: carry-forward the inbound business fields (so nothing
      // the final step forgot to echo is LOST), unify to top-level (matching external-trigger shape),
      // offload oversized fields to content-addressed refs (keeps the wire + ledger small), keep
      // last_result for back-compat, stamp _meta provenance. Deterministic given (data, lastResult) so
      // recomputing outside step.run is replay-safe; blob writes are idempotent (content-addressed).
      const assembled = emittedName
        ? assembleEmitPayload({
            incoming: data,
            lastResult,
            meta: {
              subject: subject ?? undefined,
              correlationId,
              causationId: triggerEventId ?? correlationId,
              producedBy: agent.name,
              sourceRun: runId,
            },
            offload: offloader,
          })
        : null;
      if (assembled && (assembled.carried.length || assembled.offloaded.length || assembled.missing.length)) {
        await writeRunLog(logCtx, assembled.missing.length ? "WARN" : "INFO", "emit.envelope", {
          event: emittedName,
          carried: assembled.carried, // inbound fields rescued from loss
          offloaded: assembled.offloaded, // oversized fields moved to content-addressed refs
          missing: assembled.missing, // declared contract fields absent (a data gap)
        });
      }
      const finalize = await step.run("finalize", async () => {
        const dbInner = getDb();
        let emittedEventId: string | null = null;
        if (emittedName) {
          emittedEventId = makeId("evt");
          const payload = assembled?.payload ?? {}; // #W1-12 — no non-null assertion; guard is if(emittedName) but keep this decoupled
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
          // + replay-safe across restarts (unlike the per-instance NDJSON ledger). Best-effort.
          try {
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
                  const j = JSON.stringify(assembled?.payload ?? {});
                  // #W1-14 — no SILENT truncation: oversize payloads store a marker so audits see the cut.
                  return j.length > 200_000 ? JSON.stringify({ __truncated: true, bytes: j.length, head: j.slice(0, 180_000) }) : j;
                })(),
              })
              .run();
          } catch {
            /* durable event store best-effort — never fails the run */
          }
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
        }

        const endedAtMs = Date.now();
        dbInner
          .update(runs)
          .set({
            status: "ok",
            endedAt: new Date(endedAtMs),
            durationMs: endedAtMs - startedAtMs,
            tokensIn,
            tokensOut,
            // #REDESIGN P1b — record the REAL model that served the run (falls back to the run's own
            // recorded model, else the configured default), not a hardcoded "mock-model-v1".
            model: runModel ?? "unknown",
            emittedEventId,
            // #REDESIGN P1 — execution receipt (see the run-scoped `codeRan`).
            codeRan,
          })
          .where(eq(runs.id, runId))
          .run();
        try {
          publish({
            type: "run.completed",
            tenantId: ctx.tenantId,
            at: endedAtMs,
            runId,
            durationMs: endedAtMs - startedAtMs,
            tokensIn,
            tokensOut,
            emittedEventId,
          });
        } catch {
          /* broadcast best-effort */
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
            // #W1-3 — real served model (was a hardcoded "mock-model-v1" that made per-model metrics lie).
            model: runModel ?? "unknown",
            status: "ok",
          });
          m.runDuration?.observe(endedAtMs - startedAtMs, {
            tenant: tenantSlug,
            agent: agent.name,
          });
        }
        return { emittedEventId, endedAtMs };
      });

      // The actual inngest.send must be outside step.run (step results are
      // memoized; sending an event inside a step would re-send on replay).
      // We use step.sendEvent which is Inngest's idempotent send primitive.
      if (emittedName && finalize.emittedEventId) {
        await step.sendEvent(`emit.${emittedName}`, {
          name: `${tenantSlug}/${emittedName}` as `${string}/${string}`,
          // #COMMS — the unified, carry-forward, offloaded payload (same object written to the ledger),
          // plus this event's id for downstream lineage.
          data: withCorrelation(correlationId, {
            ...(assembled?.payload ?? {}),
            __triggerEventId: finalize.emittedEventId,
          }),
        });
        await writeRunLog(logCtx, "INFO", "event.emit", {
          name: emittedName,
          event_id: finalize.emittedEventId,
        });
      }

      await writeRunLog(logCtx, "INFO", "run.end", {
        status: "ok",
        duration: finalize.endedAtMs - startedAtMs + "ms",
        emitted: emittedName ?? "—",
      });

      return { ok: true, runId, emittedEventId: finalize.emittedEventId };

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
          try {
            publish({
              type: "run.failed",
              tenantId: ctx.tenantId,
              at: ended.getTime(),
              runId: rid,
              errorMessage: message,
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
