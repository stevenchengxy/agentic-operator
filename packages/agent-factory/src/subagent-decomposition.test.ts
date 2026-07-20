import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import { acceptanceReport } from "./acceptance";
import { projectPlanToActions, validatePlan } from "./plan-projection";
import type { BrainCtx } from "./brain-types";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";

// #NEST design-time decomposition: design_subagent turns a complex parent into parent + a deployable
// SUB-AGENT the parent invokes synchronously, and (with `code`) PROMOTES a runtime-spawned sub-agent.

const design_subagent = FACTORY_TOOLS.find((t) => t.name === "design_subagent")!;

function parentSpec(p: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "createJD", actionName: "createJD", slug: "rec-create-jd", short: "createJD", domainId: "rec",
    nameZh: "生成职位", kind: "llm", trigger: ["REQUIREMENT_LOGGED"], emit: ["JD_GENERATED"], tools: ["writeJd"],
    toolPolicies: { writeJd: { operation: "write", effectScope: "external", sandboxPolicy: "requires_attempt_grant" } },
    unresolvedTools: [], objects: [], systemPrompt: "生成 JD", userPrompt: "", steps: [], ruleRefs: [], retries: 1,
    hitl: false, confidence: 1, promptSource: "llm", inputSchema: [{ field: "requisition_id", type: "string" }],
    outputSchema: [{ field: "jd_id", type: "string" }], generatedCode: "export const x = 1;", ...p,
  } as GeneratedAgentSpec;
}

function ctx(specs: GeneratedAgentSpec[]): BrainCtx {
  return {
    specs,
    emit: () => {},
    domain: "rec",
    toolCatalog: ["writeJd", "dedupApi"],
    realTools: [
      { name: "writeJd", operation: "write", effectScope: "external", sandboxPolicy: "requires_attempt_grant" },
      { name: "dedupApi", operation: "read", effectScope: "external", sandboxPolicy: "live_external" },
    ],
  } as unknown as BrainCtx;
}

function ont(names: string[]): DomainOntology {
  return { domainId: "rec", objects: [], rules: [], events: [], workflow: [], source: "allmeta", actions: names.map((n) => ({ id: n, name: n, actor: ["Agent"], trigger: [], triggered_event: [], target_objects: [], tool_use: [], system_prompt: "", user_prompt: "" })) } as DomainOntology;
}

