import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { factoryDomainInsights, getDb, tenants } from "@agentic/db";
import { DrizzleDomainInsightStore } from "../src/services/agent-factory/stores";

// #KNOW-PACK (P1-A) — 领域分析包 store：按 (tenant, domain, 本体内容哈希) 跨会话持久化
// understand_ontology 的深读产物。哈希失效=按当前哈希查不到即 miss（隐式失效）；
// 防降级=已有 deep 行时 shallow 不覆盖；修剪=每 (tenant, domain) 只留最新 5 个 sig。

const suffix = Date.now().toString(36);
const tenantA = { id: `ten-fdi-a-${suffix}`, slug: `fdia${suffix}`.slice(0, 60) };
const tenantB = { id: `ten-fdi-b-${suffix}`, slug: `fdib${suffix}`.slice(0, 60) };
const domain = `insight-domain-${suffix}`;

const coverage = { itemsAnalyzed: 148, itemsTotal: 148, batches: 6, oversized: 0, complete: true };
const perspectives = {
  selected: [{ id: "operation", label: "运营视角", focus: "…", adapted: true }],
  okCount: 1,
  total: 1,
  source: "llm" as const,
};

const rowsFor = (tenantId: string) =>
  getDb()
    .select()
    .from(factoryDomainInsights)
    .where(and(eq(factoryDomainInsights.tenantId, tenantId), eq(factoryDomainInsights.domain, domain)))
    .all();

describe("factory domain insight store (#KNOW-PACK)", () => {
  beforeAll(() => {
    getDb().insert(tenants).values([
      { id: tenantA.id, slug: tenantA.slug, name: "Insight A" },
      { id: tenantB.id, slug: tenantB.slug, name: "Insight B" },
    ]).run();
  });

  afterAll(() => {
    getDb().delete(factoryDomainInsights).where(eq(factoryDomainInsights.domain, domain)).run();
    for (const t of [tenantA, tenantB]) {
      getDb().delete(tenants).where(eq(tenants.id, t.id)).run();
    }
  });

  it("roundtrips a deep pack with coverage + perspectives + ambiguity count", async () => {
    const store = new DrizzleDomainInsightStore(tenantA.id, domain);
    await store.save({ domain, ontologySig: "sig-1", mode: "deep", digest: "深读理解正文", coverage, perspectives, ambiguityCount: 3 });
    const pack = await store.load(domain, "sig-1");
    expect(pack).toMatchObject({ domain, ontologySig: "sig-1", mode: "deep", digest: "深读理解正文", ambiguityCount: 3 });
    expect(pack!.coverage).toEqual(coverage);
    expect(pack!.perspectives).toEqual(perspectives);
    expect(typeof pack!.updatedAt).toBe("string");
  });

  it("upserts by (tenant, domain, sig): second save updates in place, row count stays 1", async () => {
    const store = new DrizzleDomainInsightStore(tenantA.id, domain);
    await store.save({ domain, ontologySig: "sig-up", mode: "deep", digest: "v1", ambiguityCount: 0 });
    await store.save({ domain, ontologySig: "sig-up", mode: "deep", digest: "v2", ambiguityCount: 1 });
    const rows = rowsFor(tenantA.id).filter((r) => r.ontologySig === "sig-up");
    expect(rows.length).toBe(1);
    expect((await store.load(domain, "sig-up"))!.digest).toBe("v2");
  });

  it("misses on a different sig (implicit invalidation when the ontology changes)", async () => {
    const store = new DrizzleDomainInsightStore(tenantA.id, domain);
    expect(await store.load(domain, "sig-never-written")).toBeNull();
  });

  it("isolates tenants and enforces expectedDomain", async () => {
    const a = new DrizzleDomainInsightStore(tenantA.id, domain);
    await a.save({ domain, ontologySig: "sig-iso", mode: "shallow", digest: "a 的浅读" });
    expect(await new DrizzleDomainInsightStore(tenantB.id, domain).load(domain, "sig-iso")).toBeNull();
    expect(await a.load(`${domain}-other`, "sig-iso")).toBeNull();
    await expect(a.save({ domain: `${domain}-other`, ontologySig: "x", mode: "shallow", digest: "y" })).rejects.toThrow(/mismatch/);
  });

  it("a shallow save never downgrades an existing deep row for the same sig", async () => {
    const store = new DrizzleDomainInsightStore(tenantA.id, domain);
    await store.save({ domain, ontologySig: "sig-dg", mode: "deep", digest: "深读", coverage, perspectives, ambiguityCount: 2 });
    await store.save({ domain, ontologySig: "sig-dg", mode: "shallow", digest: "浅读覆盖尝试" });
    const pack = await store.load(domain, "sig-dg");
    expect(pack!.mode).toBe("deep");
    expect(pack!.digest).toBe("深读");
    // 反向仍允许：deep 覆盖 shallow（升级）
    await store.save({ domain, ontologySig: "sig-dg2", mode: "shallow", digest: "浅" });
    await store.save({ domain, ontologySig: "sig-dg2", mode: "deep", digest: "深", coverage, ambiguityCount: 0 });
    expect((await store.load(domain, "sig-dg2"))!.mode).toBe("deep");
  });

  it("prunes to the newest 5 sigs per (tenant, domain)", async () => {
    const store = new DrizzleDomainInsightStore(tenantA.id, domain);
    for (let i = 0; i < 8; i++) {
      await store.save({ domain, ontologySig: `sig-prune-${i}`, mode: "shallow", digest: `d${i}` });
    }
    const rows = rowsFor(tenantA.id);
    expect(rows.length).toBe(5);
    // 最新的 sig 一定活着（其余 3 个早写的 sig 及本用例前写入的行都被修剪）
    expect(await store.load(domain, "sig-prune-7")).not.toBeNull();
    expect(await store.load(domain, "sig-prune-0")).toBeNull();
  });

  it("caps digest at 10k chars on write (same cap as ctx.ontologyUnderstanding)", async () => {
    const store = new DrizzleDomainInsightStore(tenantA.id, domain);
    await store.save({ domain, ontologySig: "sig-cap", mode: "deep", digest: "长".repeat(12_000), perspectives, ambiguityCount: 0 });
    expect((await store.load(domain, "sig-cap"))!.digest.length).toBe(10_000);
  });
});
