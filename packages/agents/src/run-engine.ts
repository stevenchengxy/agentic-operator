/**
 * Run engine — implements `BaseAgent.run()`.
 *
 * Responsibilities:
 *   1. Resolve tenant + DB rows.
 *   2. Allocate runId + correlationId; INSERT into `runs`.
 *   3. Open the file log (writeRunLog 'run.start').
 *   4. Build messages → call gateway.chat().
 *   5. INSERT into `steps` (one row per call; v1 = 1 step).
 *   6. Persist prompt + response sidecars under data/artifacts/<runId>/.
 *   7. parseOutput().
 *   8. UPDATE `runs` (status, tokens, model, ended_at, duration).
 *   9. writeRunLog('run.ok' or 'run.fail').
 *  10. Return AgentResult.
 *
 * Failure modes are caught and recorded; the LLMError is re-thrown for the
 * caller (HTTP layer) to convert into a 4xx/5xx envelope.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";

import { agents, agentVersions, getDb, runs, steps, tenants } from "@agentic/db";
import type { DB } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { publishStreamEvent, writeRunLog } from "@agentic/runtime";
import type { ProviderId } from "@agentic/contracts";
import {
  LLMError,
  isLLMError,
  type ChatMessage,
  type ChatResponse,
} from "@agentic/llm-gateway";

import type { BaseAgent } from "./base-agent";
import type { AgentContext, AgentResult } from "./types";
import { getGateway } from "./gateway-host";

const SYSTEM_TENANT_SLUG = "__system";

/**
 * Operator kill switch (POST /v1/runs/:id/cancel) for code agents.
 *
 * Unlike manifest agents — which Inngest can terminate mid-step via
 * `cancelOn` — code-agent runs execute synchronously inside the invoke
 * route handler. We therefore poll `runs.status` at the natural
 * checkpoints (before the LLM call, before parseOutput) and throw this
 * error when the row has flipped to `cancelled`. The invoke route catches
 * it and returns 200 with `{status: 'cancelled'}` — cancellation is a
 * successful outcome, not a 4xx/5xx.
 */
export class RunCancelledError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`run ${runId} cancelled by operator`);
    this.name = "RunCancelledError";
    this.runId = runId;
  }
}

function isRunCancelled(db: DB, runId: string): boolean {
  const row = db
    .select({ status: runs.status })
    .from(runs)
    .where(eq(runs.id, runId))
    .all()[0];
  return row?.status === "cancelled";
}

function artifactsRoot(): string {
  return process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts";
}

