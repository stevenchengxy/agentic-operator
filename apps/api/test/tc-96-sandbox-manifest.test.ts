/**
 * TC-96 — The Agent Factory sandbox manifest is registrable + runnable.
 *
 * `mapToManifest` turns generated specs into the runtime WorkflowManifest the sandbox deploy
 * commits. The regression this guards: previously each generated agent became per-step actions
 * (tool steps named after the step → wrong tool; logic steps → boot-blocking missing prompt). Now
 * each agent maps to ONE `generated` LLM step that (a) passes the manifest Zod schema, (b) carries
 * the global tool roster (with ontology.fetchActionRules domain/action config), and (c) is skipped
 * by findMissingTenantPrompts so registration never throws on a missing tenant prompt.
 */

import { describe, it, expect } from "vitest";
import { AgentSchema, findMissingTenantPrompts } from "@agentic/runtime";
import { mapToManifest } from "../src/services/agent-factory/sandbox-deployer";
import type { GeneratedAgentSpec } from "@agentic/agent-factory";

function spec(p: Partial<GeneratedAgentSpec> & { slug: string; actionName: string }): GeneratedAgentSpec {
  return {
    key: p.actionName,
    actionName: p.actionName,
    slug: p.slug,
    short: `${p.actionName}Agent`,
    domainId: "demo-domain",
    nameZh: p.actionName,
    kind: "llm",
    trigger: p.trigger ?? [],
    emit: p.emit ?? [],
    tools: p.tools ?? [],
    unresolvedTools: p.unresolvedTools ?? [],
    objects: p.objects ?? [],
    systemPrompt: p.systemPrompt ?? "You are an agent. Follow the rules.",
    userPrompt: "",
    steps: p.steps ?? [],
    ruleRefs: [],
    retries: p.retries ?? 1,
    hitl: p.hitl ?? false,
    confidence: 1,
    designReasoning: p.designReasoning ?? "designed for the chain",
    ...p,
  } as unknown as GeneratedAgentSpec;
}

describe("TC-96: sandbox manifest registers + runs generated agents", () => {
  const specs: GeneratedAgentSpec[] = [
    spec({ slug: "demo-intake", actionName: "IntakeResume", trigger: ["RESUME_UPLOADED"], emit: ["RESUME_PARSED"], tools: ["fs.readFromInbox", "parseResumeApi"] }),
    spec({ slug: "demo-rules", actionName: "CheckRules", trigger: ["RESUME_PARSED"], emit: ["RULES_PASSED"], tools: ["ontology.fetchActionRules"], unresolvedTools: ["someGhostTool"] }),
  ];

  it("maps each agent to a single schema-valid generated logic step", () => {
    const manifest = mapToManifest(specs);
    const parsed = manifest.map((a) => AgentSchema.parse(a)); // throws if the schema rejects it
    for (const a of parsed) {
      expect(a.generated).toBe(true);
      expect(a.actions).toHaveLength(1);
      expect(a.actions[0]!.type).toBe("logic");
    }
    // trigger/emit preserved for chain wiring.
    expect(parsed[0]!.trigger).toEqual(["RESUME_UPLOADED"]);
    expect(parsed[0]!.triggered_event).toEqual(["RESUME_PARSED"]);
    expect(parsed[1]!.trigger).toEqual(["RESUME_PARSED"]);
  });

  it("preserves the resolved tool roster and attaches ontology.fetchActionRules config; drops unresolved", () => {
    const manifest = mapToManifest(specs).map((a) => AgentSchema.parse(a));
    const intakeTools = (manifest[0]!.tool_use ?? []).map((t) => (t as { name: string }).name);
    expect(intakeTools).toEqual(["fs.readFromInbox", "parseResumeApi"]);
    const rulesUse = manifest[1]!.tool_use ?? [];
    const frEntry = rulesUse.find((t) => (t as { name: string }).name === "ontology.fetchActionRules") as { config?: { domain?: string; action?: string } };
    expect(frEntry?.config).toEqual({ domain: "demo-domain", action: "CheckRules" });
    // the unresolved ghost tool was filtered out.
    expect(rulesUse.map((t) => (t as { name: string }).name)).not.toContain("someGhostTool");
  });

  it("never blocks registration on a missing tenant prompt (generated agents are skipped)", () => {
    const manifest = mapToManifest(specs).map((a) => AgentSchema.parse(a));
    expect(findMissingTenantPrompts({ manifest, tenantRegistry: {} })).toEqual([]);
  });

  it("a HITL agent keeps its human-approval gate (manual action precedes the logic step)", () => {
    const hitlSpec = spec({ slug: "demo-approve", actionName: "ApproveOffer", trigger: ["OFFER_DRAFTED"], emit: ["OFFER_APPROVED"], tools: [], hitl: true });
    const a = AgentSchema.parse(mapToManifest([hitlSpec])[0]);
    expect(a.actor).toEqual(["Human"]);
    expect(a.actions.map((x) => x.type)).toEqual(["manual", "logic"]); // gate THEN the work
    expect(a.generated).toBe(true);
    // the manual gate is type:"manual" so findMissingTenantPrompts (which only flags logic) is fine.
    expect(findMissingTenantPrompts({ manifest: [a], tenantRegistry: {} })).toEqual([]);
  });
});
