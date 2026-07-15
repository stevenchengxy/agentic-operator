import { describe, expect, it } from "vitest";
import {
  parseJsonArray,
  parseList,
  parseTypedPorts,
  validateNumberInput,
} from "./AgentEditor";

describe("AgentEditor input parsing", () => {
  it("normalizes comma and whitespace-separated events without duplicates", () => {
    expect(parseList("READY, REVIEW\nREADY   COMPLETE")).toEqual([
      "READY",
      "REVIEW",
      "COMPLETE",
    ]);
  });

  it("accepts action and tool arrays while preserving nested extension data", () => {
    expect(
      parseJsonArray(
        '[{"type":"logic","extension":{"quality":"strict"}}]',
        "Actions",
      ),
    ).toEqual([{ type: "logic", extension: { quality: "strict" } }]);
  });

  it("rejects malformed JSON and non-array JSON", () => {
    expect(() => parseJsonArray("{", "Actions")).toThrow(
      "Actions must be valid JSON.",
    );
    expect(() => parseJsonArray('{"name":"meta.ping"}', "Tools")).toThrow(
      "Tools must be a JSON array.",
    );
  });

  it("validates typed input/output port JSON", () => {
    expect(
      parseTypedPorts(
        '[{"id":"request","kind":"value","schema":{"type":"object"}}]',
        "Inputs",
        "inputs",
      ),
    ).toHaveLength(1);
    expect(() =>
      parseTypedPorts(
        '[{"id":"request","schema":{"type":"object"}}]',
        "Inputs",
        "inputs",
      ),
    ).toThrow("Inputs[0].kind");
    expect(() =>
      parseTypedPorts('[{"id":"result"}]', "Outputs", "outputs"),
    ).toThrow("Outputs[0].schema");
  });

  it("reports malformed and out-of-range numeric values", () => {
    expect(
      validateNumberInput("0.5", "Temperature", { min: 0, max: 2 }),
    ).toBeNull();
    expect(validateNumberInput("2.5", "Temperature", { max: 2 })).toBe(
      "Temperature must be at most 2.",
    );
    expect(validateNumberInput("1.5", "Retries", { integer: true })).toBe(
      "Retries must be a whole number.",
    );
    expect(validateNumberInput("", "Stage", { required: true })).toBe(
      "Stage is required.",
    );
  });
});
