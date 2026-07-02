import { describe, it, expect } from "vitest";
import { FACTORY_TOOLS } from "./tools";
import type { BrainCtx } from "./brain-types";

// #REDESIGN P3 — create_skill gets a lightweight review: a skill is woven into every relevant agent's
// prompt, so an empty/noise skill is rejected before it dilutes the prompts.

const create_skill = FACTORY_TOOLS.find((t) => t.name === "create_skill")!;

function ctx(): BrainCtx {
  return { createdSkills: [], emit: () => {}, domain: "rec", ports: {}, ontology: null } as unknown as BrainCtx;
}

describe("create_skill — lightweight review gate", () => {
  it("rejects an empty/trivial skill (no substantive know-how)", async () => {
    const c = ctx();
    const r = await create_skill.execute({ name: "noise", purpose: "x", prompt_fragment: "", decision_rule: "" }, c);
    expect(r.ok).toBe(false);
    expect((r.output as { rejected?: string }).rejected).toBe("empty");
    expect(c.createdSkills.length).toBe(0);
  });

  it("accepts a skill with substantive reusable guidance", async () => {
    const c = ctx();
    const r = await create_skill.execute({
      name: "silent-degrade-detection",
      purpose: "catch vendors that return 200 with empty content",
      prompt_fragment: "断言关键输出字段非空；vendor 返回 200 但 meta.stages 里藏失败时，判失败并报出，绝不假装成功。",
      decision_rule: "if key output fields are empty → treat as failure",
    }, c);
    expect(r.ok).toBe(true);
    expect(c.createdSkills.length).toBe(1);
  });
});
