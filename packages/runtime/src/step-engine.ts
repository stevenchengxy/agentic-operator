/**
 * Step engine — dispatches a single action by type.
 *
 * Called from inside an Inngest function via step.run(), so each invocation
 * is durable + idempotent (Inngest replays the function with memoized step
 * results on retry).
 *
 * Resolution order for `tool` and `logic` actions:
 *   1. Tenant registry (`@tenants/<slug>`) — typed handler from agent-kit.
 *   2. Generic @agentic/tools — mock implementations for now.
 *
 * Tenant resolution lets a manifest action `{ "name": "rankCandidates", "type": "logic" }`
 * dispatch to a real tenant-defined prompt without editing the runtime.
 */

import {
  runTool,
  globalToolRegistry,
  type ToolContext as GenericToolContext,
} from "@agentic/tools";
import type {
  PromptDescriptor,
  TenantRegistry,
  ToolContext,
  ToolDescriptor,
} from "@agentic/agent-kit";
import type { ActionSpec } from "./manifest";
import { getRuntimeGateway } from "./llm-host";
import { makeGeneratedAgentPrompt } from "./generated-agent";
import { writeRunLog, type RunLogContext } from "./log-writer";
import type {
  ChatContentBlock,
  ChatMessage,
  ChatResponse,
  ProviderId,
  ToolDef,
  ToolUseBlock,
  ToolResultBlock,
} from "@agentic/llm-gateway";
import { writeArtifact } from "./artifacts";
import {
  AgentInputValidationError,
  OutputSchemaValidationError,
  canonicalJson,
  normalizeAgentForExecution,
  parseValidateAndRepairOutput,
  prepareAgentExecution,
  resolveRestrictedJsonPath,
  validateValueAgainstJsonSchema,
  type AgentConversationTurn,
} from "./agent-execution";
import { appendRuntimeTrace, type RuntimeTraceSink } from "./execution-trace";
import type {
  AgentInputPortV2,
  AgentOutputConfigV2,
  AgentOutputPortV2,
  AgentObservabilityV2,
  AgentToolLoopV2,
  ReasoningConfigDTO,
  TextVerbosity,
} from "@agentic/contracts";

/**
 * Canonical tool-use entry on an AgentSpec (matches the Zod
 * `ToolUseEntrySchema` in manifest.ts). Only `name` is mandatory — when
 * `input_schema` is absent we synthesise a permissive object schema so the
 * gateway can still hand the tool to the model.
 */
export interface ToolUseEntry {
  name: string;
  description?: string;
  input_schema?: unknown;
  config?: Record<string, unknown>;
}

interface AgentSlots {
  id?: string;
  name?: string;
  /** Internal tenant identity used for gateway budget attribution. */
  tenantId?: string;
  description?: string;
  ontology_instructions?: string;
  /** Wizard-authored agents use the runtime's generic user-turn prompt. */
  generated?: boolean;
  /** Provider-native model selected in the deploy wizard. */
  model?: string;
  /** Explicit provider selected in the deploy wizard. */
  provider?: ProviderId;
  reasoning?: ReasoningConfigDTO;
  verbosity?: TextVerbosity;
  store?: boolean;
  /** Per-call gateway timeout authored in the manifest. */
  timeout_s?: number;
  temperature?: number;
  max_tokens?: number;
  actor?: Array<"Agent" | "Human">;
  trigger?: string[];
  actions?: ActionSpec[];
  triggered_event?: string[];
  inputs?: AgentInputPortV2[];
  input_data?: Record<string, unknown>;
  user_prompt_template?: string;
  outputs?: AgentOutputPortV2[];
  output_config?: AgentOutputConfigV2;
  output_bindings?: Record<string, Record<string, unknown>>;
  trigger_bindings?: Record<string, Record<string, unknown>>;
  tool_loop?: AgentToolLoopV2;
  observability?: AgentObservabilityV2;
  /**
   * Declarative tool roster from the manifest's `agent.tool_use[]`. When
   * non-empty AND a matching `tenantRegistry.tools[name]` exists, the
   * `logic` action runs a tool-use loop (gateway emits `tool_use` blocks
   * → engine executes → feeds `tool_result` back → repeat until text or
   * `MAX_TOOL_USE_ITERS`).
   */
  tool_use?: ToolUseEntry[];
}

/** Hard cap on tool-use iterations per `logic` action. Anything above 8
 * usually means the model is looping; we'd rather fail loud than burn
 * tokens forever. Override via `AGENTIC_TOOL_USE_MAX_ITERS` for stress
 * tests. */
const MAX_TOOL_USE_ITERS_DEFAULT = 8;
function resolveMaxIters(agent?: AgentSlots): number {
  const authored = agent?.tool_loop?.max_iterations;
  if (typeof authored === "number" && Number.isFinite(authored)) {
    return Math.max(1, Math.min(100, Math.floor(authored)));
  }
  const raw = process.env.AGENTIC_TOOL_USE_MAX_ITERS;
  if (!raw) return MAX_TOOL_USE_ITERS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : MAX_TOOL_USE_ITERS_DEFAULT;
}

/**
 * Observability for the manifest execution path.
 *
 * Until now this engine was silent: an LLM turn or a tool call (success OR
 * failure) produced ZERO log output, so a tool that threw mid-loop was
 * invisible to monitoring — the error was fed back to the model as a
 * `tool_result: is_error` and then vanished. `emitStepLog` fixes that by
 * fanning every lifecycle event out to two surfaces:
 *
 *   1. stdout/stderr — a single greppable `[step-engine] <event> k=v …` line
 *      so terminal tails + external log aggregators (and the Inngest dev
 *      console) see tool dispatch + errors live.
 *   2. the per-run file log (`data/logs/<tenant>/runs/<date>/<run>.log`) when
 *      a RunLogContext is available — this is what the portal's Logs view
 *      tails over SSE, so the same trace shows up in-product.
 *
 * File-log writes are best-effort: a logging failure must never abort a real
 * agent run, so we swallow + console.warn instead of throwing.
 */
type StepLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

function fmtConsoleFields(fields: Record<string, unknown>): string {
  return Object.entries(fields)
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join(" ");
}

