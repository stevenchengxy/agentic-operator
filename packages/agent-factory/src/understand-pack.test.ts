import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BrainCtx, BrainEvent } from "./brain-types";
import type { DomainOntology } from "./ontology-types";
import type { DomainInsightPack, DomainInsightStore } from "./ports";
import { ontologyContentHash } from "./evidence-fingerprint";

// #KNOW-PACK (P1-A) — understand_ontology 的跨会话读穿/写穿 + read_ontology 预载。
// 保真纪律与 #UNDERSTAND-FIDELITY / #PERSPECTIVES-FIDELITY 完全同形：
//   · 浅包不满足 deep:true；无镜头的深包在镜头开启时不满足显式 deep:true；
//   · refresh/focus 旁路持久层，与旁路 ctx 缓存一致；
//   · skeleton 永不落盘（无网关退化产物落盘会毒化后续会话）；
//   · store 故障=advisory，静默落回计算，绝不影响工具。

vi.mock("./specialists", async (importOriginal) => {
  const real = await importOriginal<typeof import("./specialists")>();
  return { ...real, runSpecialists: vi.fn(), synthesizeUnderstanding: vi.fn() };
});
vi.mock("./perspectives", async (importOriginal) => {
  const real = await importOriginal<typeof import("./perspectives")>();
  return { ...real, selectLenses: vi.fn(), buildLensTasks: vi.fn() };
});
vi.mock("./stream-gateway", async (importOriginal) => {
  const real = await importOriginal<typeof import("./stream-gateway")>();
  return { ...real, chatJson: vi.fn() };
});

import { FACTORY_TOOLS } from "./tools";
import { runSpecialists, synthesizeUnderstanding } from "./specialists";
import { selectLenses, buildLensTasks } from "./perspectives";
import { chatJson } from "./stream-gateway";

const understand = FACTORY_TOOLS.find((t) => t.name === "understand_ontology")!;
const readOntology = FACTORY_TOOLS.find((t) => t.name === "read_ontology")!;

