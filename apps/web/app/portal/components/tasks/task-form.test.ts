import { describe, expect, it } from "vitest";
import {
  buildTaskFormDefinition,
  buildTaskResolutionPayload,
  initialTaskFormValues,
} from "./task-form";

const approvalSchema = {
  type: "object",
  required: ["decision", "notes", "evidence"],
  properties: {
    decision: { type: "string", enum: ["approve", "reject", "revise"] },
    notes: {
      type: "string",
      title: "Review notes",
      description: "Explain the decision.",
      minLength: 3,
    },
    risk: { type: "string", enum: ["low", "medium", "high"] },
    score: { type: "number" },
    attempts: { type: "integer" },
    confirmed: { type: "boolean", default: true },
    evidence: { type: "array" },
    metadata: { type: "object" },
  },
};

describe("generated manual-task form model", () => {
  it("turns common JSON Schema properties into generic portal controls", () => {
    const definition = buildTaskFormDefinition(approvalSchema);
    expect(definition.decisionField).toBe("decision");
    expect(definition.decisions).toEqual([
      { decision: "approve", formValue: "approve", label: "Approve" },
      { decision: "reject", formValue: "reject", label: "Reject" },
      {
        decision: "supplement",
        formValue: "revise",
        label: "Request revision",
      },
    ]);
    expect(
      Object.fromEntries(
        definition.fields.map((field) => [field.name, field.kind]),
      ),
    ).toEqual({
      notes: "textarea",
      risk: "select",
      score: "number",
      attempts: "number",
      confirmed: "boolean",
      evidence: "json",
      metadata: "json",
    });
    expect(
      definition.fields.find((field) => field.name === "notes"),
    ).toMatchObject({
      label: "Review notes",
      required: true,
      minLength: 3,
    });
  });

  it("coerces a revision form into supplement API semantics without losing schema values", () => {
    const definition = buildTaskFormDefinition(approvalSchema);
    const values = {
      ...initialTaskFormValues(definition),
      notes: "Please add control evidence.",
      risk: "high",
      score: "0.72",
      attempts: "2",
      confirmed: true,
      evidence: '[{"id":"policy-7"}]',
      metadata: '{"owner":"risk"}',
    };
    const revision = definition.decisions.find(
      (option) => option.decision === "supplement",
    )!;
    expect(buildTaskResolutionPayload(definition, values, revision)).toEqual({
      ok: true,
      payload: {
        decision: "revise",
        notes: "Please add control evidence.",
        risk: "high",
        score: 0.72,
        attempts: 2,
        confirmed: true,
        evidence: [{ id: "policy-7" }],
        metadata: { owner: "risk" },
      },
    });
  });

  it("blocks missing required fields and malformed typed values", () => {
    const definition = buildTaskFormDefinition(approvalSchema);
    const approve = definition.decisions[0]!;
    const result = buildTaskResolutionPayload(
      definition,
      {
        ...initialTaskFormValues(definition),
        notes: "no",
        risk: "unknown",
        attempts: "1.5",
        evidence: "not json",
      },
      approve,
    );
    expect(result).toEqual({
      ok: false,
      errors: expect.objectContaining({
        notes: expect.stringContaining("at least 3"),
        risk: expect.stringContaining("valid risk"),
        attempts: expect.stringContaining("valid integer"),
        evidence: expect.stringContaining("valid JSON"),
      }),
    });
  });

  it("ignores prototype-sensitive property names", () => {
    const definition = buildTaskFormDefinition(
      JSON.parse(
        '{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"string"},"notes":{"type":"string"}}}',
      ),
    );
    expect(definition.fields.map((field) => field.name)).toEqual(["notes"]);
  });
});