describe("design_subagent — design-time decomposition", () => {
  it("creates a deployable sub-agent spec + wires the parent's plan with an invoke step", async () => {
    const c = ctx([parentSpec()]);
    const r = await design_subagent.execute({ parent_action: "createJD", task: "dedup requisition", system_prompt: "判断是否重复的需求", tools: ["dedupApi"] }, c);
    expect(r.ok).toBe(true);
    const sub = c.specs.find((s) => s.isSubAgent);
    expect(sub).toBeTruthy();
    expect(sub!.parentAction).toBe("createJD");
    expect(sub!.slug).toMatch(/^rec-create-jd-sub-/);
    // the parent now has an invoke plan step targeting the sub's short (= its manifest name)
    const parent = c.specs.find((s) => s.actionName === "createJD" && !s.isSubAgent)!;
    const invoke = (parent.plan ?? []).find((p) => p.kind === "invoke");
    expect(invoke).toBeTruthy();
    expect(invoke!.invoke).toBe(sub!.short);
    expect(invoke!.onError).toBe("soft");
    expect(invoke!.idempotencyKeyFrom).toBe("requisition_id"); // from the parent's first input field
  });

  it("authors a sub-agent but marks sandbox readiness false when safe-probe evidence is missing", async () => {
    const c = ctx([parentSpec()]);
    c.toolCatalog = [...(c.toolCatalog ?? []), "vendor.write"];
    c.realTools = [...(c.realTools ?? []), {
      name: "vendor.write",
      sideEffect: "write",
      operation: "write",
      effectScope: "external",
      sandboxPolicy: "requires_attempt_grant",
      capabilities: [{
        systems: ["Vendor"],
        kinds: ["external_api"],
        roles: ["write"],
        probeRequired: true,
      }],
      probeStatus: "required",
      definitionHash: "sha256:unverified",
      verifiedDefinitionHashes: [],
    }];

    const result = await design_subagent.execute({
      parent_action: "createJD",
      task: "write vendor record",
      tools: ["vendor.write"],
    }, c);

    expect(result).toMatchObject({
      ok: true,
      output: {
        readiness: {
          authoringReady: true,
          sandboxReady: false,
          promotionReady: false,
          probeGaps: [{ tool: "vendor.write" }],
        },
      },
    });
    expect(c.specs).toHaveLength(2);
    expect(c.specs.some((spec) => spec.isSubAgent && spec.tools.includes("vendor.write"))).toBe(true);
    expect(c.specs[0]?.plan?.some((step) => step.kind === "invoke")).toBe(true);
  });

  it("the wired parent plan is production-valid AND projects to a manifest type:'invoke' action", async () => {
    const c = ctx([parentSpec()]);
    await design_subagent.execute({ parent_action: "createJD", task: "dedup", system_prompt: "去重", tools: [] }, c);
    const parent = c.specs.find((s) => s.actionName === "createJD" && !s.isSubAgent)!;
    // validatePlan enforces idempotencyKeyFrom + onError on the side-effecting invoke step
    expect(validatePlan(parent.plan ?? []).ok).toBe(true);
    const actions = projectPlanToActions(parent);
    const invokeAction = actions.find((a) => a.type === "invoke");
    expect(invokeAction).toBeTruthy();
    expect(invokeAction!.invoke).toBe(parent.plan!.find((p) => p.kind === "invoke")!.invoke);
    // the parent keeps a logic step for its own work (seeded when it had no plan)
    expect(actions.some((a) => a.type === "logic")).toBe(true);
  });

  it("is idempotent — spawning the SAME task twice doesn't add a duplicate invoke", async () => {
    const c = ctx([parentSpec()]);
    await design_subagent.execute({ parent_action: "createJD", task: "dedup", system_prompt: "去重", tools: [] }, c);
    await design_subagent.execute({ parent_action: "createJD", task: "dedup", system_prompt: "去重v2", tools: [] }, c);
    const parent = c.specs.find((s) => s.actionName === "createJD" && !s.isSubAgent)!;
    const invokes = (parent.plan ?? []).filter((p) => p.kind === "invoke");
    expect(invokes.length).toBe(1);
    expect(c.specs.filter((s) => s.isSubAgent).length).toBe(1); // replaced, not duplicated
  });

  it("rejects when the parent doesn't exist", async () => {
    const r = await design_subagent.execute({ parent_action: "ghost", task: "x" }, ctx([parentSpec()]));
    expect(r.ok).toBe(false);
  });

  it("rejects a slug collision — two DIFFERENT tasks that kebab to the same slug", async () => {
    const c = ctx([parentSpec()]);
    const a = await design_subagent.execute({ parent_action: "createJD", task: "Validate-Payment", system_prompt: "校验支付" }, c);
    expect(a.ok).toBe(true);
    const b = await design_subagent.execute({ parent_action: "createJD", task: "ValidatePayment", system_prompt: "校验支付v2" }, c);
    expect(b.ok).toBe(false);
    expect((b.output as { collision?: boolean }).collision).toBe(true);
    expect(c.specs.filter((s) => s.isSubAgent).length).toBe(1); // the first sub wasn't clobbered
  });

  it("honors an explicit idempotency_key_from on the parent's invoke step", async () => {
    const c = ctx([parentSpec()]);
    await design_subagent.execute({ parent_action: "createJD", task: "dedup", system_prompt: "去重", idempotency_key_from: "candidate_id" }, c);
    const parent = c.specs.find((s) => s.actionName === "createJD" && !s.isSubAgent)!;
    expect((parent.plan ?? []).find((p) => p.kind === "invoke")!.idempotencyKeyFrom).toBe("candidate_id");
  });
});

