import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq, factorySkills, getDb, tenants } from "@agentic/db";
import { DrizzleSkillStore } from "../src/services/agent-factory";
import { runSkillPromotionSweep } from "../src/services/agent-factory/fleet-governance-runner";

// #SKILL-PROMOTE (P2) — P7 治理巡检挂载的通用道晋升：跨 ≥2 域验证有效的技能自动落一份
// general 行（domainKey=""）。召回侧零改动（DrizzleSkillStore.list 早已并入 general 行）。

const suffix = Date.now().toString(36);
const tenant = { id: `ten-skprom-${suffix}`, slug: `skprom${suffix}`.slice(0, 60) };

const seedSkill = async (domain: string, evalCount: number, successCount: number, frag: string) => {
  await new DrizzleSkillStore(tenant.id, domain).save({
    slug: "gate-fetch-rules-first",
    name: "闸口先取规则",
    purpose: "闸口 agent 先 fetch 规则再判定，避免凭记忆放行",
    promptFragment: frag,
    tools: [],
    decisionRule: "动作是规则闸口时",
    domain,
  });
  getDb()
    .update(factorySkills)
    .set({ evalCount, successCount })
    .where(and(eq(factorySkills.scopeKey, tenant.id), eq(factorySkills.domainKey, domain), eq(factorySkills.slug, "gate-fetch-rules-first")))
    .run();
};

const generalRows = () =>
  getDb()
    .select()
    .from(factorySkills)
    .where(and(eq(factorySkills.scopeKey, tenant.id), eq(factorySkills.domainKey, "")))
    .all();

describe("factory skill promotion sweep (#SKILL-PROMOTE)", () => {
  beforeAll(() => {
    getDb().insert(tenants).values([{ id: tenant.id, slug: tenant.slug, name: "SkillProm" }]).run();
  });

  afterAll(() => {
    getDb().delete(factorySkills).where(eq(factorySkills.scopeKey, tenant.id)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenant.id)).run();
  });

  afterEach(() => {
    delete process.env.FACTORY_SKILL_PROMOTION;
  });

  it("跨 2 域达标 → 落 general 行（赢家内容）；重跑幂等；随后 list 任意域可见", async () => {
    await seedSkill("domA", 5, 4, "domA 片段"); // 5/7 ≈ 0.714
    await seedSkill("domB", 6, 5, "domB 赢家片段"); // 6/8 = 0.75
    const r1 = await runSkillPromotionSweep(tenant.slug);
    expect(r1.promoted).toBe(1);
    const rows = generalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.promptFragment).toBe("domB 赢家片段");
    expect(rows[0]!.domain).toBeNull();
    // 幂等：general 已存在 → 二次巡检零晋升、不报错
    const r2 = await runSkillPromotionSweep(tenant.slug);
    expect(r2.promoted).toBe(0);
    expect(generalRows()).toHaveLength(1);
    // 召回侧：第三个域 list 也能看到 general 行（早已建成的合并逻辑）
    const seen = await new DrizzleSkillStore(tenant.id, "domC").list("domC");
    expect(seen.some((s) => s.slug === "gate-fetch-rules-first" && s.domain === null)).toBe(true);
  });

  it("FACTORY_SKILL_PROMOTION=0 → 巡检不晋升", async () => {
    getDb().delete(factorySkills).where(and(eq(factorySkills.scopeKey, tenant.id), eq(factorySkills.domainKey, ""))).run();
    process.env.FACTORY_SKILL_PROMOTION = "0";
    const r = await runSkillPromotionSweep(tenant.slug);
    expect(r.promoted).toBe(0);
    expect(generalRows()).toHaveLength(0);
  });

  it("未知租户 slug → 明确报错字段而非静默空转", async () => {
    const r = await runSkillPromotionSweep(`no-such-${suffix}`);
    expect(r.promoted).toBe(0);
    expect(r.error).toMatch(/tenant/i);
  });
});
