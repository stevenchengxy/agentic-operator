/**
 * Run engine — implements `BaseAgent.run()` with the P1-RT-01 multi-turn
 * tool-use loop. The engine appends one `steps` row per LLM call (`type: "logic"`)
 * and one per tool dispatch (`type: "tool"`), aggregates tokens across turns,
 * and persists prompt + response sidecars under `data/artifacts/<runId>/`.
 *
 * Single-shot agents (default `maxSteps = 1`) take exactly one LLM call and
 * one step row, matching pre-P1 behavior.
 *
 * Failure modes are caught and recorded; the LLMError is re-thrown for the
 * caller (HTTP layer) to convert into a 4xx/5xx envelope.
 */

import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";

import {
  agents,
  agentVersions,
  getDb,
  runs,
  steps,
  tenants,
} from "@agentic/db";
import type { DB } from "@agentic/db";
import { makeId } from "@agentic/shared";
// Some builds of @agentic/runtime export the broadcast helper under the
// short alias `publish`; later sprints surface it as `publishStreamEvent`.
// Import under both names and fall back so this package builds against
// either barrel.
import * as agenticRuntime from "@agentic/runtime";
const publishStreamEvent: (event: unknown) => void =
  (
    agenticRuntime as {
      publishStreamEvent?: (event: unknown) => void;
      publish?: (event: unknown) => void;
    }
  ).publishStreamEvent ??
  (agenticRuntime as { publish?: (event: unknown) => void }).publish ??
  ((): void => {
    /* no-op: broadcast surface missing in this runtime build */
  });
const { writeRunLog } = agenticRuntime;
import type { ProviderId } from "@agentic/contracts";
import {
  currentUsageAttribution,
  LLMError,
  isLLMError,
  type ChatContentBlock,
  type ChatMessage,
  type ChatResponse,
  type ToolCall,
  type ToolResultBlock,
} from "@agentic/llm-gateway";

import type { BaseAgent } from "./base-agent";
import type { AgentContext, AgentResult, ToolHandlerResult } from "./types";
import { getGateway } from "./gateway-host";

const SYSTEM_TENANT_SLUG = "__system";

function artifactsRoot(): string {
  return process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts";
}

