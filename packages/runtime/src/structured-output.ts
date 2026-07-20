/**
 * Parse the JSON value returned by an LLM.
 *
 * Providers are asked for JSON mode when a prompt declares an output schema,
 * but OpenAI-compatible proxies and some models still wrap the value in a
 * Markdown code fence (or prepend one short sentence). Keep the recovery here
 * deterministic: direct JSON wins, then fenced JSON, then the first balanced
 * object/array. Schema validation remains the caller's responsibility.
 */

function balancedJsonSlice(text: string): string | undefined {
  let start = -1;
  let opener = "";
  let closer = "";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (start < 0) {
      if (ch !== "{" && ch !== "[") continue;
      start = i;
      opener = ch;
      closer = ch === "{" ? "}" : "]";
      depth = 1;
      continue;
    }

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Parse direct, fenced, or lightly-wrapped JSON. Throws on invalid output. */
export function parseStructuredJson(text: string): unknown {
  const normalized = text.replace(/^\uFEFF/, "").trim();
  const candidates: string[] = [];
  if (normalized) candidates.push(normalized);

  const fence = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
  for (
    let match = fence.exec(normalized);
    match;
    match = fence.exec(normalized)
  ) {
    const body = match[1]?.trim();
    if (body) candidates.push(body);
  }

  const balanced = balancedJsonSlice(normalized);
  if (balanced) candidates.push(balanced);

  let lastError: unknown;
  for (const candidate of [...new Set(candidates)]) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (err) {
      lastError = err;
    }
  }

  const detail =
    lastError instanceof Error
      ? lastError.message
      : "no JSON object or array found";
  throw new SyntaxError(`Invalid structured LLM output: ${detail}`);
}

/** Non-throwing twin used by optional consumers such as branch selection. */
export function tryParseStructuredJson(text: string): unknown | undefined {
  try {
    return parseStructuredJson(text);
  } catch {
    return undefined;
  }
}