async function emitStepLog(
  logCtx: RunLogContext | undefined,
  level: StepLogLevel,
  event: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const line = `[step-engine] ${event} ${fmtConsoleFields(fields)}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.info(line);

  if (logCtx) {
    try {
      await writeRunLog(logCtx, level, event, fields);
    } catch (err) {
      console.warn(
        `[step-engine] run-log write failed for ${event} (run=${logCtx.runId}):`,
        err,
      );
    }
  }
}

/** Build a RunLogContext from the tool context + the optional runId the
 *  register loop threads in. Returns undefined when there's no runId (ad-hoc
 *  callers / tests) so console logging still fires but file writes are skipped. */
function deriveLogCtx(
  ctx: ToolContext | undefined,
  runId: string | undefined,
): RunLogContext | undefined {
  if (!runId || !ctx) return undefined;
  return {
    tenantSlug: ctx.tenantSlug ?? "unknown",
    runId,
    correlationId: ctx.correlationId ?? "no-correlation",
  };
}

async function emitTraceBestEffort(
  trace: RuntimeTraceSink | undefined,
  event: Parameters<RuntimeTraceSink["append"]>[0],
): Promise<void> {
  try {
    await appendRuntimeTrace(trace, event);
  } catch (error) {
    console.warn(
      `[step-engine] structured trace append failed (run=${event.runId}, name=${event.name}):`,
      error,
    );
  }
}

export interface StepInput {
  ctx: ToolContext;
  action: ActionSpec;
  /** Caller-sanitized prior user/assistant turns for a continued Test Lab run. */
  conversationHistory?: AgentConversationTurn[];
  /**
   * Optional agent-level metadata that influences prompt assembly:
   *   - `description` is concatenated into the runtime prelude
   *   - `ontology_instructions` is appended to the system message
   * Pure-runtime callers (Inngest worker) pass the AgentSpec slice; tests
   * pass an inline shape.
   */
  agent?: AgentSlots;
  /** Tenant-specific tools + prompts; consulted before generic fallbacks. */
  tenantRegistry?: TenantRegistry;
  /**
   * When true (M4), manual steps log + skip rather than wait for task
   * resolution. M8 flips this to false and wires real waitForEvent + task
   * creation.
   */
  autoResolveManual?: boolean;
  /**
   * Per P0-RT-09: when both `runId` and `stepOrd` are set, the engine
   * writes JSON sidecars to AGENTIC_ARTIFACTS_DIR/<runId>/step-<ord>-{input,output}.json
   * so downstream consumers (UI, debug) can reconstruct the call.
   */
  runId?: string;
  /** Durable step row id, when the caller has allocated one. */
  stepId?: string;
  stepOrd?: number;
  /** Optional persistence seam for Studio/operator structured trace rows. */
  trace?: RuntimeTraceSink;
  /** Only the terminal action is validated against agent-level outputs. */
  finalOutput?: boolean;
}

export interface StepOutput {
  ok: boolean;
  type: ActionSpec["type"];
  data: unknown;
  tokensIn?: number;
  tokensOut?: number;
  /** Real gateway-returned model id (P0-RT-04). */
  model?: string;
  /** Real gateway-returned provider id (P0-RT-04). */
  provider?: string;
  /** Absolute path to step-<ord>-output.json when artifacts are written. */
  outputArtifact?: string;
  /** Set for manual steps that haven't been resolved yet. */
  pendingTaskTitle?: string;
  meta?: Record<string, unknown>;
}

function genericCtx(ctx: ToolContext): GenericToolContext {
  return {
    agentName: ctx.agentName,
    actionName: ctx.actionName,
    subject: ctx.subject,
    correlationId: ctx.correlationId,
  };
}

async function runTenantTool(
  ctx: ToolContext,
  tool: ToolDescriptor,
): Promise<StepOutput> {
  const result = await tool.handler(ctx);
  // Optional structured-output validation
  let validated = result.data;
  if (tool.output) {
    const parsed = tool.output.safeParse(result.data);
    if (parsed.success) {
      validated = parsed.data;
    } else {
      return {
        ok: false,
        type: "tool",
        data: result.data,
        meta: {
          tool: tool.name,
          tenant: true,
          schemaError: parsed.error.issues,
        },
      };
    }
  }
  return {
    ok: true,
    type: "tool",
    data: validated,
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
    meta: { ...result.meta, tool: tool.name, tenant: true },
  };
}

/**
 * Compose the system message:
 *   1. tenant prompt override (if any) — wins first position so the LLM
 *      reads it before the runtime prelude
 *   2. runtime prelude — generic "you are an agentic workflow step" framing
 *   3. agent description
 *   4. agent ontology_instructions
 * Empty segments are skipped.
 */
function buildSystemMessage(parts: {
  tenantOverride?: string;
  agentDescription?: string;
  ontologyInstructions?: string;
}): string {
  const lines: string[] = [];
  if (parts.tenantOverride) lines.push(parts.tenantOverride);
  lines.push(
    "You are an LLM-driven step inside an agentic workflow. Reply concisely and follow the rubric in the user message.",
  );
  if (parts.agentDescription) lines.push(parts.agentDescription);
  if (parts.ontologyInstructions) lines.push(parts.ontologyInstructions);
  return lines.join("\n\n");
}

async function callLLM(
  rendered: string,
  preferredModel?: string,
  systemOverride?: string,
  agent?: AgentSlots,
  tenantRegistry?: TenantRegistry,
  ctx?: ToolContext,
  logCtx?: RunLogContext,
  execution?: {
    messages?: ChatMessage[];
    jsonMode?: boolean;
    trace?: RuntimeTraceSink;
    runId?: string;
    stepId?: string;
  },
): Promise<{
  text: string;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
  toolCalls: ToolCallTrace[];
}> {
  const gateway = getRuntimeGateway();
  if (!gateway) {
    throw new Error(
      "[step-engine] LLMGateway not initialised — apps/api bootstrap must call setRuntimeGateway()",
    );
  }
  const systemContent = buildSystemMessage({
    tenantOverride: systemOverride,
    agentDescription: agent?.description,
    ontologyInstructions: agent?.ontology_instructions,
  });

  // Build the ToolDef[] roster ONCE per logic action. Each entry maps to a
  // tenantRegistry tool by name; absent registry entries are silently dropped
  // from the advertised list so the model can't request a tool that won't
  // resolve. A missing schema stays permissive; declared schemas are enforced
  // again immediately before handler dispatch.
  const tools: ToolDef[] = [];
  if (agent?.tool_use && agent.tool_use.length > 0) {
    for (const entry of agent.tool_use) {
      const handler =
        tenantRegistry?.tools?.[entry.name] ??
        globalToolRegistry.get(entry.name);
      if (!handler) continue;
      tools.push({
        name: entry.name,
        description: entry.description ?? handler.description ?? entry.name,
        input_schema: isPlainSchema(entry.input_schema)
          ? entry.input_schema
          : { type: "object", additionalProperties: true },
      });
    }
  }
  // `agent.tool_use[]` is the execution allow-list, not merely a hint to the
  // provider. A provider must not be able to manufacture an undeclared tool
  // call and reach any globally registered handler.
  const allowedToolNames = new Set(tools.map((tool) => tool.name));

  const messages: ChatMessage[] = execution?.messages
    ? structuredClone(execution.messages)
    : [
        { role: "system", content: systemContent },
        { role: "user", content: rendered },
      ];

  // Tool-use loop. When no tools are advertised this is a single pass and
  // exits immediately — same shape as the old single-call path.
  const maxIters = resolveMaxIters(agent);
  let totalIn = 0;
  let totalOut = 0;
  let lastProvider = "";
  let lastModel = "";
  let finalText = "";
  const toolCalls: ToolCallTrace[] = [];

  for (let iter = 0; iter < maxIters; iter++) {
    const llmStartedAt = new Date();
    let response: ChatResponse;
    try {
      response = await gateway.chat({
        messages,
        model: preferredModel,
        provider: agent?.provider,
        reasoning: agent?.reasoning,
        verbosity: agent?.verbosity,
        store: agent?.store,
        temperature: agent?.temperature,
        maxTokens: agent?.max_tokens,
        timeoutMs:
          typeof agent?.timeout_s === "number"
            ? agent.timeout_s * 1_000
            : undefined,
        tools: tools.length > 0 ? tools : undefined,
        jsonMode: execution?.jsonMode,
        tenantId: agent?.tenantId,
        tenantSlug: ctx?.tenantSlug,
        runId: execution?.runId,
        stepId: execution?.stepId,
        purpose: "manifest.logic",
      });
    } catch (error) {
      const llmEndedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      await emitStepLog(logCtx, "ERROR", "llm.error", {
        agent: ctx?.agentName ?? agent?.name ?? "unknown",
        action: ctx?.actionName ?? "—",
        tenant: ctx?.tenantSlug ?? "unknown",
        iter: iter + 1,
        error: message,
      });
      if (execution?.runId) {
        await emitTraceBestEffort(execution.trace, {
          runId: execution.runId,
          ...(execution.stepId ? { stepId: execution.stepId } : {}),
          kind: "llm",
          level: "minimal",
          name: "llm.call",
          status: "failed",
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: Math.max(
            0,
            llmEndedAt.getTime() - llmStartedAt.getTime(),
          ),
          summary: "Model call failed",
          data: { iteration: iter + 1, error: message },
          visibility: "operator",
        });
      }
      throw error;
    }
    totalIn += response.tokensIn ?? 0;
    totalOut += response.tokensOut ?? 0;
    lastProvider = response.provider;
    lastModel = response.model;
    if (execution?.runId) {
      const llmEndedAt = new Date();
      await emitTraceBestEffort(execution.trace, {
        runId: execution.runId,
        ...(execution.stepId ? { stepId: execution.stepId } : {}),
        kind: "llm",
        level: "standard",
        name: "llm.call",
        status: "ok",
        startedAt: llmStartedAt,
        endedAt: llmEndedAt,
        durationMs: Math.max(0, llmEndedAt.getTime() - llmStartedAt.getTime()),
        summary: `Model call completed with ${(response.toolCalls ?? []).length} tool request(s)`,
        data: {
          provider: response.provider,
          model: response.model,
          iteration: iter + 1,
          tokensIn: response.tokensIn ?? 0,
          tokensOut: response.tokensOut ?? 0,
          finishReason: response.finishReason,
        },
        visibility: "operator",
      });
      if (response.reasoningSummary) {
        await emitTraceBestEffort(execution.trace, {
          runId: execution.runId,
          ...(execution.stepId ? { stepId: execution.stepId } : {}),
          kind: "llm",
          level: "standard",
          name: "llm.reasoning_summary",
          status: "ok",
          startedAt: llmStartedAt,
          endedAt: llmEndedAt,
          durationMs: Math.max(
            0,
            llmEndedAt.getTime() - llmStartedAt.getTime(),
          ),
          summary: response.reasoningSummary,
          data: {
            provider: response.provider,
            model: response.model,
            reasoning: response.reasoning,
          },
          visibility: "user",
        });
      }
    }

    const requestedCalls = response.toolCalls ?? [];
    await emitStepLog(logCtx, "INFO", "llm.call", {
      agent: ctx?.agentName ?? agent?.name ?? "unknown",
      action: ctx?.actionName ?? "—",
      tenant: ctx?.tenantSlug ?? "unknown",
      provider: response.provider,
      model: response.model,
      iter: iter + 1,
      tokens_in: response.tokensIn ?? 0,
      tokens_out: response.tokensOut ?? 0,
      tools_requested: requestedCalls.length,
    });
    if (requestedCalls.length === 0) {
      // Model returned prose — we're done.
      finalText = response.text;
      break;
    }

    // Echo back an assistant message containing the model's tool_use blocks
    // so the next turn has the right conversation history.
    const assistantBlocks: ChatContentBlock[] = [];
    if (response.text)
      assistantBlocks.push({ type: "text", text: response.text });
    for (const call of requestedCalls) {
      const block: ToolUseBlock = {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      };
      assistantBlocks.push(block);
    }
    messages.push({
      role: "assistant",
      content: assistantBlocks,
      ...(response.reasoningContent
        ? { reasoningContent: response.reasoningContent }
        : {}),
    });

    // Execute each tool call, collect tool_result blocks for the next turn.
    const resultBlocks: ChatContentBlock[] = [];
    for (const call of requestedCalls) {
      // Resolution chain: tenant override → global registry → not found.
      // Tenant wins on collision so a tenant can ship a custom impl that
      // shadows a global tool. The MCP layer already folds its tools into
      // tenantRegistry under namespaced names ("<server>.<tool>"), so it's
      // covered by the first lookup.
      const callIsAllowed = allowedToolNames.has(call.name);
      const handler = callIsAllowed
        ? (tenantRegistry?.tools?.[call.name] ??
          globalToolRegistry.get(call.name))
        : undefined;

      // Per-tenant config plumbing: lift the manifest's
      // `tool_use[i].config` blob into ctx.config so global tools can be
      // specialised per tenant (api_key_env, subdir, etc.) without code.
      const toolUseEntry = agent?.tool_use?.find(
        (t) => (t as { name?: string })?.name === call.name,
      );
      const toolConfig =
        toolUseEntry && typeof toolUseEntry === "object"
          ? ((toolUseEntry as { config?: Record<string, unknown> }).config ??
            undefined)
          : undefined;

      const callCtx: ToolContext = {
        agentName: ctx?.agentName ?? agent?.name ?? "unknown",
        actionName: call.name,
        subject: ctx?.subject,
        correlationId: ctx?.correlationId ?? "no-correlation",
        tenantSlug: ctx?.tenantSlug ?? "unknown",
        event: ctx?.event,
        // Each tool sees the prior tool's output as lastResult — gives the
        // model the option to chain without re-quoting state through the prompt.
        lastResult:
          toolCalls.length > 0
            ? toolCalls[toolCalls.length - 1]!.output
            : ctx?.lastResult,
        config: toolConfig,
      };

      const startedAt = Date.now();
      const resolvedVia = !callIsAllowed
        ? "not-allowed"
        : tenantRegistry?.tools?.[call.name]
          ? "tenant"
          : globalToolRegistry.get(call.name)
            ? "global"
            : "unresolved";
      await emitStepLog(logCtx, "INFO", "tool.call", {
        agent: ctx?.agentName ?? agent?.name ?? "unknown",
        tool: call.name,
        resolved_via: resolvedVia,
        iter: iter + 1,
        subject: ctx?.subject ?? "—",
      });
      if (execution?.runId) {
        await emitTraceBestEffort(execution.trace, {
          runId: execution.runId,
          ...(execution.stepId ? { stepId: execution.stepId } : {}),
          kind: "tool",
          level: "standard",
          name: call.name,
          status: "running",
          startedAt: new Date(startedAt),
          summary: callIsAllowed
            ? `Dispatching allowed tool '${call.name}'`
            : `Rejecting undeclared tool '${call.name}'`,
          data: { iteration: iter + 1, resolvedVia },
          visibility: "operator",
        });
      }
      let outputBody: string;
      let isError = false;
      let outputData: unknown = null;
      let errorMessage: string | null = null;
      try {
        if (!handler) {
          if (!callIsAllowed) {
            throw new Error(
              `tool '${call.name}' is not declared in this agent's tool_use allow-list`,
            );
          }
          throw new Error(
            `tool '${call.name}' not registered for this tenant and not found in global registry`,
          );
        }
        if (isPlainSchema(toolUseEntry?.input_schema)) {
          const schemaIssues = validateValueAgainstJsonSchema(
            toolUseEntry.input_schema,
            call.input,
            "/tool/input",
            "tool_input_schema",
          );
          if (schemaIssues.length > 0) {
            throw new Error(
              `tool_input_schema_invalid: ${schemaIssues
                .map((issue) => `${issue.path}: ${issue.message}`)
                .join("; ")}`,
            );
          }
        }
        // Merge the model's tool-call input into the context so handlers
        // that prefer args over ctx.event.data have a single read site.
        const handlerCtx = {
          ...callCtx,
          event: { name: `tool:${call.name}`, data: call.input },
        };
        const r = await handler.handler(handlerCtx);
        outputData = r.data;
        totalIn += r.tokensIn ?? 0;
        totalOut += r.tokensOut ?? 0;
        outputBody = stringifyToolPayload(r.data);
      } catch (err) {
        isError = true;
        errorMessage = String(err instanceof Error ? err.message : err);
        outputBody = JSON.stringify({ error: errorMessage });
      }
      const durationMs = Date.now() - startedAt;
      // The headline fix: a tool failure is now LOUD. Previously this error
      // only ever reached the model (as is_error) and never any operator
      // surface — a flaky external API looked like a silent stall. We log it
      // at ERROR to both stdout and the per-run file log so it shows up in
      // monitoring + the portal Logs view, with the upstream message intact.
      await emitStepLog(
        logCtx,
        isError ? "ERROR" : "INFO",
        isError ? "tool.error" : "tool.ok",
        {
          agent: ctx?.agentName ?? agent?.name ?? "unknown",
          tool: call.name,
          duration_ms: durationMs,
          iter: iter + 1,
          ...(isError
            ? { error: errorMessage ?? "unknown" }
            : { bytes: outputBody.length }),
        },
      );
      if (execution?.runId) {
        const toolEndedAt = new Date();
        await emitTraceBestEffort(execution.trace, {
          runId: execution.runId,
          ...(execution.stepId ? { stepId: execution.stepId } : {}),
          kind: "tool",
          level: isError ? "minimal" : "standard",
          name: call.name,
          status: isError ? "failed" : "ok",
          startedAt: new Date(startedAt),
          endedAt: toolEndedAt,
          durationMs,
          summary: isError
            ? `Tool '${call.name}' failed: ${errorMessage ?? "unknown error"}`
            : `Tool '${call.name}' completed`,
          data: {
            iteration: iter + 1,
            resolvedVia,
            isError,
          },
          visibility: "operator",
        });
      }
      toolCalls.push({
        id: call.id,
        name: call.name,
        input: call.input,
        output: outputData,
        isError,
        ...(errorMessage ? { error: errorMessage } : {}),
        durationMs,
      });

      const resultBlock: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: call.id,
        content: outputBody,
        is_error: isError || undefined,
      };
      resultBlocks.push(resultBlock);
    }
    messages.push({ role: "tool", content: resultBlocks });

    // Final iteration safety — if we just executed tools but the loop is
    // about to end, surface a synthetic note so callers can see the budget
    // was hit instead of a silent prose fallback.
    if (iter === maxIters - 1) {
      finalText = `[tool-use loop hit max ${maxIters} iterations without a final text reply]`;
    }
  }

  return {
    text: finalText,
    tokensIn: totalIn,
    tokensOut: totalOut,
    provider: lastProvider,
    model: lastModel,
    toolCalls,
  };
}

