// #R3 — EXECUTION FIDELITY. The acceptance gate historically accepted "the chain
// reached a terminal" as proof. But a chain can reach terminal while an agent emits
// a payload the downstream can't parse (the observed `output_parse_error`). This
// module grades the REAL sandbox I/O: for every agent that actually emitted an event,
// does its ACTUAL output payload satisfy the downstream field contract?
//
// It is the missing ORV term ("execution_fidelity") from the Contract-First report:
// structural closure says the edges connect; this says the DATA that flowed the edge
// is well-typed. Pure + deterministic → unit-testable; it takes the already-captured
// AgentRunIO[] (sandbox real I/O) and the contract's expected fields per event.

import type { AgentRunIO } from "./brain-types";
import type { ContractGraph, FieldSpec, PayloadError } from "./contract";
import { validateEventPayload } from "./contract";

export type AgentFidelity = {
  agentSlug: string;
  agentShort: string;
  outputEvent: string | null;
  ok: boolean;
  errors: PayloadError[];
  /** why an agent was not graded (not a failure — just nothing to check). */
  skipped?: "degraded" | "no_output_event" | "no_contract";
};

export type ExecutionFidelity = {
  /** agents that actually emitted an event WITH a downstream field contract to check. */
  evaluated: number;
  passed: number;
  failed: AgentFidelity[];
  /** all per-agent verdicts (including skipped), for the UI. */
  perAgent: AgentFidelity[];
  /** passed / evaluated (1 when nothing could be graded — lenient, never punishes absence). */
  fidelity: number;
  /** shorts of agents whose emitted payload violated the contract — the acceptance signal. */
  failingShorts: string[];
  ok: boolean;
};

/** The fields a DOWNSTREAM consumer will read off each event — the exact set whose absence /
 *  wrong type triggers `output_parse_error`. Derived from the contract graph's reconciled
 *  expectedFields (union of every consumer's inputFields for that event).
 *
 *  Review fix (over-strictness): when the ontology's canonical event_data is supplied, only
 *  CANONICAL fields are hard-required (`required: true`) — a consumer-invented field that the
 *  event doesn't authoritatively define is type-checked when present but its absence is not a
 *  fidelity failure (that asymmetry used to fail legit producers on optional/conditional fields).
 *  Without a canonical map the old behavior stands (validator's requireAll decides). */
export function expectedFieldsByEvent(graph: ContractGraph, canonical?: Map<string, FieldSpec[]>): Map<string, FieldSpec[]> {
  return new Map(
    graph.events.map((e) => {
      if (!canonical) return [e.name, e.expectedFields];
      const canonNames = new Set((canonical.get(e.name) ?? []).map((f) => f.field));
      return [e.name, e.expectedFields.map((f) => ({ ...f, required: canonNames.has(f.field) }))];
    }),
  );
}

/** Grade the real sandbox I/O against the downstream payload contract.
 *  - a degraded agent is skipped (already caught by the `chain_ran` criterion);
 *  - an agent that emitted nothing is skipped (nothing to grade);
 *  - an event with no downstream field contract (terminal / signal-only) is skipped (lenient);
 *  - otherwise the ACTUAL outputPayload is validated against the downstream fields. */
export function evaluateExecutionFidelity(
  agentRuns: AgentRunIO[],
  expectedByEvent: Map<string, FieldSpec[]>,
  opts?: { requireAll?: boolean },
): ExecutionFidelity {
  const perAgent: AgentFidelity[] = [];
  for (const run of agentRuns ?? []) {
    const base = { agentSlug: run.agentSlug, agentShort: run.agentShort, outputEvent: run.outputEvent };
    if (run.degraded) {
      perAgent.push({ ...base, ok: true, errors: [], skipped: "degraded" });
      continue;
    }
    if (!run.outputEvent) {
      perAgent.push({ ...base, ok: true, errors: [], skipped: "no_output_event" });
      continue;
    }
    const expected = expectedByEvent.get(run.outputEvent) ?? [];
    if (!expected.length) {
      perAgent.push({ ...base, ok: true, errors: [], skipped: "no_contract" });
      continue;
    }
    const v = validateEventPayload(run.outputPayload, expected, { requireAll: opts?.requireAll ?? true });
    perAgent.push({ ...base, ok: v.ok, errors: v.errors });
  }
  const graded = perAgent.filter((a) => !a.skipped);
  const failed = graded.filter((a) => !a.ok);
  const passed = graded.length - failed.length;
  return {
    evaluated: graded.length,
    passed,
    failed,
    perAgent,
    fidelity: graded.length ? passed / graded.length : 1,
    failingShorts: [...new Set(failed.map((a) => a.agentShort).filter(Boolean))],
    ok: failed.length === 0,
  };
}

/** zh one-liners for the brain / UI. */
export function fidelityStrings(f: ExecutionFidelity): string[] {
  return f.failed.map((a) => {
    const why = a.errors
      .map((e) =>
        e.kind === "not_object"
          ? `payload 不是对象(${e.actualType})`
          : e.kind === "missing"
            ? `缺字段 ${e.field}(${e.expectedType})`
            : `字段 ${e.field} 类型 ${e.actualType}≠${e.expectedType}`,
      )
      .join("；");
    return `执行保真失败：agent「${a.agentShort}」emit「${a.outputEvent}」的真实 payload 不满足下游契约 — ${why}`;
  });
}
