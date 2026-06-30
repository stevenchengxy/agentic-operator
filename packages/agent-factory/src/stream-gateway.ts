// Streaming, tool-calling LLM turn against an OpenAI-compatible gateway.
//
// The new @agentic/llm-gateway chat() is NON-streaming, but the factory brain's
// whole ReAct experience is token-streaming. So (per the migration design) we keep
// a direct OpenAI-SDK streaming path here, resolving baseURL/apiKey from the new
// monorepo's env conventions (CUSTOM_LLM_* for a custom OpenAI-compatible endpoint,
// or OPENAI_*), plus FACTORY_* overrides. This is the streaming primitive the loop
// is built on: one assistant turn, yielding think deltas, then tool calls or final.

import OpenAI from "openai";

export type ChatMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
};

export type ToolSchema = {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};

export type AccTool = { id: string; name: string; args: string };

export type TurnEvent =
  | { t: "think"; delta: string }
  | { t: "usage"; promptTokens: number; completionTokens: number }
  | { t: "tool_calls"; content: string; calls: AccTool[] }
  | { t: "model"; model: string } // #7 — which model actually served this turn (after fallback)
  | { t: "done"; content: string };

/** FACTORY model. Defaults to gemini-3-flash (cheap, capable enough for the long
 *  design/iterate reasoning); override with FACTORY_AI_MODEL. */
const FACTORY_MODEL = process.env.FACTORY_AI_MODEL || "google/gemini-3-flash-preview";

/** Resolve the OpenAI-compatible endpoint the factory streams against. Reuses the
 *  new monorepo's CUSTOM_LLM_* / OPENAI_* env (and FACTORY_* overrides) so it slots
 *  into the existing gateway config without a separate scheme. */
export function resolveFactoryGateway(env: Record<string, string | undefined> = process.env): {
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
  const model = env.FACTORY_AI_MODEL || env.LLM_DEFAULT_MODEL || FACTORY_MODEL;
  return { baseURL, apiKey, model };
}

/** Is a gateway endpoint configured (an api key present)? Tools that need an LLM
 *  (e.g. test-case authoring) fall back to a deterministic path when not. */
export function isGatewayConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!(env.FACTORY_GATEWAY_API_KEY || env.CUSTOM_LLM_API_KEY || env.OPENAI_API_KEY);
}

/** One-shot, non-streaming completion (collects a streamTurn's text). For focused
 *  sub-calls like test-case authoring that don't need token streaming. */
export async function chatOnce(system: string, user: string, opts: { temperature?: number; maxTokens?: number; signal?: AbortSignal; models?: string[]; onModel?: (model: string) => void } = {}): Promise<string> {
  let text = "";
  for await (const ev of streamTurn(
    [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    [],
    { temperature: opts.temperature ?? 0.5, maxTokens: opts.maxTokens, signal: opts.signal, models: opts.models },
  )) {
    if (ev.t === "think") text += ev.delta;
    else if (ev.t === "model") opts.onModel?.(ev.model); // #7 — the model that actually served (after fallback)
    else if (ev.t === "done") text = ev.content || text;
  }
  return text;
}

/**
 * Stream a single assistant turn. Yields `think` deltas as the model emits content,
 * accumulates streamed tool-call fragments by index, and ends with either
 * `tool_calls` (the model wants to act) or `done` (final answer).
 */
export async function* streamTurn(
  messages: ChatMsg[],
  tools: ToolSchema[],
  opts: { model?: string; models?: string[]; temperature?: number; maxTokens?: number | null; signal?: AbortSignal } = {},
): AsyncGenerator<TurnEvent> {
  const gw = resolveFactoryGateway();
  const client = new OpenAI({ baseURL: gw.baseURL, apiKey: gw.apiKey });

  // Per-turn output cap. Default UNLIMITED (the brain's reasoning + a long
  // design_agent prompt can blow past any small ceiling). `effectiveMaxTokens` is
  // only lowered if the PROVIDER itself refuses with a 402 "you can only afford N".
  const envCap = Number(process.env.FACTORY_BRAIN_MAX_TOKENS);
  let effectiveMaxTokens =
    opts.maxTokens !== undefined ? opts.maxTokens
    : Number.isFinite(envCap) && envCap > 0 ? envCap
    : null;

  // #7: a fallback CHAIN of models (preferred first). On a model the gateway can't serve, or
  // any persistent failure, fall through to the next model before giving up.
  const models = opts.models && opts.models.length ? opts.models : [opts.model ?? gw.model];
  const create = async (model: string) =>
    client.chat.completions.create(
      {
        model,
        temperature: opts.temperature ?? 0.4,
        ...(effectiveMaxTokens != null ? { max_tokens: effectiveMaxTokens } : {}),
        messages: messages as unknown as OpenAI.Chat.ChatCompletionMessageParam[],
        ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      opts.signal ? { signal: opts.signal } : undefined,
    );

  let stream;
  let lastErr: unknown;
  let usedModel = models[0]!;
  const MAX_ATTEMPTS = 5;
  modelLoop: for (let mi = 0; mi < models.length; mi++) {
    usedModel = models[mi]!;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (opts.signal?.aborted) throw new Error("aborted");
      try {
        stream = await create(usedModel);
        break modelLoop;
      } catch (e) {
        lastErr = e;
        const code = (e as { status?: number }).status;
        const msg = String((e as { message?: string }).message ?? "").toLowerCase();
        // 402 provider credit limit: adapt by retrying once with the affordable budget.
        const afford = code === 402 ? msg.match(/can only afford (\d+)/) : null;
        if (afford && (effectiveMaxTokens == null || effectiveMaxTokens > Number(afford[1]))) {
          effectiveMaxTokens = Math.max(1024, Math.floor(Number(afford[1]) * 0.9));
          continue;
        }
        // Transient = upstream hiccup (5xx / overload / rate-limit / timeout): retry same model.
        const transient =
          (typeof code === "number" && code >= 500 && code < 600) ||
          /overload|\b50[234]\b|temporarily|unavailable|timeout|timed out|too many requests|rate.?limit|econn|socket hang/.test(msg);
        // A model the gateway doesn't serve (or any persistent failure) → try the NEXT model.
        const badModel = code === 404 || /no such model|model.*not found|does not exist|unknown model|unsupported model/.test(msg);
        if ((badModel || !transient || attempt === MAX_ATTEMPTS - 1) && mi < models.length - 1) continue modelLoop;
        if (!transient || attempt === MAX_ATTEMPTS - 1) throw e;
        // Exponential backoff 2s→4s→8s→16s.
        await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      }
    }
  }
  if (!stream) throw lastErr ?? new Error("stream init failed");
  yield { t: "model", model: usedModel };

  let content = "";
  const acc: Record<number, AccTool> = {};
  let prompt = 0;
  let completion = 0;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    const delta = choice?.delta as
      | { content?: string | null; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> }
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
  }

  if (prompt || completion) yield { t: "usage", promptTokens: prompt, completionTokens: completion };

  const calls = Object.values(acc).filter((c) => c.name && c.id);
  if (calls.length) yield { t: "tool_calls", content, calls };
  else yield { t: "done", content };
}
