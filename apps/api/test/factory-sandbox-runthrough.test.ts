/**
 * Factory sandbox live-runthrough — integration coverage for T1 (per-case polling + per-kind
 * verdict) + T2 (auto-synthesized mock external-platform agents), exercised against the REAL
 * ManifestSandboxDeployer → manifest-import commit → in-process Inngest function registration.
 *
 * What this proves HERE (no separate Inngest dev server in the vitest env):
 *   - a generated agent chain with an EXTERNAL handoff auto-grows a mock external-platform agent
 *     so the chain is closeable (T2),
 *   - the chain + mock are really COMMITTED to an isolated `<domain>-sb` tenant and Inngest
 *     functions are registered (functionsRegistered > 0),
 *   - the per-case / per-kind verdict pipeline runs end-to-end without throwing (T1).
 * The actual event EXECUTION (runs settling) needs a live `inngest-cli dev` (driven by `pnpm dev`);
 * with no executor here the run count is honestly 0 and fullChainRan is false — that's expected.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { buildTestEnv } from "./harness";
import { ManifestSandboxDeployer } from "../src/services/agent-factory/sandbox-deployer";
import type { GeneratedAgentSpec } from "@agentic/agent-factory";

function spec(p: Partial<GeneratedAgentSpec> & { actionName: string; trigger: string[]; emit: string[] }): GeneratedAgentSpec {
  return {
    key: p.actionName,
    actionName: p.actionName,
    slug: `sbrt-${p.actionName.toLowerCase()}`,
    short: p.actionName,
    domainId: "sbruntest",
    nameZh: p.actionName,
    kind: "llm",
    trigger: p.trigger,
    emit: p.emit,
    tools: p.tools ?? ["meta.ping"],
    unresolvedTools: [],
    objects: [],
    systemPrompt: `You are ${p.actionName}. Handle the trigger event and emit the outcome event.`,
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
  } as GeneratedAgentSpec;
}

describe("factory sandbox live-runthrough (T1 + T2 integration)", () => {
  beforeAll(async () => {
    await buildTestEnv();
    process.env.FACTORY_SANDBOX_READY_MS = "800"; // no dev server in test → don't wait the full 8s
  });

  it("auto-synthesizes a mock external agent, registers the chain on the sandbox app, and runs the per-kind verdict pipeline", async () => {
    const domain = "sbruntest";
    // A 2-agent chain with an EXTERNAL handoff: ProcessResume waits on RESUME_DOWNLOADED, which no
    // internal agent produces and we don't fire → the deployer must synthesize a mock to produce it.
    const specs = [
      spec({ actionName: "CreateJd", trigger: ["RUNTHRU_START"], emit: ["JD_GENERATED"] }),
      spec({ actionName: "ProcessResume", trigger: ["RESUME_DOWNLOADED"], emit: ["RESUME_PROCESSED"] }),
    ];
    const deployer = new ManifestSandboxDeployer();
    let res;
    try {
      res = await deployer.deployAndObserve(domain, specs, {
        testCases: [
          { entryEvent: "RUNTHRU_START", payload: { subject: "rt-pass" }, kind: "pass" },
          { entryEvent: "RUNTHRU_START", payload: { subject: "rt-reject", _force_reject: true }, kind: "reject" },
        ],
      });
    } finally {
      await deployer.teardown(domain).catch(() => {});
    }

    // T2 — a mock external-platform agent was auto-synthesized for the orphan trigger.
    expect(res.mockExternalAgents).toBeDefined();
    expect(res.mockExternalAgents!.length).toBe(1);
    expect(res.mockExternalAgents![0]).toContain("-mock-");

    // Real registration: the chain (2) + the mock (1) committed to the isolated sandbox app.
    expect(res.functionsRegistered).toBeGreaterThanOrEqual(3);
    expect(res.simulated).toBe(false);
    expect(res.registeredIds!.length).toBeGreaterThanOrEqual(3);

    // T1 — the per-case / per-kind verdict pipeline executed (2 kinded cases). Structure present;
    // allPass is honestly false here because the vitest env has no Inngest executor (0 runs).
    expect(res.caseVerdicts).toBeDefined();
    expect(res.caseVerdicts!.byKind.pass.total).toBe(1);
    expect(res.caseVerdicts!.byKind.reject.total).toBe(1);
  }, 30_000);
});
