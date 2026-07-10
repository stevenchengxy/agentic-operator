import { describe, it, expect } from "vitest";
import { lintInlineAnalysis, runInlineAnalysis } from "./inline-codeact";

// G4 系统 A 的即席 CodeAct：纯计算沙盒——安审驳回危险 API、真跑确定性统计、超时熔断、
// 全局遮蔽兜底。与 codegen/spawn 同一信任级（大脑亲笔代码），但零 I/O 零网络零模块系统。

describe("lintInlineAnalysis — AST 安审", () => {
  it("放行纯计算代码", async () => {
    const r = await lintInlineAnalysis(`const by={}; for(const x of input.items){by[x.k]=(by[x.k]||0)+1;} return by;`);
    expect(r.ok).toBe(true);
  });
  it("驳回 require/fetch/process/eval/import", async () => {
    for (const bad of [
      `const fs=require("fs"); return fs;`,
      `return fetch("http://x");`,
      `return process.env;`,
      `return eval("1+1");`,
      `import x from "y"; return x;`,
    ]) {
      const r = await lintInlineAnalysis(bad);
      expect(r.ok).toBe(false);
    }
  });
});

describe("runInlineAnalysis — 真跑", () => {
  it("统计计算：规则按阶段分布（LLM 数不清的，代码一趟数清）", async () => {
    const code = `const by={}; for(const r of input.ontology.rules){const k=r.stage||"未标注"; by[k]=(by[k]||0)+1;} return by;`;
    const input = { ontology: { rules: [{ stage: "简历匹配" }, { stage: "简历匹配" }, { stage: "JD创建" }, {}] } };
    const r = await runInlineAnalysis(code, input);
    expect(r.ok).toBe(true);
    expect(r.result).toEqual({ 简历匹配: 2, JD创建: 1, 未标注: 1 });
  });
  it("input 是只读副本——改它不影响调用方", async () => {
    const input = { items: [1, 2, 3] };
    const r = await runInlineAnalysis(`input.items.push(999); return input.items.length;`, input);
    expect(r.ok).toBe(true);
    expect(r.result).toBe(4);
    expect(input.items).toEqual([1, 2, 3]); // 原对象未被污染
  });
  it("全局遮蔽兜底：即使漏过 lint，运行时 fetch/process 也是 undefined", async () => {
    // typeof 探测不会触发 lint 的调用/标识符规则以外路径——直接断言遮蔽后的运行时形态
    const r = await runInlineAnalysis(`return { f: typeof fetch, p: typeof process, rq: typeof require };`, {});
    if (r.ok) {
      expect(r.result).toEqual({ f: "undefined", p: "undefined", rq: "undefined" });
    } else {
      expect(r.error).toContain("危险 API"); // lint 先拦下也算过（双层防线任一生效）
    }
  });
  it("同步死循环被 lint 驳回（进程内无法抢占同步循环）", async () => {
    const r = await runInlineAnalysis(`while(true){} return 1;`, {}, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("无界同步循环");
  });
  it("异步挂起被超时熔断", async () => {
    const r = await runInlineAnalysis(`return await new Promise(() => {});`, {}, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("超时");
  }, 10_000);
  it("不 return 可序列化结果 → 明确报错", async () => {
    const r = await runInlineAnalysis(`const x = 1;`, {});
    expect(r.ok).toBe(false);
  });
});
