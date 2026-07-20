export type TestCaseDecision = "approve" | "regenerate" | "supply_data";

export interface ParsedTestCaseDecision {
  decision: TestCaseDecision;
  note: string;
  raw: string;
  source: "tag" | "phrase";
}

/**
 * Whether a mailbox message is reserved for the test-case gate.
 *
 * This intentionally recognizes unsupported/malformed decision tags too. A
 * wrong-gate handler must re-queue such a message instead of consuming it as a
 * free-form clarification answer. Parsing the decision itself remains strict.
 */
export function isTestCaseDecisionTaggedMessage(input: string): boolean {
  return /^\[测试用例决策(?:\]|[:：])/i.test(input.trimStart());
}

function decisionForTaggedToken(token: string): TestCaseDecision | null {
  const normalized = token.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "执行" || normalized === "approve") return "approve";
  if (normalized === "重新生成" || normalized === "regenerate") return "regenerate";
  if (
    normalized === "补数据"
    || normalized === "supply_data"
    || normalized === "supply-data"
    || normalized === "supply data"
    || normalized === "edit"
  ) return "supply_data";
  return null;
}

/**
 * Parse only explicit test-case decisions.
 *
 * Supported inputs are an exact `[测试用例决策: ...]` protocol tag, a small set
 * of exact command phrases, or a regenerate command followed by an explicit
 * punctuation delimiter and note. Ordinary conversational text must not open
 * or close a deployment gate.
 */
export function parseTestCaseDecision(input: string): ParsedTestCaseDecision | null {
  const raw = input.trim();
  if (!raw) return null;

  const tagged = raw.match(/^\[测试用例决策[:：]\s*([^\]]+?)\]\s*([\s\S]*)$/i);
  if (tagged) {
    const decision = decisionForTaggedToken(tagged[1] ?? "");
    if (!decision) return null;
    return {
      decision,
      note: (tagged[2] ?? "").trim(),
      raw,
      source: "tag",
    };
  }

  // A reserved but malformed/unsupported tag is never treated as a plain
  // phrase. The caller may keep it queued for the correct gate or reject it.
  if (isTestCaseDecisionTaggedMessage(raw)) return null;

  if (/^(?:执行|确认执行|approve)$/i.test(raw)) {
    return { decision: "approve", note: "", raw, source: "phrase" };
  }
  if (/^(?:重新生成|regenerate|重做)$/i.test(raw)) {
    return { decision: "regenerate", note: "", raw, source: "phrase" };
  }
  const regenerateWithNote = raw.match(/^(?:重新生成|regenerate|重做)[，,：:]\s*([\s\S]+)$/i);
  if (regenerateWithNote) {
    return {
      decision: "regenerate",
      note: (regenerateWithNote[1] ?? "").trim(),
      raw,
      source: "phrase",
    };
  }
  if (/^(?:补数据|补充测试数据|supply(?:\s+|[_-])data)$/i.test(raw)) {
    return { decision: "supply_data", note: "", raw, source: "phrase" };
  }
  return null;
}
