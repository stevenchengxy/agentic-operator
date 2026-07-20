import { describe, expect, it } from "vitest";

import {
  assertGeneratedSpecExecutionOwner,
  generatedSpecExecutionOwnership,
} from "./execution-ownership";
import { projectPlanToActions } from "./plan-projection";
import type { GeneratedAgentSpec } from "./spec-types";

function spec(overrides: Partial<GeneratedAgentSpec> = {}): GeneratedAgentSpec {
  return {
    key: "pure",
    actionName: "pure",
    slug: "test-pure",
    short: "Pure",
    domainId: "test",
    nameZh: "纯推理",
    kind: "llm",
    trigger: ["START"],
    emit: ["DONE"],
    tools: [],
    unresolvedTools: [],
    objects: [],
    systemPrompt: "判断并返回。",
    userPrompt: "",
    steps: [],
    ruleRefs: [],
    retries: 1,
    hitl: false,
    confidence: 1,
    promptSource: "llm",
    ...overrides,
  } as GeneratedAgentSpec;
}

describe("generated execution ownership", () => {
  it("allows a pure deterministic/emit handler to have the CodeAct owner", () => {
    const value = spec({
      generatedCode: "export const a={async handler(i,ctx){ctx.emit('DONE',i);return i}}",
      codeExecuted: true,
    });
    expect(generatedSpecExecutionOwnership(value)).toMatchObject({
      owner: "codeact-container",
      codeActEligible: true,
      blockers: [],
    });
    expect(() => assertGeneratedSpecExecutionOwner(value)).not.toThrow();
  });

  it.each([
    ["tool", spec({ tools: ["vendor.write"], codeExecuted: true })],
    ["invoke", spec({ plan: [{ stepId: "child", kind: "invoke", invoke: "child", onError: "terminal" }], codeExecuted: true })],
    ["foreach", spec({ plan: [{ stepId: "each", kind: "foreach", itemsFrom: "input.items", itemKeyFrom: "id", body: [{ stepId: "done", kind: "emit", emitEvent: "DONE" }] }], codeExecuted: true })],
    ["errorPolicy", spec({ plan: [{ stepId: "logic", kind: "logic", errorPolicy: [{ default: "retry" }] }], codeExecuted: true })],
  ])("blocks a codeExecuted=%s persistence bypass", (_name, value) => {
    expect(generatedSpecExecutionOwnership(value)).toMatchObject({
      owner: "declarative-plan",
      codeActEligible: false,
    });
    expect(() => assertGeneratedSpecExecutionOwner(value)).toThrow(/requires declarative-plan/);
    expect(() => projectPlanToActions(value)).toThrow(/requires declarative-plan/);
  });

  it("keeps model reasoning in the durable declarative logic step", () => {
    const value = spec({
      generatedCode: "export const a={async handler(i,ctx){return ctx.reason('decide',i)}}",
      codeExecuted: true,
    });
    expect(generatedSpecExecutionOwnership(value)).toMatchObject({
      owner: "declarative-plan",
      blockers: [expect.objectContaining({ code: "code_rpc_capability" })],
    });
    expect(() => assertGeneratedSpecExecutionOwner(value)).toThrow(/declarative-plan/);
  });

  it("does not mistake ordinary business properties for runtime capabilities", () => {
    const value = spec({
      generatedCode: "export const a={async handler(input){return {tool:input.tool,memory:input.record.memory,invoke:input.invoke}}}",
      codeExecuted: true,
    });
    expect(generatedSpecExecutionOwnership(value)).toMatchObject({
      owner: "codeact-container",
      codeActEligible: true,
      blockers: [],
    });
  });

  it("detects an AI handler that calls invoke even when the plan omits it", () => {
    const value = spec({
      generatedCode: "export const a={async handler(i,ctx){return ctx.invoke('hidden',i)}}",
      codeExecuted: true,
    });
    expect(generatedSpecExecutionOwnership(value)).toMatchObject({
      owner: "declarative-plan",
      blockers: [expect.objectContaining({ code: "code_rpc_capability" })],
    });
  });

  it.each([
    "export const a={async handler(i,ctx){await ctx.memory.put('x',i);return i}}",
    "export const a={async handler(i,ctx){const m=ctx.memory;await m.delete('x');return i}}",
    "export const a={async handler(i,ctx){return ctx['memory'].get('x')}}",
  ])("keeps memory RPC code under the durable declarative owner", (generatedCode) => {
    const ownership = generatedSpecExecutionOwnership(spec({ generatedCode, codeExecuted: true }));
    expect(ownership).toMatchObject({
      owner: "declarative-plan",
      blockers: [expect.objectContaining({ code: "code_rpc_capability" })],
    });
  });

  it.each([
    "export const a={handler(){return Math.random()}}",
    "export const a={handler(){return Date.now()}}",
    "export const a={handler(){return new Date().toISOString()}}",
    "export const a={handler(){return Date()}}",
    "export const a={handler(){return crypto.randomUUID()}}",
    "export const a={handler(){return performance.now()}}",
    "import { randomUUID as uuid } from 'node:crypto'; export const a={handler(){return uuid()}}",
    "export const a={handler(){const {random}=Math;return random()}}",
  ])("keeps wall-clock/entropy code out of replayable CodeAct", (generatedCode) => {
    expect(generatedSpecExecutionOwnership(spec({ generatedCode, codeExecuted: true }))).toMatchObject({
      owner: "declarative-plan",
      codeActEligible: false,
      blockers: [expect.objectContaining({ code: "code_nondeterminism" })],
    });
  });

  it("allows deterministic date and math transforms when their values come from input", () => {
    const generatedCode = "export const a={handler(input){return {at:new Date(input.at).toISOString(),epoch:Date.parse(input.at),rounded:Math.round(input.value)}}}";
    expect(generatedSpecExecutionOwnership(spec({ generatedCode, codeExecuted: true }))).toMatchObject({
      owner: "codeact-container",
      codeActEligible: true,
      blockers: [],
    });
  });
});
