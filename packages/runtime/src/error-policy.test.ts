import { describe, expect, it } from "vitest";
import {
  actionErrorFacts,
  classifyActionFailure,
  evaluateErrorPredicate,
  failureForDisposition,
  validateErrorPredicateSyntax,
  type RuntimeErrorPolicyRule,
} from "./error-policy";
import { ActionSchema, AgentSchema } from "./manifest";

function typedFailure(kind: string, status?: number): Error {
  return Object.assign(new Error(`${kind}: upstream request failed${status ? ` HTTP ${status}` : ""}`), {
    kind,
    status,
  });
}

const ladder: RuntimeErrorPolicyRule[] = [
  { when: "status==429 || code==QUOTA_EXHAUSTED", do: "park", suppress_emit: true },
  { when: "kind==schema_mismatch", do: "terminal", suppress_emit: true },
  { when: "status>=500", do: "retry", suppress_emit: true },
  {
    when: "status>=400 && status<500",
    do: "continue",
    default_result: { accepted: false },
    emit_event: "REQUEST_REJECTED",
    emit_payload: { source: "classifier" },
  },
  { default: "terminal", suppress_emit: true },
];

describe("declarative action error policy", () => {
  it("extracts typed kind/status through a serialized message fallback", () => {
    expect(actionErrorFacts(typedFailure("rate_limit", 429))).toMatchObject({
      kind: "rate_limit",
      status: 429,
      name: "Error",
    });
    expect(actionErrorFacts(new Error("http_5xx: service HTTP 503"))).toMatchObject({
      kind: "http_5xx",
      status: 503,
    });
  });

  it.each([
    ["429 is parked/retried", typedFailure("rate_limit", 429), "retry", "park"],
    ["5xx is retried", typedFailure("http_5xx", 503), "retry", "retry"],
    ["schema mismatch is terminal", typedFailure("schema_mismatch"), "terminal", "terminal"],
  ] as const)("classifies %s", (_label, failure, disposition, policyAction) => {
    expect(classifyActionFailure({ policy: ladder, failure })).toMatchObject({
      disposition,
      policyAction,
    });
  });

  it("continues a non-retriable 4xx with its default and selects a declared error emit", () => {
    const result = classifyActionFailure({
      policy: ladder,
      failure: typedFailure("http_4xx", 422),
    });
    expect(result).toMatchObject({
      disposition: "continue",
      defaultResult: { accepted: false },
      emitEvent: "REQUEST_REJECTED",
      emitPayload: { source: "classifier" },
      suppressEmit: false,
    });
    expect(result.matchedRule).toBe(3);
  });

  it("uses first-match ordering and fail-closes invalid predicates", () => {
    const first = classifyActionFailure({
      policy: [
        { when: "status>=400", do: "continue", default_result: null },
        { when: "status==429", do: "park" },
        { default: "terminal" },
      ],
      failure: typedFailure("rate_limit", 429),
    });
    expect(first.disposition).toBe("continue");
    expect(first.matchedRule).toBe(0);

    const invalid = classifyActionFailure({
      policy: [
        { when: "process.exit()", do: "continue", default_result: null },
        { default: "retry" },
      ],
      failure: typedFailure("network"),
    });
    expect(invalid.disposition).toBe("terminal");
    expect(invalid.policyError).toMatch(/forbidden|safe predicate/i);
  });

  it("supports concise bare codes while rejecting executable syntax", () => {
    expect(validateErrorPredicateSyntax("code==QUOTA_EXHAUSTED||status==429")).toBeNull();
    expect(evaluateErrorPredicate("code==QUOTA_EXHAUSTED||status==429", {
      code: "QUOTA_EXHAUSTED",
      name: "Error",
      message: "quota",
    })).toEqual({ valid: true, value: true });
    expect(validateErrorPredicateSyntax("status >= 400 && (() => true)()" )).toMatch(/forbidden|safe/i);
  });

  it("preserves legacy soft/retry and turns legacy terminal into NonRetriableError", () => {
    const failure = typedFailure("network");
    const soft = classifyActionFailure({ policy: "soft", failure, defaultResult: null });
    expect(soft).toMatchObject({ disposition: "continue", defaultResult: null });
    expect(failureForDisposition(soft, failure)).toBeNull();

    const retry = classifyActionFailure({ policy: undefined, failure });
    expect(failureForDisposition(retry, failure)).toBe(failure);

    const terminal = classifyActionFailure({ policy: "terminal", failure });
    const terminalError = failureForDisposition(terminal, failure);
    expect(terminalError?.name).toBe("NonRetriableError");
    expect((terminalError as Error & { cause?: unknown }).cause).toBe(failure);
  });
});

describe("manifest error-policy schema", () => {
  const action = (on_error: unknown, extra: Record<string, unknown> = {}) => ({
    order: "1",
    name: "call-external",
    type: "tool",
    on_error,
    ...extra,
  });

  it("accepts a complete ladder and keeps legacy strings compatible", () => {
    expect(ActionSchema.parse(action(ladder)).on_error).toEqual(ladder);
    expect(ActionSchema.parse(action("soft", { default_result: null })).on_error).toBe("soft");
    expect(ActionSchema.parse(action("terminal")).on_error).toBe("terminal");
  });

  it("rejects unsafe, missing-default, and continue-without-fallback ladders", () => {
    expect(() => ActionSchema.parse(action([
      { when: "process.exit()", do: "continue", default_result: null },
      { default: "terminal" },
    ]))).toThrow();
    expect(() => ActionSchema.parse(action([{ when: "status==429", do: "park" }]))).toThrow();
    expect(() => ActionSchema.parse(action([
      { when: "status==400", do: "continue" },
      { default: "terminal" },
    ]))).toThrow();
  });

  it("validates classifier-selected events against the agent allow-list", () => {
    const base = {
      id: "a-1",
      name: "genericAgent",
      actor: ["Agent"],
      trigger: ["INPUT_READY"],
      actions: [action([
        { when: "status>=400&&status<500", do: "continue", default_result: {}, emit_event: "REQUEST_REJECTED" },
        { default: "terminal" },
      ])],
      triggered_event: ["REQUEST_REJECTED"],
    };
    expect(AgentSchema.parse(base).name).toBe("genericAgent");
    expect(() => AgentSchema.parse({ ...base, triggered_event: ["REQUEST_ACCEPTED"] })).toThrow(/undeclared event/i);
  });
});