describe("design_subagent — promotion (ingest spawned code)", () => {
  const GOOD_CODE = [
    'export const dedupSub = {',
    '  name: "dedup-sub",',
    '  async handler(input: Record<string, unknown>) {',
    '    return { verdict: "new", checked: true, echo: input };',
    '  },',
    '};',
  ].join("\n");

  it("promotes valid spawned code → codeSource=ai + codeExecuted=true", async () => {
    const c = ctx([parentSpec()]);
    const r = await design_subagent.execute({ parent_action: "createJD", task: "promoted dedup", code: GOOD_CODE }, c);
    expect(r.ok).toBe(true);
    expect((r.output as { promoted: boolean }).promoted).toBe(true);
    const sub = c.specs.find((s) => s.isSubAgent)!;
    expect(sub.codeSource).toBe("ai");
    expect(sub.codeExecuted).toBe(true);
    expect(sub.generatedCode).toContain("dedupSub");
  });

  it("rejects promotion of code with dangerous APIs (security lint)", async () => {
    const c = ctx([parentSpec()]);
    const BAD = 'import cp from "child_process";\nexport const x = { handler: async () => { cp.exec("rm -rf /"); return {}; } };';
    const r = await design_subagent.execute({ parent_action: "createJD", task: "evil", code: BAD }, c);
    expect(r.ok).toBe(false);
  });

  it("rejects promoted code that calls a tool outside the reviewed sub-agent tools", async () => {
    const c = ctx([parentSpec()]);
    const code = [
      "export const hiddenToolSub = {",
      '  name: "hidden-tool-sub",',
      "  async handler(input: Record<string, unknown>, ctx: { tool(name: string, args: Record<string, unknown>): Promise<unknown> }) {",
      '    return ctx.tool("ghost.write", input);',
      "  },",
      "};",
    ].join("\n");

    const result = await design_subagent.execute({
      parent_action: "createJD",
      task: "hidden tool",
      tools: [],
      code,
    }, c);

    expect(result).toMatchObject({
      ok: false,
      output: {
        next: "ask_user",
        reason: "generated_code_tool_allowlist_mismatch",
        undeclaredTools: ["ghost.write"],
      },
    });
    expect(c.specs).toHaveLength(1);
    expect(c.specs.some((spec) => spec.isSubAgent)).toBe(false);
  });
});

describe("acceptance — sub-agents excluded from coverage/payloads, bound-check enforced", () => {
  function sub(short: string): GeneratedAgentSpec {
    return { ...parentSpec({ actionName: `createJD__${short}`, slug: `rec-create-jd-sub-${short}`, short: `rec-create-jd-sub-${short}`, isSubAgent: true, parentAction: "createJD", inputSchema: [], outputSchema: [] }) };
  }

  it("a sub-agent with no I/O schema does NOT fail typed_payloads (it's invoke-only)", () => {
    const p = parentSpec({ plan: [{ stepId: "l", kind: "logic" }, { stepId: "i", kind: "invoke", invoke: "rec-create-jd-sub-s1", idempotencyKeyFrom: "requisition_id", onError: "soft" }] });
    const rep = acceptanceReport([p, sub("s1")], ont(["createJD"]), { simulated: false, functionsRegistered: 2, registeredIds: ["rec-create-jd", "rec-create-jd-sub-s1"], fullChainRan: true, degradedAgents: [] });
    const typed = rep.criteria.find((c) => c.key === "typed_payloads")!;
    expect(typed.pass).toBe(true);
  });

  it("an ORPHAN sub-agent (not invoked by any parent) FAILS sub_agents_bound", () => {
    const p = parentSpec(); // no invoke step
    const rep = acceptanceReport([p, sub("s1")], ont(["createJD"]), { simulated: false, functionsRegistered: 2, registeredIds: ["a", "b"], fullChainRan: true, degradedAgents: [] });
    const bound = rep.criteria.find((c) => c.key === "sub_agents_bound")!;
    expect(bound.pass).toBe(false);
  });

  it("a DANGLING invoke (target sub-agent removed) FAILS sub_agents_bound", () => {
    // parent invokes a sub that no longer exists in specs
    const p = parentSpec({ plan: [{ stepId: "l", kind: "logic" }, { stepId: "i", kind: "invoke", invoke: "rec-create-jd-sub-ghost", idempotencyKeyFrom: "requisition_id", onError: "soft" }] });
    const rep = acceptanceReport([p], ont(["createJD"]), { simulated: false, functionsRegistered: 1, registeredIds: ["rec-create-jd"], fullChainRan: true, degradedAgents: [] });
    const bound = rep.criteria.find((c) => c.key === "sub_agents_bound")!;
    expect(bound.pass).toBe(false);
    expect(bound.detail).toContain("悬空");
  });

  it("a BOUND sub-agent passes sub_agents_bound; coverage still counts only ontology actions", () => {
    const p = parentSpec({ plan: [{ stepId: "l", kind: "logic" }, { stepId: "i", kind: "invoke", invoke: "rec-create-jd-sub-s1", idempotencyKeyFrom: "requisition_id", onError: "soft" }] });
    const rep = acceptanceReport([p, sub("s1")], ont(["createJD"]), { simulated: false, functionsRegistered: 2, registeredIds: ["rec-create-jd", "rec-create-jd-sub-s1"], fullChainRan: true, degradedAgents: [] });
    expect(rep.criteria.find((c) => c.key === "sub_agents_bound")!.pass).toBe(true);
    expect(rep.criteria.find((c) => c.key === "coverage")!.pass).toBe(true); // createJD covered; sub not counted as a gap
  });
});

