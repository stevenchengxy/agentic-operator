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
import { runAction } from "./step-engine";
import { appendToLedger } from "./event-ledger";
import { writeRunLog } from "./log-writer";
import { writeArtifact } from "./artifacts";
import { correlationFromEvent, withCorrelation } from "./correlation";
import type { AgentSpec } from "./manifest";
import { makeId } from "@agentic/shared";
import {
  agents,
  agentVersions,
  events,
  runs,
  steps,
  tasks as tasksTable,
  artifacts,
  getDb,
} from "@agentic/db";
import { eq, and } from "drizzle-orm";

import type { TenantRegistry } from "@agentic/agent-kit";
import type { InngestFunction } from "inngest";
import { getRuntimeMetrics } from "./llm-host";

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

  return inngest.createFunction(
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
      const data = (event.data ?? {}) as Record<string, unknown>;
      if (!eventTargetsAgent(data, agent.name)) {
        return {
          skipped: true,
          reason: "targeted_event_for_another_agent",
          targetAgent: data.__invokedAgent,
        };
      }
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
            logPath: null,
          })
          .run();
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
      let lastResult: unknown = null;

      for (let i = 0; i < agent.actions.length; i++) {
        const action = agent.actions[i]!;
        const ord = i + 1;

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
            // step.ok logged inside this memoized block (approve path only —
            // a reject is surfaced via failRun's run.end below) so replays
            // don't append a duplicate line.
            if (resolution.decision !== "reject") {
              await safeRunLog("INFO", "step.ok", {
                name: action.name,
                type: action.type,
                taskId: initStep.taskId,
                decision: resolution.decision ?? "approve",
              });
            }
          });

          if (resolution.decision === "reject") {
            await failRun(runId, "human rejected", startedAt);
            throw new Error("rejected by human");
          }

          lastResult = resolution.payload ?? null;
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
              // portal Logs view tails it over SSE). Without it the engine
              // still logs to stdout but the in-product trace would miss the
              // per-tool detail. stepOrd is intentionally omitted — passing
              // it would also switch on the artifact-sidecar JSON writes,
              // which is a separate (heavier) debugging feature.
              runId,
              ctx: {
                agentName: agent.name,
                actionName: action.name,
                subject: subject ?? undefined,
                correlationId,
                tenantSlug,
                event: {
                  name: event.name,
                  data: (event.data ?? {}) as Record<string, unknown>,
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
              agent: {
                name: agent.name,
                tenantId: ctx.tenantId,
                description: agent.description,
                ontology_instructions: agent.ontology_instructions,
                generated: (agent as { generated?: boolean }).generated,
                model: (agent as { model?: string }).model,
                provider: (
                  agent as {
                    provider?: import("@agentic/contracts").ProviderId;
                  }
                ).provider,
                timeout_s: (agent as { timeout_s?: number }).timeout_s,
                tool_use: Array.isArray(agent.tool_use)
                  ? (agent.tool_use as Array<{
                      name: string;
                      description?: string;
                      input_schema?: unknown;
                    }>)
                  : undefined,
              },
              tenantRegistry: ctx.tenantRegistry,
              autoResolveManual: true,
            });
            const sEnded = Date.now();
            dbInner
              .update(steps)
              .set({
                status: res.ok ? "ok" : "failed",
                endedAt: new Date(sEnded),
                durationMs: sEnded - sStarted,
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

        if (!stepOutcome.ok) {
          await failRun(runId, "step returned ok=false", startedAt);
          throw new Error(`step ${action.name} failed`);
        }
        tokensIn += stepOutcome.tokensIn;
        tokensOut += stepOutcome.tokensOut;
        lastModel = stepOutcome.model ?? lastModel;
        lastResult = stepOutcome.data;
        // (step.ok is written inside the memoized step.run block above.)
      }

      // Emit downstream event + finalize run — wrapped in step.run so it
      // executes once even with Inngest replays.
      const emittedName = agent.triggered_event[0];
      const finalize = await step.run("finalize", async () => {
        const dbInner = getDb();
        let emittedEventId: string | null = null;
        if (emittedName) {
          emittedEventId = makeId("evt");
          const payload = {
            source_agent: agent.name,
            source_run: runId,
            subject,
            last_result: lastResult,
          };
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
          // event.emit logged inside this memoized block (the actual
          // step.sendEvent stays outside — it's Inngest-idempotent on its own).
          await safeRunLog("INFO", "event.emit", {
            name: emittedName,
            event_id: emittedEventId,
          });
        }

        const endedAtMs = Date.now();
        const outputArtifactPath = await writeArtifact(
          runId,
          "run-output.json",
          {
            run_id: runId,
            agent: agent.name,
            title: agent.title ?? agent.name,
            tenant: tenantSlug,
            status: "ok",
            trigger: {
              name: event.name,
              subject,
              data,
            },
            output: lastResult,
            emitted_event: emittedName ?? null,
            tokens: { in: tokensIn, out: tokensOut, model: lastModel },
            started_at: startedAt.toISOString(),
            ended_at: new Date(endedAtMs).toISOString(),
          },
        );
        const outputArtifactId = makeId("art");
        const outputArtifactSize = (await stat(outputArtifactPath)).size;
        dbInner
          .insert(artifacts)
          .values({
            id: outputArtifactId,
            tenantId: ctx.tenantId,
            runId,
            kind: "application/json",
            path: outputArtifactPath,
            size: outputArtifactSize,
          })
          .run();
        dbInner
          .update(runs)
          .set({
            status: "ok",
            endedAt: new Date(endedAtMs),
            durationMs: endedAtMs - startedAtMs,
            tokensIn,
            tokensOut,
            model: lastModel,
            emittedEventId,
          })
          .where(eq(runs.id, runId))
          .run();

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
          emitted: emittedName ?? "—",
        });
        return { emittedEventId, endedAtMs };
      });

      // The actual inngest.send must be outside step.run (step results are
      // memoized; sending an event inside a step would re-send on replay).
      // We use step.sendEvent which is Inngest's idempotent send primitive.
      // The event.emit + run.end LOG lines were already written inside the
      // memoized `finalize` step above, so they aren't duplicated here.
      if (emittedName && finalize.emittedEventId) {
        await step.sendEvent(`emit.${emittedName}`, {
          name: `${tenantSlug}/${emittedName}` as `${string}/${string}`,
          data: withCorrelation(correlationId, {
            source_agent: agent.name,
            source_run: runId,
            subject: subject ?? undefined,
            last_result: lastResult,
            __triggerEventId: finalize.emittedEventId,
          }),
        });
      }

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

          // UC-V11-22 / AR-GAP-07 — `runs_total{status="failed"}` so the
          // dashboards see manifest-engine failures, not just code-agent
          // failures (which already bump from BaseAgent.run).
          const m = getRuntimeMetrics();
          if (m) {
            m.runs.inc({
              tenant: tenantSlug,
              agent: agent.name,
              model: "mock-model-v1",
              status: "failed",
            });
          }
          // run.end (failed) logged inside this memoized block so a replay
          // doesn't append a duplicate terminal line, and via try/catch so a
          // log IO failure can't mask the run failure being recorded.
          try {
            await writeRunLog(logCtx, "ERROR", "run.end", {
              status: "failed",
              error: message,
            });
          } catch (err) {
            logger.warn("run.end(failed) log failed", { err: String(err) });
          }
        });
      }
    },
  );
}
