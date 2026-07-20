import { describe, expect, it } from "vitest";
import { AgentSchema } from "./manifest";

const base = {
  id: "generated-1",
  name: "generated",
  actor: ["Agent"],
  trigger: ["START"],
  triggered_event: [],
  actions: [{ order: "1", name: "run", description: "run", type: "logic" }],
  generated: true,
};

describe("generated manifest tool execution policy", () => {
  it("requires the reviewed policy triple for every generated tool", () => {
    const parsed = AgentSchema.safeParse({
      ...base,
      tool_use: [{ name: "meta.ping", side_effect: "read" }],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("execution_policy"))).toBe(true);
    }
  });

  it("rejects a semantically inconsistent triple", () => {
    expect(AgentSchema.safeParse({
      ...base,
      tool_use: [{
        name: "meta.ping",
        execution_policy: {
          operation: "write",
          effect_scope: "none",
          sandbox_policy: "pure",
        },
      }],
    }).success).toBe(false);
  });

  it("accepts a complete reviewed triple", () => {
    expect(AgentSchema.safeParse({
      ...base,
      tool_use: [{
        name: "meta.ping",
        execution_policy: {
          operation: "read",
          effect_scope: "none",
          sandbox_policy: "pure",
        },
      }],
    }).success).toBe(true);
  });
});
