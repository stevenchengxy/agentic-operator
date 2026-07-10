import { describe, it, expect } from "vitest";
import { deriveBusinessFlow, classifyTool } from "./business-flow";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    actionName: p.actionName,
    slug: p.slug ?? `d-${p.actionName}`,
    nameZh: p.nameZh ?? p.actionName,
    trigger: p.trigger ?? [],
    emit: p.emit ?? [],
    tools: p.tools ?? [],
    unresolvedTools: [],
    systemPrompt: "",
    isSubAgent: p.isSubAgent,
  } as unknown as GeneratedAgentSpec;
}

function ont(actions: Array<Record<string, unknown>>): DomainOntology {
  return {
    domainId: "rec",
    objects: [],
    rules: [],
    events: [],
    workflow: [],
    source: "snapshot",
    actions: actions.map((a) => ({
      id: String(a.name),
      name: String(a.name),
      actor: ["Agent"],
      trigger: [],
      triggered_event: [],
      target_objects: [],
      tool_use: [],
      system_prompt: "",
      user_prompt: "",
      ...a,
    })),
  } as unknown as DomainOntology;
}

describe("classifyTool", () => {
  it("classifies the tool families", () => {
    expect(classifyTool("fs.readFromInbox")).toMatchObject({ kind: "file_store", role: "reads" });
    expect(classifyTool("fs.writeHtmlToArchive")).toMatchObject({ kind: "file_store", role: "writes" });
    expect(classifyTool("ontology.fetchActionRules")).toMatchObject({ kind: "rulebase", role: "reads" });
    expect(classifyTool("send_email")).toMatchObject({ kind: "email", role: "notifies" });
    expect(classifyTool("parseResumeApi")).toMatchObject({ kind: "external_api", role: "calls" });
    expect(classifyTool("http.fetch")).toMatchObject({ kind: "external_api", role: "calls" });
    expect(classifyTool("meta.ping")).toBeNull(); // internal utility — not an integration
  });
});