/**
 * One executed tool call, surfaced in the step's `meta.toolCalls` for the
 * UI's trace tab and for downstream emit payloads.
 */
export interface ToolCallTrace {
  id: string;
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  isError: boolean;
  error?: string;
  durationMs: number;
}

function isPlainSchema(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringifyToolPayload(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function runTenantPrompt(
  ctx: ToolContext,
  prompt: PromptDescriptor,
  action: ActionSpec,
  agent?: AgentSlots,
  tenantRegistry?: TenantRegistry,
  logCtx?: RunLogContext,
  trace?: RuntimeTraceSink,
  runId?: string,
  stepId?: string,
  validateOutput = true,
  conversationHistory?: AgentConversationTurn[],
): Promise<StepOutput> {
  const rendered = prompt.template(ctx);
  const usesV2Execution =
    agent !== undefined &&
    normalizeAgentForExecution(agent).compatibilityMode === "v2";
  let messages: ChatMessage[] | undefined;
  if (usesV2Execution) {
    try {
      const rawEventName = ctx.event?.name ?? "unknown";
      const tenantPrefix = ctx.tenantSlug ? `${ctx.tenantSlug}/` : "";
      const eventName =
        tenantPrefix && rawEventName.startsWith(tenantPrefix)
          ? rawEventName.slice(tenantPrefix.length)
          : rawEventName;
      const authoredActionObjective =
        typeof action.action_prompt === "string" && action.action_prompt.trim()
          ? action.action_prompt.trim()
          : action.description?.trim() || action.name;
      const eventData = (ctx.event?.data ?? {}) as Record<string, unknown>;
      const suppliedInputs = isPlainSchema(eventData.inputs)
        ? { ...eventData.inputs }
        : undefined;
      const promptPorts = normalizeAgentForExecution(
        agent,
      ).definition.inputs.filter((input) => input.kind === "prompt");
      const promptPort = promptPorts.length === 1 ? promptPorts[0] : undefined;
      if (
        suppliedInputs &&
        promptPort &&
        !Object.hasOwn(suppliedInputs, promptPort.id) &&
        typeof eventData.prompt === "string"
      ) {
        suppliedInputs[promptPort.id] = eventData.prompt;
      }
      const prepared = await prepareAgentExecution({
        definition: agent,
        // Register and Studio both inject their already-validated input set
        // under event.data.inputs. Prefer it here so per-action input_mapping
        // is not discarded by re-applying the original trigger bindings.
        ...(suppliedInputs ? { inputs: suppliedInputs } : {}),
        event: {
          name: eventName,
          data: eventData,
          subject: ctx.subject ?? null,
        },
        promptOptions: {
          tenantInstructions: prompt.system,
          actionObjective: authoredActionObjective,
          includeOutputContract: validateOutput,
          // PromptDescriptor templates historically formed the user turn.
          // Keep their dynamic context in that same trust tier while the
          // Studio-owned `inputs.prompt` remains the immutable first block.
          actionContext: rendered,
          run: {
            subject: ctx.subject ?? null,
            correlationId: ctx.correlationId,
          },
          conversationHistory,
        },
        trace,
        runId,
        stepId,
      });
      messages = prepared.prompts?.messages;
      if (!messages) {
        throw new AgentInputValidationError([
          {
            path: "/actor",
            code: "llm_prompt_unavailable",
            severity: "error",
            message: "logic actions require an LLM prompt message pair",
          },
        ]);
      }
      const currentUserMessage = messages[messages.length - 1];
      if (runId) {
        const persistRendered =
          agent?.observability?.persist_rendered_prompts === true;
        await emitTraceBestEffort(trace, {
          runId,
          ...(stepId ? { stepId } : {}),
          kind: "prompt",
          level: persistRendered ? "debug" : "standard",
          name: "prompt.compiled",
          status: "ok",
          summary: "Compiled separate system and user messages",
          data: persistRendered
            ? { messages }
            : {
                roles: messages.map((message) => message.role),
                systemBytes:
                  typeof messages[0]?.content === "string"
                    ? Buffer.byteLength(messages[0].content)
                    : 0,
                userBytes:
                  typeof currentUserMessage?.content === "string"
                    ? Buffer.byteLength(currentUserMessage.content)
                    : 0,
              },
          visibility: persistRendered ? "debug" : "operator",
        });
      }
    } catch (error) {
      if (error instanceof AgentInputValidationError) {
        return {
          ok: false,
          type: "logic",
          data: null,
          meta: {
            error: error.code,
            validationIssues: error.issues,
          },
        };
      }
      throw error;
    }
  }
  const result = await callLLM(
    rendered,
    action.model ?? prompt.model ?? agent?.model,
    prompt.system,
    agent,
    tenantRegistry,
    ctx,
    logCtx,
    {
      messages,
      jsonMode: usesV2Execution ? true : undefined,
      trace,
      runId,
      stepId,
    },
  );
  let validated: unknown = result.text;
  let repairTokensIn = 0;
  let repairTokensOut = 0;
  let validationMeta: Record<string, unknown> | undefined;
  if (usesV2Execution && validateOutput) {
    try {
      const structured = await parseValidateAndRepairOutput({
        definition: agent,
        candidate: result.text,
        trace,
        runId,
        stepId,
        repair: async ({
          invalidResponse,
          issues,
          schema,
          attempt,
          maxAttempts,
        }) => {
          const gateway = getRuntimeGateway();
          if (!gateway) {
            throw new Error("LLMGateway not initialised for output repair");
          }
          const repairStartedAt = new Date();
          const response = await gateway.chat({
            messages: [
              {
                role: "system",
                content:
                  "Correct the supplied invalid response into one JSON value that satisfies the declared schema. Return JSON only; do not add facts or explanation.",
              },
              {
                role: "user",
                content: [
                  "Validation errors:",
                  canonicalJson(issues),
                  "Declared schema:",
                  canonicalJson(schema),
                  "Invalid response:",
                  invalidResponse,
                ].join("\n\n"),
              },
            ],
            model: action.model ?? prompt.model ?? agent?.model,
            provider: agent?.provider,
            reasoning: agent?.reasoning,
            verbosity: agent?.verbosity,
            store: agent?.store,
            temperature: agent?.temperature,
            maxTokens: agent?.max_tokens,
            timeoutMs:
              typeof agent?.timeout_s === "number"
                ? agent.timeout_s * 1_000
                : undefined,
            jsonMode: true,
            tenantId: agent?.tenantId,
            runId,
            stepId,
            purpose: "manifest.output-repair",
            tenantSlug: ctx.tenantSlug,
          });
          repairTokensIn += response.tokensIn ?? 0;
          repairTokensOut += response.tokensOut ?? 0;
          if (runId) {
            const repairEndedAt = new Date();
            await emitTraceBestEffort(trace, {
              runId,
              ...(stepId ? { stepId } : {}),
              kind: "llm",
              level: "standard",
              name: "llm.output_repair",
              status: "ok",
              startedAt: repairStartedAt,
              endedAt: repairEndedAt,
              durationMs: Math.max(
                0,
                repairEndedAt.getTime() - repairStartedAt.getTime(),
              ),
              summary: `Completed output repair turn ${attempt} of ${maxAttempts}`,
              data: {
                attempt,
                maxAttempts,
                provider: response.provider,
                model: response.model,
                tokensIn: response.tokensIn ?? 0,
                tokensOut: response.tokensOut ?? 0,
              },
              visibility: "operator",
            });
          }
          return response.text;
        },
      });
      validated = structured.value;
      validationMeta = {
        outputValid: structured.valid,
        repaired: structured.repaired,
        repairAttempts: structured.repairAttempts,
        validationIssues: structured.issues,
        rawResponse: structured.rawResponse,
      };
    } catch (error) {
      if (error instanceof OutputSchemaValidationError) {
        return {
          ok: false,
          type: "logic",
          data: null,
          tokensIn: result.tokensIn + repairTokensIn,
          tokensOut: result.tokensOut + repairTokensOut,
          model: result.model,
          provider: result.provider,
          meta: {
            error: error.code,
            validationIssues: error.issues,
            repairAttempts: error.attempts,
            rawResponse: error.invalidResponse,
            toolCalls: result.toolCalls,
          },
        };
      }
      throw error;
    }
  } else if (usesV2Execution) {
    // Intermediate logic results and results with an explicit output mapping
    // still need to be usable as structured mapping input. Final aggregate
    // validation happens after `applyActionOutputMapping` in the caller.
    try {
      validated = JSON.parse(result.text) as unknown;
    } catch {
      validated = result.text;
    }
    validationMeta = { rawResponse: result.text };
  } else if (prompt.output) {
    try {
      const json = JSON.parse(result.text);
      const parsed = prompt.output.safeParse(json);
      if (parsed.success) validated = parsed.data;
    } catch {
      // Real LLMs may return prose; structured-output enforcement is a v2 hardening.
    }
  }
  return {
    ok: true,
    type: "logic",
    data: validated,
    tokensIn: result.tokensIn + repairTokensIn,
    tokensOut: result.tokensOut + repairTokensOut,
    model: result.model,
    provider: result.provider,
    meta: {
      prompt: prompt.name,
      provider: result.provider,
      model: result.model,
      tenant: true,
      // Surface the tool-use trace so the UI's IO/TRACE tabs can render
      // each tool call inline with the LLM turn that spawned it. Empty
      // array when the model didn't request any tools.
      toolCalls: result.toolCalls,
      ...validationMeta,
    },
  };
}

/**
 * Write per-step input + output sidecars to AGENTIC_ARTIFACTS_DIR. No-op
 * if runId/stepOrd weren't provided. Failures are logged + swallowed —
 * artifact write is a debugging aid, not a correctness gate.
 */
async function writeStepArtifacts(
  runId: string,
  stepOrd: number,
  payload: { input: unknown; output: unknown },
): Promise<string | undefined> {
  try {
    await writeArtifact(runId, `step-${stepOrd}-input.json`, payload.input);
    const outputPath = await writeArtifact(
      runId,
      `step-${stepOrd}-output.json`,
      payload.output,
    );
    return outputPath;
  } catch (err) {
    console.warn(
      `[step-engine] failed to write step artifacts for ${runId} step-${stepOrd}:`,
      err,
    );
    return undefined;
  }
}

function renderActionMappingTemplate(
  template: string,
  root: Record<string, unknown>,
): string {
  return template.replace(/{{([\s\S]*?)}}/g, (_token, raw: string) => {
    const expression = raw.trim();
    const asJson = expression.startsWith("json ");
    const dotted = (asJson ? expression.slice(5) : expression).trim();
    if (
      !/^[A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*$/.test(dotted)
    ) {
      throw new TypeError(
        `unsupported action mapping expression '${expression}'`,
      );
    }
    const value = resolveRestrictedJsonPath(root, `$.${dotted}`);
    return asJson
      ? canonicalJson(value)
      : value == null
        ? ""
        : typeof value === "string"
          ? value
          : canonicalJson(value);
  });
}

function resolveActionMappingValue(
  value: unknown,
  root: Record<string, unknown>,
): unknown {
  if (typeof value === "string" && value.startsWith("$")) {
    return resolveRestrictedJsonPath(root, value);
  }
  if (isPlainSchema(value)) {
    if (Object.hasOwn(value, "constant"))
      return structuredClone(value.constant);
    if (typeof value.path === "string") {
      return resolveRestrictedJsonPath(root, value.path);
    }
    if (typeof value.template === "string") {
      return renderActionMappingTemplate(value.template, root);
    }
  }
  return structuredClone(value);
}

function mapActionRecord(
  mapping: Record<string, unknown>,
  root: Record<string, unknown>,
): Record<string, unknown> {
  const mapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapping)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) {
      throw new TypeError(`forbidden action mapping key '${key}'`);
    }
    mapped[key] = resolveActionMappingValue(value, root);
  }
  return mapped;
}

