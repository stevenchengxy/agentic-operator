/**
 * Shared, side-effect-free context and provider-budget helpers.
 *
 * The conductor uses these today. Focused chatOnce/reviewer calls can adopt the
 * same ledger view later without guessing how their private prompts should be
 * charged into a running conversation.
 */

export interface ContextMessageLike {
  role?: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: unknown;
}

export interface ContextUsage {
  chars: number;
  estimatedTokens: number;
}

const DEFAULT_CHARS_PER_TOKEN = 4;

function positiveNumber(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value ?? "");
  } catch {
    return String(value ?? "");
  }
}

export function estimateMessageChars(message: ContextMessageLike): number {
  return (
    String(message.role ?? "").length +
    (typeof message.content === "string" ? message.content.length : 0) +
    String(message.tool_call_id ?? "").length +
    (message.tool_calls === undefined ? 0 : jsonText(message.tool_calls).length)
  );
}

export function estimateContextUsage(
  messages: ContextMessageLike[],
  options: { additionalChars?: number; charsPerToken?: number } = {},
): ContextUsage {
  const chars = Math.max(
    0,
    messages.reduce((sum, message) => sum + estimateMessageChars(message), 0) +
      Math.max(0, options.additionalChars ?? 0),
  );
  const charsPerToken = positiveNumber(
    options.charsPerToken,
    DEFAULT_CHARS_PER_TOKEN,
  );
  return { chars, estimatedTokens: Math.ceil(chars / charsPerToken) };
}

export interface CompactionThresholds {
  maxMessages: number;
  maxChars: number;
  maxEstimatedTokens: number;
  charsPerToken?: number;
}

/** Trigger compaction on any exhausted dimension, not only message count. */
export function shouldCompactContext(
  messages: ContextMessageLike[],
  thresholds: CompactionThresholds,
): boolean {
  const usage = estimateContextUsage(messages, {
    charsPerToken: thresholds.charsPerToken,
  });
  return (
    messages.length > thresholds.maxMessages ||
    usage.chars > thresholds.maxChars ||
    usage.estimatedTokens > thresholds.maxEstimatedTokens
  );
}

/**
 * Select a suffix that is bounded by message count and estimated context size.
 * The final message is always retained even if it alone exceeds the keep budget;
 * the caller may then retain its preceding assistant tool-call frame as a pair.
 */
export function recentContextStart(
  messages: ContextMessageLike[],
  thresholds: CompactionThresholds,
): number {
  if (messages.length <= 1) return messages.length;
  let start = messages.length;
  let kept = 0;
  let chars = 0;
  for (let index = messages.length - 1; index >= 1; index--) {
    const nextChars = estimateMessageChars(messages[index]!);
    const nextTokens = Math.ceil(
      (chars + nextChars) /
        positiveNumber(thresholds.charsPerToken, DEFAULT_CHARS_PER_TOKEN),
    );
    if (
      kept > 0 &&
      (kept >= thresholds.maxMessages ||
        chars + nextChars > thresholds.maxChars ||
        nextTokens > thresholds.maxEstimatedTokens)
    ) {
      break;
    }
    start = index;
    kept += 1;
    chars += nextChars;
  }
  return Math.max(1, start);
}

export interface ToolResultForContext {
  ok?: unknown;
  summary?: unknown;
  output?: unknown;
  [key: string]: unknown;
}

/**
 * Serialize a tool result without ever slicing serialized JSON. Oversized
 * payloads become a small, valid JSON envelope with an explicitly truncated
 * preview and recovery instruction.
 */
