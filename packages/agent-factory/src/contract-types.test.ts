import { describe, it, expect } from "vitest";
import {
  deriveContractGraph,
  contractIssueStrings,
  contractAgentIssueMap,
  validateEventPayload,
  normalizeDeclaredType,
  runtimeType,
  typesCompatible,
  canonicalEventFields,
} from "./contract";
import type { GeneratedAgentSpec } from "./spec-types";
import type { DomainOntology } from "./ontology-types";

// Minimal spec factory — mirrors contract.test.ts.
function spec(p: Partial<GeneratedAgentSpec> & { actionName: string }): GeneratedAgentSpec {
  return {
    actionName: p.actionName,
    slug: p.slug ?? `d-${p.actionName}`,
    nameZh: p.nameZh ?? p.actionName,
    trigger: p.trigger ?? [],
    emit: p.emit ?? [],
    tools: p.tools ?? [],
    unresolvedTools: p.unresolvedTools ?? [],
    systemPrompt: p.systemPrompt ?? "",
    inputSchema: p.inputSchema,
    outputSchema: p.outputSchema,
  } as GeneratedAgentSpec;
}

describe("type normalization", () => {
  it("normalizes declared-type synonyms to the known vocabulary", () => {
    expect(normalizeDeclaredType("String")).toBe("string");
    expect(normalizeDeclaredType("text")).toBe("string");
    expect(normalizeDeclaredType("Integer")).toBe("number");
    expect(normalizeDeclaredType("float")).toBe("number");
    expect(normalizeDeclaredType("Boolean")).toBe("boolean");
    expect(normalizeDeclaredType("JSON")).toBe("object");
    expect(normalizeDeclaredType("record")).toBe("object");
    expect(normalizeDeclaredType("list")).toBe("array");
    expect(normalizeDeclaredType("string[]")).toBe("array");
  });
  it("maps domain / empty / unknown declared types to 'unknown' (lenient — never a false mismatch)", () => {
    expect(normalizeDeclaredType("DateTime")).toBe("unknown");
    expect(normalizeDeclaredType("Candidate")).toBe("unknown");
    expect(normalizeDeclaredType("")).toBe("unknown");
    expect(normalizeDeclaredType("any")).toBe("unknown");
  });
  it("runtimeType classifies JS values", () => {
    expect(runtimeType("x")).toBe("string");
    expect(runtimeType(3)).toBe("number");
    expect(runtimeType(true)).toBe("boolean");
    expect(runtimeType({})).toBe("object");
    expect(runtimeType([])).toBe("array");
    expect(runtimeType(null)).toBe("null");
    expect(runtimeType(undefined)).toBe("undefined");
  });
  it("typesCompatible is lenient on unknown, strict otherwise", () => {
    expect(typesCompatible("unknown", "string")).toBe(true);
    expect(typesCompatible("string", "unknown")).toBe(true);
    expect(typesCompatible("string", "string")).toBe(true);
    expect(typesCompatible("number", "string")).toBe(false);
    expect(typesCompatible("object", "array")).toBe(false);
  });
});

describe("validateEventPayload (RUNTIME payload validator — the output_parse_error killer)", () => {
  const expected = [
    { field: "candidate_id", type: "string" },
    { field: "score", type: "number" },
    { field: "profile", type: "object" },
  ];

  it("rejects a non-object payload (this is the observed 'expected object, received undefined')", () => {
    const r = validateEventPayload(undefined, expected);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ kind: "not_object", actualType: "undefined" });
    expect(validateEventPayload(null, expected).errors[0]?.kind).toBe("not_object");
    expect(validateEventPayload("nope", expected).errors[0]?.kind).toBe("not_object");
    expect(validateEventPayload([1, 2], expected).errors[0]).toMatchObject({ kind: "not_object", actualType: "array" });
  });

  it("passes when every expected field is present with a compatible type", () => {
    const r = validateEventPayload({ candidate_id: "c-1", score: 88, profile: { name: "A" } }, expected);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("flags a MISSING required field", () => {
    const r = validateEventPayload({ candidate_id: "c-1", score: 88 }, expected);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(expect.objectContaining({ field: "profile", kind: "missing" }));
  });

  it("flags a TYPE MISMATCH (score emitted as string where a number is expected)", () => {
    const r = validateEventPayload({ candidate_id: "c-1", score: "high", profile: {} }, expected);
    expect(r.ok).toBe(false);
    expect(r.errors).toContainEqual(
      expect.objectContaining({ field: "score", kind: "type_mismatch", expectedType: "number", actualType: "string" }),
    );
  });

  it("flags object-vs-array mismatch", () => {
    const r = validateEventPayload({ candidate_id: "c", score: 1, profile: [] }, expected);
    expect(r.errors).toContainEqual(expect.objectContaining({ field: "profile", kind: "type_mismatch", actualType: "array" }));
  });

  it("is LENIENT: unknown declared type and null values never trip (avoids over-rejection)", () => {
    const exp = [
      { field: "when", type: "DateTime" }, // unknown → skip type check
      { field: "candidate_id", type: "string" },
      { field: "notes", type: "string" },
    ];
    const r = validateEventPayload({ when: 1720000000, candidate_id: "c-1", notes: null }, exp);
    expect(r.ok).toBe(true);
  });

  it("requireAll:false treats absent fields as OK (optional-field contexts)", () => {
    const r = validateEventPayload({ candidate_id: "c-1" }, expected, { requireAll: false });
    expect(r.ok).toBe(true);
  });
});

