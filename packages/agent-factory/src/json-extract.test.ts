import { describe, it, expect } from "vitest";
import { extractBalancedJson } from "./json-extract";
import { chatJson, chatJsonResult, isTransientLlmError } from "./stream-gateway";

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

// #JSON-DIAG 回归 —— 旧版把【网关故障】与【模型没写出 JSON】折成同一个 null，调用方无法区分，
// 于是网关 503 被逐字报成"网关空响应或格式错误"（还去问用户，用户根本答不了）。
describe("chatJsonResult — 失败要说清是谁的问题", () => {
  it("网关抛错 = llm_error 且能识别 transient（不是模型输出问题）", async () => {
    const r = await chatJsonResult("S", "U", {
      callFn: async () => { throw new Error("503 system cpu overloaded"); },
    });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.failure.kind).toBe("llm_error");
    if (r.failure.kind !== "llm_error") throw new Error("unreachable");
    expect(r.failure.transient).toBe(true);
    expect(r.failure.message).toContain("503");
  });

  it("非 transient 的网关错误（鉴权）不会被误标成可重试", async () => {
    const r = await chatJsonResult("S", "U", { callFn: async () => { throw new Error("401 invalid api key"); } });
    expect(r.ok).toBe(false);
    if (r.ok || r.failure.kind !== "llm_error") throw new Error("unreachable");
    expect(r.failure.transient).toBe(false);
  });

  it("空响应 ≠ 格式错误", async () => {
    const r = await chatJsonResult("S", "U", { callFn: async () => "   " });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.failure.kind).toBe("empty_output");
  });

  it("模型讲道理但没吐 JSON = no_json（带样本便于诊断）", async () => {
    const r = await chatJsonResult("S", "U", { callFn: async () => "抱歉，我无法完成该请求。" });
    expect(r.ok).toBe(false);
    if (r.ok || r.failure.kind !== "no_json") throw new Error("unreachable");
    expect(r.failure.sample).toContain("抱歉");
  });

  it("截断 = invalid_json（两次都截断后如实报，而不是笼统说'空响应'）", async () => {
    const truncated = '{"phases":[{"id":"p1","title":"接收","intent":"收到需求后建档立卡以便后续处理","anchors":[{"kind":"acti';
    const r = await chatJsonResult("S", "U", { maxTokens: 100, callFn: async () => truncated });
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    // 截断片段里的内层对象会先闭合 → 提取到不完整片段 → 解析失败；无论落到哪一档，
    // 都必须是"模型输出问题"而【不是】llm_error（网关没坏）。
    expect(["invalid_json", "no_json"]).toContain(r.failure.kind);
  });

  it("成功时与 chatJson 等价（控制流没被我改坏：仍是失败一次→加大预算重试一次）", async () => {
    const calls: number[] = [];
    const full = '{"ok":true}';
    const r = await chatJsonResult<{ ok: boolean }>("SYS", "USER", {
      maxTokens: 1500,
      callFn: async (_s, _u, o) => { calls.push(o.maxTokens ?? 0); return calls.length === 1 ? "还没想好" : full; },
    });
    expect(r).toEqual({ ok: true, value: { ok: true } });
    expect(calls.length).toBe(2);
    expect(calls[1]).toBeGreaterThanOrEqual(6000);
  });
});

describe("isTransientLlmError", () => {
  it("认得上游波动，不把逻辑错误当波动", () => {
    for (const m of ["503 system cpu overloaded", "Rate limit exceeded", "socket hang up", "request timed out", "ECONNRESET"]) {
      expect(isTransientLlmError(m)).toBe(true);
    }
    for (const m of ["401 unauthorized", "invalid api key", "model not found"]) {
      expect(isTransientLlmError(m)).toBe(false);
    }
  });
});