function applyActionInputMapping(
  ctx: ToolContext,
  action: ActionSpec,
): ToolContext {
  const mapping = (action as { input_mapping?: unknown }).input_mapping;
  if (!isPlainSchema(mapping) || Object.keys(mapping).length === 0) return ctx;
  const eventData = ctx.event?.data ?? {};
  const nestedInputs = isPlainSchema(eventData.inputs) ? eventData.inputs : {};
  const mapped = mapActionRecord(mapping, {
    event: eventData,
    inputs: nestedInputs,
    lastResult: ctx.lastResult,
    run: { subject: ctx.subject, correlationId: ctx.correlationId },
  });
  return {
    ...ctx,
    event: {
      name: ctx.event?.name ?? `action:${action.name}`,
      data:
        action.type === "logic"
          ? { ...eventData, inputs: { ...nestedInputs, ...mapped } }
          : mapped,
    },
  };
}

function applyActionOutputMapping(
  result: StepOutput,
  action: ActionSpec,
  ctx: ToolContext,
): StepOutput {
  const mapping = (action as { output_mapping?: unknown }).output_mapping;
  if (!isPlainSchema(mapping) || Object.keys(mapping).length === 0)
    return result;
  const eventData = ctx.event?.data ?? {};
  const nestedInputs = isPlainSchema(eventData.inputs) ? eventData.inputs : {};
  const mapped = mapActionRecord(mapping, {
    result: result.data,
    lastResult: result.data,
    event: eventData,
    inputs: nestedInputs,
    run: { subject: ctx.subject, correlationId: ctx.correlationId },
  });
  // Branch control fields are runtime state, not ordinary mapped output.
  // Preserve them even when an author maps additional condition fields so
  // register.ts and Studio cannot silently take the false branch.
  if (action.type === "condition" && isPlainSchema(result.data)) {
    for (const key of ["evaluated", "condition", "targetActionId"] as const) {
      if (Object.hasOwn(result.data, key)) mapped[key] = result.data[key];
    }
  }
  return {
    ...result,
    data: mapped,
    meta: { ...result.meta, outputMapped: true },
  };
}

