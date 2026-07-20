// Streaming, tool-calling LLM turn against an OpenAI-compatible gateway.
//
// The new @agentic/llm-gateway chat() is NON-streaming, but the factory brain's
// whole ReAct experience is token-streaming. So (per the migration design) we keep
// a direct OpenAI-SDK streaming path here, resolving baseURL/apiKey from the new
// monorepo's env conventions (CUSTOM_LLM_* for a custom OpenAI-compatible endpoint,
// or OPENAI_*), plus FACTORY_* overrides. This is the streaming primitive the loop
// is built on: one assistant turn, yielding think deltas, then tool calls or final.

import OpenAI from "openai";
import { extractBalancedJson } from "./json-extract";

export type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
};

export type ToolSchema = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type AccTool = { id: string; name: string; args: string };

export type TurnEvent =
  | { t: "think"; delta: string }
  | { t: "usage"; promptTokens: number; completionTokens: number }
  | { t: "tool_calls"; content: string; calls: AccTool[] }
  | { t: "model"; model: string } // #7 — which model actually served this turn (after fallback)
  | { t: "done"; content: string; finishReason?: string };

/** Resolve the OpenAI-compatible endpoint the factory streams against. Reuses the
 *  new monorepo's CUSTOM_LLM_* / OPENAI_* env (and FACTORY_* overrides) so it slots
 *  into the existing gateway config without a separate scheme. A model is an
 *  explicit deployment choice: there is deliberately no baked-in model id that
 *  could route a supposedly real run somewhere the operator never configured. */
export function resolveFactoryGateway(
  env: Record<string, string | undefined> = process.env,
): {
  baseURL: string;
  apiKey: string;
  model: string;
} {
  const baseURL =
    env.FACTORY_GATEWAY_BASE_URL ||
    env.CUSTOM_LLM_BASE_URL ||
    env.OPENAI_BASE_URL ||
    "https://api.openai.com/v1";
  const apiKey =
    env.FACTORY_GATEWAY_API_KEY ||
    env.CUSTOM_LLM_API_KEY ||
    env.OPENAI_API_KEY ||
    "";
  const model = (env.FACTORY_AI_MODEL || env.LLM_DEFAULT_MODEL || "").trim();
  if (!model || /(^|[\s/_-])mock([\s/_-]|$)/i.test(model)) {
    throw new Error(
      "Agent Factory requires FACTORY_AI_MODEL or LLM_DEFAULT_MODEL to name a real model; mock/implicit defaults are forbidden",
    );
  }
  return { baseURL, apiKey, model };
}

/** Is a real gateway endpoint fully configured? */
export function isGatewayConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const apiKey = (
    env.FACTORY_GATEWAY_API_KEY ||
    env.CUSTOM_LLM_API_KEY ||
    env.OPENAI_API_KEY ||
    ""
  ).trim();
  const model = (env.FACTORY_AI_MODEL || env.LLM_DEFAULT_MODEL || "").trim();
  const provider = (env.LLM_DEFAULT_PROVIDER || "").trim().toLowerCase();
  return Boolean(
    apiKey &&
    model &&
    provider !== "mock" &&
    !/(^|[\s/_-])mock([\s/_-]|$)/i.test(model),
  );
}

// #P0-3 — LLM telemetry sink. The brain runs in-process (apps/api); a caller wires a DB writer via
// setLlmCallSink so every chatOnce records model/routing/latency/size (was ephemeral). The per-run
// context (conversation/domain/tenant) is set once by the conductor — single-instance assumption
// (typically one brain run at a time); documented as such.
export interface LlmCallRecord {
  conversationId?: string;
  domain?: string;
  tenantId?: string;
  runId?: string;
  purpose?: string;
  requestedModel?: string;
  servedModel?: string;
  provider?: string;
  fallback?: boolean;
  promptChars: number;
  completionChars: number;
  approxTokensIn: number;
  approxTokensOut: number;
  tokenSource?: "provider" | "estimated_chars";
  latencyMs: number;
  ok: boolean;
  failureReason?: string;
}
let llmCallSink: ((rec: LlmCallRecord) => void) | null = null;
let llmCallCtx: {
  conversationId?: string;
  domain?: string;
  tenantId?: string;
} = {};
export function setLlmCallSink(
  fn: ((rec: LlmCallRecord) => void) | null,
): void {
  llmCallSink = fn;
}
export function setLlmCallContext(c: {
  conversationId?: string;
  domain?: string;
  tenantId?: string;
}): void {
  llmCallCtx = c ?? {};
}

