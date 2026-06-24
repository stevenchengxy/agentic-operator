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
import { runAction } from "./step-engine";
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
  runs,
  steps,
  tasks as tasksTable,
  workflows,
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
      const data = (event.data ?? {}) as Record<string, unknown>;
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

      let tokensIn = 0;
      let tokensOut = 0;
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
            const res = await runAction({
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
                description: agent.description,
                ontology_instructions: agent.ontology_instructions,
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
                tokensIn: res.tokensIn ?? null,
                tokensOut: res.tokensOut ?? null,
              })
              .where(eq(steps.id, sid))
              .run();
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
                provider: null,
                model: null,
                tokensIn: res.tokensIn ?? null,
                tokensOut: res.tokensOut ?? null,
                error: null,
              });
            } catch {
              /* broadcast best-effort */
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
            throw err;
          }
        });

        if (!stepOutcome.ok) {
          await failRun(runId, "step returned ok=false", startedAt);
          throw new Error(`step ${action.name} failed`);
        }
        tokensIn += stepOutcome.tokensIn;
        tokensOut += stepOutcome.tokensOut;
        lastResult = stepOutcome.data;

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
            model: "mock-model-v1",
            emittedEventId,
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
            model: "mock-model-v1",
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
          data: withCorrelation(correlationId, {
            source_agent: agent.name,
            source_run: runId,
            subject: subject ?? undefined,
            last_result: lastResult,
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
              model: "mock-model-v1",
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