function evaluateRestrictedCondition(
  expression: string,
  ctx: ToolContext,
): boolean {
  const trimmed = expression.trim();
  if (/^true$/i.test(trimmed)) return true;
  if (/^false$/i.test(trimmed)) return false;
  const comparison = trimmed.match(
    /^(lastResult|inputs|event)((?:\.[A-Za-z_][A-Za-z0-9_-]*)*)\s*(==|!=|>=|<=|>|<)\s*(null|true|false|-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|'[^']*')$/,
  );
  const eventData = ctx.event?.data ?? {};
  const roots: Record<string, unknown> = {
    lastResult: ctx.lastResult,
    inputs: isPlainSchema(eventData.inputs) ? eventData.inputs : {},
    event: eventData,
  };
  if (!comparison) {
    const bare = trimmed.match(
      /^(lastResult|inputs|event)((?:\.[A-Za-z_][A-Za-z0-9_-]*)*)$/,
    );
    if (!bare) {
      throw new TypeError(`unsupported condition expression '${expression}'`);
    }
    return Boolean(
      resolveRestrictedJsonPath(roots, `$.${bare[1]}${bare[2] ?? ""}`),
    );
  }
  const left = resolveRestrictedJsonPath(
    roots,
    `$.${comparison[1]}${comparison[2] ?? ""}`,
  );
  const literal = comparison[4]!;
  let right: unknown;
  if (literal === "null") right = null;
  else if (literal === "true" || literal === "false")
    right = literal === "true";
  else if (/^-?\d/.test(literal)) right = Number(literal);
  else if (literal.startsWith('"')) right = JSON.parse(literal);
  else right = literal.slice(1, -1);
  switch (comparison[3]) {
    case "==":
      return left === right;
    case "!=":
      return left !== right;
    case ">":
      return (
        typeof left === "number" && typeof right === "number" && left > right
      );
    case "<":
      return (
        typeof left === "number" && typeof right === "number" && left < right
      );
    case ">=":
      return (
        typeof left === "number" && typeof right === "number" && left >= right
      );
    case "<=":
      return (
        typeof left === "number" && typeof right === "number" && left <= right
      );
    default:
      return false;
  }
}

