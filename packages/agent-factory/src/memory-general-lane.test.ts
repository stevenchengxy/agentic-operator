import { describe, expect, it } from "vitest";
import { consolidateRunMemory, extractMemoryFacts, renderMemoryRecall } from "./memory-consolidation";
import { GENERAL_MEMORY_SUBJECT } from "./ports";
import type { FactoryMemoryPort } from "./ports";

// #MEM-GENERAL (P2) — 跨域通用记忆道：提取器给每条事实标 scope（domain=本域业务事实 /
// general=跨域方法论），consolidation 分道写入（通用道 subject=__general__），召回帧标 (通用)。
// 领域分析包永远严格 domain+hash 域内；通用道只运载方法论。

function laneAwareMemory(): FactoryMemoryPort & {
  searches: Array<{ domain: string; k: number }>;
  puts: Array<{ domain: string; key: string }>;
} {
  const searches: Array<{ domain: string; k: number }> = [];
  const puts: Array<{ domain: string; key: string }> = [];
  return {
    searches,
    puts,
    async search(domain, _q, k) {
      searches.push({ domain, k });
      return [];
    },
    async put(domain, key) {
      puts.push({ domain, key });
    },
    async del() {},
  };
}

describe("#MEM-GENERAL — extractMemoryFacts scope 字段", () => {
  it("解析 scope=general；缺省/非法值回落 domain", async () => {
    const llm = async () =>
      JSON.stringify([
        { key: "vendor-envelope", value: "vendor 接口信封常嵌套两层，读 data.data 才是业务载荷", scope: "general" },
        { key: "domain-fact", value: "该域 JD 创建后必须人工审批才能发布" },
        { key: "weird-scope", value: "scope 非法时按本域事实处理，避免误入通用道", scope: "everything" },
      ]);
    const facts = await extractMemoryFacts("dom", "digest", { llm });
    expect(facts.map((f) => f.scope)).toEqual(["general", "domain", "domain"]);
  });

  it("提取提示词向模型说明通用道语义（跨域方法论）", async () => {
    let seenSys = "";
    const llm = async (sys: string) => {
      seenSys = sys;
      return "[]";
    };
    await extractMemoryFacts("dom", "digest", { llm });
    expect(seenSys).toContain("general");
    expect(seenSys).toContain("跨域");
  });
});

describe("#MEM-GENERAL — consolidateRunMemory 分道写入", () => {
  it("domain 事实走本域、general 事实走 __general__（检索与写入都分道）", async () => {
    const mem = laneAwareMemory();
    let call = 0;
    const llm = async (): Promise<string> => {
      call++;
      if (call === 1) {
        return JSON.stringify([
          { key: "domain-fact", value: "该域 JD 创建后必须人工审批才能发布", scope: "domain" },
          { key: "vendor-envelope", value: "vendor 接口信封常嵌套两层，读 {payload_path} 才是业务载荷", scope: "general" },
        ]);
      }
      // 每道各自一次 decide：按本道事实回 ADD
      if (call === 2) return JSON.stringify([{ op: "ADD", key: "domain-fact", value: "该域 JD 创建后必须人工审批才能发布" }]);
      return JSON.stringify([{ op: "ADD", key: "vendor-envelope", value: "vendor 接口信封常嵌套两层，读 {payload_path} 才是业务载荷" }]);
    };
    const res = await consolidateRunMemory({ domain: "dom", digest: "…", memory: mem, llm });
    expect(res.extracted).toBe(2);
    expect(res.written).toBe(2);
    expect(call).toBe(3); // 1 extract + 2 decide（每道一次）
    expect(mem.searches.map((s) => s.domain)).toEqual(["dom", GENERAL_MEMORY_SUBJECT]);
    expect(mem.puts).toEqual([
      { domain: "dom", key: "domain-fact" },
      { domain: GENERAL_MEMORY_SUBJECT, key: "vendor-envelope" },
    ]);
  });

  it("全部 general → 本域道零调用（不空转 decide）", async () => {
    const mem = laneAwareMemory();
    let call = 0;
    const llm = async (): Promise<string> => {
      call++;
      if (call === 1) return JSON.stringify([{ key: "method", value: "先探活接口真实信封再写 normalizer，别信文档", scope: "general" }]);
      return JSON.stringify([{ op: "ADD", key: "method", value: "先探活接口真实信封再写 normalizer，别信文档" }]);
    };
    const res = await consolidateRunMemory({ domain: "dom", digest: "…", memory: mem, llm });
    expect(res.written).toBe(1);
    expect(call).toBe(2); // 1 extract + 1 decide（只有通用道）
    expect(mem.searches.map((s) => s.domain)).toEqual([GENERAL_MEMORY_SUBJECT]);
    expect(mem.puts[0]!.domain).toBe(GENERAL_MEMORY_SUBJECT);
  });
});

describe("#MEM-GENERAL — 召回帧通用标记", () => {
  it("general 命中渲染为 (通用·key)，本域命中不带标", () => {
    const frame = renderMemoryRecall([
      { key: "domain-fact", value: "该域 JD 创建后必须人工审批才能发布", score: 0.8 },
      { key: "vendor-envelope", value: "vendor 接口信封常嵌套两层，读 data.data 才是业务载荷", score: 0.7, general: true },
    ]);
    expect(frame).toContain("(domain-fact)");
    expect(frame).toContain("(通用·vendor-envelope)");
  });
});
