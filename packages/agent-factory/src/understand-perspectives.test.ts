import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BrainCtx, BrainEvent } from "./brain-types";
import type { DomainOntology } from "./ontology-types";

// #PERSPECTIVES — understand_ontology 深读主链的镜头集成：四维结构专家之后跑「视角选配 → 镜头
// 并行检视」，结论并入同一次合成。结构四维在 understand-deep.test.ts 单独测（那边显式关镜头）；
// 这里专测镜头的编排：选配调用、结果落 ctx、歧义聚合、全败降级、kill-switch。

vi.mock("./specialists", async (importOriginal) => {
  const real = await importOriginal<typeof import("./specialists")>();
  return { ...real, runSpecialists: vi.fn(), synthesizeUnderstanding: vi.fn() };
});
vi.mock("./perspectives", async (importOriginal) => {
  const real = await importOriginal<typeof import("./perspectives")>();
  return { ...real, selectLenses: vi.fn(), buildLensTasks: vi.fn() };
});

import { FACTORY_TOOLS } from "./tools";
import { runSpecialists, synthesizeUnderstanding } from "./specialists";
import { selectLenses, buildLensTasks } from "./perspectives";

const understand = FACTORY_TOOLS.find((t) => t.name === "understand_ontology")!;

function bigOntology(): DomainOntology {
  const rules = Array.from({ length: 80 }, (_, i) => ({ id: `r-${i}`, businessLogicRuleName: `规则${i}` }));
  return {
    domainId: "rec",
    objects: [{ id: "Candidate", name: "候选人" }],
    rules,
    actions: [{ id: "a", name: "processResume", actor: ["Agent"], trigger: ["RESUME_DOWNLOADED"], triggered_event: ["RESUME_PROCESSED"], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" }],
    events: [{ name: "RESUME_PROCESSED", payload: { source_action: "processResume", event_data: [], state_mutations: [] } }],
    workflow: [],
    source: "snapshot",
  } as unknown as DomainOntology;
}

function ctxWith(ontology: DomainOntology): { ctx: BrainCtx; events: BrainEvent[] } {
  const events: BrainEvent[] = [];
  const ctx = {
    domain: "rec",
    ontology,
    specs: [],
    emit: (e: BrainEvent) => events.push(e),
    toolCatalog: [],
    realTools: [],
    createdSkills: [],
    rulesByAction: {},
    attemptHistory: {},
    humanDirectives: [],
    ports: {},
  } as unknown as BrainCtx;
  return { ctx, events };
}

const OK4 = ["objects", "rules", "actions", "events"].map((id) => ({
  id,
  role: `${id} 专家`,
  ok: true,
  output: { keyFindings: ["f"], risks: [], ambiguities: id === "rules" ? ["规则9-15未列出"] : [] },
  summary: `${id} 专家：1 项发现`,
}));

const LENS_SELECTION = {
  source: "llm" as const,
  lenses: [
    { id: "operation", label: "运营视角", focus: "贴合本域的运营检视", adapted: true },
    { id: "backoffice", label: "后台对账视角", focus: "贴合本域的对账检视", adapted: true },
  ],
};
const LENS_TASKS = [
  { id: "lens.operation", role: "运营视角", system: "s", user: "u", maxTokens: 1400 },
  { id: "lens.backoffice", role: "后台对账视角", system: "s", user: "u", maxTokens: 1400 },
];
const LENS_OK = [
  { id: "lens.operation", role: "运营视角", ok: true, output: { keyFindings: ["解析环节无监控事件"], risks: [], ambiguities: ["积压阈值未定义"] }, summary: "运营视角：1 项发现" },
  { id: "lens.backoffice", role: "后台对账视角", ok: true, output: { keyFindings: ["无审计事件"], risks: [], ambiguities: [] }, summary: "后台对账视角：1 项发现" },
];

beforeEach(() => {
  process.env.CUSTOM_LLM_API_KEY = "test-key";
  process.env.FACTORY_AI_MODEL = "test/real-model";
  process.env.FACTORY_GATEWAY_BASE_URL = "http://127.0.0.1:1";
  delete process.env.FACTORY_PERSPECTIVES;
  vi.mocked(runSpecialists).mockReset();
  vi.mocked(synthesizeUnderstanding).mockReset();
  vi.mocked(selectLenses).mockReset();
  vi.mocked(buildLensTasks).mockReset();
});
afterEach(() => {
  delete process.env.CUSTOM_LLM_API_KEY;
  delete process.env.FACTORY_AI_MODEL;
  delete process.env.FACTORY_GATEWAY_BASE_URL;
  delete process.env.FACTORY_PERSPECTIVES;
});

/** dims 调用返回 OK4，镜头调用（任务 id 以 lens. 开头）返回 lensResults。 */
function wireRunSpecialists(lensResults: unknown[]) {
  vi.mocked(runSpecialists).mockImplementation(async (_ctx, tasks) =>
    (tasks[0]?.id ?? "").startsWith("lens.") ? (lensResults as never) : (OK4 as never));
}

describe("#PERSPECTIVES — understand_ontology 深读镜头集成", () => {
  it("深读成功：选配→镜头并行→结论进同一次合成；ctx.ontologyPerspectives 落账；歧义含镜头", async () => {
    wireRunSpecialists(LENS_OK);
    vi.mocked(selectLenses).mockResolvedValue(LENS_SELECTION);
    vi.mocked(buildLensTasks).mockReturnValue(LENS_TASKS as never);
    vi.mocked(synthesizeUnderstanding).mockResolvedValue("整体理解：含运营与对账视角结论。");
    const { ctx, events } = ctxWith(bigOntology());
    const r = await understand.execute({ deep: true }, ctx);
    expect(r.ok).toBe(true);
    expect((r.output as { mode: string }).mode).toBe("deep");
    // 选配收到的是结构四维结果
    expect(vi.mocked(selectLenses)).toHaveBeenCalledTimes(1);
    // 合成收到 dims + lenses
    const synthArg = vi.mocked(synthesizeUnderstanding).mock.calls[0]![0] as Array<{ role: string }>;
    expect(synthArg.map((x) => x.role)).toContain("运营视角");
    expect(synthArg.map((x) => x.role)).toContain("rules 专家");
    // ctx 落账
    expect(ctx.ontologyPerspectives).toEqual({ selected: LENS_SELECTION.lenses, okCount: 2, total: 2, source: "llm" });
    // 歧义 = 结构(1) + 镜头(1)
    expect(ctx.ontologyAmbiguityCount).toBe(2);
    expect(r.summary).toContain("业务视角 2/2");
    expect((r.output as { perspectives?: { okCount: number } }).perspectives?.okCount).toBe(2);
    expect(events.some((e) => e.t === "message" && String((e as { text: string }).text).includes("业务视角深读"))).toBe(true);
  });

  it("镜头全败：深读仍成立（四维），okCount=0 仍为镜头感知，summary 有全败警告", async () => {
    wireRunSpecialists(LENS_OK.map((r) => ({ ...r, ok: false, output: null })));
    vi.mocked(selectLenses).mockResolvedValue(LENS_SELECTION);
    vi.mocked(buildLensTasks).mockReturnValue(LENS_TASKS as never);
    vi.mocked(synthesizeUnderstanding).mockResolvedValue("四维理解");
    const { ctx } = ctxWith(bigOntology());
    const r = await understand.execute({ deep: true }, ctx);
    expect((r.output as { mode: string }).mode).toBe("deep");
    expect(ctx.ontologyPerspectives?.okCount).toBe(0);
    expect(ctx.ontologyPerspectives?.total).toBe(2);
    expect(r.summary).toContain("业务视角全部失败");
    expect(ctx.ontologyAmbiguityCount).toBe(1); // 只剩结构歧义
  });

  it("FACTORY_PERSPECTIVES=0：选配根本不调、ctx 无镜头字段、output 无 perspectives", async () => {
    process.env.FACTORY_PERSPECTIVES = "0";
    vi.mocked(runSpecialists).mockResolvedValue(OK4 as never);
    vi.mocked(synthesizeUnderstanding).mockResolvedValue("四维理解");
    const { ctx } = ctxWith(bigOntology());
    const r = await understand.execute({ deep: true }, ctx);
    expect((r.output as { mode: string }).mode).toBe("deep");
    expect(vi.mocked(selectLenses)).not.toHaveBeenCalled();
    expect(ctx.ontologyPerspectives).toBeUndefined();
    expect("perspectives" in (r.output as Record<string, unknown>)).toBe(false);
    expect(vi.mocked(runSpecialists)).toHaveBeenCalledTimes(1);
  });
});
