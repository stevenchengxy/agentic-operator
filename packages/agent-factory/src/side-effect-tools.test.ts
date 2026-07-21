import { describe, expect, it } from "vitest";
import { isSideEffectTool, SIDE_EFFECT_TOOLS } from "./side-effect-tools";

// WS1 (#SIDE-EFFECT-CKPT): the brain checkpoints immediately after a SIDE-EFFECTING tool
// so a crash before the end-of-turn checkpoint cannot make resume re-run the real effect.
// This predicate is the trust boundary for "which tool results must be made durable at once".
describe("isSideEffectTool", () => {
  it("classifies the durable/external/billed tools as side-effecting", () => {
    // The three the resumability analysis flagged for DUPLICATION on replay:
    expect(isSideEffectTool("sandbox_run")).toBe(true); // deploys ephemeral app + real billed tests
    expect(isSideEffectTool("finish")).toBe(true);       // persists delivery + marks delivered
    expect(isSideEffectTool("save_draft")).toBe(true);   // persists a draft version
    // Other durable/external writers must also be covered:
    expect(isSideEffectTool("run_regression")).toBe(true);
    expect(isSideEffectTool("create_tool")).toBe(true);
    expect(isSideEffectTool("create_skill")).toBe(true);
    expect(isSideEffectTool("create_signed_fixture")).toBe(true);
    expect(isSideEffectTool("confirm_integration_profile")).toBe(true);
    expect(isSideEffectTool("revise_ontology")).toBe(true);
    expect(isSideEffectTool("generate_report")).toBe(true);
    expect(isSideEffectTool("delivery_bundle")).toBe(true);
    expect(isSideEffectTool("probe_tool")).toBe(true);
  });

  it("treats read-only / in-memory-ctx tools as NON side-effecting", () => {
    // Pure reads — re-running on resume is free and harmless, no checkpoint needed:
    for (const t of [
      "read_ontology", "list_agents", "list_domains", "describe_domain",
      "describe_object", "inspect_run", "read_spec", "diff_spec", "score_spec",
      "review_agent", "review_context", "review_completeness", "web_search",
      "fetch_doc", "search_tools", "inspect_action_readiness",
    ]) {
      expect(isSideEffectTool(t), `${t} should be read-only`).toBe(false);
    }
    // In-memory ctx builders — their product lands in ctx, which is already
    // checkpointed per-turn; re-deriving is cheap and idempotent, so no per-tool save:
    for (const t of ["create_plan", "critique_plan", "understand_ontology", "design_agent", "codegen_agent"]) {
      expect(isSideEffectTool(t), `${t} is an in-memory ctx builder`).toBe(false);
    }
  });

  it("is false for unknown/open-vocabulary tool names (fail-open to no extra checkpoint)", () => {
    expect(isSideEffectTool("some_new_tool_2027")).toBe(false);
    expect(isSideEffectTool("")).toBe(false);
  });

  it("SIDE_EFFECT_TOOLS is a non-empty frozen set", () => {
    expect(SIDE_EFFECT_TOOLS.size).toBeGreaterThan(5);
    expect(SIDE_EFFECT_TOOLS.has("sandbox_run")).toBe(true);
  });
});