/** One-shot, non-streaming completion (collects a streamTurn's text). For focused
 *  sub-calls like test-case authoring that don't need token streaming. Records LLM telemetry. */
export async function chatOnce(
  system: string,
  user: string,
  opts: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    models?: string[];
    onModel?: (model: string) => void;
    purpose?: string;
  } = {},
): Promise<string> {
  let text = "";
  const started = Date.now();
  // #W1-1 — attribution snapshot AT ENTRY: a concurrent brain run overwriting the module-global
  // context mid-call can no longer re-attribute THIS call. Combined with the conductor re-asserting
  // its context every turn, cross-run bleed shrinks from "rest of the run" to a same-instant race.
  const ctxAtEntry = { ...llmCallCtx };
  const requested = opts.models?.[0];
  let served = requested;
  let ok = true;
  let failure: string | undefined;
  const emit = () => {
    if (!llmCallSink) return;
    const promptChars = system.length + user.length;
    llmCallSink({
      ...ctxAtEntry,
      purpose: opts.purpose,
      requestedModel: requested,
      servedModel: served,
      provider: resolveFactoryGateway().baseURL,
      fallback: !!(requested && served && served !== requested),
      promptChars,
      completionChars: text.length,
      approxTokensIn: Math.ceil(promptChars / 4),
      approxTokensOut: Math.ceil(text.length / 4),
      tokenSource: "estimated_chars",
      latencyMs: Date.now() - started,
      ok,
      failureReason: failure,
    });
  };
  try {
    for await (const ev of streamTurn(
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      [],
      {
        temperature: opts.temperature ?? 0.5,
        maxTokens: opts.maxTokens,
        signal: opts.signal,
        models: opts.models,
      },
    )) {
      if (ev.t === "think") text += ev.delta;
      else if (ev.t === "model") {
        served = ev.model;
        opts.onModel?.(ev.model);
      } // #7 — model that served (post-fallback)
      else if (ev.t === "done") {
        text = ev.content || text;
        // #JSON-FIX — a max_tokens truncation is recorded in llm_calls (ok stays true; the call
        // succeeded — WE capped it). This is what made the «每次都回退» bug a one-query diagnosis.
        if (ev.finishReason === "length")
          failure = "output truncated at max_tokens (finish_reason=length)";
      }
    }
  } catch (e) {
    ok = false;
    failure = String((e as Error)?.message ?? e).slice(0, 200);
    try {
      emit();
    } catch (telemetryError) {
      throw new AggregateError(
        [e, telemetryError],
        "LLM call failed and its telemetry could not be durably recorded",
      );
    }
    throw e;
  }
  emit();
  return text;
}

/** #TRANSIENT — 上游算力波动/限流/网络抖动 vs 真实的逻辑错误。用于把"重试就好"的故障与
 *  "输入有问题"的故障分开——两者对用户的含义完全不同（前者不该惊动用户）。 */
export function isTransientLlmError(message: string): boolean {
  return /overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang/i.test(message);
}

/** #JSON-DIAG — chatJson 为什么没拿到 JSON。旧版把【基础设施故障】和【模型没写出 JSON】
 *  折成同一个 `null`，调用方无法区分，于是网关 503 被逐字报成"格式错误/空响应"（真实事故：
 *  build_blueprint 报「网关空响应或格式错误」，实际多半是 fast 档 + 400k 上下文下的网关故障），
 *  并且被当成"你的输入有问题"去打扰用户。 */
export type ChatJsonFailure =
  /** 调用根本没成功（鉴权/网络/过载/超时）——与模型输出无关，重试通常有效。 */
  | { kind: "llm_error"; message: string; transient: boolean }
  /** 调用成功但模型什么都没吐。 */
  | { kind: "empty_output" }
  /** 模型吐了内容，但里面没有可提取的 JSON（多半在讲道理/道歉）。 */
  | { kind: "no_json"; sample: string }
  /** 提取到了 JSON 片段但解析失败（典型：被 max_tokens 截断）。 */
  | { kind: "invalid_json"; sample: string };