describe("deriveContractGraph — DESIGN-TIME type mismatch", () => {
  it("flags a consumer expecting a different type than the event provides", () => {
    const g = deriveContractGraph(
      [
        spec({
          actionName: "parseResume",
          trigger: ["RESUME_DOWNLOADED"],
          emit: ["RESUME_PROCESSED"],
          outputSchema: [{ field: "score", type: "string" }], // producer emits string
        }),
        spec({
          actionName: "matchResume",
          trigger: ["RESUME_PROCESSED"],
          emit: ["MATCH_PASSED"],
          inputSchema: [{ field: "score", type: "number" }], // consumer wants number
        }),
      ],
      "rec",
    );
    const tm = g.issues.find((i) => i.kind === "type_mismatch");
    expect(tm).toMatchObject({ event: "RESUME_PROCESSED", field: "score", side: "consumer" });
    expect(g.ok).toBe(false);
    expect(contractIssueStrings(g).some((s) => s.includes("类型") && s.includes("score"))).toBe(true);
    expect(Object.keys(contractAgentIssueMap(g))).toContain("matchResume");
  });

  it("flags a producer emitting a type that conflicts with the ontology's canonical event_data", () => {
    const eventFields = new Map([["RESUME_PROCESSED", [{ field: "candidate_id", type: "number" }]]]);
    const g = deriveContractGraph(
      [
        spec({
          actionName: "parseResume",
          trigger: ["RESUME_DOWNLOADED"],
          emit: ["RESUME_PROCESSED"],
          outputSchema: [{ field: "candidate_id", type: "string" }], // ontology says number
        }),
        spec({ actionName: "matchResume", trigger: ["RESUME_PROCESSED"], emit: ["MATCH_PASSED"] }),
      ],
      "rec",
      eventFields,
    );
    const tm = g.issues.find((i) => i.kind === "type_mismatch" && i.side === "producer");
    expect(tm).toMatchObject({ event: "RESUME_PROCESSED", field: "candidate_id" });
    expect(g.ok).toBe(false);
  });

  it("does NOT flag when types match or are unknown (no false positives)", () => {
    const g = deriveContractGraph(
      [
        spec({ actionName: "a", trigger: ["E_IN"], emit: ["E_MID"], outputSchema: [{ field: "x", type: "String" }, { field: "d", type: "DateTime" }] }),
        spec({ actionName: "b", trigger: ["E_MID"], emit: ["E_OUT"], inputSchema: [{ field: "x", type: "text" }, { field: "d", type: "SomethingDomainy" }] }),
      ],
      "rec",
    );
    expect(g.issues.some((i) => i.kind === "type_mismatch")).toBe(false);
  });
});

