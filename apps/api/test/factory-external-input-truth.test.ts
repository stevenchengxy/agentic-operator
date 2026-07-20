import { describe, expect, it } from "vitest";
import type { GeneratedAgentSpec } from "@agentic/agent-factory";

import { externalInputCoverageGaps } from "../src/services/agent-factory/sandbox-deployer";

function spec(
  actionName: string,
  trigger: string[],
  emit: string[],
): GeneratedAgentSpec {
  return {
    key: actionName,
    actionName,
    slug: `truth-${actionName}`,
    short: actionName,
    domainId: "truth-domain",
    nameZh: actionName,
    kind: "llm",
    trigger,
    emit,
    tools: ["records.upsert"],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "execute",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
  } as GeneratedAgentSpec;
}

describe("Agent Factory external-input truth gate", () => {
  const specs = [
    spec("createJd", ["REQUIREMENT_LOGGED"], ["JD_GENERATED"]),
    spec("processResume", ["RESUME_DOWNLOADED"], ["RESUME_PROCESSED"]),
  ];

  it("treats an external callback without an approved entry case as an uncovered blocker", () => {
    expect(externalInputCoverageGaps(specs, ["REQUIREMENT_LOGGED"])).toEqual([
      "RESUME_DOWNLOADED",
    ]);
  });

  it("clears the blocker only when that exact external event has an explicit case", () => {
    expect(
      externalInputCoverageGaps(specs, [
        "REQUIREMENT_LOGGED",
        "RESUME_DOWNLOADED",
      ]),
    ).toEqual([]);
  });
});