async function writeArtifact(runId: string, name: string, payload: unknown): Promise<string> {
  const dir = path.join(artifactsRoot(), runId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  await writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function resolveTenantId(db: DB, slug: string): { id: string; slug: string } {
  const row = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
  if (!row) {
    throw new LLMError(
      `Tenant '${slug}' not found — bootstrap must run first`,
      "bad_request",
      "mock",
    );
  }
  return { id: row.id, slug: row.slug };
}

function resolveAgentRow(
  db: DB,
  agentName: string,
  tenantId: string,
): { agentId: string; agentVersionId: string | null } {
  const agentRows = db
    .select()
    .from(agents)
    .where(eq(agents.kebabId, agentName))
    .all();

  if (agentRows.length === 0) {
    throw new LLMError(
      `Agent '${agentName}' is not registered in DB — bootstrap must run first`,
      "bad_request",
      "mock",
    );
  }

  // Prefer the row whose workflow is in the right tenant; otherwise take the first.
  // For code agents the kebab_id is unique per workflow, and the __system workflow
  // is the only one carrying them, so this lookup is effectively unambiguous.
  const agentRow = agentRows[0]!;
  const av = db
    .select()
    .from(agentVersions)
    .where(eq(agentVersions.agentId, agentRow.id))
    .all()[0];

  return {
    agentId: agentRow.id,
    agentVersionId: av?.id ?? null,
  };
}

export async function executeAgentRun<TInput, TOutput>(
  agent: BaseAgent<TInput, TOutput>,
  input: TInput,
  ctx: AgentContext,
): Promise<AgentResult<TOutput>> {
  const db = getDb();
  const gateway = getGateway();
  const tenantSlug = ctx.tenantSlug || SYSTEM_TENANT_SLUG;
  const { id: tenantId } = resolveTenantId(db, tenantSlug);
  const { agentId, agentVersionId } = resolveAgentRow(db, agent.name, tenantId);

  const runId = makeId("run");
  const stepId = makeId("stp");
  const correlationId = ctx.correlationId ?? makeId("cor");
  const startedAt = Date.now();
  const logCtx = { tenantSlug, runId, correlationId };
  // P2-FE-18 — propagate the test-run flag from the API layer (set when the
  // caller hit `POST /v1/agents/:name/invoke?testRun=1`). Drives both the
  // `runs.is_test` column and the broadcast `run.started` event payload so
  // operator SSE clients can paint the TEST badge without an extra DB read.
  const isTest = ctx.testRun === true;

  // Initial run row
  db.insert(runs)
    .values({
      id: runId,
      tenantId,
      agentId,
      agentVersionId: agentVersionId ?? null,
      triggerEventId: null,
      status: "running",
      startedAt: new Date(startedAt),
      correlationId,
      subject: null,
      isTest,
      logPath: null,
    })
    .run();

  // P2-FE-18 — emit the SSE `run.started` event so the operator portal can
  // render the new row (and TEST badge) without polling. Best-effort: a
  // broadcast failure must not abort the synchronous invoke path.
  try {
    publishStreamEvent({
      type: "run.started",
      tenantId,
      at: startedAt,
      runId,
      agentName: agent.name,
      triggerEvent: null,
      subject: null,
      correlationId,
      testRun: isTest,
    });
  } catch {
    /* broadcast best-effort */
  }

  await writeRunLog(logCtx, "INFO", "run.start", {
    agent: agent.name,
    kind: "code",
    invocation_id: ctx.invocationId ?? "—",
    test_run: isTest,
  });

  // Initial step row
  db.insert(steps)
    .values({
      id: stepId,
      runId,
      ord: 1,
      name: "llm.call",
      type: "logic",
      status: "running",
      startedAt: new Date(),
    })
    .run();

  try {
    const provider: ProviderId | undefined = ctx.provider ?? agent.defaultProvider;
    const model = ctx.model ?? agent.defaultModel;
    const reasoning = ctx.reasoning ?? agent.defaultReasoning;
    const verbosity = ctx.verbosity ?? agent.defaultVerbosity;
    const store = ctx.store ?? agent.storeResponses;

    const messages: ChatMessage[] = await agent._buildMessages(input, ctx);
    const inputArtifact = await writeArtifact(runId, "step-1-input.json", {
      agent: agent.name,
      provider,
      model,
      reasoning,
      verbosity,
      store,
      messages,
    });

    // Cooperative cancel checkpoint #1 — before the LLM call. The route
    // handler `POST /v1/runs/:id/cancel` flips `runs.status='cancelled'`
    // synchronously; we read it here so a Stop click that lands after the
    // run starts but before the (potentially seconds-long) provider call
    // skips the spend entirely.
    if (isRunCancelled(db, runId)) {
      throw new RunCancelledError(runId);
    }

    const response: ChatResponse = await gateway.chat({
      messages,
      provider,
      model: model ?? undefined,
      reasoning,
      verbosity,
      store,
      tenantId,
      runId,
      stepId,
      purpose: "code-agent",
    });

    // Cooperative cancel checkpoint #2 — between the LLM response and
    // parseOutput. The provider call may have taken several seconds; the
    // operator could have clicked Stop while it was in flight. Honouring
    // the cancel here keeps the run row in `cancelled` rather than
    // overwriting it to `ok` on the finalize update below.
    if (isRunCancelled(db, runId)) {
      throw new RunCancelledError(runId);
    }

    const outputArtifact = await writeArtifact(runId, "step-1-output.json", {
      text: response.text,
      provider: response.provider,
      model: response.model,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      finishReason: response.finishReason,
      latencyMs: response.latencyMs,
    });

    const stepEndedAt = Date.now();
    db.update(steps)
      .set({
        status: "ok",
        endedAt: new Date(stepEndedAt),
        durationMs: stepEndedAt - startedAt,
        inputRef: inputArtifact,
        outputRef: outputArtifact,
        provider: response.provider,
        model: response.model,
        tokensIn: response.tokensIn ?? null,
        tokensOut: response.tokensOut ?? null,
      })
      .where(eq(steps.id, stepId))
      .run();

    const output = await agent._parseOutput(response.text, ctx);

    const runEndedAt = Date.now();
    db.update(runs)
      .set({
        status: "ok",
        endedAt: new Date(runEndedAt),
        durationMs: runEndedAt - startedAt,
        tokensIn: response.tokensIn ?? null,
        tokensOut: response.tokensOut ?? null,
        provider: response.provider,
        model: response.model,
      })
      .where(eq(runs.id, runId))
      .run();

    await writeRunLog(logCtx, "INFO", "run.ok", {
      agent: agent.name,
      provider: response.provider,
      model: response.model,
      tokens_in: response.tokensIn ?? 0,
      tokens_out: response.tokensOut ?? 0,
      duration_ms: runEndedAt - startedAt,
    });

    return {
      runId,
      status: "ok",
      output,
      provider: response.provider,
      model: response.model,
      tokensIn: response.tokensIn,
      tokensOut: response.tokensOut,
      durationMs: runEndedAt - startedAt,
      // P2-FE-18 — echo back so the API can put it in the envelope without
      // re-reading the runs row.
      testRun: isTest,
    };
  } catch (err) {
    // Operator-initiated cancel — close the step row (status=skipped, so
    // the timeline visualiser knows the step never ran) but leave the run
    // row alone: it was already flipped to `cancelled` by the route
    // handler. Overwriting it here to `failed` would lose the cancel
    // distinction (which the dashboard renders differently) and would
    // discard the cancel reason recorded in `runs.error_message`.
    if (err instanceof RunCancelledError) {
      const stepEndedAt = Date.now();
      db.update(steps)
        .set({
          status: "skipped",
          endedAt: new Date(stepEndedAt),
          durationMs: stepEndedAt - startedAt,
          error: "cancelled_by_operator",
        })
        .where(eq(steps.id, stepId))
        .run();
      await writeRunLog(logCtx, "INFO", "run.cancelled", {
        agent: agent.name,
        reason: "operator_stop",
      });
      throw err;
    }

    const llm = isLLMError(err)
      ? err
      : new LLMError(
          err instanceof Error ? err.message : String(err),
          "provider_error",
          "mock",
          err,
        );

    const stepEndedAt = Date.now();
    db.update(steps)
      .set({
        status: "failed",
        endedAt: new Date(stepEndedAt),
        durationMs: stepEndedAt - startedAt,
        error: `${llm.code}: ${llm.message}`,
      })
      .where(eq(steps.id, stepId))
      .run();

    const runEndedAt = Date.now();
    db.update(runs)
      .set({
        status: "failed",
        endedAt: new Date(runEndedAt),
        durationMs: runEndedAt - startedAt,
        errorMessage: `${llm.code}: ${llm.message}`,
      })
      .where(eq(runs.id, runId))
      .run();

    await writeRunLog(logCtx, "ERROR", "run.fail", {
      agent: agent.name,
      code: llm.code,
      provider: llm.provider,
      message: llm.message,
    });

    throw llm;
  }
}
