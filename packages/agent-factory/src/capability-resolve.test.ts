import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx, BrainEvent } from "./brain-types";
import type { DomainOntology } from "./ontology-types";
import type { FleetCatalog, LibrarySkill } from "./ports";

// capability_resolve — G1 能力解析门（支柱④「选型优先于制造」，附录 B）。
// Deterministic：无 LLM。断言三面解析（舰队/技能/工具）、复用判定、形态判据、
// 折叠幸存写入（ctx.capabilityResolution）与诚实的未接线降级。

const resolve = FACTORY_TOOLS.find((t) => t.name === "capability_resolve")!;

function ont(): DomainOntology {
  return {
    domainId: "rec",
    objects: [],
    rules: [],
    actions: [
      { id: "1", name: "processResume", actor: ["Agent"], trigger: ["RESUME_DOWNLOADED"], triggered_event: ["RESUME_PROCESSED"], target_objects: [], tool_use: ["parseResumeApi"], system_prompt: "", user_prompt: "", description: "解析简历并锁定归属" },
      { id: "2", name: "syncVendorFeed", actor: ["Agent"], trigger: ["FEED_READY"], triggered_event: ["FEED_SYNCED"], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "", description: "调用第三方 API 同步至供应商系统", integration: { systems: [{ name: "vendor-feed", kind: "external_api", role: "call", capability: "/api/v1/syncVendorFeed" }] } },
      { id: "3", name: "humanReview", actor: ["Human"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" },
    ] as DomainOntology["actions"],
    events: [],
    workflow: [],
    source: "snapshot",
  } as DomainOntology;
}

function mkCtx(opts: { fleet?: FleetCatalog; skills?: LibrarySkill[] }): { ctx: BrainCtx; events: BrainEvent[] } {
  const events: BrainEvent[] = [];
  const ctx = {
    domain: "rec",
    ontology: ont(),
    specs: [],
    emit: (e: BrainEvent) => events.push(e),
    humanDirectives: [],
    ports: {
      fleet: opts.fleet,
      skills: opts.skills ? { list: async () => opts.skills!, save: async () => {}, bumpUse: async () => {}, recordEval: async () => {} } : undefined,
    },
  } as unknown as BrainCtx;
  return { ctx, events };
}

describe("capability_resolve — G1 能力解析门", () => {
  it("fleet name-hit AND trigger/emit flow-hit both count as 复用/组合；Human 动作不解析", async () => {
    const fleet: FleetCatalog = {
      list: async () => [
        { kebabId: "agents-gener-process-resume", name: "processResume", title: "简历处理", enabled: true, trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"], prodRuns: 6, prodFailRate: 0.67 },
        { kebabId: "unrelated-agent", name: "somethingElse", enabled: true, trigger: ["X"], emit: ["Y"] },
      ],
    };
    const { ctx, events } = mkCtx({ fleet });
    const r = await resolve.execute({}, ctx);
    expect(r.ok).toBe(true);
    const rows = (r.output as { rows: Array<{ action: string; decision: string; fleetHits: string[] }> }).rows;
    expect(rows).toHaveLength(2); // humanReview excluded
    const pr = rows.find((x) => x.action === "processResume")!;
    expect(pr.decision).toBe("复用/组合");
    // 人读名字优先（name || title || kebabId）+ G2 生产战绩内联（高失败率带 ⚠）
    expect(pr.fleetHits[0]).toContain("processResume");
    expect(pr.fleetHits[0]).toContain("生产6次");
    expect(pr.fleetHits[0]).toContain("67%失败⚠");
    expect(rows.find((x) => x.action === "syncVendorFeed")!.decision).toBe("新造");
    // fold survivor + reflect event
    expect(ctx.capabilityResolution).toContain("processResume→复用/组合");
    expect(events.some((e) => e.t === "reflect" && (e as { kind?: string }).kind === "capability")).toBe(true);
  });

  it("新造判据来自结构化执行声明，不从描述关键词猜工具", async () => {
    const { ctx } = mkCtx({ fleet: { list: async () => [] } });
    const r = await resolve.execute({}, ctx);
    let rows = (r.output as { rows: Array<{ action: string; makeForm?: string }> }).rows;
    expect(rows.find((x) => x.action === "syncVendorFeed")!.makeForm).toBe("agent+待绑定执行面");
    expect(rows.find((x) => x.action === "processResume")!.makeForm).toBe("agent+tool");

    const sync = ctx.ontology!.actions.find((action) => action.name === "syncVendorFeed")!;
    delete sync.integration;
    const proseOnly = await resolve.execute({}, ctx);
    rows = (proseOnly.output as { rows: Array<{ action: string; makeForm?: string }> }).rows;
    expect(rows.find((x) => x.action === "syncVendorFeed")!.makeForm).toBe("agent");
  });

  it("技能面：CJK 双字重合命中（动作描述 ↔ 技能名/用途）", async () => {
    const skills = [{ slug: "s1", name: "简历解析套路", purpose: "解析简历字段的稳定方法", promptFragment: "", tools: [], useCount: 3 } as unknown as LibrarySkill];
    const { ctx } = mkCtx({ fleet: { list: async () => [] }, skills });
    const r = await resolve.execute({}, ctx);
    const rows = (r.output as { rows: Array<{ action: string; skillHits: string[] }> }).rows;
    expect(rows.find((x) => x.action === "processResume")!.skillHits).toContain("简历解析套路");
  });

  it("舰队端口未接线 → 诚实说明并只按其余面解析（绝不猜）", async () => {
    const { ctx } = mkCtx({});
    const r = await resolve.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain("舰队面未接线");
    expect((r.output as { fleetWired: boolean }).fleetWired).toBe(false);
  });

  it("没读本体时拒绝", async () => {
    const { ctx } = mkCtx({});
    (ctx as { ontology: unknown }).ontology = null;
    const r = await resolve.execute({}, ctx);
    expect(r.ok).toBe(false);
  });
});