export type ChatJsonResult<T> = { ok: true; value: T } | { ok: false; failure: ChatJsonFailure };

/** #JSON-FIX — structured-output helper: chatOnce → BALANCED extraction → parse, with ONE
 *  truncation-aware retry at a much bigger budget + a stricter "complete JSON only" instruction.
 *  Chinese JSON runs ≈1 token/char, so the small per-call caps that were fine for English silently
 *  truncated mid-JSON and every greedy-regex caller fell back deterministically. Returns null only
 *  after both attempts fail — callers keep their existing degraded paths.
 *
 *  诊断信息会丢（null 不携带原因）。需要如实报告故障原因的调用方用 `chatJsonResult`；
 *  本函数保留原签名，既有调用方的降级路径一行都不用改。 */
export async function chatJson<T>(
  system: string,
  user: string,
  opts: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    models?: string[];
    purpose?: string;
    onModel?: (model: string) => void;
    /** test hook — swap the underlying call (defaults to chatOnce). */
    callFn?: (
      sys: string,
      usr: string,
      o: {
        temperature?: number;
        maxTokens?: number;
        signal?: AbortSignal;
        models?: string[];
        purpose?: string;
        onModel?: (model: string) => void;
      },
    ) => Promise<string>;
  } = {},
): Promise<T | null> {
  const result = await chatJsonResult<T>(system, user, opts);
  return result.ok ? result.value : null;
}

/** #JSON-DIAG — 与 chatJson 完全相同的调用/重试/提取逻辑，但失败时【说清为什么】。
 *  给需要如实报告故障的调用方用（网关故障 ≠ 模型没写出 JSON ≠ 输入有问题）。 */
export async function chatJsonResult<T>(
  system: string,
  user: string,
  opts: {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    models?: string[];
    purpose?: string;
    onModel?: (model: string) => void;
    /** test hook — swap the underlying call (defaults to chatOnce). */
    callFn?: (
      sys: string,
      usr: string,
      o: {
        temperature?: number;
        maxTokens?: number;
        signal?: AbortSignal;
        models?: string[];
        purpose?: string;
        onModel?: (model: string) => void;
      },
    ) => Promise<string>;
  } = {},
): Promise<ChatJsonResult<T>> {
  const call = opts.callFn ?? chatOnce;
  const attempt = async (
    cap: number | undefined,
    extraSys: string,
  ): Promise<ChatJsonResult<T>> => {
    let text = "";
    try {
      text = await call(system + extraSys, user, {
        temperature: opts.temperature,
        maxTokens: cap,
        signal: opts.signal,
        models: opts.models,
        purpose: opts.purpose,
        onModel: opts.onModel,
      });
    } catch (e) {
      // A telemetry durability failure is not a model-output failure and must
      // never be converted into a plausible deterministic fallback.
      if (isTelemetryDurabilityFailure(e)) throw e;
      // #AUDIT-FIX(L27) — 基础设施故障（鉴权/网络/看门狗）与"模型没写出 JSON"必须可区分：
      // 前者留日志（所有 chatJson 调用方都曾把网关故障误报为模型输出问题）。
      const message = String((e as Error)?.message ?? e).slice(0, 200);
      try {
        console.warn(
          `[chatJson] LLM 调用失败（非解析问题）：${message.slice(0, 160)}${opts.purpose ? ` · purpose=${opts.purpose}` : ""}`,
        );
      } catch {
        /* best-effort */
      }
      return { ok: false, failure: { kind: "llm_error", message, transient: isTransientLlmError(message) } };
    }
    if (!text.trim()) return { ok: false, failure: { kind: "empty_output" } };
    const slice = extractBalancedJson(text);
    if (!slice) return { ok: false, failure: { kind: "no_json", sample: text.slice(0, 200) } };
    try {
      return { ok: true, value: JSON.parse(slice) as T };
    } catch {
      return { ok: false, failure: { kind: "invalid_json", sample: slice.slice(0, 200) } };
    }
  };
  // 控制流与旧版 chatJson 逐字一致（第一次失败 → 加大预算重试一次），只是把"为什么失败"
  // 一路带出来。这里【刻意不】因为 transient 就跳过重试：streamTurn 自己已有退避重试，
  // 改动重试语义超出"如实诊断"的范围，容易引入难查的回归。
  const first = await attempt(opts.maxTokens, "");
  if (first.ok) return first;
  if (opts.signal?.aborted) return first;
  const bigger = Math.max(Math.ceil((opts.maxTokens ?? 2400) * 2.5), 6000);
  const second = await attempt(
    bigger,
    "\n【重要】必须输出一个完整、闭合的 JSON——不要截断、不要 JSON 以外的任何文字；内容可精炼，但结构必须完整。",
  );
  // 两次都失败 → 报第二次（更大预算下）的原因：它更能说明真实卡点。但若第二次是网关故障、
  // 而第一次是模型输出问题，第一次的原因反而更有信息量（网关是在重试时才挂的）。
  if (!second.ok && second.failure.kind === "llm_error" && !first.ok && first.failure.kind !== "llm_error") return first;
  return second;
}