export function serializeToolResultForContext(
  body: ToolResultForContext,
  maxChars: number,
): string {
  const full = jsonText(body);
  const cap = Math.max(64, Math.floor(maxChars));
  if (full.length <= cap) return full;

  const rawOutput = Object.prototype.hasOwnProperty.call(body, "output")
    ? body.output
    : body;
  const previewSource =
    typeof rawOutput === "string" ? rawOutput : jsonText(rawOutput);
  const originalType = Array.isArray(rawOutput)
    ? "array"
    : rawOutput === null
      ? "null"
      : typeof rawOutput;
  const rawSummary =
    typeof body.summary === "string" ? body.summary : String(body.summary ?? "");

  const build = (previewChars: number, summaryChars: number): string => {
    const envelope: ToolResultForContext = {
      ...(Object.prototype.hasOwnProperty.call(body, "ok") ? { ok: body.ok } : {}),
      summary: rawSummary.slice(0, summaryChars),
      output: {
        truncated: true,
        originalType,
        originalChars: previewSource.length,
        preview: previewSource.slice(0, previewChars),
        recovery:
          "结果过长，已保留结构化截断元数据；需要完整内容请用对应工具重取。",
      },
    };
    return jsonText(envelope);
  };

  let summaryChars = Math.min(rawSummary.length, Math.max(0, Math.floor(cap / 6)));
  let minimal = build(0, summaryChars);
  while (minimal.length > cap && summaryChars > 0) {
    summaryChars = Math.floor(summaryChars / 2);
    minimal = build(0, summaryChars);
  }
  if (minimal.length > cap) {
    // Extremely small caller caps still receive valid JSON; parseability is the
    // invariant even when the metadata itself cannot fit the requested cap.
    return jsonText({ truncated: true, originalChars: full.length });
  }

  let low = 0;
  let high = previewSource.length;
  let best = minimal;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = build(mid, summaryChars);
    if (candidate.length <= cap) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

/** A structural ledger view shared by the main conductor and future sub-calls. */
export interface TokenBudgetLedgerView {
  scope: string;
  spentTokens: number;
  maxTokens: number | null;
}

export interface ProviderCallBudgetPlan {
  allowed: boolean;
  promptTokens: number;
  reserveTokens: number;
  /** Null means the ledgers impose no completion cap. */
  completionTokenCap: number | null;
  limitingScope?: string;
  remainingTokens?: number;
  reason?: string;
}

/**
 * Plan a provider call before it is made. The reserve remains unspent as a
 * safety margin; the returned completion cap prevents one final paid turn from
 * crossing the limiting ledger by an entire completion.
 */
export function planProviderCall(input: {
  ledgers: TokenBudgetLedgerView[];
  promptTokens: number;
  reserveTokens: number;
  requestedCompletionTokens?: number | null;
}): ProviderCallBudgetPlan {
  const promptTokens = Math.max(0, Math.ceil(input.promptTokens));
  const reserveTokens = Math.max(0, Math.ceil(input.reserveTokens));
  const bounded = input.ledgers
    .filter(
      (ledger): ledger is TokenBudgetLedgerView & { maxTokens: number } =>
        ledger.maxTokens != null,
    )
    .map((ledger) => ({
      scope: ledger.scope,
      remaining: Math.max(0, ledger.maxTokens - Math.max(0, ledger.spentTokens)),
    }))
    .sort((left, right) => left.remaining - right.remaining);

  const requested =
    input.requestedCompletionTokens != null &&
    Number.isFinite(input.requestedCompletionTokens) &&
    input.requestedCompletionTokens > 0
      ? Math.floor(input.requestedCompletionTokens)
      : null;
  if (!bounded.length) {
    return {
      allowed: true,
      promptTokens,
      reserveTokens,
      completionTokenCap: requested,
    };
  }

  const limiting = bounded[0]!;
  const availableCompletion =
    limiting.remaining - promptTokens - reserveTokens;
  if (availableCompletion < 1) {
    return {
      allowed: false,
      promptTokens,
      reserveTokens,
      completionTokenCap: 0,
      limitingScope: limiting.scope,
      remainingTokens: limiting.remaining,
      reason: `remaining ${limiting.remaining} < prompt ${promptTokens} + reserve ${reserveTokens} + 1`,
    };
  }

  return {
    allowed: true,
    promptTokens,
    reserveTokens,
    completionTokenCap:
      requested == null
        ? Math.floor(availableCompletion)
        : Math.min(requested, Math.floor(availableCompletion)),
    limitingScope: limiting.scope,
    remainingTokens: limiting.remaining,
  };
}
