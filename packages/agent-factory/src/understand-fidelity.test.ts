import { describe, expect, it } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

// #UNDERSTAND-FIDELITY — the audit-confirmed defect: the #UNDERSTAND-CACHE hit gated ONLY on
// refresh/focus/content-hash. `args.deep` never participated, and every writer stamped the same
// signature — so a cheap deterministic skeleton (or a single-hop digest) written early would
// silently satisfy a LATER explicit deep:true, the four-dimension full-coverage read would never
// run, and the replay carried no fidelity label. The cache may only serve what it actually meets.

const understand = FACTORY_TOOLS.find((t) => t.name === "understand_ontology")!;

const ont = (): DomainOntology => ({
  domainId: "d",
  source: "allmeta",
  workflow: [],
  objects: [{ id: "o1", name: "Obj" }],
  events: [{ id: "e1", name: "E" }],
  rules: [{ id: "r1", name: "R" }],
  actions: [{ id: "a1", name: "act", actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" }],
} as unknown as DomainOntology);

const mk = (over: Partial<BrainCtx> = {}): BrainCtx => ({
  domain: "d",
  ontology: ont(),
  specs: [],
  emit: () => {},
  conversationId: "c",
  ports: {},
  ...over,
} as unknown as BrainCtx);

describe("#UNDERSTAND-FIDELITY — the cache may only serve a request it actually meets", () => {
  it("a cached SKELETON must NOT satisfy an explicit deep:true (the confirmed bug)", async () => {
    const ctx = mk({
      ontologyUnderstanding: JSON.stringify({ agentsToBuild: ["act"] }),
      ontologyUnderstandingMode: "skeleton",
    });
    // stamp the signature the way a real prior skeleton write would
    const first = await understand.execute({}, mk({ ...ctx }));
    void first;
    ctx.ontologyUnderstandingSig = (await (async () => {
      const probe = mk({});
      await understand.execute({}, probe);
      return probe.ontologyUnderstandingSig;
    })())!;
    const res = await understand.execute({ deep: true }, ctx);
    // must NOT be a cache replay — it has to actually go and do the work
    expect((res.output as { mode?: string })?.mode).not.toBe("cached");
  });

  it("a cached SHALLOW understanding must NOT satisfy deep:true", async () => {
    const probe = mk({});
    await understand.execute({}, probe); // produces a real (skeleton, no gateway) write + sig
    const ctx = mk({
      ontologyUnderstanding: "{\"agentsToBuild\":[]}",
      ontologyUnderstandingMode: "shallow",
      ontologyUnderstandingSig: probe.ontologyUnderstandingSig,
    });
    const res = await understand.execute({ deep: true }, ctx);
    expect((res.output as { mode?: string })?.mode).not.toBe("cached");
  });

  it("a cached lens-aware DEEP understanding DOES satisfy deep:true, and replays fidelity + coverage + lens labels", async () => {
    const probe = mk({});
    await understand.execute({}, probe);
    const coverage = { itemsAnalyzed: 148, itemsTotal: 148, batches: 6, oversized: 0, complete: true };
    const perspectives = {
      selected: [{ id: "operation", label: "运营视角", focus: "…", adapted: true }, { id: "backoffice", label: "后台对账视角", focus: "…", adapted: false }],
      okCount: 2,
      total: 2,
      source: "llm" as const,
    };
    const ctx = mk({
      ontologyUnderstanding: "deep understanding text",
      ontologyUnderstandingMode: "deep",
      ontologyUnderstandingSig: probe.ontologyUnderstandingSig,
      ontologyUnderstandingCoverage: coverage,
      ontologyPerspectives: perspectives,
    });
    const res = await understand.execute({ deep: true }, ctx);
    const out = res.output as { mode?: string; fidelity?: string; coverage?: typeof coverage; perspectives?: typeof perspectives };
    expect(out.mode).toBe("cached");
    expect(out.fidelity).toBe("deep");
    expect(out.coverage).toEqual(coverage); // the disclosure survives the replay
    expect(out.perspectives).toEqual(perspectives); // lens account survives too
    expect(res.summary).toContain("逐条全量覆盖 148/148");
    expect(res.summary).toContain("运营视角"); // replay restates which lenses the understanding carries
  });

  // #PERSPECTIVES-FIDELITY — the lens system versions the deep cache: a deep digest produced BEFORE
  // the lens era (no ontologyPerspectives) must not silently satisfy an explicit deep:true now.
  it("a PRE-LENS deep cache must NOT satisfy deep:true while lenses are enabled", async () => {
    const probe = mk({});
    await understand.execute({}, probe);
    const ctx = mk({
      ontologyUnderstanding: "old deep text (no lens account)",
      ontologyUnderstandingMode: "deep",
      ontologyUnderstandingSig: probe.ontologyUnderstandingSig,
    });
    const res = await understand.execute({ deep: true }, ctx);
    expect((res.output as { mode?: string })?.mode).not.toBe("cached");
  });

  it("with FACTORY_PERSPECTIVES=0 a pre-lens deep cache satisfies deep:true again (kill-switch parity)", async () => {
    process.env.FACTORY_PERSPECTIVES = "0";
    try {
      const probe = mk({});
      await understand.execute({}, probe);
      const ctx = mk({
        ontologyUnderstanding: "old deep text",
        ontologyUnderstandingMode: "deep",
        ontologyUnderstandingSig: probe.ontologyUnderstandingSig,
      });
      const res = await understand.execute({ deep: true }, ctx);
      expect((res.output as { mode?: string })?.mode).toBe("cached");
    } finally {
      delete process.env.FACTORY_PERSPECTIVES;
    }
  });

  it("an honest lens degradation (okCount:0) is still lens-aware and cacheable", async () => {
    const probe = mk({});
    await understand.execute({}, probe);
    const ctx = mk({
      ontologyUnderstanding: "deep text, lenses all failed that day",
      ontologyUnderstandingMode: "deep",
      ontologyUnderstandingSig: probe.ontologyUnderstandingSig,
      ontologyPerspectives: { selected: [{ id: "operation", label: "运营视角", focus: "…", adapted: false }], okCount: 0, total: 3, source: "fallback" },
    });
    const res = await understand.execute({ deep: true }, ctx);
    expect((res.output as { mode?: string })?.mode).toBe("cached");
  });

  it("a non-deep call may still reuse a shallow cache, but the replay LABELS its fidelity", async () => {
    const probe = mk({});
    await understand.execute({}, probe);
    const ctx = mk({
      ontologyUnderstanding: "{}",
      ontologyUnderstandingMode: "shallow",
      ontologyUnderstandingSig: probe.ontologyUnderstandingSig,
    });
    const res = await understand.execute({}, ctx);
    const out = res.output as { mode?: string; fidelity?: string };
    expect(out.mode).toBe("cached");
    expect(out.fidelity).toBe("shallow");
    expect(res.summary).toContain("未做四维分治全量深读"); // honest about what it is
    expect(res.summary).toContain("deep=true"); // and tells the brain how to get the real thing
  });

  it("the skeleton writer stamps skeleton fidelity and clears any stale coverage + lens claims", async () => {
    const ctx = mk({
      ontologyUnderstandingCoverage: { itemsAnalyzed: 1, itemsTotal: 1, batches: 1, oversized: 0, complete: true },
      ontologyPerspectives: { selected: [{ id: "operation", label: "运营视角", focus: "…", adapted: false }], okCount: 1, total: 1, source: "llm" },
    });
    await understand.execute({}, ctx); // no gateway configured in tests → skeleton path
    expect(ctx.ontologyUnderstandingMode).toBe("skeleton");
    expect(ctx.ontologyUnderstandingCoverage).toBeUndefined(); // no fake coverage claim
    expect(ctx.ontologyPerspectives).toBeUndefined(); // #PERSPECTIVES — 非深读不得携带陈旧镜头声明
  });
});

// #AMBIGUITY-COUNT — the audit-confirmed inversion: the policy router recovered the ambiguity count
// by regex-scraping ontologyUnderstanding for "N 处歧义". No successful writer emits that literal
// (it lives in TOOL SUMMARIES), so the count was 0 on every healthy path; it matched ONLY the
// degraded fallback stitch in synthesizeUnderstanding, which concatenates specialist summaries that
// DO contain it. Result: the ask_first route could fire only when synthesis had failed.
describe("#AMBIGUITY-COUNT — the count is recorded as data, never scraped from prose", () => {
  const OLD_SCRAPE = (s?: string) => Number(s?.match(/(\d+)\s*处歧义/)?.[1] ?? 0);

  it("proves the old scrape was inverted: 0 on a healthy deep understanding, non-zero only on the degraded stitch", () => {
    // What synthesizeUnderstanding actually stores on SUCCESS: prose with no such literal.
    const healthy = "本域需要构建 6 个 agent：createJD 负责生成标准化 JD……事件链 REQUIREMENT_LOGGED → JD_GENERATED。";
    expect(OLD_SCRAPE(healthy)).toBe(0); // ← the bug: real ambiguities existed, gate saw none
    // What the DEGRADED fallback stitch stores: specialist summaries, which DO carry the literal.
    const degraded = "【四维分治理解（确定性拼接）】\n· rules 专家：3 项发现 · 1 项风险 · 4 处歧义\n（合成调用失败）";
    expect(OLD_SCRAPE(degraded)).toBe(4); // ← fires only when synthesis FAILED
  });

  it("the deterministic skeleton records a real 0 rather than leaving a stale count", async () => {
    const ctx = mk({ ontologyAmbiguityCount: 7 }); // stale value from a previous ontology
    await understand.execute({}, ctx); // no gateway → skeleton path
    expect(ctx.ontologyAmbiguityCount).toBe(0);
  });
});
