import { createHash } from "node:crypto";
import type { FactoryHumanMemory, FactoryHumanMemoryKind } from "./ports";

/** Stable storage key for a semantic human question/decision.  The exact
 * question is stored alongside it; hashing only keeps the unique key bounded. */
export function humanMemoryQuestionKey(kind: FactoryHumanMemoryKind, question: string): string {
  const normalized = question.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  return `${kind}:${createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 32)}`;
}

/** Verbatim prompt block for a fresh factory conversation.  Values are not
 * summarized or paraphrased; callers receive the precise human wording. */
export function renderHumanMemorySeed(memories: FactoryHumanMemory[]): string {
  if (!memories.length) return "";
  const rows = memories.map((memory) => {
    const context = memory.context == null ? "" : `\ncontext(verbatim): ${memory.context}`;
    return [
      `key=${memory.questionKey} kind=${memory.kind} pinned=${memory.pinned}`,
      `question(verbatim): ${memory.question}`,
      `answer(verbatim): ${memory.answer}${context}`,
    ].join("\n");
  });
  return [
    "[此前人工确认记忆｜source=human｜verbatim｜仅背景]",
    "下面是你与用户在【以往会话】中确认过的决策，逐字保留。这些只是背景参考，用户【本次并未重新提出】——" +
      "不要以此开场、不要主动复述或罗列这些内容，也不要据此假设用户当前想做什么。只有当用户本次的请求与某条" +
      "直接相关时，才把它当作已知前提使用；若与本次目标冲突，按需再询问用户。不得把它改写成 AI 推断。",
    ...rows,
  ].join("\n\n");
}
