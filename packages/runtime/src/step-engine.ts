/**
 * Step engine — dispatches a single action by type.
 *
 * Called from inside an Inngest function via step.run(), so each invocation
 * is durable + idempotent (Inngest replays the function with memoized step
 * results on retry).
 *
 * Resolution order for `tool` and `logic` actions:
 *   1. Tenant registry (`@tenants/<slug>`) — typed handler from agent-kit.
 *   2. Global @agentic/tools registry — real handlers only.
 *
 * Tenant resolution lets a manifest action `{ "name": "rankCandidates", "type": "logic" }`
 * dispatch to a real tenant-defined prompt without editing the runtime.
 */

import {
  globalToolExecutionPolicy,
  globalToolRegistry,
  toolExecutionPoliciesEqual,
  type ToolEffectScope,
  type ToolExecutionPolicy,
  type ToolOperation,
  type ToolSandboxPolicy,
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
import {
  runGeneratedCodeIsolated,
  type GeneratedCodeHostRuntime,
} from "./codeact";
import type { CodeActDockerTransport } from "./codeact-container";
import {
  ActionTimeoutError,
  applyToolResultMap,
  evaluateConditionDetailed,
  foreachStepId,
  materializeForeach,
  materializeToolArguments,
  resolveConditionPath,
  runSequentialForeach,
  runWithActionTimeout,
  shouldSkip,
  type GateState,
} from "./action-plan";
import { mergeStepResults } from "./message-envelope";
import type { EmitIntent } from "./emit-select";
import {
  actionErrorFacts,
  classifyActionFailure,
  failureForDisposition,
  type ActionFailureResolution,
  type RuntimeOnErrorPolicy,
} from "./error-policy";
import {
  isSandboxTenant,
  sandboxToolMode,
  sandboxToolStub,
  cassetteLookup,
  toolDispatchDecision,
  factorySandboxDispatchDecision,
  replayFactorySandboxTool,
  recordFactorySandboxLocalDispatch,
  gatedToolMarker,
  injectedFault,
  faultResult,
  type FactorySandboxExecutionScope,
  type FactorySandboxReplayRef,
  type FactorySandboxDispatchReceipt,
} from "./sandbox-mode";
import type {
  ChatContentBlock,
  ChatMessage,
  ToolDef,
  ToolUseBlock,
  ToolResultBlock,
} from "@agentic/llm-gateway";
import { parseStructuredJson } from "./structured-output";
import { writeArtifact } from "./artifacts";
import {
  evaluateDecisionTable,
  materializeInvokePayload,
} from "@agentic/shared";
import { makeCodeActExecutionReceipt } from "./codeact-receipt";
import { createHash } from "node:crypto";
import {
  revalidateProductionCodeActCapability,
  type ProductionCodeActCapability,
} from "./production-codeact-authorization";

/**
 * Canonical tool-use entry on an AgentSpec (matches the Zod
 * `ToolUseEntrySchema` in manifest.ts). Only `name` is mandatory — when
 * `input_schema` is absent we synthesise a permissive object schema so the
 * gateway can still hand the tool to the model.
 */
export interface ToolUseEntry {
  name: string;
  /** Historical documentation only. Sandbox authorization does not read it. */
  side_effect?: "read" | "write" | "dual" | "call";
  execution_policy?: {
    operation: ToolOperation;
    effect_scope: ToolEffectScope;
    sandbox_policy: ToolSandboxPolicy;
  };
  description?: string;
  input_schema?: unknown;
  config?: Record<string, unknown>;
}

function declaredExecutionPolicy(
  entry: ToolUseEntry | undefined,
): ToolExecutionPolicy | undefined {
  const declared = entry?.execution_policy;
  return declared
    ? {
        operation: declared.operation,
        effectScope: declared.effect_scope,
        sandboxPolicy: declared.sandbox_policy,
      }
    : undefined;
}

function reviewedExecutionPolicy(
  name: string,
  entry: ToolUseEntry | undefined,
  useGlobalMetadata: boolean,
): ToolExecutionPolicy | undefined {
  const declared = declaredExecutionPolicy(entry);
  const catalog = useGlobalMetadata ? globalToolExecutionPolicy(name) : undefined;
  if (catalog && declared && !toolExecutionPoliciesEqual(catalog, declared)) {
    throw new Error(
      `tool '${name}' execution_policy conflicts with current reviewed registry metadata`,
    );
  }
  return catalog ?? declared;
}

interface AgentSlots {
  id?: string;
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
  factoryDomainId?: string;
  /** Server-authored sandbox identity + profile provenance. A tool config or
   * generated handler cannot manufacture this pair at dispatch time. */
  factoryExecutionScope?: FactorySandboxExecutionScope | {
    kind: "production";
    target_domain_id?: string;
  };
  factoryToolProfileRefs?: Record<string, string>;
  /** Server-authored, attempt-bound cassette hashes for external tools. */
  factoryToolReplayRefs?: Record<string, FactorySandboxReplayRef>;
  /** #G — true CodeAct: execute `typescriptCode` in the worker isolate. Sandbox is allowed by
   * default; production additionally requires an exact code attestation. Failure never falls back. */
  codeExecuted?: boolean;
  typescriptCode?: string;
  /** Exact production execution attestation. Absent means production code execution is forbidden. */
  codeAttestation?: {
    allow_production?: boolean;
    expected_sha256?: string;
  };
  factoryPromotionVersionId?: string;
  factoryRegressionSuiteFingerprint?: string;
  /** Process-local authority minted only after durable promotion/evidence
   * verification. A manifest-shaped object never satisfies this identity. */
  productionCodeActCapability?: ProductionCodeActCapability;
  productionCodeActManifestSha256?: string;
  productionCodeActWorkflowManifestSha256?: string;
  /** Declared downstream event allow-list. Required by explicit `emit` actions. */
  triggeredEvents?: string[];
}

interface ActionToolBoundary {
  /** `false` is the legacy hand-written-manifest compatibility path. */
  explicit: boolean;
  agentAllowed: string[];
  actionAllowed: string[];
  effective: string[];
}

function resolveActionToolBoundary(
  action: Pick<ActionSpec, "allowed_tools">,
  agent?: AgentSlots,
): ActionToolBoundary {
  const agentAllowed = [
    ...new Set(
      (agent?.tool_use ?? [])
        .map((entry) => entry.name.trim())
        .filter(Boolean),
    ),
  ];
  if (action.allowed_tools === undefined) {
    return {
      explicit: false,
      agentAllowed,
      actionAllowed: agentAllowed,
      effective: agentAllowed,
    };
  }
  const actionAllowed = [
    ...new Set(action.allowed_tools.map((name) => name.trim()).filter(Boolean)),
  ];
  const actionSet = new Set(actionAllowed);
  return {
    explicit: true,
    agentAllowed,
    actionAllowed,
    effective: agentAllowed.filter((name) => actionSet.has(name)),
  };
}

function hasVerifiedSandboxProfile(
  agent: AgentSlots | undefined,
  toolName: string,
): boolean {
  return agent?.factoryExecutionScope?.kind === "sandbox"
    && typeof agent.factoryToolProfileRefs?.[toolName] === "string"
    && agent.factoryToolProfileRefs[toolName]!.trim().length > 0;
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
  return Number.isFinite(n) && n > 0
    ? Math.floor(n)
    : MAX_TOOL_USE_ITERS_DEFAULT;
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
  /** Optional step-safe host bindings for generated-code RPC. Production `invoke` must be supplied
   * by a durable caller; missing bindings fail the generated-code run rather than returning null. */
  generatedCodeHostRuntime?: GeneratedCodeHostRuntime;
  /** Trusted CodeAct executor seam used by focused tests. Production resolves
   * the Docker socket transport inside runGeneratedCodeIsolated. */
  generatedCodeContainerTransport?: CodeActDockerTransport;
  generatedCodeCandidateImage?: string;
  /** Durable orchestration primitives supplied by register.ts for actions
   * nested under foreach. A container is interpreted recursively, while each
   * leaf side effect receives a content-addressed step id. */
  durableActionRuntime?: {
    run(stepId: string, operation: () => Promise<StepOutput>): Promise<StepOutput>;
    invoke(args: {
      stepId: string;
      target: string;
      input: Record<string, unknown>;
      timeoutMs?: number;
    }): Promise<unknown>;
  };
  /** Stable parent identity for a nested foreach/invoke action. */
  durableStepId?: string;
  /** Internal absolute deadline inherited from a durable foreach parent. */
  deadlineAt?: number;
  /** Internal resolved budget supplied by the public timeout wrapper. */
  resolvedTimeoutMs?: number;
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
          error: "schema_mismatch",
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
  action?: ActionSpec,
  jsonMode = false,
): Promise<{
  text: string;
  tokensIn: number;
  tokensOut: number;
  provider: string;
  model: string;
  toolCalls: ToolCallTrace[];
  turns: LlmTurnTrace[];
  terminalError?: string;
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

  // Build the action-scoped ToolDef[] roster ONCE per logic action. Every tool
  // in the effective agent/action intersection must resolve before the model
  // runs; tools outside that intersection are neither advertised nor callable.
  const tools: ToolDef[] = [];
  const boundary = resolveActionToolBoundary(action ?? {}, agent);
  const effectiveToolAllowlist = new Set(boundary.effective);
  const effectiveToolEntries = (agent?.tool_use ?? []).filter((entry) =>
    effectiveToolAllowlist.has(entry.name.trim()),
  );
  if (effectiveToolEntries.length > 0) {
    for (const entry of effectiveToolEntries) {
      // Tenant tool wins; for GENERATED agents, fall back to the global registry so their roster
      // (ontology.fetchActionRules, fs.*, …) is actually advertised to the model. Hand-authored
      // tenants keep the strict tenant-only behaviour.
      const handler =
        tenantRegistry?.tools?.[entry.name] ??
        (agent?.generated ? globalToolRegistry.get(entry.name) : undefined);
      if (!handler) {
        throw new Error(
          `agent ${agent?.name ?? "unknown"} declares unresolved tool ${entry.name}; refusing to run with a silently reduced tool roster`,
        );
      }
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
  let terminalError: string | undefined;

  for (let iter = 0; iter < maxIters; iter++) {
    // #ACI (P1-8) — collapse tool outputs older than the last N rounds to one line before每轮调用
    // （SWE-agent实测：只留最近5条完整观察优于全量历史 +3.0pp；折叠幂等，标记可见不装没发生）。
    foldOldToolResults(messages as Array<{ role: string; content: unknown }>);
    const response = await gateway.chat({
      messages,
      model: preferredModel,
      tools: tools.length > 0 ? tools : undefined,
      jsonMode,
      signal: ctx?.signal,
      tenantId: ctx?.tenantId,
      runId: ctx?.runId,
      tenantSlug: ctx?.tenantSlug,
      purpose: ctx
        ? `agent:${ctx.agentName}/step:${ctx.actionName}`
        : "step-engine",
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
    if (agent?.generated || boundary.explicit) {
      const forbidden = [
        ...new Set(
          requestedCalls
            .map((call) => call.name.trim())
            .filter((name) => !effectiveToolAllowlist.has(name)),
        ),
      ];
      if (forbidden.length) {
        terminalError = boundary.explicit
          ? `[action_tool_not_allowed] Action「${ctx?.actionName ?? "unknown"}」请求了不在 agent.tool_use 与 action.allowed_tools 交集内的工具：${forbidden.join("、")}；已拒绝执行。` +
            `当前 Action 允许：${boundary.actionAllowed.length ? [...boundary.actionAllowed].sort().join("、") : "（无）"}；Agent 允许：${boundary.agentAllowed.length ? [...boundary.agentAllowed].sort().join("、") : "（无）"}`
          : `[generated_tool_not_declared] 生成 Agent「${agent?.name ?? "unknown"}」请求了未在不可变 agent.tool_use 中声明的工具：${forbidden.join("、")}；已拒绝执行。` +
            `允许工具：${effectiveToolAllowlist.size ? [...effectiveToolAllowlist].sort().join("、") : "（无）"}`;
        break;
      }
    }
    if (requestedCalls.length === 0) {
      // Model returned prose — we're done.
      finalText = response.text;
      if (!finalText.trim()) {
        terminalError = `provider ${response.provider}/${response.model} returned an empty final response`;
      }
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
    messages.push({ role: "assistant", content: assistantBlocks });

    // Execute each tool call, collect tool_result blocks for the next turn.
    const resultBlocks: ChatContentBlock[] = [];
    for (const call of requestedCalls) {
      // Resolution chain: tenant override → global registry → not found.
      // Tenant wins on collision so a tenant can ship a custom impl that
      // shadows a global tool. The MCP layer already folds its tools into
      // tenantRegistry under namespaced names ("<server>.<tool>"), so it's
      // covered by the first lookup.
      const tenantHandler = tenantRegistry?.tools?.[call.name];
      const globalHandler = tenantHandler
        ? undefined
        : globalToolRegistry.get(call.name);
      const handler = tenantHandler ?? globalHandler;

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
        ontologyActionName: ctx?.ontologyActionName,
        subject: ctx?.subject,
        correlationId: ctx?.correlationId ?? "no-correlation",
        signal: ctx?.signal,
        runId: ctx?.runId,
        tenantSlug: ctx?.tenantSlug ?? "unknown",
        tenantId: ctx?.tenantId,
        event: ctx?.event,
        // Each tool sees the prior tool's output as lastResult — gives the
        // model the option to chain without re-quoting state through the prompt.
        lastResult:
          toolCalls.length > 0
            ? toolCalls[toolCalls.length - 1]!.output
            : ctx?.lastResult,
        config: toolConfig,
        memory: ctx?.memory, // #P0-1 — durable memory reaches each tool in the tool-use loop
      };

      const startedAt = Date.now();
      let outputBody: string;
      let isError = false;
      let outputData: unknown = null;
      let sandboxDispatch: FactorySandboxDispatchReceipt | undefined;
      try {
        if (!handler) {
          throw new Error(
            `tool '${call.name}' not registered for this tenant and not found in global registry`,
          );
        }
        // #REDESIGN P1b — the LLM tool-use loop must honour sandbox gating too (not just the
        // type:"tool" plan path): in a `-sb` tenant, READS run live, external WRITES are gated
        // (marker, not fired) unless a server-owned attempt grant exists; mock/replay short-circuit.
        const reviewedPolicy = reviewedExecutionPolicy(
          call.name,
          toolUseEntry,
          !!globalHandler,
        );
        const factoryDecision = factorySandboxDispatchDecision(
          reviewedPolicy,
          callCtx.tenantSlug,
          agent?.factoryExecutionScope,
        );
        const sbDecision = factoryDecision ?? (isSandboxTenant(callCtx.tenantSlug)
          ? toolDispatchDecision(
              reviewedPolicy,
              sandboxToolMode(),
              {
                sandboxProfileVerified: hasVerifiedSandboxProfile(agent, call.name),
              },
            )
          : "live");
        if (sbDecision === "reject") {
          throw new Error(
            `tool '${call.name}' is missing valid reviewed execution_policy metadata`,
          );
        }
        if (factoryDecision === "replay") {
          const scope = agent?.factoryExecutionScope;
          if (!scope || scope.kind !== "sandbox" || !reviewedPolicy) {
            throw new Error(`factory sandbox replay scope is missing for tool '${call.name}'`);
          }
          const replayed = await replayFactorySandboxTool({
            scope,
            tenantSlug: callCtx.tenantSlug!,
            toolName: call.name,
            toolArgs: call.input,
            policy: reviewedPolicy,
            replayRef: agent.factoryToolReplayRefs?.[call.name],
          });
          outputData = replayed.body;
          sandboxDispatch = replayed.receipt;
          const faultLoop = injectedFault(ctx?.event?.data, call.name);
          if (faultLoop) outputData = faultResult(call.name, faultLoop.kind);
          outputBody = stringifyToolPayload(outputData);
        } else if (sbDecision !== "live") {
          const replayed =
            sbDecision === "replay"
              ? await cassetteLookup(callCtx.tenantSlug!, call.name, call.input)
              : undefined;
          if (sbDecision === "replay" && replayed === undefined) {
            throw new Error(
              `No replay cassette exists for tool '${call.name}'`,
            );
          }
          outputData =
            sbDecision === "gate_profile"
              ? gatedToolMarker(call.name, call.input, "sandbox_profile")
              : sbDecision === "gate_grant"
                ? gatedToolMarker(call.name, call.input, "requires_attempt_grant")
              : (replayed ?? sandboxToolStub(call.name));
          const faultLoop = injectedFault(ctx?.event?.data, call.name); // #W3-FAULT — poisoned tool in the LLM loop
          if (faultLoop) outputData = faultResult(call.name, faultLoop.kind);
          // #W1-9 — make the sandbox decision VISIBLE in the artifact: a mocked/gated call must never
          // read like a real one in the run trace.
          if (outputData && typeof outputData === "object")
            (outputData as Record<string, unknown>).__sbDecision = sbDecision;
          outputBody = stringifyToolPayload(outputData);
        } else {
          if (factoryDecision === "live") {
            const scope = agent?.factoryExecutionScope;
            if (!scope || scope.kind !== "sandbox" || !reviewedPolicy) {
              throw new Error(`factory sandbox local scope is missing for tool '${call.name}'`);
            }
            sandboxDispatch = await recordFactorySandboxLocalDispatch({
              scope,
              tenantSlug: callCtx.tenantSlug!,
              toolName: call.name,
              toolArgs: call.input,
              policy: reviewedPolicy,
            });
          }
          // Merge the model's tool-call input into the context so handlers
          // that prefer args over ctx.event.data have a single read site.
          const handlerCtx = {
            ...callCtx,
            event: { name: `tool:${call.name}`, data: call.input },
          };
          const r = await handler.handler(handlerCtx);
          if (handler.output) {
            const parsed = handler.output.safeParse(r.data);
            if (!parsed.success) {
              throw new Error(
                `tool '${call.name}' returned data that violates its output schema: ${JSON.stringify(parsed.error.issues)}`,
              );
            }
            outputData = parsed.data;
          } else {
            outputData = r.data;
          }
          outputBody = stringifyToolPayload(outputData);
          totalIn += r.tokensIn ?? 0;
          totalOut += r.tokensOut ?? 0;
        }
      } catch (err) {
        isError = true;
        const error = String(err instanceof Error ? err.message : err);
        // Never retain an unserialisable value as if it were a successful
        // observation.  The trace and the model both receive the same
        // explicit error receipt.
        outputData = { error };
        outputBody = JSON.stringify(outputData);
      }
      toolCalls.push({
        id: call.id,
        name: call.name,
        input: call.input,
        output: outputData,
        isError,
        durationMs: Date.now() - startedAt,
        ...(sandboxDispatch ? { sandboxDispatch } : {}),
      });

      // #ACI (P1-8) — window the observation + make empty success EXPLICIT (silence otherwise
      // reads as failure and triggers pointless retries; SWE-agent ships the same receipt).
      const windowed = windowToolOutput(outputBody);
      const resultBlock: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: call.id,
        content: windowed.trim()
          ? windowed
          : JSON.stringify({ ok: !isError, note: "（调用成功，无输出）" }),
        is_error: isError || undefined,
      };
      resultBlocks.push(resultBlock);
    }
    messages.push({ role: "tool", content: resultBlocks });

    // Final iteration safety: never turn an unfinished tool loop into
    // synthetic prose that the caller can mistake for a successful answer.
    if (iter === maxIters - 1) {
      terminalError = `tool-use loop hit max ${maxIters} iterations without a final model response`;
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
    terminalError,
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
  } catch (error) {
    return {
      _unserializable: true,
      _error: String(error instanceof Error ? error.message : error),
    };
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
      else if (b?.type === "redacted_thinking")
        parts.push("[redacted thinking]");
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
  sandboxDispatch?: FactorySandboxDispatchReceipt;
}

function isPlainSchema(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringifyToolPayload(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch (error) {
    throw new TypeError(
      `tool output is not JSON-serializable: ${String(
        error instanceof Error ? error.message : error,
      )}`,
    );
  }
}

// #ACI (P1-8, SWE-agent arXiv 2405.15793) — tool-output windowing + history folding.
// Measured on SWE-bench: capped observation windows beat both "too little" (-3.7pp) and "full
// output" (-5.3pp); collapsing all but the last 5 observations to one line beats full history
// by +3.0pp; an EXPLICIT "ran successfully, no output" receipt prevents the model misreading
// silence as failure. Ported to the payload sizes of our JSON tool results (char-based window).
const TOOL_OUTPUT_WINDOW = Math.max(
  2000,
  Number(process.env.AGENTIC_TOOL_OUTPUT_WINDOW) || 8000,
);
const TOOL_HISTORY_KEEP = Math.max(
  1,
  Number(process.env.AGENTIC_TOOL_HISTORY_KEEP) || 5,
);
const FOLD_MARK = "…[已折叠的早期工具输出 — 只保留首行]";

/** Cap one tool output at the window: keep head + tail with an explicit truncation marker
 *  (the marker names the elided size, so the model KNOWS it is looking at a window). */
export function windowToolOutput(
  body: string,
  window = TOOL_OUTPUT_WINDOW,
): string {
  if (body.length <= window) return body;
  const head = Math.floor(window * 0.7);
  const tail = Math.max(0, window - head);
  return `${body.slice(0, head)}\n…[输出截断：省略 ${body.length - window} 字符——需要更多请用更具体的参数重新调用]…\n${body.slice(body.length - tail)}`;
}

/** Fold tool_result blocks OLDER than the last `keep` tool rounds down to their first line.
 *  Idempotent (folded blocks start with FOLD_MARK). Mutates in place — messages are loop-local. */
export function foldOldToolResults(
  messages: Array<{ role: string; content: unknown }>,
  keep = TOOL_HISTORY_KEEP,
): void {
  const toolIdxs: number[] = [];
  for (let i = 0; i < messages.length; i++)
    if (messages[i]!.role === "tool") toolIdxs.push(i);
  const foldUpto = toolIdxs.length - keep;
  for (let k = 0; k < foldUpto; k++) {
    const m = messages[toolIdxs[k]!]!;
    if (!Array.isArray(m.content)) continue;
    for (const blk of m.content as Array<{
      type?: string;
      content?: unknown;
    }>) {
      if (blk?.type !== "tool_result" || typeof blk.content !== "string")
        continue;
      if (blk.content.startsWith(FOLD_MARK) || blk.content.length <= 160)
        continue;
      blk.content = `${FOLD_MARK} ${blk.content.slice(0, 140).split("\n")[0]}…`;
    }
  }
}

async function runTenantPrompt(
  ctx: ToolContext,
  prompt: PromptDescriptor,
  action: ActionSpec,
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
    action,
    !!prompt.output,
  );
  const sandboxDispatches = result.toolCalls.flatMap((call) =>
    call.sandboxDispatch ? [call.sandboxDispatch] : []);
  if (result.terminalError) {
    return {
      ok: false,
      type: "logic",
      data: null,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      model: result.model,
      provider: result.provider,
      meta: {
        error: "llm_incomplete",
        message: result.terminalError,
        prompt: prompt.name,
        provider: result.provider,
        model: result.model,
        tenant: true,
        toolCalls: result.toolCalls,
        sandboxDispatches,
        turns: result.turns,
      },
    };
  }
  let validated: unknown = result.text;
  if (prompt.output) {
    try {
      const json = parseStructuredJson(result.text);
      const parsed = prompt.output.safeParse(json);
      if (!parsed.success) {
        return {
          ok: false,
          type: "logic",
          data: result.text,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          model: result.model,
          provider: result.provider,
          meta: {
            error: "prompt_output_schema_mismatch",
            schemaError: parsed.error.issues,
            prompt: prompt.name,
            provider: result.provider,
            model: result.model,
            toolCalls: result.toolCalls,
            sandboxDispatches,
            turns: result.turns,
          },
        };
      }
      validated = parsed.data;
    } catch (err) {
      return {
        ok: false,
        type: "logic",
        data: result.text,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        model: result.model,
        provider: result.provider,
        meta: {
          error: "prompt_output_invalid_json",
          message: err instanceof Error ? err.message : String(err),
          prompt: prompt.name,
          provider: result.provider,
          model: result.model,
          toolCalls: result.toolCalls,
          sandboxDispatches,
          turns: result.turns,
        },
      };
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
      sandboxDispatches,
      // #W0 — raw per-turn LLM capture (response text + reasoning + requested
      // tools). register.ts persists this to `llm_turns` when capture is on.
      turns: result.turns,
    },
  };
}

function invokePayload(
  action: ActionSpec,
  ctx: ToolContext,
): Record<string, unknown> {
  const a = action as ActionSpec & {
    invoke_input?: Record<string, unknown>;
    forward_last_result?: boolean;
    forward_results?: boolean;
  };
  return materializeInvokePayload({
    eventData: ctx.event?.data,
    invokeInput: a.invoke_input,
    forwardLastResult: a.forward_last_result,
    forwardResults: a.forward_results,
    lastResult: ctx.lastResult,
    results: ctx.results,
    subject: ctx.subject,
    correlationId: ctx.correlationId,
  });
}

function failureEmitIntent(resolution: ActionFailureResolution): EmitIntent | undefined {
  if (!resolution.emitEvent) return undefined;
  const fallback =
    resolution.defaultResult &&
    typeof resolution.defaultResult === "object" &&
    !Array.isArray(resolution.defaultResult)
      ? (resolution.defaultResult as Record<string, unknown>)
      : { error: resolution.facts };
  return {
    event: resolution.emitEvent,
    payload: { ...fallback, ...(resolution.emitPayload ?? {}) },
  };
}

function classifyNestedActionFailure(
  action: ActionSpec,
  failure: unknown,
): ActionFailureResolution {
  const inherited = (
    failure as {
      output?: { meta?: { failureResolution?: unknown } };
    } | null
  )?.output?.meta?.failureResolution;
  if (
    action.on_error === undefined &&
    inherited &&
    typeof inherited === "object" &&
    !Array.isArray(inherited)
  ) {
    return inherited as ActionFailureResolution;
  }
  return classifyActionFailure({
    policy: action.on_error as RuntimeOnErrorPolicy,
    failure,
    defaultResult: Object.prototype.hasOwnProperty.call(action, "default_result")
      ? action.default_result
      : action.on_error === "soft"
        ? null
        : undefined,
  });
}

async function runActionCore(input: StepInput): Promise<StepOutput> {
  const { ctx, action, tenantRegistry, agent, runId, stepOrd } = input;

  // Optional ad-hoc artifact contract: persist input before any provider/tool
  // can run. The durable register.ts path writes its own richer input ref and
  // therefore leaves these arguments unset.
  if (runId && typeof stepOrd === "number") {
    await writeArtifact(runId, `step-${stepOrd}-input.json`, {
      action: action.name,
      type: action.type,
      ctx,
      agent: agent
        ? { name: agent.name, description: agent.description }
        : undefined,
    });
  }

  let result: StepOutput;
  switch (action.type) {
    case "decision": {
      if (!action.decision_table) {
        result = {
          ok: false,
          type: "decision",
          data: { __error: "decision_table_missing" },
          meta: { error: "decision_table_missing" },
        };
        break;
      }
      const decision = evaluateDecisionTable(action.decision_table, {
        input: ctx.event?.data ?? {},
        event: ctx.event ?? {},
        lastResult: ctx.lastResult,
        results: ctx.results ?? {},
      });
      result = {
        ok: true,
        type: "decision",
        data: {
          ...(decision.payload ?? {}),
          outcome: decision.outcome,
          decision_table: decision.tableId,
          decision_row: decision.rowId,
          ...(decision.emitEvent ? { _emit: decision.emitEvent } : {}),
        },
        meta: {
          decisionTable: decision.tableId,
          decisionRow: decision.rowId,
          matched: decision.matched,
        },
      };
      break;
    }
    case "tool": {
      const boundary = resolveActionToolBoundary(action, agent);
      if (
        boundary.explicit &&
        (
          boundary.actionAllowed.length !== 1 ||
          boundary.actionAllowed[0] !== action.name ||
          !boundary.effective.includes(action.name)
        )
      ) {
        result = {
          ok: false,
          type: "tool",
          data: {
            __error: "action_tool_not_allowed",
            tool: action.name,
            message: `工具 Action「${action.name}」只能调用自身，且该工具必须同时存在于 agent.tool_use。`,
          },
          meta: {
            error: "action_tool_not_allowed",
            tool: action.name,
            actionAllowedTools: boundary.actionAllowed,
            agentAllowedTools: boundary.agentAllowed,
          },
        };
        break;
      }
      const dataflowAction = action as ActionSpec & {
        tool_arguments?: Record<string, { from: string; required?: boolean } | { const: unknown }>;
      };
      const materializedArguments = dataflowAction.tool_arguments
        ? materializeToolArguments(dataflowAction.tool_arguments, {
            event: ctx.event,
            input: ctx.event?.data,
            lastResult: ctx.lastResult,
            results: ctx.results,
            locals: ctx.locals,
          })
        : null;
      if (materializedArguments && !materializedArguments.ok) {
        result = {
          ok: false,
          type: "tool",
          data: null,
          meta: {
            error: "tool_arguments_unresolved",
            detail: materializedArguments.error,
            argument: materializedArguments.argument,
            path: materializedArguments.path,
            tool: action.name,
            argumentMode: "explicit",
          },
        };
        break;
      }
      const invocationCtx: ToolContext = materializedArguments?.ok
        ? {
            ...ctx,
            event: {
              name: ctx.event?.name ?? "generated-plan.tool",
              data: materializedArguments.args,
            },
            // An explicit mapping is also a capability/data-minimisation
            // boundary. The handler receives the selected arguments, not a
            // second implicit route to the entire preceding carry.
            lastResult: undefined,
            results: undefined,
            locals: undefined,
          }
        : ctx;
      // Resolve the handler and its reviewed side-effect metadata before the
      // sandbox boundary. Policy is based on metadata, never on the tool name.
      const tenantTool = tenantRegistry?.tools?.[action.name];
      const globalTool = !tenantTool
        ? globalToolRegistry.get(action.name)
        : undefined;
      const toolUseEntry = agent?.tool_use?.find(
        (entry) => entry.name === action.name,
      );
      // Generated plans share the exact same immutable capability boundary as
      // CodeAct and the LLM tool loop. Hand-written agents retain their
      // historical tenant/global resolution behaviour.
      if (
        agent?.generated &&
        !(agent.tool_use ?? []).some((entry) => entry.name === action.name)
      ) {
        result = {
          ok: false,
          type: "tool",
          data: {
            __error: "generated_tool_not_declared",
            tool: action.name,
            message: `生成 Agent「${agent.name ?? ctx.agentName}」的计划请求了未在不可变 agent.tool_use 中声明的工具「${action.name}」；已拒绝执行。`,
          },
          meta: {
            error: "generated_tool_not_declared",
            tool: action.name,
            declaredTools: (agent.tool_use ?? []).map((entry) => entry.name),
          },
        };
        break;
      }
      const reviewedPolicy = reviewedExecutionPolicy(
        action.name,
        toolUseEntry,
        !!globalTool,
      );
      const factoryDecision = factorySandboxDispatchDecision(
        reviewedPolicy,
        ctx.tenantSlug,
        agent?.factoryExecutionScope,
      );
      let sandboxLocalDispatch: FactorySandboxDispatchReceipt | undefined;
      // T3 — sandbox interception: in the isolated `-sb` tenant, a Phase-1 `type:"tool"` step calls
      // the real handler directly (no LLM in the loop), so without this it would hit RoboHire/etc.
      // for real. Tests may use mock/replay; production accepts gated/live only.
      if (isSandboxTenant(ctx.tenantSlug)) {
        // #W3-FAULT — an injected fault (from a kind:"fault" test case's __fault payload marker) beats
        // every dispatch mode: return a failing result so the step's onError policy is EXERCISED.
        const fault = injectedFault(ctx.event?.data, action.name);
        if (fault) {
          result = {
            ok: false,
            type: "tool",
            data: faultResult(action.name, fault.kind),
            meta: {
              tool: action.name,
              sandbox: true,
              injectedFault: fault.kind,
            },
          };
          break;
        }
        const mode = factoryDecision === null ? sandboxToolMode() : "evidence_replay";
        const decision = factoryDecision ?? toolDispatchDecision(
          reviewedPolicy,
          sandboxToolMode(),
          { sandboxProfileVerified: hasVerifiedSandboxProfile(agent, action.name) },
        );
        if (decision === "reject") {
          result = {
            ok: false,
            type: "tool",
            data: {
              __error: `tool '${action.name}' is missing valid reviewed execution_policy metadata`,
            },
            meta: {
              tool: action.name,
              sandbox: true,
              toolMode: mode,
              decision,
            },
          };
          break;
        }
        if (factoryDecision === "replay") {
          const scope = agent?.factoryExecutionScope;
          const args = (invocationCtx.event?.data ?? {}) as Record<string, unknown>;
          if (!scope || scope.kind !== "sandbox" || !reviewedPolicy) {
            result = {
              ok: false,
              type: "tool",
              data: { __error: `factory sandbox replay scope is missing for tool '${action.name}'` },
              meta: { tool: action.name, sandbox: true, toolMode: mode, decision: "reject" },
            };
            break;
          }
          try {
            const replayed = await replayFactorySandboxTool({
              scope,
              tenantSlug: ctx.tenantSlug!,
              toolName: action.name,
              toolArgs: args,
              policy: reviewedPolicy,
              replayRef: agent.factoryToolReplayRefs?.[action.name],
            });
            result = {
              ok: true,
              type: "tool",
              data: replayed.body,
              meta: {
                tool: action.name,
                sandbox: true,
                toolMode: mode,
                decision: "replay",
                replayed: true,
                sandboxDispatches: [replayed.receipt],
              },
            };
          } catch (error) {
            result = {
              ok: false,
              type: "tool",
              data: { __error: String((error as Error)?.message ?? error) },
              meta: {
                tool: action.name,
                sandbox: true,
                toolMode: mode,
                decision: "replay",
                replayed: false,
              },
            };
          }
          break;
        }
        if (factoryDecision === "live") {
          const scope = agent?.factoryExecutionScope;
          if (!scope || scope.kind !== "sandbox" || !reviewedPolicy) {
            result = {
              ok: false,
              type: "tool",
              data: { __error: `factory sandbox local scope is missing for tool '${action.name}'` },
              meta: { tool: action.name, sandbox: true, toolMode: mode, decision: "reject" },
            };
            break;
          }
          sandboxLocalDispatch = await recordFactorySandboxLocalDispatch({
            scope,
            tenantSlug: ctx.tenantSlug!,
            toolName: action.name,
            toolArgs: invocationCtx.event?.data ?? {},
            policy: reviewedPolicy,
          });
        }
        if (decision !== "live") {
          const args = (invocationCtx.event?.data ?? {}) as Record<string, unknown>;
          const replayed =
            decision === "replay"
              ? await cassetteLookup(ctx.tenantSlug!, action.name, args)
              : undefined;
          if (decision === "replay" && replayed === undefined) {
            result = {
              ok: false,
              type: "tool",
              data: {
                __error: `No replay cassette exists for tool '${action.name}'`,
              },
              meta: {
                tool: action.name,
                sandbox: true,
                toolMode: mode,
                decision,
                replayed: false,
              },
            };
            break;
          }
          result = {
            ok: true,
            type: "tool",
            data:
              decision === "gate_profile"
                ? gatedToolMarker(action.name, args, "sandbox_profile")
                : decision === "gate_grant"
                  ? gatedToolMarker(action.name, args, "requires_attempt_grant")
                : (replayed ?? sandboxToolStub(action.name)),
            meta: {
              tool: action.name,
              sandbox: true,
              toolMode: mode,
              decision,
              replayed: replayed !== undefined,
            },
          };
          break;
        }
      }
      // Same resolution chain as the LLM tool-use loop: tenant override
      // → global registry. An unresolved name fails closed; there is no
      // name-guessing or synthetic success path.
      if (tenantTool || globalTool) {
        // Look up matching tool_use[] entry by action name so per-tenant
        // config flows the same way it does in the LLM tool-use loop.
        // tenant-test1's writeWorkflowLog (a `type: "tool"` action with
        // no LLM loop) relies on this path to receive its subdir/filename
        // binding from the manifest.
        const toolConfig =
          toolUseEntry && typeof toolUseEntry === "object"
            ? ((toolUseEntry as { config?: Record<string, unknown> }).config ??
              undefined)
            : undefined;
        const enrichedCtx: ToolContext = toolConfig
          ? { ...invocationCtx, config: toolConfig }
          : invocationCtx;
        result = await runTenantTool(enrichedCtx, (tenantTool ?? globalTool)!);
        if (sandboxLocalDispatch) {
          result.meta = {
            ...result.meta,
            sandbox: true,
            toolMode: "evidence_replay",
            decision: "live",
            sandboxDispatches: [sandboxLocalDispatch],
          };
        }
      } else {
        result = {
          ok: false,
          type: "tool",
          data: {
            __error: `工具「${action.name}」未注册（tenant/global 都没有）——生产不使用假桩兜底。请为该动作绑定真实工具或补进工具库。`,
          },
          meta: { tool: action.name, unresolved: true },
        };
      }
      break;
    }
    case "logic": {
      const tenantPrompt = tenantRegistry?.prompts?.[action.name];
      // A codeExecuted claim is authoritative: execute the exact bytes in the
      // worker isolate or fail this step. There is no declarative/LLM fallback.
      // Sandbox tenants use their attempt-scoped gate. Production requires an
      // opaque capability minted from durable promotion evidence; manifest
      // allow/hash fields are descriptive and are never execution authority.
      if (agent?.generated && agent.codeExecuted) {
        if (!agent.typescriptCode) {
          const codeExecutionReceipt = makeCodeActExecutionReceipt({
            codeExecuted: false,
            codeRan: false,
            isolation: null,
            codeSha256: null,
            attestation: "not_checked",
            durationMs: 0,
            failure: "empty_code",
          });
          result = {
            ok: false,
            type: "logic",
            data: null,
            meta: {
              error: "generated_code_missing",
              codeExecuted: false,
              isolation: null,
              codeAttestation: "not_checked",
              codeExecutionReceipt,
            },
          };
          break;
        }

        const codeSha256 = createHash("sha256")
          .update(agent.typescriptCode, "utf8")
          .digest("hex");
        const sandboxCodeAct = isSandboxTenant(ctx.tenantSlug);
        const productionClaims =
          !sandboxCodeAct &&
          ctx.tenantId &&
          agent.id &&
          agent.factoryDomainId &&
          agent.factoryPromotionVersionId &&
          agent.factoryRegressionSuiteFingerprint
          && agent.productionCodeActManifestSha256
          && agent.productionCodeActWorkflowManifestSha256
            ? await revalidateProductionCodeActCapability(
                agent.productionCodeActCapability,
                {
                  executionKind: "codeact",
                  tenantId: ctx.tenantId,
                  tenantSlug: ctx.tenantSlug,
                  domainId: agent.factoryDomainId,
                  agentSlug: agent.id,
                  promotionVersionId: agent.factoryPromotionVersionId,
                  regressionSuiteFingerprint:
                    agent.factoryRegressionSuiteFingerprint,
                  codeSha256,
                  agentManifestSha256:
                    agent.productionCodeActManifestSha256,
                  workflowManifestSha256:
                    agent.productionCodeActWorkflowManifestSha256,
                },
              )
            : null;
        if (!sandboxCodeAct && !productionClaims) {
          const codeExecutionReceipt = makeCodeActExecutionReceipt({
            codeExecuted: false,
            codeRan: false,
            isolation: null,
            codeSha256,
            attestation: "not_authorized",
            durationMs: 0,
            failure: "production_not_authorized",
          });
          result = {
            ok: false,
            type: "logic",
            data: null,
            meta: {
              // Preserve the historical top-level code for callers while the
              // structured receipt carries the precise durable denial.
              error: "generated_code_requires_sandbox",
              denialReason: "durable_production_authorization_missing",
              codeExecuted: false,
              isolation: null,
              codeSha256,
              codeAttestation: "not_authorized",
              tenantSlug: ctx.tenantSlug,
              codeExecutionReceipt,
            },
          };
          break;
        }

        const codeToolBoundary = resolveActionToolBoundary(action, agent);
        const declaredCodeTools = codeToolBoundary.effective;
        const declaredCodeToolSet = new Set(declaredCodeTools);
        const unresolvedCodeTools = declaredCodeTools.filter(
          (name) =>
            !tenantRegistry?.tools?.[name] && !globalToolRegistry.get(name),
        );
        if (unresolvedCodeTools.length) {
          const codeExecutionReceipt = makeCodeActExecutionReceipt({
            codeExecuted: false,
            codeRan: false,
            isolation: null,
            codeSha256: null,
            attestation: "not_checked",
            durationMs: 0,
            failure: "generated_tool_configuration_missing",
          });
          result = {
            ok: false,
            type: "logic",
            data: null,
            meta: {
              error: "generated_tool_configuration_missing",
              codeExecuted: false,
              missingTools: unresolvedCodeTools,
              message: `生成 Agent「${agent.name ?? ctx.agentName}」声明的工具尚未注册/配置：${unresolvedCodeTools.join("、")}；代码未启动。`,
              codeExecutionReceipt,
            },
          };
          break;
        }

        const configuredHost = input.generatedCodeHostRuntime;
        const productionTool = async (
          name: string,
          args?: unknown,
        ): Promise<unknown> => {
          if (!declaredCodeToolSet.has(name)) {
            throw new Error(
              `[action_tool_not_allowed] generated-code tool '${name}' is outside the current action capability boundary`,
            );
          }
          const tenantTool = tenantRegistry?.tools?.[name];
          const globalTool = tenantTool
            ? undefined
            : globalToolRegistry.get(name);
          const descriptor = tenantTool ?? globalTool;
          if (!descriptor)
            throw new Error(`generated-code tool '${name}' is not registered`);
          const toolUse = agent.tool_use?.find((entry) => entry.name === name);
          const toolData =
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : { value: args };
          const toolCtx: ToolContext = {
            ...ctx,
            actionName: name,
            event: {
              name: ctx.event?.name ?? "generated-code.tool",
              data: toolData,
            },
            ...(toolUse?.config ? { config: toolUse.config } : {}),
          };
          const toolResult = await runTenantTool(toolCtx, descriptor);
          if (!toolResult.ok) {
            throw new Error(
              `generated-code tool '${name}' failed: ${JSON.stringify(toolResult.meta ?? toolResult.data)}`,
            );
          }
          return toolResult.data;
        };
        // The host binding resolves tenant/global handlers for both targets.
        // In a nonce Factory sandbox, runGeneratedCodeIsolated applies the
        // attempt replay gate before this binding is reachable: external tools
        // never call it, while pure/sandbox_local tools may execute locally.
        const hostRuntime: GeneratedCodeHostRuntime = {
          ...configuredHost,
          tool: configuredHost?.tool ?? productionTool,
        };

        const exec = await runGeneratedCodeIsolated(
          agent.typescriptCode,
          (ctx.event?.data ?? {}) as Record<string, unknown>,
          {
            systemPrompt: agent.ontology_instructions,
            tenantSlug: ctx.tenantSlug,
            tenantId: ctx.tenantId,
            agentName: agent.name ?? ctx.agentName,
            correlationId: ctx.correlationId,
            subject: ctx.subject,
            memory: input.memory,
            runId: input.runId,
            timeoutMs: input.resolvedTimeoutMs,
            production: {
              allowProduction: productionClaims !== null,
              expectedCodeSha256: productionClaims?.codeSha256,
              promotionVersionId: productionClaims?.promotionVersionId,
              regressionSuiteFingerprint:
                productionClaims?.regressionSuiteFingerprint,
            },
            allowedTools: declaredCodeTools,
            toolPolicies: Object.fromEntries(
              (agent.tool_use ?? [])
                .filter((entry) => declaredCodeToolSet.has(entry.name.trim()))
                .flatMap((entry) => {
                  const policy = reviewedExecutionPolicy(
                    entry.name,
                    entry,
                    globalToolRegistry.has(entry.name),
                  );
                  return policy ? [[entry.name, policy] as const] : [];
                }),
            ),
            sandboxProfileVerifiedTools: declaredCodeTools.filter((name) =>
              hasVerifiedSandboxProfile(agent, name)),
            factoryExecutionScope: agent.factoryExecutionScope,
            factoryToolReplayRefs: agent.factoryToolReplayRefs,
            hostRuntime,
            containerTransport: input.generatedCodeContainerTransport,
            candidateImage: input.generatedCodeCandidateImage,
          },
        );
        if (exec.ok) {
          const codeExecutionReceipt = makeCodeActExecutionReceipt({
            codeExecuted: exec.executorStarted,
            codeRan: true,
            isolation: exec.executorStarted ? exec.isolation : null,
            codeSha256: exec.codeSha256,
            attestation: exec.attestation,
            durationMs: exec.durationMs,
            failure: null,
          });
          result = {
            ok: true,
            type: "logic",
            data: exec.data,
            meta: {
              codeExecuted: true,
              emitted: exec.emitted,
              isolation: exec.isolation,
              codeSha256: exec.codeSha256,
              codeAttestation: exec.attestation,
              codeDurationMs: exec.durationMs,
              productionAttested: exec.productionAttested,
              ...(exec.containerEvidence
                ? { containerEvidence: exec.containerEvidence }
                : {}),
              sandboxDispatches: exec.toolDispatches.flatMap((dispatch) =>
                dispatch.receipt ? [dispatch.receipt] : []),
              codeExecutionReceipt,
            },
          };
        } else {
          const productionPolicyDenied =
            exec.failure === "production_not_authorized" ||
            exec.failure === "attestation_missing";
          const codeExecutionReceipt = makeCodeActExecutionReceipt({
            codeExecuted: exec.executorStarted,
            codeRan: false,
            isolation: exec.executorStarted ? exec.isolation : null,
            codeSha256: exec.codeSha256,
            attestation: exec.attestation,
            durationMs: exec.durationMs,
            failure: exec.failure,
          });
          result = {
            ok: false,
            type: "logic",
            data: null,
            meta: {
              // Keep the historical top-level code for an unattested legacy
              // manifest while exposing the precise structured failure below.
              error: productionPolicyDenied
                ? "generated_code_requires_sandbox"
                : exec.failure === "attestation_mismatch"
                  ? "generated_code_attestation_failed"
                  : "generated_code_execution_failed",
              codeExecuted: exec.executorStarted,
              codeExecutionFailure: exec.failure,
              codeExecutionError: exec.error,
              isolation: exec.executorStarted ? exec.isolation : null,
              codeSha256: exec.codeSha256,
              codeAttestation: exec.attestation,
              codeDurationMs: exec.durationMs,
              productionAttested: exec.productionAttested,
              ...(exec.containerEvidence
                ? { containerEvidence: exec.containerEvidence }
                : {}),
              sandboxDispatches: exec.toolDispatches.flatMap((dispatch) =>
                dispatch.receipt ? [dispatch.receipt] : []),
              tenantSlug: ctx.tenantSlug,
              timedOut: exec.timedOut ?? false,
              crashed: exec.crashed ?? false,
              codeExecutionReceipt,
              hint: "The exact generated handler did not complete in its isolate; no declarative fallback was executed.",
            },
          };
        }
      } else if (tenantPrompt) {
        result = await runTenantPrompt(
          ctx,
          tenantPrompt,
          action,
          agent,
          tenantRegistry,
        );
      } else if (agent?.generated) {
        // Declarative generated agent (codeExecuted=false): run its authored
        // ontology instructions through the real gateway.
        result = await runTenantPrompt(
          ctx,
          makeGeneratedAgentPrompt(action.name),
          action,
          agent,
          tenantRegistry,
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
        ok: false,
        type: "manual",
        data: {
          error: "manual_step_requires_durable_runtime",
          note: "manual steps must run through register.ts waitForEvent/task orchestration",
        },
        pendingTaskTitle: action.name,
      };
      break;
    }
    case "condition": {
      // Phase 1a: the real, safe boolean evaluator (action-plan.ts) — supports path
      // comparisons (==/!=/>/</>=/<=), presence, negation, &&/||, plus the legacy
      // `lastResult == null` forms plus named `results.<stepId>` access. Unparseable is a
      // configuration failure (ok:false), never a silent false branch.
      // register.ts consumes `data.evaluated` to SKIP downstream dependsOn steps.
      const condition = (action as { condition?: string }).condition ?? "true";
      const evaluation = evaluateConditionDetailed(condition, {
        lastResult: ctx.lastResult,
        results: ctx.results,
        event: ctx.event,
        input: ctx.event?.data,
        locals: ctx.locals,
      });
      result = {
        // Invalid expressions are configuration defects, not a false business branch. Fail the
        // step closed so the plan cannot silently continue to its default success emit.
        ok: evaluation.valid,
        type: "condition",
        data: {
          evaluated: evaluation.value,
          condition,
          valid: evaluation.valid,
          error: evaluation.error,
        },
        ...(evaluation.valid
          ? {}
          : { meta: { error: "invalid_condition", detail: evaluation.error } }),
      };
      break;
    }
    case "delay": {
      // Durable timers require Inngest's step.sleep and are orchestrated in
      // register.ts. Refuse an ad-hoc in-process timer: setTimeout inside a
      // worker is neither crash-safe nor replay-safe and could otherwise
      // produce a false completion receipt after a restart.
      const ms = (action as { delay_ms?: number }).delay_ms ?? 0;
      result = {
        ok: false,
        type: "delay",
        data: {
          error: "delay_requires_durable_runtime",
          delay_ms: ms,
          note: "delay steps must run through register.ts step.sleep orchestration",
        },
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
        ok: false,
        type: "subflow",
        data: {
          error: "subflow_requires_durable_runtime",
          subflow: a.subflow ?? null,
          subflow_input: a.subflow_input ?? {},
        },
      };
      break;
    }
    case "emit": {
      const a = action as ActionSpec & {
        emit_event?: string;
        emit_payload_from?: string;
        emit_payload?: Record<string, unknown>;
      };
      const event = (a.emit_event ?? "").trim();
      const allow = agent?.triggeredEvents;
      if (!event || (allow && !allow.includes(event))) {
        result = {
          ok: false,
          type: "emit",
          data: null,
          meta: {
            error: !event ? "emit_event_missing" : "emit_event_not_declared",
            event,
            declared: allow ?? [],
          },
        };
        break;
      }
      let selected: unknown = ctx.lastResult;
      if (a.emit_payload_from) {
        const resolved = resolveConditionPath(
          {
            lastResult: ctx.lastResult,
            results: ctx.results,
            event: ctx.event,
            input: ctx.event?.data,
            locals: ctx.locals,
          },
          a.emit_payload_from,
        );
        if (!resolved.valid || resolved.value === undefined) {
          result = {
            ok: false,
            type: "emit",
            data: null,
            meta: {
              error: "emit_payload_path_unresolved",
              path: a.emit_payload_from,
            },
          };
          break;
        }
        selected = resolved.value;
      }
      const selectedRecord =
        selected && typeof selected === "object" && !Array.isArray(selected)
          ? (selected as Record<string, unknown>)
          : selected === undefined
            ? {}
            : { value: selected };
      const payload = { ...selectedRecord, ...(a.emit_payload ?? {}) };
      const intent: EmitIntent = { event, payload };
      result = {
        ok: true,
        type: "emit",
        // `_emit` keeps old one-branch consumers working; `_emits` is the lossless contract.
        data: { ...payload, _emit: event, _emits: [intent] },
        meta: { emitted: [intent], explicitEmit: true },
      };
      break;
    }
    case "invoke": {
      const target = (action.invoke ?? "").trim();
      if (!target || !input.durableActionRuntime) {
        result = {
          ok: false,
          type: "invoke",
          data: null,
          meta: {
            error: !target ? "invoke_target_missing" : "invoke_requires_durable_runtime",
            target,
          },
        };
        break;
      }
      try {
        const data = await input.durableActionRuntime.invoke({
          stepId: input.durableStepId ?? action.result_key ?? action.name,
          target,
          input: invokePayload(action, ctx),
          timeoutMs: input.resolvedTimeoutMs,
        });
        result = {
          ok: true,
          type: "invoke",
          data,
          meta: { invoked: target, durableStepId: input.durableStepId },
        };
      } catch (failure) {
        const facts = actionErrorFacts(failure);
        result = {
          ok: false,
          type: "invoke",
          data: { __error: "invoke_failed", target },
          meta: {
            error: "invoke_failed",
            target,
            facts,
            ...(facts.kind ? { kind: facts.kind } : {}),
            ...(facts.code ? { code: facts.code } : {}),
            ...(facts.status !== undefined ? { status: facts.status } : {}),
            message: facts.message,
          },
        };
      }
      break;
    }
    case "foreach": {
      const a = action as ActionSpec & {
        items_from?: string;
        item_as?: string;
        item_key_from?: string;
        foreach_actions?: ActionSpec[];
      };
      const itemsPath = a.items_from ?? "";
      const resolved = resolveConditionPath(
        {
          lastResult: ctx.lastResult,
          results: ctx.results,
          event: ctx.event,
          input: ctx.event?.data,
          locals: ctx.locals,
        },
        itemsPath,
      );
      if (!resolved.valid || !Array.isArray(resolved.value)) {
        result = {
          ok: false,
          type: "foreach",
          data: null,
          meta: { error: "foreach_items_not_array", path: itemsPath },
        };
        break;
      }
      const materialized = materializeForeach({
        items: resolved.value,
        itemAs: a.item_as,
        itemKeyFrom: a.item_key_from ?? "",
      });
      if (!materialized.ok) {
        result = {
          ok: false,
          type: "foreach",
          data: null,
          meta: { error: "foreach_key_invalid", detail: materialized.error },
        };
        break;
      }

      let totalIn = 0;
      let totalOut = 0;
      const allEmitted: EmitIntent[] = [];
      let suppressImplicitEmit = false;
      let terminalFailure: {
        stepId: string;
        data: unknown;
        resolution?: ActionFailureResolution;
      } | null = null;
      const parentId = input.durableStepId ?? action.result_key ?? action.name;
      const receipts = await runSequentialForeach(
        materialized.frames,
        async (frame) => {
          if (terminalFailure) {
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
          const stepIds: string[] = [];
          const failures: Array<{
            stepId: string;
            action: string;
            resolution: ActionFailureResolution;
          }> = [];
          for (const child of a.foreach_actions ?? []) {
            if (ctx.signal?.aborted) break;
            const childKey = child.result_key ?? child.name;
            const durableId = foreachStepId(parentId, frame, childKey);
            stepIds.push(durableId);
            const skip = shouldSkip(
              { name: childKey, dependsOn: child.depends_on },
              localGate,
            );
            if (skip.skip) {
              localGate.skipped.add(childKey);
              localResults[childKey] = { skipped: true, reason: skip.reason };
              continue;
            }
            const combinedLocals = { ...(ctx.locals ?? {}), ...frame.locals };
            const childInput: StepInput = {
              ...input,
              runId: undefined,
              stepOrd: undefined,
              action: child,
              durableStepId: durableId,
              ctx: {
                ...ctx,
                actionName: child.name,
                event: {
                  name: ctx.event?.name ?? "foreach",
                  data: {
                    ...(ctx.event?.data ?? {}),
                    ...combinedLocals,
                    _foreach: {
                      parentStepId: parentId,
                      index: frame.index,
                      key: frame.businessKey,
                      stableKey: frame.stableKey,
                    },
                  },
                },
                lastResult: localLast,
                results: { ...(ctx.results ?? {}), ...localResults },
                locals: combinedLocals,
              },
            };
            let bodyResult: StepOutput;
            try {
              const operation = () => runAction(childInput);
              // A foreach container owns no external side effect itself; its
              // descendants receive their own ids. Every other body action is
              // one durable item-local boundary (invoke uses host.invoke).
              bodyResult = child.type === "foreach" || child.type === "invoke"
                ? await operation()
                : input.durableActionRuntime
                  ? await input.durableActionRuntime.run(durableId, operation)
                  : await operation();
            } catch (failure) {
              const resolution = classifyNestedActionFailure(child, failure);
              if (resolution.disposition === "retry") {
                throw failureForDisposition(resolution, failure) ?? failure;
              }
              failures.push({ stepId: durableId, action: childKey, resolution });
              suppressImplicitEmit ||= resolution.suppressEmit;
              const intent = failureEmitIntent(resolution);
              if (intent) allEmitted.push(intent);
              if (resolution.disposition === "continue") {
                bodyResult = {
                  ok: true,
                  type: child.type,
                  data: resolution.defaultResult,
                  meta: { failureResolution: resolution, softFailed: true },
                };
              } else {
                terminalFailure = {
                  stepId: durableId,
                  data: { error: resolution.facts },
                  resolution,
                };
                break;
              }
            }
            totalIn += bodyResult.tokensIn ?? 0;
            totalOut += bodyResult.tokensOut ?? 0;
            const emitted = (
              bodyResult.meta as { emitted?: EmitIntent[] } | undefined
            )?.emitted;
            if (Array.isArray(emitted)) allEmitted.push(...emitted);
            if (!bodyResult.ok) {
              const resolution = classifyNestedActionFailure(child, {
                output: bodyResult,
              });
              if (resolution.disposition === "retry") {
                throw failureForDisposition(resolution, { output: bodyResult })
                  ?? new Error(`foreach child ${childKey} requested retry`);
              }
              failures.push({ stepId: durableId, action: childKey, resolution });
              suppressImplicitEmit ||= resolution.suppressEmit;
              const intent = failureEmitIntent(resolution);
              if (intent) allEmitted.push(intent);
              if (resolution.disposition === "continue") {
                localResults[childKey] = resolution.defaultResult;
                localLast = mergeStepResults(localLast, resolution.defaultResult);
                continue;
              }
              terminalFailure = {
                stepId: durableId,
                data: bodyResult.data,
                resolution,
              };
              break;
            }
            localResults[childKey] = bodyResult.data;
            localLast = mergeStepResults(localLast, bodyResult.data);
            if (child.type === "condition") {
              localGate.conditionTrue[childKey] = Boolean(
                (bodyResult.data as { evaluated?: boolean } | null)?.evaluated,
              );
            }
          }
          return {
            index: frame.index,
            key: frame.businessKey,
            stableKey: frame.stableKey,
            item: frame.item,
            stepIds,
            results: localResults,
            lastResult: localLast,
            failures,
          };
        },
      );

      const resolvedTerminalFailure = terminalFailure as {
        stepId: string;
        data: unknown;
        resolution?: ActionFailureResolution;
      } | null;
      if (resolvedTerminalFailure) {
        result = {
          ok: false,
          type: "foreach",
          data: { receipts, failure: resolvedTerminalFailure },
          tokensIn: totalIn,
          tokensOut: totalOut,
          meta: {
            foreach: true,
            emitted: allEmitted,
            error: "foreach_body_failed",
            suppressImplicitEmit,
            ...(resolvedTerminalFailure.resolution
              ? { failureResolution: resolvedTerminalFailure.resolution }
              : {}),
          },
        };
        break;
      }
      const byKey = Object.fromEntries(
        receipts.map((receipt) => [receipt.stableKey, receipt]),
      );
      result = {
        ok: true,
        type: "foreach",
        data: { count: receipts.length, items: receipts, byKey },
        tokensIn: totalIn,
        tokensOut: totalOut,
        meta: {
          foreach: true,
          mode: "sequential",
          emitted: allEmitted,
          suppressImplicitEmit,
        },
      };
      break;
    }
    default: {
      // Keep the switch fail-closed for any unexpected/ad-hoc type.
      result = {
        ok: false,
        type: "logic",
        data: null,
        meta: {
          error: "unsupported_action_type",
          actionType: (action as { type?: string }).type,
        },
      };
      break;
    }
  }

  if (action.type === "tool") {
    const dataflowAction = action as ActionSpec & {
      tool_arguments?: Record<string, unknown>;
      result_map?: { fields: Record<string, string>; include_raw?: boolean };
    };
    const argumentMode = dataflowAction.tool_arguments
      ? "explicit"
      : "legacy_whole_context";
    if (result.ok && dataflowAction.result_map) {
      const mapped = applyToolResultMap(result.data, dataflowAction.result_map);
      if (!mapped.ok) {
        result = {
          ...result,
          ok: false,
          data: null,
          meta: {
            ...(result.meta ?? {}),
            error: "tool_result_map_unresolved",
            detail: mapped.error,
            field: mapped.field,
            path: mapped.path,
            argumentMode,
          },
        };
      } else {
        result = {
          ...result,
          data: mapped.value,
          meta: {
            ...(result.meta ?? {}),
            argumentMode,
            resultMapped: true,
            rawResultIncluded: dataflowAction.result_map.include_raw === true,
          },
        };
      }
    } else {
      result = {
        ...result,
        meta: { ...(result.meta ?? {}), argumentMode },
      };
    }
  }

  // P0-RT-09: optional artifact sidecars.
  if (runId && typeof stepOrd === "number") {
    result.outputArtifact = await writeArtifact(
      runId,
      `step-${stepOrd}-output.json`,
      result,
    );
  }

  return result;
}

/**
 * Execute every in-process action kind behind the same manifest deadline.
 * Tool/LLM handlers receive an AbortSignal; isolated CodeAct workers receive
 * the exact millisecond budget and are hard-terminated by their worker host.
 */
export async function runAction(input: StepInput): Promise<StepOutput> {
  const now = Date.now();
  const localTimeoutMs =
    typeof input.action.timeout_s === "number"
      ? input.action.timeout_s * 1000
      : undefined;
  const localDeadlineAt =
    localTimeoutMs === undefined ? undefined : now + localTimeoutMs;
  const effectiveDeadlineAt =
    input.deadlineAt === undefined
      ? localDeadlineAt
      : localDeadlineAt === undefined
        ? input.deadlineAt
        : Math.min(input.deadlineAt, localDeadlineAt);
  const remainingDeadlineMs = effectiveDeadlineAt === undefined
    ? undefined
    : Math.max(0, effectiveDeadlineAt - now);
  const deadlineSource =
    input.deadlineAt !== undefined &&
    (localDeadlineAt === undefined || input.deadlineAt <= localDeadlineAt)
      ? "parent_deadline"
      : "action_timeout";
  const timeoutMs = remainingDeadlineMs;
  try {
    return await runWithActionTimeout(
      (signal) =>
        runActionCore({
          ...input,
          ctx: signal ? { ...input.ctx, signal } : input.ctx,
          deadlineAt: effectiveDeadlineAt,
          resolvedTimeoutMs: timeoutMs,
        }),
      {
        timeoutMs,
        parentSignal: input.ctx.signal,
        label: `action ${input.action.name}`,
      },
    );
  } catch (error) {
    if (!(error instanceof ActionTimeoutError)) throw error;
    return {
      ok: false,
      type: input.action.type,
      data: {
        __error: "action_timeout",
        code: error.code,
        timeout_ms: error.timeoutMs,
      },
      meta: {
        error: "action_timeout",
        kind: error.kind,
        code: error.code,
        timeoutMs: error.timeoutMs,
        deadlineSource,
        retryable: true,
      },
    };
  }
}
