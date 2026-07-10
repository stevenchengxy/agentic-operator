import { describe, it, expect } from "vitest";
import { isStopIntent } from "./intent";

describe("isStopIntent", () => {
  it("recognizes bare stop commands", () => {
    for (const t of ["停止", "停下", "停一下", "暂停", "取消", "别跑了", "停掉", "中止", "stop", "Stop", "cancel", "abort"]) {
      expect(isStopIntent(t)).toBe(true);
    }
  });
  it("does NOT fire on negations / 'keep going'", () => {
    for (const t of ["不要停", "别停", "继续", "don't stop", "keep going"]) {
      expect(isStopIntent(t)).toBe(false);
    }
  });
  it("does NOT fire on long sentences that merely contain a stop word", () => {
    expect(isStopIntent("先别急着停止，我想先看看本体里有哪些动作和事件再决定")).toBe(false);
    expect(isStopIntent("讲讲我们这个领域的 Ontology")).toBe(false);
    expect(isStopIntent("为这个业务域生成能跑通的智能体")).toBe(false);
  });
});