function isTelemetryDurabilityFailure(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if (
    "code" in error &&
    (error as { code?: unknown }).code === "llm_telemetry_unavailable"
  ) {
    return true;
  }
  if (error instanceof AggregateError) {
    return error.errors.some(isTelemetryDurabilityFailure);
  }
  return false;
}

/**
 * Stream a single assistant turn. Yields `think` deltas as the model emits content,
 * accumulates streamed tool-call fragments by index, and ends with either
 * `tool_calls` (the model wants to act) or `done` (final answer).
 */
export async function* streamTurn(
  messages: ChatMsg[],
  tools: ToolSchema[],
  opts: {
    model?: string;
    models?: string[];
    temperature?: number;
    maxTokens?: number | null;
    signal?: AbortSignal;
  } = {},
): AsyncGenerator<TurnEvent> {
  const gw = resolveFactoryGateway();
  const client = new OpenAI({ baseURL: gw.baseURL, apiKey: gw.apiKey });

  // Per-turn output cap. Default UNLIMITED (the brain's reasoning + a long
  // design_agent prompt can blow past any small ceiling). `effectiveMaxTokens` is
  // only lowered if the PROVIDER itself refuses with a 402 "you can only afford N".
  const envCap = Number(process.env.FACTORY_BRAIN_MAX_TOKENS);
  let effectiveMaxTokens =
    opts.maxTokens !== undefined
      ? opts.maxTokens
      : Number.isFinite(envCap) && envCap > 0
        ? envCap
        : null;

  // #WATCHDOG — 空转看门狗（修「运行中…永远不动」的挂起类故障，见 2026-07-09 无响应事故）：
  // provider 连接挂起 / 网络黑洞时流不再产出任何 chunk，没有超时的话整个 run 会永远停在
  // "运行中"，直到前端 staleness 兜底报"已无响应"。这里在最底层咽喉点装【空转】计时器——
  // 只要流还在动就不断续命（长输出永不误杀），静默超过阈值才中止；上层（specialists 的
  // 降级链 / 重试链）把中止当普通失败处理，run 继续而不是死等。FACTORY_LLM_IDLE_TIMEOUT_MS 可调。
  const idleMs = Math.max(
    15_000,
    Number(process.env.FACTORY_LLM_IDLE_TIMEOUT_MS) || 90_000,
  );
  const watchdog = new AbortController();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => watchdog.abort(), idleMs);
    (idleTimer as unknown as { unref?: () => void }).unref?.();
  };
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, watchdog.signal])
    : watchdog.signal;
  // 把 SDK 的泛化 abort 错误翻译成可诊断的看门狗消息（telemetry/日志一眼定位）。
  const translateAbort = (e: unknown): unknown =>
    watchdog.signal.aborted && !opts.signal?.aborted
      ? new Error(
          `LLM 流空转超过 ${idleMs}ms 被看门狗中止（provider 挂起/网络黑洞）——按失败降级继续`,
        )
      : e;

  // #7: a fallback CHAIN of models (preferred first). On a model the gateway can't serve, or
  // any persistent failure, fall through to the next model before giving up.
  const models =
    opts.models && opts.models.length ? opts.models : [opts.model ?? gw.model];
  const create = async (model: string) =>
    client.chat.completions.create(
      {
        model,
        temperature: opts.temperature ?? 0.4,
        ...(effectiveMaxTokens != null
          ? { max_tokens: effectiveMaxTokens }
          : {}),
        messages:
          messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      { signal },
    );

  let stream;
  let lastErr: unknown;
  let usedModel = models[0]!;
  // Connection retries per model in the chain (chain length × this = total provider attempts).
  const MAX_ATTEMPTS = Math.max(1, Number(process.env.FACTORY_LLM_MAX_ATTEMPTS) || 5);
  modelLoop: for (let mi = 0; mi < models.length; mi++) {
    usedModel = models[mi]!;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) throw new Error("aborted");
      try {
        armIdle(); // 连接阶段同样受看门狗保护（fetch 挂在首字节前也算空转）
        stream = await create(usedModel);
        break modelLoop;
      } catch (e0) {
        const e = translateAbort(e0);
        if (watchdog.signal.aborted && !opts.signal?.aborted) {
          if (idleTimer) clearTimeout(idleTimer);
          throw e;
        }
        lastErr = e;
        const code = (e as { status?: number }).status;
        const msg = String(
          (e as { message?: string }).message ?? "",
        ).toLowerCase();
        // 402 provider credit limit: adapt by retrying once with the affordable budget.
        const afford = code === 402 ? msg.match(/can only afford (\d+)/) : null;
        if (
          afford &&
          (effectiveMaxTokens == null || effectiveMaxTokens > Number(afford[1]))
        ) {
          effectiveMaxTokens = Math.max(
            1024,
            Math.floor(Number(afford[1]) * 0.9),
          );
          continue;
        }
        // Transient = upstream hiccup (5xx / overload / rate-limit / timeout): retry same model.
        const transient =
          (typeof code === "number" && code >= 500 && code < 600) ||
          /overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang/.test(
            msg,
          );
        // A model the gateway doesn't serve (or any persistent failure) → try the NEXT model.
        const badModel =
          code === 404 ||
          /no such model|model.*not found|does not exist|unknown model|unsupported model/.test(
            msg,
          );
        if (
          (badModel || !transient || attempt === MAX_ATTEMPTS - 1) &&
          mi < models.length - 1
        )
          continue modelLoop;
        if (!transient || attempt === MAX_ATTEMPTS - 1) throw e;
        // Exponential backoff 2s→4s→8s→16s.
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }
  if (!stream) throw lastErr ?? new Error("stream init failed");
  yield { t: "model", model: usedModel };

  let content = "";
  let finishReason: string | undefined;
  const acc: Record<number, AccTool> = {};
  let prompt = 0;
  let completion = 0;

  try {
    armIdle(); // 流已建立但首 chunk 迟迟不来也算空转
    for await (const chunk of stream) {
      armIdle(); // #WATCHDOG — 每个 chunk 续命：只要在动就永不误杀，静默 idleMs 才中止
      const choice = chunk.choices?.[0];
      const delta = choice?.delta as
        | {
            content?: string | null;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          }
        | undefined;

      if (delta?.content) {
        content += delta.content;
        yield { t: "think", delta: delta.content };
      }
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const a = (acc[idx] ??= { id: "", name: "", args: "" });
          if (tc.id) a.id = tc.id;
          if (tc.function?.name) a.name += tc.function.name;
          if (tc.function?.arguments) a.args += tc.function.arguments;
        }
      }
      if (chunk.usage) {
        prompt = chunk.usage.prompt_tokens ?? 0;
        completion = chunk.usage.completion_tokens ?? 0;
      }
      // #JSON-FIX — surface finish_reason: "length" = WE truncated the output at max_tokens. Callers
      // parsing structured output must be able to tell "model wrote bad JSON" from "we cut it off".
      const fr = (choice as { finish_reason?: string | null } | undefined)
        ?.finish_reason;
      if (fr) finishReason = fr;
    }
  } catch (e0) {
    throw translateAbort(e0);
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  if (prompt || completion)
    yield { t: "usage", promptTokens: prompt, completionTokens: completion };

  const calls = Object.values(acc).filter((c) => c.name && c.id);
  if (calls.length) yield { t: "tool_calls", content, calls };
  else yield { t: "done", content, finishReason };
}
