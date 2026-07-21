// #SIDE-EFFECT-CKPT (WS1) — which brain tools produce a durable/external/billed effect that
// MUST NOT be re-issued on crash-resume.
//
// The conductor checkpoints the conversation ONCE at the end of every turn (#CRASH-CKPT,
// conductor.ts). That is enough for read-only or in-memory work, but a tool whose whole point is
// an irreversible side effect (deploying an ephemeral sandbox + running real billed tests,
// persisting a draft/tool/skill/report) leaves its `role:"tool"` result only in the in-memory
// `messages` array until the turn ends. If the process dies AFTER the effect but BEFORE that
// end-of-turn save, boot auto-resume replays from the previous checkpoint and re-issues the call —
// re-deploying a second sandbox, re-billing test runs, appending a duplicate draft version.
//
// Listing a tool here promotes its checkpoint to "immediately after the tool returns", so the
// durable snapshot always reflects that the effect already happened. An extra SQLite upsert is
// cheap; a duplicated side effect is not. Defense-in-depth only — WS2/WS3 also make the two most
// expensive effects (sandbox_run, save_draft) idempotent on replay.
//
// Inclusion principle: a tool belongs here if it (a) runs real external/billed execution,
// (b) persists a durable record, or (c) spawns sub-runs that consume budget. Pure reads and
// in-memory ctx builders (design_agent/codegen_agent/create_plan/understand_ontology/…) are
// EXCLUDED: their product lands in ctx, which is already checkpointed per turn, so re-deriving on
// resume is cheap and free of external effects.
//
// Open-vocabulary safety: unknown tool names are treated as NON side-effecting (fail-open to no
// extra checkpoint). A genuinely new side-effecting tool must be added here explicitly — the same
// discipline the trust boundary already uses elsewhere.

export const SIDE_EFFECT_TOOLS: ReadonlySet<string> = new Set([
  // Real external / billed execution
  "sandbox_run",
  "run_regression",
  "probe_tool",
  // Delivery / durable draft persistence
  "finish",
  "save_draft",
  "delivery_bundle",
  // Durable capability/artifact writes
  "create_tool",
  "create_skill",
  "create_signed_fixture",
  "confirm_integration_profile",
  "revise_ontology",
  "generate_report",
  // Sub-run spawns (consume budget, may persist run rows)
  "spawn_subagent",
  "spawn_subagent_group",
  "design_fleet",
  // Skill execution can perform arbitrary effects
  "use_skill",
]);

/** True when a completed tool call must be made durable at once (see SIDE_EFFECT_TOOLS). */
export function isSideEffectTool(toolName: string): boolean {
  return SIDE_EFFECT_TOOLS.has(toolName);
}
