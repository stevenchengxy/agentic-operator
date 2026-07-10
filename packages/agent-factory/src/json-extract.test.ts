import { describe, it, expect } from "vitest";
import { extractBalancedJson } from "./json-extract";
import { chatJson } from "./stream-gateway";

// #JSON-FIX — the «本体理解（确定性骨架·LLM 解析失败已回退）every run» bug: greedy regex + small
// max_tokens truncated Chinese JSON mid-structure and fed unbalanced garbage to JSON.parse.

describe("extractBalancedJson", () => {
  it("extracts a clean object", () => {
    expect(extractBalancedJson('{"a":1}')).toBe('{"a":1}');
  });
  it("tolerates code fences and surrounding prose", () => {
    const t = '好的，这是结果：\n```json\n{"agentsToBuild":[{"action":"createJD"}]}\n```\n以上。';
    expect(JSON.parse(extractBalancedJson(t)!)).toEqual({ agentsToBuild: [{ action: "createJD" }] });
  });
  it("stops at the FIRST balanced structure (greedy regex would span trailing prose braces)", () => {
    const t = '{"verdict":"ok"} 另外备注 {未闭合';
    expect(extractBalancedJson(t)).toBe('{"verdict":"ok"}');
  });
  it("handles braces/brackets inside strings + escaped quotes", () => {
    const t = '{"note":"数组是 [1,2,{x}] 这样","q":"he said \\"}\\" ok"}';
    expect(JSON.parse(extractBalancedJson(t)!)).toEqual({ note: "数组是 [1,2,{x}] 这样", q: 'he said "}" ok' });
  });
  it("supports an array root", () => {
    expect(JSON.parse(extractBalancedJson('前言 [{"agent":"a","issue":"x"}] 后记')!)).toEqual([{ agent: "a", issue: "x" }]);
  });
  it("returns null on a max_tokens-TRUNCATED output (the deterministic-fallback root cause)", () => {
    // truncated mid-string: inner objects closed, top-level never balances — the old greedy regex
    // grabbed first-{…last-inner-} and JSON.parse threw.
    const truncated = '{"agentsToBuild":[{"action":"createJD","responsibility":"生成JD"},{"action":"processResume","respo';
    expect(extractBalancedJson(truncated)).toBeNull();
  });
  it("returns null when there is no JSON at all", () => {
    expect(extractBalancedJson("抱歉，我无法完成该请求。")).toBeNull();
  });
});

describe("chatJson — truncation-aware retry", () => {
  it("retries ONCE with a bigger budget when the first output is truncated, then parses", async () => {
    const calls: Array<{ sys: string; cap?: number }> = [];
    const full = '{"agentsToBuild":[{"action":"createJD","responsibility":"生成JD"}],"ruleGates":["createJD"]}';
    const out = await chatJson<Record<string, unknown>>("SYS", "USER", {
      maxTokens: 1500,
      callFn: async (sys, _usr, o) => {
        calls.push({ sys, cap: o.maxTokens });
        return calls.length === 1 ? full.slice(0, 60) /* truncated */ : full;
      },
    });
    expect(out).toEqual(JSON.parse(full));
    expect(calls.length).toBe(2);
    expect(calls[1]!.cap).toBeGreaterThanOrEqual(6000); // bigger budget on retry
    expect(calls[1]!.sys).toContain("完整"); // stricter complete-JSON instruction appended
  });
  it("parses prose-wrapped JSON on the first attempt (no wasted retry)", async () => {
    let n = 0;
    const out = await chatJson<{ ok: boolean }>("S", "U", {
      callFn: async () => { n++; return '结论如下：\n{"ok":true}\n完毕。'; },
    });
    expect(out).toEqual({ ok: true });
    expect(n).toBe(1);
  });
  it("returns null after both attempts fail (caller keeps its degraded path)", async () => {
    const out = await chatJson("S", "U", { callFn: async () => "彻底不是 JSON" });
    expect(out).toBeNull();
  });
});