export async function runAction(input: StepInput): Promise<StepOutput> {
  const {
    ctx: suppliedCtx,
    action,
    tenantRegistry,
    agent,
    runId,
    stepId,
    stepOrd,
    trace,
    finalOutput = true,
    conversationHistory,
  } = input;
  const ctx = applyActionInputMapping(suppliedCtx, action);
  const logCtx = deriveLogCtx(ctx, runId);
  const actionStartedAt = new Date();

  await emitStepLog(logCtx, "INFO", "action.start", {
    agent: ctx?.agentName ?? agent?.name ?? "unknown",
    action: action.name,
    type: action.type,
    subject: ctx?.subject ?? "—",
  });
  if (runId) {
    await emitTraceBestEffort(trace, {
      runId,
      ...(stepId ? { stepId } : {}),
      kind: "step",
      level: "standard",
      name: action.name,
      status: "running",
      startedAt: actionStartedAt,
      summary: action.description || `Executing ${action.type} action`,
      data: { type: action.type, ...(stepOrd ? { ord: stepOrd } : {}) },
      visibility: "user",
    });
  }

  let result: StepOutput;
  try {
    switch (action.type) {
      case "tool": {
        const v2ToolBoundary =
          agent !== undefined &&
          normalizeAgentForExecution(agent).compatibilityMode === "v2";
        // Same resolution chain as the LLM tool-use loop: tenant override
        // → global registry → legacy mock runTool fallback. Keeps the two
        // dispatch paths behaviourally aligned so an action declared as
        // `type: "tool"` resolves the same way the LLM would have if it
        // had asked for the tool by name itself.
        const toolName =
          typeof action.tool === "string" && action.tool.length > 0
            ? action.tool
            : action.name;
        // `tool_use[]` is the execution trust boundary for direct actions just
        // as it is for model-requested tool calls. A registered global/tenant
        // tool is never implicitly callable merely because an action knows its
        // name.
        const toolUseEntry = agent?.tool_use?.find(
          (entry) => (entry as { name?: string })?.name === toolName,
        );
        if (v2ToolBoundary && !toolUseEntry) {
          result = {
            ok: false,
            type: "tool",
            data: null,
            meta: {
              error: "tool_not_allowed",
              tool: toolName,
              message: `Tool '${toolName}' is not present in this agent's tool_use allow-list`,
            },
          };
          break;
        }
        const tenantTool = tenantRegistry?.tools?.[toolName];
        const globalTool = !tenantTool
          ? globalToolRegistry.get(toolName)
          : undefined;
        if (tenantTool || globalTool) {
          // Look up matching tool_use[] entry by the explicit tool identifier so per-tenant
          // config flows the same way it does in the LLM tool-use loop.
          // tenant-test1's writeWorkflowLog (a `type: "tool"` action with
          // no LLM loop) relies on this path to receive its subdir/filename
          // binding from the manifest.
          const toolConfig =
            toolUseEntry && typeof toolUseEntry === "object"
              ? ((toolUseEntry as { config?: Record<string, unknown> })
                  .config ?? undefined)
              : undefined;
          const enrichedCtx: ToolContext = toolConfig
            ? { ...ctx, config: toolConfig }
            : ctx;
          if (v2ToolBoundary && isPlainSchema(toolUseEntry?.input_schema)) {
            const schemaIssues = validateValueAgainstJsonSchema(
              toolUseEntry.input_schema,
              ctx.event?.data ?? {},
              "/tool/input",
              "tool_input_schema",
            );
            if (schemaIssues.length > 0) {
              result = {
                ok: false,
                type: "tool",
                data: null,
                meta: {
                  error: "tool_input_schema_invalid",
                  tool: toolName,
                  validationIssues: schemaIssues,
                },
              };
              break;
            }
          }
          const toolStartedAt = Date.now();
          await emitStepLog(logCtx, "INFO", "tool.call", {
            agent: ctx?.agentName ?? agent?.name ?? "unknown",
            tool: toolName,
            resolved_via: tenantTool ? "tenant" : "global",
            via: "action",
            subject: ctx?.subject ?? "—",
          });
          result = await runTenantTool(
            enrichedCtx,
            (tenantTool ?? globalTool)!,
          );
          await emitStepLog(
            logCtx,
            result.ok ? "INFO" : "ERROR",
            result.ok ? "tool.ok" : "tool.error",
            {
              agent: ctx?.agentName ?? agent?.name ?? "unknown",
              tool: toolName,
              duration_ms: Date.now() - toolStartedAt,
              ...(result.ok
                ? {}
                : {
                    error: JSON.stringify(
                      result.meta?.schemaError ?? result.meta ?? "tool failed",
                    ),
                  }),
            },
          );
        } else if (v2ToolBoundary) {
          result = {
            ok: false,
            type: "tool",
            data: null,
            meta: {
              error: "tool_not_registered",
              tool: toolName,
              message: `Tool '${toolName}' is allow-listed but has no tenant or global implementation`,
            },
          };
        } else {
          await emitStepLog(logCtx, "WARN", "tool.call", {
            agent: ctx?.agentName ?? agent?.name ?? "unknown",
            tool: toolName,
            resolved_via: "legacy-mock",
            via: "action",
          });
          const r = await runTool(genericCtx(ctx), toolName);
          result = {
            ok: r.ok,
            type: "tool",
            data: r.data,
            meta: r.meta,
          };
        }
        break;
      }
      case "logic": {
        const logicPrompt =
          tenantRegistry?.prompts?.[action.name] ??
          (agent?.generated
            ? makeGeneratedAgentPrompt(action.name, action.description)
            : undefined);
        if (!logicPrompt) {
          // UC-V11-25 / AR-GAP-13 — strict mode. Boot-time validation in
          // `packages/runtime/src/bootstrap.ts` refuses to register a tenant
          // whose manifest has logic actions without matching prompts.
          // Reaching this branch means a hot-reload path bypassed validation
          // or a test wired a partial registry. Fail loud instead of
          // shipping `${name}: ${description}` (often non-English text) to
          // the model as a user message.
          result = {
            ok: false,
            type: "logic",
            data: null,
            meta: {
              error: "missing_tenant_prompt",
              actionName: action.name,
              hint:
                "Add a definePrompt to tenants/<slug>/prompts/ and re-export it " +
                "from the TenantRegistry.prompts map.",
            },
          };
          break;
        }

        const retryCount = Math.min(10, Math.max(0, action.retries ?? 0));
        const maxAttempts = retryCount + 1;
        // Action controls are true per-step overrides. Any omitted field
        // inherits the agent-level selection, preserving old manifests while
        // allowing a cheap classifier, a reasoning-heavy planner, and a
        // long-context synthesizer to coexist in one authored agent.
        const effectiveAgent = agent
          ? {
              ...agent,
              ...(action.provider ? { provider: action.provider } : {}),
              ...(action.model ? { model: action.model } : {}),
              ...(action.reasoning ? { reasoning: action.reasoning } : {}),
              ...(action.verbosity ? { verbosity: action.verbosity } : {}),
              ...(typeof action.store === "boolean"
                ? { store: action.store }
                : {}),
              ...(typeof action.temperature === "number"
                ? { temperature: action.temperature }
                : {}),
              ...(typeof action.max_tokens === "number"
                ? { max_tokens: action.max_tokens }
                : {}),
              ...(typeof action.timeout_s === "number"
                ? { timeout_s: action.timeout_s }
                : {}),
            }
          : agent;
        const hasOutputMapping =
          isPlainSchema(action.output_mapping) &&
          Object.keys(action.output_mapping).length > 0;
        let attempts = 0;
        for (;;) {
          attempts += 1;
          try {
            result = await runTenantPrompt(
              ctx,
              logicPrompt,
              action,
              effectiveAgent,
              tenantRegistry,
              logCtx,
              trace,
              runId,
              stepId,
              finalOutput && !hasOutputMapping,
              conversationHistory,
            );
          } catch (error) {
            if (attempts >= maxAttempts) throw error;
            const message =
              error instanceof Error ? error.message : String(error);
            await emitStepLog(logCtx, "WARN", "action.retry", {
              action: action.name,
              attempt: attempts,
              max_attempts: maxAttempts,
              error: message,
            });
            if (runId) {
              await emitTraceBestEffort(trace, {
                runId,
                ...(stepId ? { stepId } : {}),
                kind: "step",
                level: "standard",
                name: `${action.name}.retry`,
                status: "running",
                summary: `Retrying logic action after attempt ${attempts} failed`,
                data: { attempt: attempts, maxAttempts, error: message },
                visibility: "operator",
              });
            }
            continue;
          }

          const retryableResult =
            !result.ok && result.meta?.error === "output_schema_invalid";
          if (!retryableResult || attempts >= maxAttempts) break;
          await emitStepLog(logCtx, "WARN", "action.retry", {
            action: action.name,
            attempt: attempts,
            max_attempts: maxAttempts,
            error: result.meta?.error,
          });
        }
        result = {
          ...result,
          meta: { ...result.meta, actionAttempts: attempts },
        };
        break;
      }
      case "manual": {
        // Real HITL flow lives in register.ts (step.waitForEvent + tasks).
        // The engine never reaches this case via the main loop — register.ts
        // short-circuits manual steps before calling runAction. Kept here so
        // ad-hoc callers (tests, replays) get a sensible placeholder.
        result = {
          ok: true,
          type: "manual",
          data: {
            autoResolved: true,
            note: "manual step handled by register.ts via waitForEvent",
          },
          pendingTaskTitle: action.name,
        };
        break;
      }
      case "condition": {
        const condition =
          (action as { condition?: string }).condition ?? "true";
        const evaluated = evaluateRestrictedCondition(condition, ctx);
        const targetActionId = evaluated
          ? action.true_action_id
          : action.false_action_id;
        result = {
          ok: true,
          type: "condition",
          data: {
            evaluated,
            condition,
            targetActionId: targetActionId ?? null,
          },
        };
        break;
      }
      case "delay": {
        // P1-RT-03: in production this becomes `step.sleep(...)` so Inngest
        // owns the durable timer. The engine version uses setTimeout so
        // ad-hoc callers (tests) get matching wall-clock behavior.
        const ms = (action as { delay_ms?: number }).delay_ms ?? 0;
        if (ms > 0) {
          await new Promise<void>((r) => setTimeout(r, ms));
        }
        result = {
          ok: true,
          type: "delay",
          data: { delay_ms: ms, sleptMs: ms },
        };
        break;
      }
      case "subflow": {
        // P1-RT-03: placeholder. The real fork — emitting an event for the
        // child agent and (optionally) awaiting its terminal event — is in
        // register.ts. The engine version records the intended fanout so
        // ad-hoc callers can inspect it.
        const a = action as {
          subflow?: string;
          subflow_input?: Record<string, unknown>;
        };
        result = {
          ok: true,
          type: "subflow",
          data: {
            subflow: a.subflow ?? null,
            subflow_input: a.subflow_input ?? {},
          },
        };
        break;
      }
    }
    if (result.ok) result = applyActionOutputMapping(result, action, ctx);
  } catch (error) {
    const actionEndedAt = new Date();
    const message = error instanceof Error ? error.message : String(error);
    await emitStepLog(logCtx, "ERROR", "action.end", {
      agent: ctx?.agentName ?? agent?.name ?? "unknown",
      action: action.name,
      type: action.type,
      ok: false,
      error: message,
    });
    if (runId) {
      await emitTraceBestEffort(trace, {
        runId,
        ...(stepId ? { stepId } : {}),
        kind: "step",
        level: "minimal",
        name: action.name,
        status: "failed",
        startedAt: actionStartedAt,
        endedAt: actionEndedAt,
        durationMs: Math.max(
          0,
          actionEndedAt.getTime() - actionStartedAt.getTime(),
        ),
        summary: `${action.type} action failed: ${message}`,
        data: { type: action.type, error: message },
        visibility: "user",
      });
    }
    throw error;
  }

  // P0-RT-09: optional artifact sidecars.
  if (runId && typeof stepOrd === "number") {
    const outputArtifact = await writeStepArtifacts(runId, stepOrd, {
      input: {
        action: action.name,
        type: action.type,
        ctx,
        agent: agent
          ? { name: agent.name, description: agent.description }
          : undefined,
      },
      output: result,
    });
    if (outputArtifact) result.outputArtifact = outputArtifact;
  }

  // Summary line so monitoring can see the action's terminal state + the
  // model/provider it resolved to + how many tool calls it fanned out into
  // (and how many of those errored) without parsing every intermediate line.
  const toolCalls = Array.isArray(result.meta?.toolCalls)
    ? (result.meta!.toolCalls as ToolCallTrace[])
    : [];
  const toolErrors = toolCalls.filter((t) => t.isError).length;
  await emitStepLog(logCtx, result.ok ? "INFO" : "ERROR", "action.end", {
    agent: ctx?.agentName ?? agent?.name ?? "unknown",
    action: action.name,
    type: action.type,
    ok: result.ok,
    ...(result.model ? { model: result.model } : {}),
    ...(result.provider ? { provider: result.provider } : {}),
    tokens_in: result.tokensIn ?? 0,
    tokens_out: result.tokensOut ?? 0,
    tool_calls: toolCalls.length,
    tool_errors: toolErrors,
  });
  if (runId) {
    const actionEndedAt = new Date();
    await emitTraceBestEffort(trace, {
      runId,
      ...(stepId ? { stepId } : {}),
      kind: "step",
      level: result.ok ? "standard" : "minimal",
      name: action.name,
      status: result.ok ? "ok" : "failed",
      startedAt: actionStartedAt,
      endedAt: actionEndedAt,
      durationMs: Math.max(
        0,
        actionEndedAt.getTime() - actionStartedAt.getTime(),
      ),
      summary: result.ok
        ? `${action.type} action completed`
        : `${action.type} action failed`,
      data: {
        type: action.type,
        tokensIn: result.tokensIn ?? 0,
        tokensOut: result.tokensOut ?? 0,
        toolCalls: toolCalls.length,
        toolErrors,
        ...(result.model ? { model: result.model } : {}),
        ...(result.provider ? { provider: result.provider } : {}),
        ...(result.ok ? {} : { error: result.meta?.error ?? "action_failed" }),
      },
      visibility: "user",
    });
  }

  return result;
}