// Review fixes — order-independence + per-field required.
describe("type_conflict (review fix: order-independent divergent declarations)", () => {
  it("two CONSUMERS declaring the same field with divergent known types → type_conflict, verdict independent of order", () => {
    const mk = (order: "ab" | "ba") => {
      const a = spec({ actionName: "consA", trigger: ["E_MID"], emit: ["E_A"], inputSchema: [{ field: "score", type: "string" }] });
      const b = spec({ actionName: "consB", trigger: ["E_MID"], emit: ["E_B"], inputSchema: [{ field: "score", type: "number" }] });
      const prod = spec({ actionName: "prod", trigger: ["E_IN"], emit: ["E_MID"], outputSchema: [{ field: "score", type: "number" }] });
      return deriveContractGraph(order === "ab" ? [prod, a, b] : [prod, b, a], "rec");
    };
    for (const order of ["ab", "ba"] as const) {
      const g = mk(order);
      const tc = g.issues.find((i) => i.kind === "type_conflict" && i.side === "consumer");
      expect(tc).toMatchObject({ event: "E_MID", field: "score", types: ["number", "string"] });
      expect(g.ok).toBe(false);
      // the merged expected field degrades to unknown → no order-dependent type_mismatch on top
      const ev = g.events.find((e) => e.name === "E_MID")!;
      expect(ev.expectedFields.find((f) => f.field === "score")!.type).toBe("unknown");
      expect(g.issues.some((i) => i.kind === "type_mismatch")).toBe(false);
    }
  });

  it("two PRODUCERS declaring divergent known types for a non-canonical field → type_conflict (was silently order-resolved)", () => {
    const g = deriveContractGraph(
      [
        spec({ actionName: "prodA", trigger: ["E_1"], emit: ["E_MID"], outputSchema: [{ field: "foo", type: "string" }] }),
        spec({ actionName: "prodB", trigger: ["E_2"], emit: ["E_MID"], outputSchema: [{ field: "foo", type: "number" }] }),
        spec({ actionName: "cons", trigger: ["E_MID"], emit: ["E_OUT"], inputSchema: [{ field: "foo", type: "number" }] }),
      ],
      "rec",
    );
    const tc = g.issues.find((i) => i.kind === "type_conflict" && i.side === "producer");
    expect(tc).toMatchObject({ event: "E_MID", field: "foo", types: ["number", "string"] });
    expect(g.ok).toBe(false);
  });

  it("agreeing types + unknown extras do NOT conflict", () => {
    const g = deriveContractGraph(
      [
        spec({ actionName: "a", trigger: ["E_MID"], emit: ["E_A"], inputSchema: [{ field: "x", type: "string" }] }),
        spec({ actionName: "b", trigger: ["E_MID"], emit: ["E_B"], inputSchema: [{ field: "x", type: "text" }, { field: "d", type: "DateTime" }] }),
        spec({ actionName: "p", trigger: ["E_IN"], emit: ["E_MID"], outputSchema: [{ field: "x", type: "string" }, { field: "d", type: "string" }] }),
      ],
      "rec",
    );
    expect(g.issues.some((i) => i.kind === "type_conflict")).toBe(false);
  });
});

describe("per-field required (review fix: consumer-invented optional fields)", () => {
  it("required:false fields are type-checked when present but their absence is OK even with requireAll:true", () => {
    const expected = [
      { field: "candidate_id", type: "string", required: true },
      { field: "rejection_reason", type: "string", required: false },
    ];
    expect(validateEventPayload({ candidate_id: "c-1" }, expected).ok).toBe(true);
    expect(validateEventPayload({}, expected).errors).toContainEqual(expect.objectContaining({ field: "candidate_id", kind: "missing" }));
    expect(validateEventPayload({ candidate_id: "c", rejection_reason: 42 }, expected).errors).toContainEqual(
      expect.objectContaining({ field: "rejection_reason", kind: "type_mismatch" }),
    );
  });
});

describe("canonicalEventFields", () => {
  it("builds a per-event FieldSpec map from ontology event_data", () => {
    const ont = {
      events: [
        { name: "RESUME_PROCESSED", payload: { source_action: null, event_data: [{ name: "candidate_id", type: "string", target_object: "Candidate", required: false }], state_mutations: [] } },
      ],
    } as unknown as DomainOntology;
    const m = canonicalEventFields(ont);
    expect(m.get("RESUME_PROCESSED")).toEqual([{ field: "candidate_id", type: "string", source: "Candidate", required: false }]);
  });
  it("is safe on null / missing payload", () => {
    expect(canonicalEventFields(null).size).toBe(0);
    expect(canonicalEventFields({ events: [{ name: "E" }] } as unknown as DomainOntology).get("E")).toEqual([]);
  });
});
