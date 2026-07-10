/**
 * TC-97 — #D: the redefined 跑通 (full-chain-ran) verdict treats island/external agents correctly.
 *
 * An agent whose emit is consumed by an EXTERNAL platform (createJD → JD_GENERATED → HSM) is a
 * legitimate handoff terminal, NOT a broken chain. An agent triggered ONLY by an externally-sourced
 * event (it waits for a platform to send it) is exempt from the "must run" count. Only a real
 * break (kind:"break") fails the chain.
 */

import { describe, it, expect } from "vitest";
import { compileGraph } from "@agentic/agent-factory";
import { chainVerdict } from "../src/services/agent-factory/sandbox-deployer";

type S = { slug: string; actionName: string; trigger: string[]; emit: string[] };
const spec = (p: S) =>
  ({ slug: p.slug, actionName: p.actionName, short: p.actionName, nameZh: p.actionName, trigger: p.trigger, emit: p.emit, tools: ["x"], hitl: false, objects: [], systemPrompt: "x", userPrompt: "" }) as never;
const actionsOf = (specs: S[]) =>
  specs.map((s) => ({ id: s.slug, name: s.actionName, actor: ["Agent"], trigger: s.trigger, triggered_event: s.emit, target_objects: [], tool_use: ["x"], system_prompt: "", user_prompt: "" }) as never);
const graphOf = (specs: S[]) => compileGraph(actionsOf(specs), { domainId: "D" });

describe("TC-97: chainVerdict (#D 跑通 redefinition)", () => {
  it("counts an external-handoff emit as a legitimate success terminal (createJD → JD_GENERATED → external)", () => {
    const specs: S[] = [
      { slug: "a", actionName: "intake", trigger: ["RESUME_UPLOADED"], emit: ["RESUME_PROCESSED"] },
      { slug: "b", actionName: "createJD", trigger: ["RESUME_PROCESSED"], emit: ["JD_GENERATED"] },
    ];
    const cv = chainVerdict(specs.map(spec), graphOf(specs), [{ event: "JD_GENERATED", kind: "external" }], ["RESUME_UPLOADED"]);
    expect(cv.externalTerminals).toBe(1);
    expect(cv.successTerminals).toContain("JD_GENERATED");
    expect(cv.expectedToRun.length).toBe(2); // both are internally reachable
  });

  it("exempts an agent triggered ONLY by an externally-sourced, unfired event", () => {
    const specs: S[] = [
      { slug: "a", actionName: "intake", trigger: ["RESUME_UPLOADED"], emit: ["RESUME_PROCESSED"] },
      { slug: "c", actionName: "onWebhook", trigger: ["EXTERNAL_PING"], emit: ["DONE"] },
    ];
    const cv = chainVerdict(specs.map(spec), graphOf(specs), [], ["RESUME_UPLOADED"]); // only RESUME_UPLOADED is fired
    expect([...cv.externallyEntered]).toEqual(["onWebhook"]);
    expect(cv.expectedToRun.map((s) => (s as { actionName: string }).actionName)).toEqual(["intake"]);
  });

  it("does NOT count a real break (kind:break) as an external handoff", () => {
    const specs: S[] = [{ slug: "a", actionName: "intake", trigger: ["RESUME_UPLOADED"], emit: ["DANGLING"] }];
    const cv = chainVerdict(specs.map(spec), graphOf(specs), [{ event: "DANGLING", kind: "break" }], ["RESUME_UPLOADED"]);
    expect(cv.externalTerminals).toBe(0);
  });
});
