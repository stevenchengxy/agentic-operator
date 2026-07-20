import { describe, expect, it } from "vitest";
import type { AgentDraft } from "@agentic/agent-factory";
import {
  buildFactoryReworkSeed,
  ReworkSeedError,
  reworkStartRequest,
  type ReworkRunEvidence,
} from "../src/services/agent-factory/rework-seed";

const draft: AgentDraft = {
  domain: "agents-generation",
  slug: "resume-parser",
  versionId: "v-immutable-1",
  createdAt: "2026-07-12T00:00:00.000Z",
  spec: {
    key: "resume-parser",
    actionName: "parseResume",
    short: "resume-parser",
    nameZh: "简历解析",
    slug: "resume-parser",
    domainId: "agents-generation",
    trigger: ["RESUME_UPLOADED"],
    emit: ["RESUME_PARSED"],
    systemPrompt: "解析简历；api_key=should-not-survive",
    tools: ["document.extract"],
    toolConfigs: { "document.extract": { api_key_env: "DOCUMENT_API_KEY" } },
    unresolvedTools: [],
    objects: ["Resume"],
    ruleRefs: [],
    plan: [{ stepId: "extract", kind: "tool", tool: "document.extract" }],
    inputSchema: [],
    outputSchema: [],
    steps: [],
    edgeCases: [],
    retries: 2,
    hitl: false,
    confidence: 0.9,
    generatedCode: "export const secret = 'not-returned';",
  },
};

const evidence: ReworkRunEvidence[] = [{
  runId: "run-production-1",
  status: "failed",
  startedAt: "2026-07-13T00:00:00.000Z",
  endedAt: "2026-07-13T00:00:02.000Z",
  durationMs: 2_000,
  codeRan: false,
  error: "schema mismatch",
  summary: { problem: "字段 mapping 错误" },
  steps: [{ ord: 1, name: "extract", type: "tool", status: "failed", attempts: 3, durationMs: 1_900, error: "missing candidate_id" }],
}];

describe("factory production rework seed", () => {
  it("binds an immutable promoted draft to production evidence without starting a run", () => {
    const seed = buildFactoryReworkSeed({
      domain: draft.domain,
      draft,
      liveAgentVersionId: "agv-live-1",
      liveWorkflowVersion: "42",
      evidence,
      createdAt: "2026-07-13T01:00:00.000Z",
    });
    expect(seed.source).toMatchObject({ liveManifestMatchedDraft: true, draftVersionId: "v-immutable-1" });
    expect(seed.productionEvidence).toMatchObject({ total: 1, failed: 1, failureRate: 1 });
    expect(seed.draft).not.toHaveProperty("spec.generatedCode");
    expect(seed.draft.generatedCodeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(seed)).not.toContain("not-returned");
    expect(JSON.stringify(seed)).not.toContain("should-not-survive");
    const request = reworkStartRequest(seed);
    expect(request).toMatchObject({ domain: "agents-generation", started: false });
    expect(request.goal).toContain(seed.seedId);
    expect(request.goal).toContain("不得自动晋升");
  });

  it("refuses to claim a production-evidence seed when no production run exists", () => {
    expect(() => buildFactoryReworkSeed({
      domain: draft.domain,
      draft,
      liveAgentVersionId: "agv-live-1",
      liveWorkflowVersion: "42",
      evidence: [],
    })).toThrow(ReworkSeedError);
  });
});
