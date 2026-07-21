import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import { composeFactoryGoal, isFactoryRunStartReceipt, replayModeForStart } from "./factory-run-start";

const t = (key: string, vars?: Record<string, string | number>) => translate("zh", key, vars);

describe("composeFactoryGoal", () => {
  it("preserves document content beyond the old 3000-character cutoff", () => {
    const tail = "TAIL_AFTER_3000";
    const text = `${"x".repeat(3_500)}${tail}`;
    const result = composeFactoryGoal(t, "生成真实工具", [{ name: "api.md", text }]);

    expect(result).toContain(text);
    expect(result).toContain(tail);
    expect(result).toContain("生成真实工具");
  });

  it("keeps multiple documents ordered and unmodified", () => {
    const result = composeFactoryGoal(t, "", [
      { name: "one.txt", text: "FIRST\nLINE" },
      { name: "two.txt", text: "SECOND" },
    ]);

    expect(result.indexOf("FIRST\nLINE")).toBeLessThan(result.indexOf("SECOND"));
    expect(result).toContain("据此为当前运行领域生成能真正跑通的智能体并验证整条事件链。");
  });

  it("returns a plain operator goal when no documents are attached", () => {
    expect(composeFactoryGoal(t, "  只回答问题  ", [])).toBe("只回答问题");
  });
});

describe("isFactoryRunStartReceipt", () => {
  it("accepts a newly started driver receipt", () => {
    expect(isFactoryRunStartReceipt({
      runId: "factory-raas-domain-1",
      mode: "started",
    })).toBe(true);
  });

  it("accepts an attached live-run receipt", () => {
    expect(isFactoryRunStartReceipt({
      runId: "factory-raas-domain-1",
      mode: "attached",
    })).toBe(true);
  });

  it("rejects an unknown mode", () => {
    expect(isFactoryRunStartReceipt({
      runId: "factory-raas-domain-1",
      mode: "queued",
    })).toBe(false);
  });

  it("appends only a started follow-up turn and replaces an attached full replay", () => {
    expect(replayModeForStart({ runId: "run-1", mode: "started" }, true)).toBe("append");
    expect(replayModeForStart({ runId: "run-1", mode: "started" }, false)).toBe("replace");
    expect(replayModeForStart({ runId: "run-1", mode: "attached" }, true)).toBe("replace");
  });
});