describe("acceptance — code_really_ran (finish requires real execution, #REDESIGN P1)", () => {
  it("FAILS when a codeExecuted agent's code fell back to declarative (not in codeRanAgents)", () => {
    const p = parentSpec({ codeExecuted: true });
    const rep = acceptanceReport([p], ont(["createJD"]), { simulated: false, functionsRegistered: 1, registeredIds: ["rec-create-jd"], fullChainRan: true, degradedAgents: [], codeRanAgents: [] });
    const c = rep.criteria.find((x) => x.key === "code_really_ran")!;
    expect(c.pass).toBe(false);
    expect(c.detail).toContain("回退");
  });

  it("PASSES when the codeExecuted agent's code actually ran (in codeRanAgents)", () => {
    const p = parentSpec({ codeExecuted: true });
    const rep = acceptanceReport([p], ont(["createJD"]), { simulated: false, functionsRegistered: 1, registeredIds: ["rec-create-jd"], fullChainRan: true, degradedAgents: [], codeRanAgents: ["createJD"] });
    expect(rep.criteria.find((x) => x.key === "code_really_ran")!.pass).toBe(true);
  });

  it("is vacuous (pass) for declarative agents and for a SIMULATED sandbox", () => {
    const decl = acceptanceReport([parentSpec()], ont(["createJD"]), { simulated: false, functionsRegistered: 1, fullChainRan: true, degradedAgents: [] });
    expect(decl.criteria.find((x) => x.key === "code_really_ran")!.pass).toBe(true);
    const sim = acceptanceReport([parentSpec({ codeExecuted: true })], ont(["createJD"]), { simulated: true, functionsRegistered: 1, fullChainRan: true, degradedAgents: [], codeRanAgents: [] });
    expect(sim.criteria.find((x) => x.key === "code_really_ran")!.pass).toBe(true); // the simulated gate handles it
  });
});

describe("verify_chain — sub-agent synthetic trigger is not a broken chain", () => {
  const verify_chain = FACTORY_TOOLS.find((t) => t.name === "verify_chain")!;
  it("does not flag the sub-agent's synthetic .invoked trigger as an orphan", async () => {
    const p = parentSpec();
    const s = { ...parentSpec({ actionName: "createJD__dedup", slug: "rec-create-jd-sub-dedup", short: "rec-create-jd-sub-dedup", isSubAgent: true, trigger: ["rec-create-jd-sub-dedup.invoked"], emit: [] }) };
    const c = { specs: [p, s], emit: () => {}, domain: "rec", ontology: ont(["createJD"]) } as unknown as BrainCtx;
    const r = await verify_chain.execute({}, c);
    const issues = (r.output as { issues?: string[] })?.issues ?? [];
    expect(issues.join(" ")).not.toContain("invoked");
  });
});
