import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agentMemoryLong, and, eq, getDb, tenants } from "@agentic/db";
import { makeFactoryPorts } from "../src/services/agent-factory";

// #MEM-CAP — 记忆召回（#MEM-RECALL）上线后，无界的每域事实增长从"占地"变成"有害"（召回质量被
// 噪音稀释）。上限语义：新 key 且已达上限 → 按 updatedAt 逐出最旧；UPDATE 既有 key 永不逐出。

const suffix = Date.now().toString(36);
const tenant = { id: `ten-memcap-${suffix}`, slug: `memcap${suffix}`.slice(0, 60) };
const domain = `memcap-domain-${suffix}`;

const scope = () =>
  and(
    eq(agentMemoryLong.tenantId, tenant.id),
    eq(agentMemoryLong.agentName, "factory"),
    eq(agentMemoryLong.subject, domain),
  );

const rows = () => getDb().select().from(agentMemoryLong).where(scope()).all();

describe("factory memory #MEM-CAP", () => {
  beforeAll(() => {
    getDb().insert(tenants).values([{ id: tenant.id, slug: tenant.slug, name: "MemCap" }]).run();
  });

  afterAll(() => {
    getDb().delete(agentMemoryLong).where(scope()).run();
    getDb().delete(tenants).where(eq(tenants.id, tenant.id)).run();
  });

  afterEach(() => {
    delete process.env.FACTORY_MEMORY_MAX_FACTS;
  });

  it("新 key 超限逐出最旧；UPDATE 既有 key 不逐出", async () => {
    process.env.FACTORY_MEMORY_MAX_FACTS = "3";
    const memory = makeFactoryPorts(tenant.slug, tenant.id, domain).memory!;
    await memory.put(domain, "fact-a", "事实 A 的内容");
    await memory.put(domain, "fact-b", "事实 B 的内容");
    await memory.put(domain, "fact-c", "事实 C 的内容");
    expect(rows().length).toBe(3);
    // 人为把 fact-a 标成最旧（同毫秒写入时排序不稳，测试固定受害者）
    getDb()
      .update(agentMemoryLong)
      .set({ updatedAt: new Date(Date.now() - 60_000) })
      .where(and(scope(), eq(agentMemoryLong.key, "fact-a")))
      .run();
    // 达上限时 UPDATE 既有 key：不逐出任何行
    await memory.put(domain, "fact-b", "事实 B 更新后的内容");
    expect(rows().length).toBe(3);
    expect(rows().map((r) => r.key).sort()).toEqual(["fact-a", "fact-b", "fact-c"]);
    // 新 key 进入 → 最旧的 fact-a 被逐出
    await memory.put(domain, "fact-d", "事实 D 的内容");
    const keys = rows().map((r) => r.key).sort();
    expect(keys.length).toBe(3);
    expect(keys).toEqual(["fact-b", "fact-c", "fact-d"]);
  });

  it("默认上限 200：常规写入不受影响", async () => {
    const memory = makeFactoryPorts(tenant.slug, tenant.id, domain).memory!;
    await memory.put(domain, "fact-normal", "常规事实");
    expect(rows().some((r) => r.key === "fact-normal")).toBe(true);
  });

  // #MEM-GENERAL (P2) — __general__ 哨兵豁免域校验：通用道方法论可跨域写入/读取。
  it("__general__ 哨兵不触发 domain mismatch；行落 subject=__general__；search 过域门后才因缺驱动失败", async () => {
    const memory = makeFactoryPorts(tenant.slug, tenant.id, domain).memory!;
    await memory.put("__general__", "probe-first", "先探活接口真实信封再写 normalizer");
    const generalRows = getDb()
      .select()
      .from(agentMemoryLong)
      .where(and(
        eq(agentMemoryLong.tenantId, tenant.id),
        eq(agentMemoryLong.agentName, "factory"),
        eq(agentMemoryLong.subject, "__general__"),
      ))
      .all();
    expect(generalRows.some((r) => r.key === "probe-first")).toBe(true);
    // search 的哨兵也放行域门（测试环境无向量驱动 → 报驱动缺失而非 domain mismatch，证明门已过）
    await expect(memory.search("__general__", "任意查询", 3)).rejects.toThrow(/vector driver/);
    await memory.del("__general__", "probe-first");
    expect(
      getDb().select().from(agentMemoryLong)
        .where(and(eq(agentMemoryLong.tenantId, tenant.id), eq(agentMemoryLong.subject, "__general__"), eq(agentMemoryLong.key, "probe-first")))
        .all().length,
    ).toBe(0);
  });
});
