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
import type { MemoryHandle } from "@agentic/agent-sdk";
import type { ActionSpec } from "./manifest";
import { getRuntimeGateway } from "./llm-host";
import { makeGeneratedAgentPrompt } from "./generated-agent";
import { runGeneratedCode } from "./codeact";
import { evaluateCondition } from "./action-plan";
import { isSandboxTenant, sandboxToolMode, sandboxToolStub, cassetteLookup, toolDispatchDecision, gatedWriteMarker, injectedFault, faultResult } from "./sandbox-mode";
import type {
  ChatContentBlock,
  ChatMessage,
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
  description?: string;
  ontology_instructions?: string;
  /**
   * Declarative tool roster from the manifest's `agent.tool_use[]`. When
   * non-empty AND a matching `tenantRegistry.tools[name]` exists, the
   * `logic` action runs a tool-use loop (gateway emits `tool_use` blocks
   * → engine executes → feeds `tool_result` back → repeat until text or
   * `MAX_TOOL_USE_ITERS`).
   */
  tool_use?: ToolUseEntry[];
  /**
   * Agent Factory marker. When true, the agent's `logic` action runs the runtime's default
   * generated-agent prompt (no hand-written tenant prompt required) and the tool-use loop
   * advertises GLOBAL registry tools in addition to tenant tools — so a machine-generated agent
   * referencing global tools (ontology.fetchActionRules, fs.*, …) can actually call them.
   */
  generated?: boolean;
  /** #G — true CodeAct: when true (AI-written code), the logic action EXECUTES `typescriptCode`'s
   *  handler in the sandbox instead of the default prompt. Gated (FACTORY_EXEC_GENERATED) + falls back. */
  codeExecuted?: boolean;
  typescriptCode?: string;
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
  /**
   * #REDESIGN FU1 — the REAL durable MemoryHandle for this run (createMemoryHandle), threaded from the
   * delivered adapter (register.ts). Passed into generated-code execution so a deployed agent's handler
   * gets persistent vector-recall memory instead of an ephemeral map. Undefined for pure-runtime/test
   * callers → codeact falls back to an in-process handle.
   */
  memory?: MemoryHandle;
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
): Promise<{
  text: string;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
  toolCalls: ToolCallTrace[];
  turns: LlmTurnTrace[];
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
      // Tenant tool wins; for GENERATED agents, fall back to the global registry so their roster
      // (ontology.fetchActionRules, fs.*, …) is actually advertised to the model. Hand-authored
      // tenants keep the strict tenant-only behaviour (a stale declaration silently no-ops).
      const handler =
        tenantRegistry?.tools?.[entry.name] ??
        (agent?.generated ? globalToolRegistry.get(entry.name) : undefined);
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
  // #W0 — raw per-turn capture (response text + reasoning + requested tools),
  // surfaced up to register.ts which persists it to `llm_turns`. This is the
  // only site that sees every turn's full response, incl. provider-native
  // reasoning via response.raw.
  const turns: LlmTurnTrace[] = [];

  for (let iter = 0; iter < maxIters; iter++) {
    const response = await gateway.chat({
      messages,
      model: preferredModel,
      tools: tools.length > 0 ? tools : undefined,
      tenantSlug: ctx?.tenantSlug,
    });
    totalIn += response.tokensIn ?? 0;
    totalOut += response.tokensOut ?? 0;
    lastProvider = response.provider;
    lastModel = response.model;

    const requestedCalls = response.toolCalls ?? [];

    turns.push({
      ord: iter,
      promptPreview: iter === 0 ? capText(rendered, 4000) : undefined,
      responseText: capText(response.text ?? "", 8000),
      reasoning: capText(extractReasoning(response.raw), 8000),
      toolCalls: requestedCalls.map((c) => ({
        name: c.name,
        input: capValue(c.input, 1500),
      })),
      provider: response.provider,
      model: response.model,
      tokensIn: response.tokensIn ?? 0,
      tokensOut: response.tokensOut ?? 0,
      finishReason: response.finishReason,
      latencyMs: response.latencyMs ?? 0,
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
      const handler =
        tenantRegistry?.tools?.[call.name] ?? globalToolRegistry.get(call.name);

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
        runId: ctx?.runId,
        tenantSlug: ctx?.tenantSlug ?? "unknown",
        event: ctx?.event,
        // Each tool sees the prior tool's output as lastResult — gives the
        // model the option to chain without re-quoting state through the prompt.
        lastResult:
          toolCalls.length > 0 ? toolCalls[toolCalls.length - 1]!.output : ctx?.lastResult,
        config: toolConfig,
        memory: ctx?.memory, // #P0-1 — durable memory reaches each tool in the tool-use loop
      };

      const startedAt = Date.now();
      let outputBody: string;
      let isError = false;
      let outputData: unknown = null;
      try {
        if (!handler) {
          throw new Error(
            `tool '${call.name}' not registered for this tenant and not found in global registry`,
          );
        }
        // #REDESIGN P1b — the LLM tool-use loop must honour sandbox gating too (not just the
        // type:"tool" plan path): in a `-sb` tenant, READS run live, external WRITES are gated
        // (marker, not fired) unless FACTORY_SANDBOX_ALLOW_WRITES=1; mock/replay short-circuit.
        const sbDecision = isSandboxTenant(callCtx.tenantSlug) ? toolDispatchDecision(call.name, sandboxToolMode()) : "live";
        if (sbDecision !== "live") {
          const replayed = sbDecision === "replay" ? await cassetteLookup(callCtx.tenantSlug!, call.name, call.input) : undefined;
          outputData = sbDecision === "gate" ? gatedWriteMarker(call.name, call.input) : (replayed ?? sandboxToolStub(call.name));
          const faultLoop = injectedFault(ctx?.event?.data, call.name); // #W3-FAULT — poisoned tool in the LLM loop
          if (faultLoop) outputData = faultResult(call.name, faultLoop.kind);
          // #W1-9 — make the sandbox decision VISIBLE in the artifact: a mocked/gated call must never
          // read like a real one in the run trace.
          if (outputData && typeof outputData === "object") (outputData as Record<string, unknown>).__sbDecision = sbDecision;
          outputBody = stringifyToolPayload(outputData);
        } else {
          // Merge the model's tool-call input into the context so handlers
          // that prefer args over ctx.event.data have a single read site.
          const handlerCtx = { ...callCtx, event: { name: `tool:${call.name}`, data: call.input } };
          const r = await handler.handler(handlerCtx);
          outputData = r.data;
          outputBody = stringifyToolPayload(r.data);
          totalIn += r.tokensIn ?? 0;
          totalOut += r.tokensOut ?? 0;
        }
      } catch (err) {
        isError = true;
        outputBody = JSON.stringify({
          error: String(err instanceof Error ? err.message : err),
        });
      }
      toolCalls.push({
        id: call.id,
        name: call.name,
        input: call.input,
        output: outputData,
        isError,
        durationMs: Date.now() - startedAt,
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
    turns,
  };
}

/**
 * One raw LLM turn captured from the tool-use loop. Persisted to `llm_turns`
 * (via register.ts) and surfaced in the run's reasoning views. Text fields are
 * pre-bounded here so the runtime never hands the DB an unbounded blob.
 */
export interface LlmTurnTrace {
  ord: number;
  promptPreview?: string | null;
  responseText: string | null;
  reasoning: string | null;
  toolCalls: Array<{ name: string; input: unknown }>;
  provider: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  finishReason: string;
  latencyMs: number;
}

/** Truncate a string to `max` chars with a compact "+N more" marker. */
function capText(s: string | null | undefined, max: number): string | null {
  if (s == null) return null;
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

/** Bound an arbitrary value by its serialized size; oversized → preview marker. */
function capValue(v: unknown, max: number): unknown {
  if (v == null) return v;
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    return null;
  }
  if (s.length <= max) return v;
  return { _truncated: true, _bytes: s.length, _preview: s.slice(0, max) };
}

/**
 * Best-effort extraction of provider-native reasoning/thinking from a chat
 * response's `raw` payload. Anthropic surfaces `thinking` content blocks;
 * OpenAI-family adapters may expose `reasoning`/`reasoning_content`. Returns
 * null when the provider didn't surface any (the common case).
 */
function extractReasoning(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Anthropic: content[].{thinking|redacted_thinking}
  if (Array.isArray(r.content)) {
    const parts: string[] = [];
    for (const b of r.content as Array<Record<string, unknown>>) {
      if (b?.type === "thinking" && typeof b.thinking === "string")
        parts.push(b.thinking);
      else if (b?.type === "redacted_thinking") parts.push("[redacted thinking]");
    }
    if (parts.join("").trim()) return parts.join("\n");
  }
  // OpenAI-ish: choices[0].message.{reasoning_content|reasoning}
  const choices = r.choices as Array<Record<string, unknown>> | undefined;
  const msg = choices?.[0]?.message as Record<string, unknown> | undefined;
  const rc = msg?.reasoning_content ?? msg?.reasoning;
  if (typeof rc === "string" && rc.trim()) return rc;
  if (typeof r.reasoning === "string" && r.reasoning.trim()) return r.reasoning;
  return null;
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
): Promise<StepOutput> {
  const rendered = prompt.template(ctx);
  const result = await callLLM(
    rendered,
    prompt.model,
    prompt.system,
    agent,
    tenantRegistry,
    ctx,
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
      // #W0 — raw per-turn LLM capture (response text + reasoning + requested
      // tools). register.ts persists this to `llm_turns` when capture is on.
      turns: result.turns,
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

  let result: StepOutput;
  switch (action.type) {
    case "tool": {
      // T3 — sandbox interception: in the isolated `-sb` tenant, a Phase-1 `type:"tool"` step calls
      // the real handler directly (no LLM in the loop), so without this it would hit RoboHire/etc.
      // for real. mock (default) → stub; replay → recorded cassette (miss → stub); live → real.
      if (isSandboxTenant(ctx.tenantSlug)) {
        // #W3-FAULT — an injected fault (from a kind:"fault" test case's __fault payload marker) beats
        // every dispatch mode: return a failing result so the step's onError policy is EXERCISED.
        const fault = injectedFault(ctx.event?.data, action.name);
        if (fault) {
          result = { ok: false, type: "tool", data: faultResult(action.name, fault.kind), meta: { tool: action.name, sandbox: true, injectedFault: fault.kind } };
          break;
        }
        const mode = sandboxToolMode();
        // #REDESIGN P1b — gated: READ tools run live (real integration, fall through below); external
        // WRITES are gated (real payload recorded, not fired) unless FACTORY_SANDBOX_ALLOW_WRITES=1.
        const decision = toolDispatchDecision(action.name, mode);
        if (decision !== "live") {
          const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
          const replayed = decision === "replay" ? await cassetteLookup(ctx.tenantSlug!, action.name, args) : undefined;
          result = {
            ok: true,
            type: "tool",
            data: decision === "gate" ? gatedWriteMarker(action.name, args) : (replayed ?? sandboxToolStub(action.name)),
            meta: { tool: action.name, sandbox: true, toolMode: mode, decision, replayed: replayed !== undefined },
          };
          break;
        }
      }
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
        result = await runTenantTool(enrichedCtx, (tenantTool ?? globalTool)!);
      } else {
        // #NOMOCK — 生产路径不再走 legacy runTool 假桩（httpFetch→{status:200,mock:true}）：一个
        // 未解析到真实工具的 type:"tool" 步曾在【生产】里静默返回 mock 成功（沙箱路径在上面已被
        // sandboxToolStub 拦截，这里只会命中真实/晋升租户）。改为 fail-closed：报错让 step 的
        // onError 策略生效，别让"跑通"建立在假成功上。FACTORY_ALLOW_LEGACY_MOCK_TOOL=1 可临时放行。
        if (process.env.FACTORY_ALLOW_LEGACY_MOCK_TOOL === "1") {
          const r = await runTool(genericCtx(ctx), action.name);
          result = { ok: r.ok, type: "tool", data: r.data, meta: { ...r.meta, legacyMock: true } };
        } else {
          result = { ok: false, type: "tool", data: { __error: `工具「${action.name}」未注册（tenant/global 都没有）——生产不再用假桩兜底。请为该动作绑定真实工具或补进工具库。` }, meta: { tool: action.name, unresolved: true } };
        }
      }
      break;
    }
    case "logic": {
      const tenantPrompt = tenantRegistry?.prompts?.[action.name];
      if (tenantPrompt) {
        result = await runTenantPrompt(ctx, tenantPrompt, agent, tenantRegistry);
      } else if (agent?.generated) {
        // #G — true CodeAct: when this generated agent has executable AI code, RUN it (gated,
        // sandboxed, dry-run tools) so the verdict reflects the deployable code — not a
        // re-interpretation. Any failure returns null → fall through to the default prompt.
        const exec = agent.codeExecuted && agent.typescriptCode
          ? await runGeneratedCode(agent.typescriptCode, (ctx?.event?.data ?? {}) as Record<string, unknown>, { systemPrompt: agent.ontology_instructions, tenantSlug: ctx?.tenantSlug, memory: input.memory, runId: input.runId })
          : null;
        if (exec) {
          result = { ok: true, type: "logic", data: exec.data, meta: { codeExecuted: true, emitted: exec.emitted } };
        } else {
          // Generated agent: no hand-written tenant prompt by design. Run the default generated
          // prompt — the agent's ontology_instructions ARE its system prompt; this feeds the event
          // payload and lets the tool-use loop drive.
          result = await runTenantPrompt(ctx, makeGeneratedAgentPrompt(action.name), agent, tenantRegistry);
        }
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
      // Phase 1a: the real, safe boolean evaluator (action-plan.ts) — supports path
      // comparisons (==/!=/>/</>=/<=), presence, negation, &&/||, plus the legacy
      // `lastResult == null` forms. Unparseable → false (deterministic, never throws).
      // register.ts consumes `data.evaluated` to SKIP downstream dependsOn steps.
      const condition = (action as { condition?: string }).condition ?? "true";
      const evaluated = evaluateCondition(condition, {
        lastResult: ctx.lastResult,
        event: ctx.event,
      });
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
    default: {
      // Phase 1a — `invoke` is handled synchronously in register.ts (step.invoke) and never
      // reaches runAction. This default keeps the switch exhaustive over StepTypeEnum and
      // returns a benign error result for any unexpected/ad-hoc type.
      result = {
        ok: false,
        type: "logic",
        data: null,
        meta: { error: "unsupported_action_type", actionType: (action as { type?: string }).type },
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

  return result;
}
