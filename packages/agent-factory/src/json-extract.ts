// #JSON-FIX — balanced JSON extraction. The old `text.match(/\{[\s\S]*\}/)` pattern was DOUBLY
// broken: (1) greedy first-{ … last-} spans trailing prose braces; (2) on a max_tokens-TRUNCATED
// output it happily grabs first-{ … last-INNER-} — unbalanced garbage — so JSON.parse throws and the
// caller silently falls back (the «本体理解（确定性骨架·LLM 解析失败已回退）» every-run bug: a
// 6-agent Chinese digest ≈1 token/char blows a 1500-token cap mid-JSON, deterministically).
// This walks the text string-aware and returns the FIRST balanced top-level object/array, or null
// when the structure never closes (= truncation) so the caller can retry with a bigger budget
// instead of parsing garbage.

/** Extract the first balanced top-level JSON object or array from mixed text (code fences /
 *  surrounding prose tolerated). Returns null when no balanced structure exists — which for LLM
 *  output almost always means the completion was truncated at max_tokens. */
export function extractBalancedJson(text: string): string | null {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = Math.max(startObj, startArr);
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // never balanced → truncated / malformed
}