async function writeArtifact(
  runId: string,
  name: string,
  payload: unknown,
): Promise<string> {
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
  _tenantId: string,
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

function contentToToolUseBlocks(
  toolCalls: ToolCall[] | undefined,
): ChatContentBlock[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  return toolCalls.map((tc) => ({
    type: "tool_use" as const,
    id: tc.id,
    name: tc.name,
    input: tc.input,
  }));
}

function buildAssistantTurnContent(
  text: string,
  toolCalls: ToolCall[] | undefined,
): string | ChatContentBlock[] {
  const toolBlocks = contentToToolUseBlocks(toolCalls);
  if (toolBlocks.length === 0) return text;
  const blocks: ChatContentBlock[] = [];
  if (text) blocks.push({ type: "text", text });
  blocks.push(...toolBlocks);
  return blocks;
}

function buildToolResultMessage(
  toolCalls: ToolCall[],
  results: Array<ToolHandlerResult>,
): ChatMessage {
  const blocks: ToolResultBlock[] = toolCalls.map((tc, idx) => {
    const res = results[idx]!;
    const body = res.ok
      ? JSON.stringify(res.data ?? null)
      : JSON.stringify({
          error: res.error ?? { code: "unknown", message: "tool failed" },
        });
    return {
      type: "tool_result",
      tool_use_id: tc.id,
      content: body,
      ...(res.ok ? {} : { is_error: true }),
    };
  });
  return { role: "tool", content: blocks };
}

function artifactSafeMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(
    ({ reasoningContent: _reasoningContent, ...message }) => message,
  );
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
  const correlationId = ctx.correlationId ?? makeId("cor");
  const startedAt = Date.now();
  const logCtx = { tenantSlug, runId, correlationId };
  const testRun = ctx.testRun === true;
  const usageAttribution = currentUsageAttribution();

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
      requestId: usageAttribution?.requestId,
      interactionId: usageAttribution?.interactionId,
      productSurface: usageAttribution?.productSurface,
      productAction: usageAttribution?.productAction,
      requestedBy:
        usageAttribution?.actorType === "user"
          ? usageAttribution.actorId
          : undefined,
      subject: null,
      logPath: null,
      isTest: testRun,
    })
    .run();

  await writeRunLog(logCtx, "INFO", "run.start", {
    agent: agent.name,
    kind: "code",
    invocation_id: ctx.invocationId ?? "—",
    test_run: testRun,
  });

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
      testRun,
    });
  } catch {
    /* broadcast best-effort */
  }

  let totalTokensIn = 0;
  let totalTokensOut = 0;
  let lastProvider: ProviderId | "mock" = "mock";
  let lastModel = "mock-model-v1";
  let ord = 0;
  let finalText = "";

  try {
    const provider: ProviderId | undefined =
      ctx.provider ?? agent.defaultProvider;
    const model = ctx.model ?? agent.defaultModel;
    const reasoning = ctx.reasoning ?? agent.defaultReasoning;
    const verbosity = ctx.verbosity ?? agent.defaultVerbosity;
    const store = ctx.store ?? agent.storeResponses;

    const messages: ChatMessage[] = await agent._buildMessages(input, ctx);

    const tools = agent.getTools(ctx);
    const toolHandlers = agent.getToolHandlers(ctx);
    const maxSteps = Math.max(1, agent.maxSteps ?? 1);

    let lastResponse: ChatResponse | null = null;

    for (let turn = 0; turn < maxSteps; turn++) {
      ord += 1;
      const stepId = makeId("stp");
      const stepStartedAt = Date.now();

      db.insert(steps)
        .values({
          id: stepId,
          runId,
          ord,
          name: "llm.call",
          type: "logic",
          status: "running",
          startedAt: new Date(stepStartedAt),
        })
        .run();

      const inputArtifact = await writeArtifact(
        runId,
        `step-${ord}-input.json`,
        {
          agent: agent.name,
          provider,
          model,
          reasoning,
          verbosity,
          store,
          messages: artifactSafeMessages(messages),
          tools: tools.length > 0 ? tools : undefined,
        },
      );

      const response: ChatResponse = await gateway.chat({
        messages,
        provider,
        providers: ctx.providers,
        model: model ?? undefined,
        reasoning,
        verbosity,
        store,
        tools: tools.length > 0 ? tools : undefined,
        jsonMode: agent.outputSchema ? true : undefined,
        tenantId,
        runId,
        stepId,
        purpose: "agent-runtime",
        routing: {
          taskType: ctx.taskClass ?? agent.taskClass,
          ...(ctx.provider || ctx.model ? { bypassTaskPolicy: true } : {}),
          ...(ctx.provider && ctx.model
            ? { requestedRoute: `${ctx.provider}/${ctx.model}` }
            : {}),
        },
      } as never);

      const outputArtifact = await writeArtifact(
        runId,
        `step-${ord}-output.json`,
        {
          text: response.text,
          provider: response.provider,
          model: response.model,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          finishReason: response.finishReason,
          toolCalls: response.toolCalls ?? null,
          latencyMs: response.latencyMs,
        },
      );

      const stepEndedAt = Date.now();
      db.update(steps)
        .set({
          status: "ok",
          endedAt: new Date(stepEndedAt),
          durationMs: stepEndedAt - stepStartedAt,
          inputRef: inputArtifact,
          outputRef: outputArtifact,
          provider: response.provider,
          model: response.model,
          tokensIn: response.tokensIn ?? null,
          tokensOut: response.tokensOut ?? null,
        })
        .where(eq(steps.id, stepId))
        .run();

      totalTokensIn += response.tokensIn ?? 0;
      totalTokensOut += response.tokensOut ?? 0;
      lastProvider = response.provider;
      lastModel = response.model;
      lastResponse = response;

      const toolCalls = response.toolCalls ?? [];
      if (toolCalls.length === 0 || turn === maxSteps - 1) {
        finalText = response.text;
        break;
      }

      // Append assistant turn (carries the tool_use blocks).
      messages.push({
        role: "assistant",
        content: buildAssistantTurnContent(response.text, toolCalls),
        ...(response.reasoningContent
          ? { reasoningContent: response.reasoningContent }
          : {}),
      });

      // Dispatch tool calls in order, one tool step per call.
      const results: ToolHandlerResult[] = [];
      for (const tc of toolCalls) {
        ord += 1;
        const toolStepId = makeId("stp");
        const toolStartedAt = Date.now();
        db.insert(steps)
          .values({
            id: toolStepId,
            runId,
            ord,
            name: tc.name,
            type: "tool",
            status: "running",
            startedAt: new Date(toolStartedAt),
          })
          .run();
        const handler = toolHandlers[tc.name];
        let res: ToolHandlerResult;
        try {
          if (!handler) {
            res = {
              ok: false,
              error: {
                code: "tool_handler_missing",
                message: `No handler for ${tc.name}`,
              },
            };
          } else {
            res = await handler(tc.input, ctx);
          }
        } catch (err) {
          res = {
            ok: false,
            error: {
              code: "tool_threw",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        const toolEndedAt = Date.now();
        db.update(steps)
          .set({
            status: res.ok ? "ok" : "failed",
            endedAt: new Date(toolEndedAt),
            durationMs: toolEndedAt - toolStartedAt,
            error: res.ok
              ? null
              : `${res.error?.code ?? "tool_failed"}: ${res.error?.message ?? ""}`,
          })
          .where(eq(steps.id, toolStepId))
          .run();
        results.push(res);
      }

      // Append the tool result message for the next LLM turn.
      messages.push(buildToolResultMessage(toolCalls, results));
    }

    // Optional output validation + one repair retry.
    let output: TOutput;
    if (agent.outputSchema) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(finalText);
      } catch {
        parsed = undefined;
      }
      const validation = agent.outputSchema.safeParse(parsed);
      if (validation.success) {
        output = validation.data as TOutput;
      } else {
        // Repair turn: re-prompt with the issues and one more LLM call.
        ord += 1;
        const repairStepId = makeId("stp");
        const repairStartedAt = Date.now();
        db.insert(steps)
          .values({
            id: repairStepId,
            runId,
            ord,
            name: "llm.repair",
            type: "logic",
            status: "running",
            startedAt: new Date(repairStartedAt),
          })
          .run();
        messages.push({
          role: "assistant",
          content: finalText,
        });
        messages.push({
          role: "user",
          content: `Your previous reply did not match the required schema. Issues: ${JSON.stringify(validation.error.issues)}. Reply with strict JSON only.`,
        });
        const repair = await gateway.chat({
          messages,
          provider,
          providers: ctx.providers,
          model: model ?? undefined,
          reasoning,
          verbosity,
          store,
          jsonMode: true,
          tenantId,
          runId,
          stepId: repairStepId,
          purpose: "agent-runtime.output-repair",
          routing: {
            taskType: "output.repair",
            ...(ctx.provider || ctx.model ? { bypassTaskPolicy: true } : {}),
            ...(ctx.provider && ctx.model
              ? { requestedRoute: `${ctx.provider}/${ctx.model}` }
              : {}),
          },
        } as never);
        const repairEndedAt = Date.now();
        db.update(steps)
          .set({
            status: "ok",
            endedAt: new Date(repairEndedAt),
            durationMs: repairEndedAt - repairStartedAt,
            provider: repair.provider,
            model: repair.model,
            tokensIn: repair.tokensIn ?? null,
            tokensOut: repair.tokensOut ?? null,
          })
          .where(eq(steps.id, repairStepId))
          .run();
        totalTokensIn += repair.tokensIn ?? 0;
        totalTokensOut += repair.tokensOut ?? 0;
        lastProvider = repair.provider;
        lastModel = repair.model;
        let repaired: unknown;
        try {
          repaired = JSON.parse(repair.text);
        } catch {
          repaired = undefined;
        }
        const validation2 = agent.outputSchema.safeParse(repaired);
        if (!validation2.success) {
          throw new LLMError(
            `output_parse_error: ${JSON.stringify(validation2.error.issues)}`,
            "bad_request",
            lastProvider as ProviderId,
          );
        }
        output = validation2.data as TOutput;
        finalText = repair.text;
      }
    } else {
      output = await agent._parseOutput(finalText, ctx);
    }

    const runEndedAt = Date.now();
    db.update(runs)
      .set({
        status: "ok",
        endedAt: new Date(runEndedAt),
        durationMs: runEndedAt - startedAt,
        tokensIn: totalTokensIn,
        tokensOut: totalTokensOut,
        model: lastModel,
      })
      .where(eq(runs.id, runId))
      .run();

    await writeRunLog(logCtx, "INFO", "run.ok", {
      agent: agent.name,
      provider: lastProvider,
      model: lastModel,
      tokens_in: totalTokensIn,
      tokens_out: totalTokensOut,
      duration_ms: runEndedAt - startedAt,
    });

    return {
      runId,
      status: "ok",
      output,
      provider: lastProvider as ProviderId,
      model: lastModel,
      tokensIn: totalTokensIn,
      tokensOut: totalTokensOut,
      durationMs: runEndedAt - startedAt,
      steps: ord,
      testRun,
    };
  } catch (err) {
    const llm = isLLMError(err)
      ? err
      : new LLMError(
          err instanceof Error ? err.message : String(err),
          "provider_error",
          "mock",
          err,
        );

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