describe("deriveBusinessFlow", () => {
  const specs = [
    spec({
      actionName: "processResume",
      trigger: ["RESUME_DOWNLOADED"],
      emit: ["RESUME_PROCESSED", "RESUME_LOCKED_CONFLICT"],
      tools: ["fs.readFromInbox", "parseResumeApi", "ontology.fetchActionRules"],
    }),
    spec({ actionName: "matchResume", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED", "MATCH_FAILED"], tools: ["matchResumeApi"] }),
  ];

  it("infers external systems from bound tools + external event sources", () => {
    const m = deriveBusinessFlow(specs, ont([{ name: "processResume" }, { name: "matchResume" }]));
    const names = m.externals.map((e) => e.name);
    expect(names).toContain("文件收件箱 (data/)");
    expect(names).toContain("本体/规则库");
    expect(names.some((n) => n.includes("parseResume"))).toBe(true);
    // RESUME_DOWNLOADED is consumed but produced by nobody → external trigger source
    expect(m.externals.some((e) => e.roles.includes("triggers"))).toBe(true);
    expect(m.entries).toEqual([{ event: "RESUME_DOWNLOADED", consumers: ["processResume"] }]);
    const pr = m.agents.find((a) => a.actionName === "processResume")!;
    expect(pr.triggers[0]).toMatchObject({ event: "RESUME_DOWNLOADED", external: true });
    expect(pr.reads.some((r) => r.includes("fs.readFromInbox"))).toBe(true);
    expect(pr.calls.some((c) => c.includes("parseResumeApi"))).toBe(true);
  });

  it("assigns branch semantics: internal chain / failure / terminal", () => {
    const m = deriveBusinessFlow(specs, ont([{ name: "processResume" }, { name: "matchResume" }]));
    const pr = m.agents.find((a) => a.actionName === "processResume")!;
    expect(pr.emits.find((e) => e.event === "RESUME_PROCESSED")).toMatchObject({ semantic: "internal", consumers: ["matchResume"] });
    expect(pr.emits.find((e) => e.event === "RESUME_LOCKED_CONFLICT")!.semantic).toBe("failure");
    const mr = m.agents.find((a) => a.actionName === "matchResume")!;
    expect(mr.emits.find((e) => e.event === "MATCH_PASSED")!.semantic).toBe("terminal");
    expect(mr.emits.find((e) => e.event === "MATCH_FAILED")!.semantic).toBe("failure");
  });

  it("boundary classification overrides: external handoff carries the consumer platform", () => {
    const m = deriveBusinessFlow(specs, ont([{ name: "processResume" }, { name: "matchResume" }]), [
      { event: "MATCH_PASSED", kind: "external", consumer: "RAAS/HSM" },
      { event: "RESUME_DOWNLOADED", kind: "external", consumer: "RAAS+MinIO" },
    ]);
    const mr = m.agents.find((a) => a.actionName === "matchResume")!;
    expect(mr.emits.find((e) => e.event === "MATCH_PASSED")).toMatchObject({ semantic: "external", externalConsumer: "RAAS/HSM" });
    expect(m.externals.some((e) => e.name === "RAAS/HSM" && e.roles.includes("consumes"))).toBe(true);
    // the entry's external source is attributed to the declared platform, not the generic label
    const pr = m.agents.find((a) => a.actionName === "processResume")!;
    expect(pr.triggers[0]).toMatchObject({ external: true, source: "RAAS+MinIO" });
    expect(m.externals.some((e) => e.name === "RAAS+MinIO" && e.roles.includes("triggers"))).toBe(true);
  });

  it("lifts writes + notifications from ontology side_effects", () => {
    const o = ont([
      {
        name: "processResume",
        side_effects: {
          data_changes: [
            { object_type: "Resume", action: "CREATE" },
            { object_type: "Candidate", action: "CREATE_OR_MODIFY" },
          ],
          notifications: [{ recipient: "招聘专员", channel: "InApp" }],
        },
      },
      { name: "matchResume" },
    ]);
    const m = deriveBusinessFlow(specs, o);
    const pr = m.agents.find((a) => a.actionName === "processResume")!;
    expect(pr.writes).toEqual([
      { object: "Resume", action: "CREATE" },
      { object: "Candidate", action: "CREATE_OR_MODIFY" },
    ]);
    expect(pr.notifies).toEqual(["招聘专员 · InApp"]);
  });

  it("a DECLARED integration block wins over tool inference", () => {
    const o = ont([
      {
        name: "processResume",
        integration: {
          systems: [
            { name: "RoboHire", kind: "external_api", role: "calls", capability: "parse-resume" },
            { name: "MinIO", kind: "file_store", role: "reads" },
            { name: "PartnerPG", kind: "datastore", role: "writes" },
          ],
        },
      },
      { name: "matchResume" },
    ]);
    const m = deriveBusinessFlow(specs, o);
    const pr = m.agents.find((a) => a.actionName === "processResume")!;
    expect(pr.calls).toContain("RoboHire · parse-resume");
    expect(pr.reads).toContain("MinIO");
    const names = m.externals.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["RoboHire", "MinIO", "PartnerPG"]));
    // inference for THIS agent is suppressed (no parseResumeApi-derived system from it)
    expect(pr.calls.some((c) => c.includes("parseResumeApi"))).toBe(false);
  });

  // #OPEN-VOCAB — 词表外的 kind/role 原样保留（不再静默归并），并计入 unmodeled 仪表。
  it("preserves novel declared kinds verbatim and surfaces them in unmodeled (no silent coercion)", () => {
    const o = ont([
      {
        name: "processResume",
        integration: { systems: [{ name: "企业消息队列", kind: "message_queue", role: "publishes" }] },
      },
      { name: "matchResume" },
    ]);
    const m = deriveBusinessFlow(specs, o);
    const mq = m.externals.find((e) => e.name === "企业消息队列")!;
    expect(mq.kind).toBe("message_queue"); // 旧版会被塌成 external_platform
    expect(mq.roles).toContain("publishes");
    expect(m.unmodeled).toEqual({ kinds: ["message_queue"], roles: ["publishes"] });
  });

  it("is safe with a null ontology", () => {
    const m = deriveBusinessFlow(specs, null);
    expect(m.agents).toHaveLength(2);
    expect(m.domain).toBe("");
  });

  it("DECLARED integration.event_sources attributes the external trigger source (boundary still wins)", () => {
    const o = ont([
      {
        name: "processResume",
        integration: { systems: [], event_sources: { RESUME_DOWNLOADED: "RAAS + MinIO (resumeCollection)" } },
      },
      { name: "matchResume" },
    ]);
    const m = deriveBusinessFlow(specs, o);
    const pr = m.agents.find((a) => a.actionName === "processResume")!;
    expect(pr.triggers[0]).toMatchObject({ external: true, source: "RAAS + MinIO (resumeCollection)" });
    expect(m.externals.some((e) => e.name === "RAAS + MinIO (resumeCollection)" && e.roles.includes("triggers"))).toBe(true);
    // boundary classification overrides the declared source
    const m2 = deriveBusinessFlow(specs, o, [{ event: "RESUME_DOWNLOADED", kind: "external", consumer: "RAAS 正式环境" }]);
    expect(m2.agents.find((a) => a.actionName === "processResume")!.triggers[0]!.source).toBe("RAAS 正式环境");
  });

  // Smoke: the exact enriched v005 action shape (integration.systems + event_sources) flows through.
  it("consumes the enriched actions_v0_1_005 shape end-to-end", () => {
    const v005Action = {
      name: "processResume",
      integration: {
        systems: [
          { name: "MinIO", kind: "file_store", role: "reads", capability: "getResumeBuffer 下载简历原文件" },
          { name: "RoboHire", kind: "external_api", role: "calls", capability: "POST /parse-resume（multipart 智能解析）" },
          { name: "本体/规则库", kind: "rulebase", role: "reads", capability: "锁定与归属策略规则" },
          { name: "Partner PG", kind: "datastore", role: "writes", objects: ["Candidate", "Resume", "Application"] },
          { name: "Allmeta", kind: "datastore", role: "writes", objects: ["Candidate", "Resume"] },
        ],
        event_sources: { RESUME_DOWNLOADED: "RAAS + MinIO (resumeCollection)" },
      },
      side_effects: { data_changes: [{ object_type: "Resume", action: "CREATE" }] },
    };
    const m = deriveBusinessFlow(specs, ont([v005Action, { name: "matchResume" }]));
    const pr = m.agents.find((a) => a.actionName === "processResume")!;
    expect(pr.calls).toContain("RoboHire · POST /parse-resume（multipart 智能解析）");
    expect(pr.reads).toEqual(expect.arrayContaining(["MinIO · getResumeBuffer 下载简历原文件", "本体/规则库 · 锁定与归属策略规则"]));
    expect(pr.writes).toEqual([{ object: "Resume", action: "CREATE" }]);
    expect(pr.triggers[0]!.source).toBe("RAAS + MinIO (resumeCollection)");
    const names = m.externals.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["MinIO", "RoboHire", "Partner PG", "Allmeta"]));
  });
});
