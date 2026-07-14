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
  ProviderId,
  ToolDef,
  ToolUseBlock,
  ToolResultBlock,
} from "@agentic/llm-gateway";
import path from "node:path";
import { promises as fs } from "node:fs";

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
}

interface AgentSlots {
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
  /** Per-call gateway timeout authored in the manifest. */
  timeout_s?: number;
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
function resolveMaxIters(): number {
  const raw = process.env.AGENTIC_TOOL_USE_MAX_ITERS;
  if (!raw) return MAX_TOOL_USE_ITERS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : MAX_TOOL_USE_ITERS_DEFAULT;
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

export interface StepInput {
  ctx: ToolContext;
  action: ActionSpec;
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
  stepOrd?: number;
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
  // resolve. The schema fallback is intentionally permissive — strict input
  // validation belongs in the tool handler.
  const tools: ToolDef[] = [];
  if (agent?.tool_use && agent.tool_use.length > 0) {
    for (const entry of agent.tool_use) {
      const handler =
        tenantRegistry?.tools?.[entry.name] ??
        (agent.generated ? globalToolRegistry.get(entry.name) : undefined);
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

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: rendered },
  ];

  // Tool-use loop. When no tools are advertised this is a single pass and
  // exits immediately — same shape as the old single-call path.
  const maxIters = resolveMaxIters();
  let totalIn = 0;
  let totalOut = 0;
  let lastProvider = "";
  let lastModel = "";
  let finalText = "";
  const toolCalls: ToolCallTrace[] = [];

  for (let iter = 0; iter < maxIters; iter++) {
    const response = await gateway.chat({
      messages,
      model: preferredModel,
      provider: agent?.provider,
      timeoutMs:
        typeof agent?.timeout_s === "number"
          ? agent.timeout_s * 1_000
          : undefined,
      tools: tools.length > 0 ? tools : undefined,
      tenantId: agent?.tenantId,
      tenantSlug: ctx?.tenantSlug,
    });
    totalIn += response.tokensIn ?? 0;
    totalOut += response.tokensOut ?? 0;
    lastProvider = response.provider;
    lastModel = response.model;

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
    if (response.text) assistantBlocks.push({ type: "text", text: response.text });
    for (const call of requestedCalls) {
      const block: ToolUseBlock = {
        type: "tool_use",
        id: call.id,
        name: call.name,
        input: call.input,
      };
      assistantBlocks.push(block);
    }
    messages.push({ role: "assistant", content: assistantBlocks });

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
        ? tenantRegistry?.tools?.[call.name] ?? globalToolRegistry.get(call.name)
        : undefined;

      // Per-tenant config plumbing: lift the manifest's
      // `tool_use[i].config` blob into ctx.config so global tools can be
      // specialised per tenant (api_key_env, subdir, etc.) without code.
      const toolUseEntry = agent?.tool_use?.find(
        (t) => (t as { name?: string })?.name === call.name,
      );
      const toolConfig =
        toolUseEntry && typeof toolUseEntry === "object"
          ? ((toolUseEntry as { config?: Record<string, unknown> }).config ?? undefined)
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
          toolCalls.length > 0 ? toolCalls[toolCalls.length - 1]!.output : ctx?.lastResult,
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
        // Merge the model's tool-call input into the context so handlers
        // that prefer args over ctx.event.data have a single read site.
        const handlerCtx = { ...callCtx, event: { name: `tool:${call.name}`, data: call.input } };
        const r = await handler.handler(handlerCtx);
        outputData = r.data;
        outputBody = stringifyToolPayload(r.data);
        totalIn += r.tokensIn ?? 0;
        totalOut += r.tokensOut ?? 0;
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
      toolCalls.push({
        id: call.id,
        name: call.name,
        input: call.input,
        output: outputData,
        isError,
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
      finalText =
        `[tool-use loop hit max ${maxIters} iterations without a final text reply]`;
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
  agent?: AgentSlots,
  tenantRegistry?: TenantRegistry,
  logCtx?: RunLogContext,
): Promise<StepOutput> {
  const rendered = prompt.template(ctx);
  const result = await callLLM(
    rendered,
    prompt.model,
    prompt.system,
    agent,
    tenantRegistry,
    ctx,
    logCtx,
  );
  let validated: unknown = result.text;
  if (prompt.output) {
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
    tokensIn: result.tokensIn,
    tokensOut: result.tokensOut,
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
  const root = process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts";
  const dir = path.resolve(root, runId);
  try {
    await fs.mkdir(dir, { recursive: true });
    const inputPath = path.join(dir, `step-${stepOrd}-input.json`);
    const outputPath = path.join(dir, `step-${stepOrd}-output.json`);
    await fs.writeFile(inputPath, JSON.stringify(payload.input, null, 2), "utf8");
    await fs.writeFile(outputPath, JSON.stringify(payload.output, null, 2), "utf8");
    return outputPath;
  } catch (err) {
    console.warn(
      `[step-engine] failed to write step artifacts for ${runId} step-${stepOrd}:`,
      err,
    );
    return undefined;
  }
}

export async function runAction(input: StepInput): Promise<StepOutput> {
  const { ctx, action, tenantRegistry, agent, runId, stepOrd } = input;
  const logCtx = deriveLogCtx(ctx, runId);

  await emitStepLog(logCtx, "INFO", "action.start", {
    agent: ctx?.agentName ?? agent?.name ?? "unknown",
    action: action.name,
    type: action.type,
    subject: ctx?.subject ?? "—",
  });

  let result: StepOutput;
  switch (action.type) {
    case "tool": {
      // Same resolution chain as the LLM tool-use loop: tenant override
      // → global registry → legacy mock runTool fallback. Keeps the two
      // dispatch paths behaviourally aligned so an action declared as
      // `type: "tool"` resolves the same way the LLM would have if it
      // had asked for the tool by name itself.
      const tenantTool = tenantRegistry?.tools?.[action.name];
      const globalTool = !tenantTool ? globalToolRegistry.get(action.name) : undefined;
      if (tenantTool || globalTool) {
        // Look up matching tool_use[] entry by action name so per-tenant
        // config flows the same way it does in the LLM tool-use loop.
        // tenant-test1's writeWorkflowLog (a `type: "tool"` action with
        // no LLM loop) relies on this path to receive its subdir/filename
        // binding from the manifest.
        const toolUseEntry = agent?.tool_use?.find(
          (t) => (t as { name?: string })?.name === action.name,
        );
        const toolConfig =
          toolUseEntry && typeof toolUseEntry === "object"
            ? ((toolUseEntry as { config?: Record<string, unknown> }).config ?? undefined)
            : undefined;
        const enrichedCtx: ToolContext = toolConfig ? { ...ctx, config: toolConfig } : ctx;
        const toolStartedAt = Date.now();
        await emitStepLog(logCtx, "INFO", "tool.call", {
          agent: ctx?.agentName ?? agent?.name ?? "unknown",
          tool: action.name,
          resolved_via: tenantTool ? "tenant" : "global",
          via: "action",
          subject: ctx?.subject ?? "—",
        });
        result = await runTenantTool(enrichedCtx, (tenantTool ?? globalTool)!);
        await emitStepLog(
          logCtx,
          result.ok ? "INFO" : "ERROR",
          result.ok ? "tool.ok" : "tool.error",
          {
            agent: ctx?.agentName ?? agent?.name ?? "unknown",
            tool: action.name,
            duration_ms: Date.now() - toolStartedAt,
            ...(result.ok
              ? {}
              : { error: JSON.stringify(result.meta?.schemaError ?? result.meta ?? "tool failed") }),
          },
        );
      } else {
        await emitStepLog(logCtx, "WARN", "tool.call", {
          agent: ctx?.agentName ?? agent?.name ?? "unknown",
          tool: action.name,
          resolved_via: "legacy-mock",
          via: "action",
        });
        const r = await runTool(genericCtx(ctx), action.name);
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
      const tenantPrompt = tenantRegistry?.prompts?.[action.name];
      if (tenantPrompt) {
        result = await runTenantPrompt(ctx, tenantPrompt, agent, tenantRegistry, logCtx);
      } else if (agent?.generated) {
        result = await runTenantPrompt(
          ctx,
          {
            ...makeGeneratedAgentPrompt(action.name, action.description),
            model: agent.model,
          },
          agent,
          tenantRegistry,
          logCtx,
        );
      } else {
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
      }
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
      // P1-RT-03: lightweight expression evaluator. The real evaluator lives
      // in register.ts where it has access to step/event/agent context; the
      // step-engine version returns the same shape so callers can branch on
      // `data.evaluated` without case analysis on `type`.
      const condition = (action as { condition?: string }).condition ?? "true";
      // Minimal JS-ish evaluator: supports `lastResult == null`, `!= null`,
      // and bare literals. Anything that doesn't parse cleanly is treated
      // as `false` rather than throwing — keeps the engine deterministic.
      let evaluated = false;
      try {
        if (/^true$/i.test(condition.trim())) evaluated = true;
        else if (/lastResult\s*==\s*null/.test(condition)) evaluated = ctx.lastResult == null;
        else if (/lastResult\s*!=\s*null/.test(condition)) evaluated = ctx.lastResult != null;
        else evaluated = Boolean(condition);
      } catch {
        evaluated = false;
      }
      result = {
        ok: true,
        type: "condition",
        data: { evaluated, condition },
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

  // P0-RT-09: optional artifact sidecars.
  if (runId && typeof stepOrd === "number") {
    const outputArtifact = await writeStepArtifacts(runId, stepOrd, {
      input: {
        action: action.name,
        type: action.type,
        ctx,
        agent: agent ? { name: agent.name, description: agent.description } : undefined,
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
  await emitStepLog(
    logCtx,
    result.ok ? "INFO" : "ERROR",
    "action.end",
    {
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
    },
  );

  return result;
}
