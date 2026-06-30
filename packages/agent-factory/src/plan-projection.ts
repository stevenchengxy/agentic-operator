// Phase 1 — project a GeneratedAgentSpec's structured `plan[]` into the runtime manifest's
// ordered `actions[]`. Each plan step becomes its OWN manifest action (= one durable step.run in
// register.ts), so a generated agent gets the per-step durability + branching + soft-fail that a
// hand-written production agent has. Pure (imports only spec-types) so it's unit-testable without
// the deployer's heavy deps; mapToManifest (apps/api) calls it.

import type { GeneratedAgentSpec, PlanStep, PlanStepKind } from "./spec-types";

const PLAN_KINDS: PlanStepKind[] = ["tool", "logic", "condition", "invoke"];

/** Normalize raw LLM-authored plan rows (snake_case OR camelCase) into PlanStep[]. Drops rows
 *  missing a stepId or a valid kind. */
export function parsePlan(raw: unknown): PlanStep[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanStep[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    const stepId = String(o.stepId ?? o.step_id ?? "").trim();
    const kind = String(o.kind ?? "").trim() as PlanStepKind;
    if (!stepId || !PLAN_KINDS.includes(kind)) continue;
    const dependsRaw = o.dependsOn ?? o.depends_on;
    const onErrRaw = String(o.onError ?? o.on_error ?? "").trim();
    const step: PlanStep = {
      stepId,
      kind,
      tool: o.tool != null ? String(o.tool) : undefined,
      condition: o.condition != null ? String(o.condition) : undefined,
      invoke: o.invoke != null ? String(o.invoke) : undefined,
      dependsOn: Array.isArray(dependsRaw) ? dependsRaw.map(String) : undefined,
      idempotencyKeyFrom: (o.idempotencyKeyFrom ?? o.idempotency_key_from) != null ? String(o.idempotencyKeyFrom ?? o.idempotency_key_from) : undefined,
      onError: onErrRaw === "soft" || onErrRaw === "terminal" || onErrRaw === "park" ? (onErrRaw as PlanStep["onError"]) : undefined,
      defaultResult: o.defaultResult ?? o.default_result,
      timeoutS: typeof (o.timeoutS ?? o.timeout_s) === "number" ? (o.timeoutS ?? o.timeout_s) as number : undefined,
      description: o.description != null ? String(o.description) : undefined,
    };
    out.push(step);
  }
  return out;
}

/** Enforce production discipline on an authored plan (Phase 1). Side-effecting steps (tool /
 *  invoke) MUST declare a failure policy (onError) and a replay-stable idempotencyKeyFrom — the
 *  same guarantees a hand-written agent gets from step.run + sanitized business-key ids. Returns
 *  the concrete errors so design_agent can REJECT a sloppy plan (mirrors the empty-prompt reject). */
export function validatePlan(plan: PlanStep[], opts?: { knownTools?: string[] }): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < plan.length; i++) {
    const s = plan[i]!;
    const at = `step "${s.stepId || `#${i + 1}`}"`;
    if (!s.stepId) errors.push(`${at}: missing stepId`);
    if (seen.has(s.stepId)) errors.push(`${at}: duplicate stepId`);
    seen.add(s.stepId);
    if (!PLAN_KINDS.includes(s.kind)) errors.push(`${at}: invalid kind "${s.kind}"`);

    const sideEffecting = s.kind === "tool" || s.kind === "invoke";
    if (s.kind === "tool" && !s.tool) errors.push(`${at}: tool step needs a "tool" name`);
    if (s.kind === "invoke" && !s.invoke) errors.push(`${at}: invoke step needs an "invoke" target`);
    if (s.kind === "condition" && !s.condition) errors.push(`${at}: condition step needs a "condition" expression`);
    if (s.kind === "tool" && s.tool && opts?.knownTools && !opts.knownTools.includes(s.tool)) {
      errors.push(`${at}: tool "${s.tool}" is not in the resolved tool set`);
    }
    if (sideEffecting && !s.idempotencyKeyFrom) errors.push(`${at}: side-effecting step needs idempotencyKeyFrom (a replay-stable business key)`);
    if (sideEffecting && !s.onError) errors.push(`${at}: side-effecting step needs an onError failure policy (terminal | soft | park)`);

    for (const dep of s.dependsOn ?? []) {
      if (!seen.has(dep)) errors.push(`${at}: dependsOn "${dep}" is not a prior step (forward/unknown reference)`);
    }
  }
  return { ok: errors.length === 0, errors };
}

/** The manifest action shape the runtime ActionSchema accepts (loose — validated downstream). */
export type ManifestAction = Record<string, unknown> & { order: string; name: string; type: string };

function actionForStep(step: PlanStep, order: number, retries: number): ManifestAction {
  const a: ManifestAction = {
    order: String(order),
    // A tool step's name IS the tool name so step-engine resolves it (tenant ?? global registry).
    // Other kinds use the human-readable stepId.
    name: step.kind === "tool" ? (step.tool || step.stepId) : step.stepId,
    type: step.kind,
    description: step.description ?? step.stepId,
    retries,
  };
  if (step.dependsOn?.length) a.depends_on = step.dependsOn;
  if (step.idempotencyKeyFrom) a.idempotency_key_from = step.idempotencyKeyFrom;
  // manifest on_error enum is soft|terminal; "park" maps to the default Inngest retry (omit).
  if (step.onError === "soft" || step.onError === "terminal") a.on_error = step.onError;
  if (step.defaultResult !== undefined) a.default_result = step.defaultResult;
  if (step.kind === "condition") a.condition = step.condition ?? "true";
  if (step.kind === "invoke") {
    a.invoke = step.invoke;
    if (step.timeoutS) a.timeout_s = step.timeoutS;
  }
  return a;
}

/** Build the ordered manifest actions for a spec: an optional HITL manual gate, then either the
 *  projected plan steps (Phase 1) or the legacy single-logic action (back-compat, no plan). */
export function projectPlanToActions(spec: GeneratedAgentSpec): ManifestAction[] {
  const retries = spec.retries ?? 1;
  const actions: ManifestAction[] = [];
  let order = 1;

  if (spec.hitl) {
    actions.push({
      order: String(order++),
      name: `${spec.actionName || spec.slug}-approval`,
      description: "Human approval gate",
      type: "manual",
      retries,
    });
  }

  const plan = spec.plan ?? [];
  if (plan.length) {
    for (const step of plan) actions.push(actionForStep(step, order++, retries));
  } else {
    actions.push({
      order: String(order++),
      name: spec.actionName || spec.slug,
      description: (spec.designReasoning ?? "").slice(0, 200) || (spec.actionName || spec.slug),
      type: "logic",
      retries,
    });
  }
  return actions;
}
