import { describe, expect, it } from "vitest";
import {
  estimateContextUsage,
  planProviderCall,
  serializeToolResultForContext,
  shouldCompactContext,
} from "./context-budget";

describe("context and provider budget helpers", () => {
  it("keeps an oversized structured tool result parseable after truncation", () => {
    const serialized = serializeToolResultForContext(
      {
        summary: "large ontology result",
        output: {
          actions: Array.from({ length: 500 }, (_, index) => ({
            id: index,
            description: `action-${index}-${"x".repeat(80)}`,
          })),
        },
      },
      1_200,
    );

    expect(serialized.length).toBeLessThanOrEqual(1_200);
    const parsed = JSON.parse(serialized) as {
      summary: string;
      output: {
        truncated: boolean;
        originalType: string;
        originalChars: number;
        preview: string;
      };
    };
    expect(parsed.summary).toBe("large ontology result");
    expect(parsed.output.truncated).toBe(true);
    expect(parsed.output.originalType).toBe("object");
    expect(parsed.output.originalChars).toBeGreaterThan(parsed.output.preview.length);
  });

  it("requests compaction for fewer than 40 messages when payload chars/tokens are large", () => {
    const messages = [
      { role: "system", content: "system" },
      { role: "user", content: "inspect" },
      { role: "assistant", content: "x".repeat(20_000) },
      { role: "user", content: "continue" },
    ];
    const usage = estimateContextUsage(messages);

    expect(messages.length).toBeLessThan(40);
    expect(usage.estimatedTokens).toBeGreaterThan(1_000);
    expect(
      shouldCompactContext(messages, {
        maxMessages: 40,
        maxChars: 4_000,
        maxEstimatedTokens: 1_000,
      }),
    ).toBe(true);
  });

  it("returns a reusable pre-call reserve plan across multiple ledgers", () => {
    expect(
      planProviderCall({
        ledgers: [
          { scope: "conversation", spentTokens: 9_400, maxTokens: 10_000 },
          { scope: "run-tree", spentTokens: 100, maxTokens: 20_000 },
        ],
        promptTokens: 500,
        reserveTokens: 200,
      }),
    ).toMatchObject({
      allowed: false,
      completionTokenCap: 0,
      limitingScope: "conversation",
      remainingTokens: 600,
    });
  });
});