const smallOnt = (): DomainOntology =>
  ({
    domainId: "d",
    source: "snapshot",
    workflow: [],
    objects: [{ id: "o1", name: "Obj" }],
    events: [{ name: "E", payload: { source_action: "act", event_data: [], state_mutations: [] } }],
    rules: [{ id: "r1", name: "R" }],
    actions: [{ id: "a1", name: "act", actor: ["Agent"], trigger: [], triggered_event: ["E"], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" }],
  }) as unknown as DomainOntology;

const bigOnt = (): DomainOntology => {
  const o = smallOnt();
  (o as { rules: unknown[] }).rules = Array.from({ length: 80 }, (_, i) => ({ id: `r-${i}`, name: `规则${i}` }));
  return o;
};

type FakeStore = DomainInsightStore & { loads: Array<{ domain: string; sig: string }>; saves: Array<Omit<DomainInsightPack, "updatedAt">> };
function fakeStore(packFor?: (domain: string, sig: string) => DomainInsightPack | null): FakeStore {
  const store: FakeStore = {
    loads: [],
    saves: [],
    async load(domain, sig) {
      store.loads.push({ domain, sig });
      return packFor ? packFor(domain, sig) : null;
    },
    async save(pack) {
      store.saves.push(pack);
    },
  };
  return store;
}

function mkCtx(over: Partial<BrainCtx> = {}): { ctx: BrainCtx; events: BrainEvent[] } {
  const events: BrainEvent[] = [];
  const ctx = {
    domain: "d",
    ontology: smallOnt(),
    specs: [],
    emit: (e: BrainEvent) => events.push(e),
    toolCatalog: [],
    realTools: [],
    createdSkills: [],
    rulesByAction: {},
    attemptHistory: {},
    humanDirectives: [],
    ports: {},
    ...over,
  } as unknown as BrainCtx;
  return { ctx, events };
}

const PERSPECTIVES: NonNullable<DomainInsightPack["perspectives"]> = {
  selected: [{ id: "operation", label: "运营视角", focus: "…", adapted: true }],
  okCount: 1,
  total: 1,
  source: "llm",
};

const deepPack = (sig: string, over: Partial<DomainInsightPack> = {}): DomainInsightPack => ({
  domain: "d",
  ontologySig: sig,
  mode: "deep",
  digest: "跨会话沉淀的深读理解",
  coverage: { itemsAnalyzed: 4, itemsTotal: 4, batches: 4, oversized: 0, complete: true },
  perspectives: PERSPECTIVES,
  ambiguityCount: 3,
  updatedAt: "2026-07-19T00:00:00.000Z",
  ...over,
});

beforeEach(() => {
  vi.mocked(runSpecialists).mockReset();
  vi.mocked(synthesizeUnderstanding).mockReset();
  vi.mocked(selectLenses).mockReset();
  vi.mocked(buildLensTasks).mockReset();
  vi.mocked(chatJson).mockReset();
  delete process.env.FACTORY_PERSPECTIVES;
  delete process.env.FACTORY_DOMAIN_INSIGHTS;
});
afterEach(() => {
  delete process.env.CUSTOM_LLM_API_KEY;
  delete process.env.FACTORY_AI_MODEL;
  delete process.env.FACTORY_GATEWAY_BASE_URL;
  delete process.env.FACTORY_PERSPECTIVES;
  delete process.env.FACTORY_DOMAIN_INSIGHTS;
});

describe("#KNOW-PACK — understand_ontology 读穿（store hit 跳过计算）", () => {
  it("深包命中：水合全部 ctx 字段（含镜头账目）、mode=stored、deep:true 也满足", async () => {
    const { ctx } = mkCtx();
    const sig = ontologyContentHash(ctx.ontology!);
    const store = fakeStore((_d, s) => (s === sig ? deepPack(sig) : null));
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const r = await understand.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect((r.output as { mode: string }).mode).toBe("stored");
    expect(ctx.ontologyUnderstanding).toBe("跨会话沉淀的深读理解");
    expect(ctx.ontologyUnderstandingMode).toBe("deep");
    expect(ctx.ontologyUnderstandingSig).toBe(sig);
    expect(ctx.ontologyUnderstandingCoverage?.complete).toBe(true);
    expect(ctx.ontologyPerspectives).toEqual(PERSPECTIVES);
    expect(ctx.ontologyAmbiguityCount).toBe(3);
    expect(r.summary).toContain("跨会话");
    // 二次调用命中会话内 ctx 缓存（证明 store 写回的 sig 与 ctx 缓存门同源）
    const r2 = await understand.execute({ deep: true }, ctx);
    expect((r2.output as { mode: string }).mode).toBe("cached");
  });

  it("浅包不满足 deep:true（落回计算→无网关=骨架）；不带 deep 时照常复用", async () => {
    const { ctx } = mkCtx();
    const sig = ontologyContentHash(ctx.ontology!);
    const store = fakeStore((_d, s) => (s === sig ? deepPack(sig, { mode: "shallow", coverage: undefined, perspectives: undefined }) : null));
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const deep = await understand.execute({ deep: true }, ctx);
    expect((deep.output as { mode?: string }).mode).not.toBe("stored");
    const { ctx: ctx2 } = mkCtx();
    (ctx2.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const plain = await understand.execute({}, ctx2);
    expect((plain.output as { mode: string }).mode).toBe("stored");
    expect(ctx2.ontologyUnderstandingMode).toBe("shallow");
  });

  it("#PERSPECTIVES-FIDELITY 对齐：无镜头深包不满足显式 deep:true；FACTORY_PERSPECTIVES=0 则满足", async () => {
    const { ctx } = mkCtx();
    const sig = ontologyContentHash(ctx.ontology!);
    const store = fakeStore((_d, s) => (s === sig ? deepPack(sig, { perspectives: undefined }) : null));
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const rejected = await understand.execute({ deep: true }, ctx);
    expect((rejected.output as { mode?: string }).mode).not.toBe("stored");
    process.env.FACTORY_PERSPECTIVES = "0";
    const { ctx: ctx2 } = mkCtx();
    (ctx2.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const accepted = await understand.execute({ deep: true }, ctx2);
    expect((accepted.output as { mode: string }).mode).toBe("stored");
  });

  it("哈希 miss（本体已变）→ 落回计算；refresh/focus/开关 旁路持久层", async () => {
    const { ctx } = mkCtx();
    const store = fakeStore(() => null);
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const r = await understand.execute({}, ctx);
    expect((r.output as { mode?: string }).mode).not.toBe("stored");
    expect(store.loads.length).toBe(1);

    const { ctx: c2 } = mkCtx();
    (c2.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    store.loads.length = 0;
    await understand.execute({ refresh: true }, c2);
    expect(store.loads.length).toBe(0);
    await understand.execute({ focus: "某子问题" }, c2);
    expect(store.loads.length).toBe(0);
    process.env.FACTORY_DOMAIN_INSIGHTS = "0";
    const { ctx: c3 } = mkCtx();
    (c3.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    await understand.execute({}, c3);
    expect(store.loads.length).toBe(0);
  });

  it("store.load 抛错 → 静默落回计算，工具照常 ok", async () => {
    const { ctx } = mkCtx();
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = {
      load: async () => { throw new Error("db down"); },
      save: async () => {},
    };
    const r = await understand.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect((r.output as { mode?: string }).mode).not.toBe("stored");
  });
});

describe("#KNOW-PACK — 写穿", () => {
  const gatewayOn = () => {
    process.env.CUSTOM_LLM_API_KEY = "test-key";
    process.env.FACTORY_AI_MODEL = "test/real-model";
    process.env.FACTORY_GATEWAY_BASE_URL = "http://127.0.0.1:1";
  };

  it("深读成功 → save 一次：mode=deep、digest=ctx 理解、sig 同源、镜头账目随包", async () => {
    gatewayOn();
    const OK4 = ["objects", "rules", "actions", "events"].map((id) => ({
      id, role: `${id} 专家`, ok: true, output: { keyFindings: ["f"], risks: [], ambiguities: id === "rules" ? ["歧义A"] : [] }, summary: "s",
    }));
    vi.mocked(runSpecialists).mockImplementation(async (_c, tasks) =>
      ((tasks[0]?.id ?? "").startsWith("lens.")
        ? [{ id: "lens.operation", role: "运营视角", ok: true, output: { keyFindings: ["k"], risks: [], ambiguities: ["歧义B"] }, summary: "s" }]
        : OK4) as never);
    vi.mocked(selectLenses).mockResolvedValue({ source: "llm", lenses: PERSPECTIVES.selected });
    vi.mocked(buildLensTasks).mockReturnValue([{ id: "lens.operation", role: "运营视角", system: "s", user: "u", maxTokens: 1400 }] as never);
    vi.mocked(synthesizeUnderstanding).mockResolvedValue("合成后的深读理解");
    const { ctx } = mkCtx({ ontology: bigOnt() });
    const sig = ontologyContentHash(ctx.ontology!);
    const store = fakeStore(() => null);
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const r = await understand.execute({ deep: true }, ctx);
    expect((r.output as { mode: string }).mode).toBe("deep");
    expect(store.saves.length).toBe(1);
    const saved = store.saves[0]!;
    expect(saved.mode).toBe("deep");
    expect(saved.ontologySig).toBe(sig);
    expect(saved.digest).toBe(ctx.ontologyUnderstanding);
    expect(saved.perspectives).toEqual({ selected: PERSPECTIVES.selected, okCount: 1, total: 1, source: "llm" });
    expect(saved.ambiguityCount).toBe(2);
  });

  it("浅读成功 → save 一次 mode=shallow（无镜头账目）", async () => {
    gatewayOn();
    vi.mocked(chatJson).mockResolvedValue({ agentsToBuild: [], eventChain: "E", ruleGates: [], externalHandoffs: [], ambiguities: ["x"], risks: [] });
    const { ctx } = mkCtx(); // 小本体 → 自动走单跳
    const store = fakeStore(() => null);
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const r = await understand.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect(store.saves.length).toBe(1);
    expect(store.saves[0]!.mode).toBe("shallow");
    expect(store.saves[0]!.perspectives).toBeUndefined();
    expect(store.saves[0]!.ambiguityCount).toBe(1);
  });

  it("skeleton 永不落盘（无网关退化）；save 抛错也不影响工具", async () => {
    const { ctx } = mkCtx();
    const store = fakeStore(() => null);
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const r = await understand.execute({}, ctx); // 无网关 → skeleton
    expect(r.ok).toBe(true);
    expect(store.saves.length).toBe(0);

    gatewayOn();
    vi.mocked(chatJson).mockResolvedValue({ agentsToBuild: [], eventChain: "E", ruleGates: [], externalHandoffs: [], ambiguities: [], risks: [] });
    const { ctx: c2 } = mkCtx();
    (c2.ports as { domainInsights?: DomainInsightStore }).domainInsights = {
      load: async () => null,
      save: async () => { throw new Error("disk full"); },
    };
    const r2 = await understand.execute({}, c2);
    expect(r2.ok).toBe(true); // 写穿失败是 advisory
  });
});

describe("#KNOW-PACK — read_ontology 预载（新会话开局即受益）", () => {
  const ontologyPort = {
    fetchOntology: async () => smallOnt(),
    listDomains: async () => [{ id: "d" }],
  };

  it("读到本体后按 post-heal 哈希预载分析包：水合 ctx + 提示消息；随后 understand 直接 cached", async () => {
    const store = fakeStore((_d, sig) => deepPack(sig));
    const { ctx, events } = mkCtx({ ontology: null as never });
    (ctx.ports as unknown as Record<string, unknown>).ontology = ontologyPort;
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    await readOntology.execute({}, ctx);
    expect(store.loads.length).toBe(1);
    expect(ctx.ontologyUnderstanding).toBe("跨会话沉淀的深读理解");
    expect(ctx.ontologyPerspectives).toEqual(PERSPECTIVES);
    expect(events.some((e) => e.t === "message" && String((e as { text: string }).text).includes("已载入"))).toBe(true);
    // 预载写回的 sig 与 understand 的缓存门同源 → 直接 cached，不再烧任何计算
    const r = await understand.execute({}, ctx);
    expect((r.output as { mode: string }).mode).toBe("cached");
  });

  it("store miss → 不水合、不出提示，read_ontology 照常成功；已有理解时不再查", async () => {
    const store = fakeStore(() => null);
    const { ctx, events } = mkCtx({ ontology: null as never });
    (ctx.ports as unknown as Record<string, unknown>).ontology = ontologyPort;
    (ctx.ports as { domainInsights?: DomainInsightStore }).domainInsights = store;
    const r = await readOntology.execute({}, ctx);
    expect(r.ok).toBe(true);
    expect(ctx.ontologyUnderstanding).toBeUndefined();
    expect(events.some((e) => e.t === "message" && String((e as { text: string }).text).includes("已载入"))).toBe(false);
    // 已有理解（哪怕来自本会话）→ 预载跳过
    store.loads.length = 0;
    ctx.ontologyUnderstanding = "本会话已有理解";
    await readOntology.execute({}, ctx);
    expect(store.loads.length).toBe(0);
  });
});
