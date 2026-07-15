import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskFormFields } from "./TaskFormFields";
import { buildTaskFormDefinition, initialTaskFormValues } from "./task-form";

describe("TaskFormFields", () => {
  it("renders generated enum, narrative, numeric, boolean, and JSON controls", () => {
    const definition = buildTaskFormDefinition({
      type: "object",
      required: ["notes"],
      properties: {
        decision: { type: "string", enum: ["approve", "reject"] },
        notes: { type: "string", title: "Operator notes" },
        severity: { type: "string", enum: ["low", "high"] },
        confidence: { type: "number" },
        confirmed: { type: "boolean" },
        evidence: { type: "array" },
      },
    });
    const html = renderToStaticMarkup(
      <TaskFormFields
        definition={definition}
        values={initialTaskFormValues(definition)}
        errors={{ notes: "Operator notes is required." }}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("Operator notes");
    expect(html).toContain("Operator notes is required.");
    expect(html).toContain("<textarea");
    expect(html).toContain("<select");
    expect(html).toContain('type="number"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="evidence"');
    expect(html).not.toContain('name="decision"');
  });
});
