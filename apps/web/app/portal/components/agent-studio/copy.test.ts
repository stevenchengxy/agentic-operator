import { describe, expect, it, vi } from "vitest";

import { studioCopyKey, studioHelp, studioLocale, studioUi } from "./copy";

describe("Agent Studio localized copy helpers", () => {
  it("creates stable, namespace-specific keys", () => {
    expect(studioCopyKey("agentStudioUi", "Agent")).toBe(
      "agentStudioUi.copy.k1w5o8jq",
    );
    expect(studioCopyKey("agentStudioHelp", "Agent")).toBe(
      "agentStudioHelp.copy.k1w5o8jq",
    );
  });

  it("passes interpolation variables through the shared translator", () => {
    const t = vi.fn((key: string) => `translated:${key}`);
    const vars = { count: 2 };

    expect(studioUi(t, "{count} issues", vars)).toMatch(
      /^translated:agentStudioUi\.copy\.k/,
    );
    expect(studioHelp(t, "{count} topics", vars)).toMatch(
      /^translated:agentStudioHelp\.copy\.k/,
    );
    expect(t).toHaveBeenNthCalledWith(1, expect.any(String), vars);
    expect(t).toHaveBeenNthCalledWith(2, expect.any(String), vars);
  });

  it("uses browser-compatible locale tags", () => {
    expect(studioLocale("en")).toBe("en-US");
    expect(studioLocale("zh")).toBe("zh-CN");
  });
});
