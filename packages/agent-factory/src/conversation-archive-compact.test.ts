// #CONV-ARCHIVE × compaction — the fold's archive-before-drop contract:
//   1. with a configured archive, dropped turns are archived VERBATIM before the fold;
//   2. a FAILING configured archive DEFERS the fold (messages untouched — loss is never silent);
//   3. no archive configured → legacy summary-only fold still works (embedded/test contexts).
import { beforeAll, describe, expect, it } from "vitest";
import { __maybeCompactForTest as maybeCompact } from "./conductor";

// Deterministic folds: no abstractive LLM pass in unit tests.
beforeAll(() => { process.env.FACTORY_COMPACT_ABSTRACTIVE = "0"; });
import type { FactoryConversationArchive, ConversationArchiveEntry } from "./conversation-archive";
import type { BrainCtx } from "./brain-types";
import type { ChatMsg } from "./stream-gateway";

function ctxWith(archive: FactoryConversationArchive | undefined): { ctx: BrainCtx; events: Array<{ t: string; kind?: string }> } {
  const events: Array<{ t: string; kind?: string }> = [];
  const ctx = {
    domain: "test", goal: "g", emit: (e: { t: string; kind?: string }) => events.push(e),
    specs: [], ontology: null, currentPlan: null, toolCatalog: [], realTools: [],
    attemptHistory: {}, createdSkills: [], research: [], priorReflections: [], humanDirectives: [],
    lastSandbox: null, lastValidation: null,
    budget: { maxTokens: null, maxTurns: 99 }, spent: { tokens: 0, turns: 0, sandboxRuns: 0 },
    conversationId: "frn-test-archive",
    ports: { conversationArchive: archive } as unknown as BrainCtx["ports"],
  } as unknown as BrainCtx;
  return { ctx, events };
}

/** Enough messages to trip the count trigger (default FACTORY_COMPACT_AT_MSGS=40). */
function longConversation(): ChatMsg[] {
  const messages: ChatMsg[] = [{ role: "system", content: "sys" }];
  for (let i = 0; i < 45; i++) {
    messages.push({ role: i % 2 ? "assistant" : "user", content: `第${i}轮：讨论人工边界与规则工具选择细节 ${i}` });
  }
  return messages;
}

describe("#CONV-ARCHIVE — maybeCompact archives before folding", () => {
  it("archives the dropped turns verbatim, then folds (recent turns + summary remain)", async () => {
    const appended: ConversationArchiveEntry[][] = [];
    const archive: FactoryConversationArchive = {
      append: async (_id, entries) => { appended.push(entries); },
      search: async () => [], count: async () => 0,
    };
    const { ctx } = ctxWith(archive);
    const messages = longConversation();
    const before = messages.length;
    const compacted = await maybeCompact(messages, ctx);
    expect(compacted).toBe(true);
    expect(messages.length).toBeLessThan(before);
    // every dropped turn is in the archive batch, verbatim
    expect(appended).toHaveLength(1);
    const batch = appended[0]!;
    expect(batch.length).toBe(before - messages.length + 1); // dropped = before - (system+summary+recent) + summary slot
    expect(batch[0]!.content).toContain("第0轮");
    expect(batch.every((entry) => entry.foldSeq === 1)).toBe(true);
    expect(ctx.compactionFolds).toBe(1);
  });

  it("a FAILING configured archive defers the fold — messages untouched, a visible reflect event fires", async () => {
    const archive: FactoryConversationArchive = {
      append: async () => { throw new Error("archive disk full"); },
      search: async () => [], count: async () => 0,
    };
    const { ctx, events } = ctxWith(archive);
    const messages = longConversation();
    const before = messages.length;
    const compacted = await maybeCompact(messages, ctx);
    expect(compacted).toBe(false);
    expect(messages.length).toBe(before); // nothing dropped
    expect(ctx.compactionFolds ?? 0).toBe(0); // failed fold does not consume a sequence number
    expect(events.some((e) => e.t === "reflect" && e.kind === "compact-archive-failed")).toBe(true);
  });

  it("no archive configured → legacy summary-only fold (back-compat for embedded contexts)", async () => {
    const { ctx } = ctxWith(undefined);
    const messages = longConversation();
    const compacted = await maybeCompact(messages, ctx);
    expect(compacted).toBe(true);
    expect(String(messages[1]!.content)).toContain("已折叠早期对话");
  });
});
