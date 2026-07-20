import { describe, expect, it } from "vitest";
import { ActionSchema, AgentSchema, flattenActionSpecs } from "./manifest";
import { runAction } from "./step-engine";

describe("foreach runtime contract", () => {
  it("validates nested emit declarations and exposes nested actions to boot checks", () => {
    const base = {
      id: "batch", name: "batch", actor: ["Agent"], trigger: ["IN"], triggered_event: ["ROW_DONE"],
      actions: [{
        order: "1", name: "each", type: "foreach", items_from: "input.rows", item_key_from: "id",
        foreach_actions: [
          { order: "1", name: "save", type: "tool" },
          { order: "2", name: "done", type: "emit", emit_event: "ROW_DONE" },
        ],
      }],
    } as const;
    const parsed = AgentSchema.parse(base);
    expect(flattenActionSpecs(parsed.actions).map((action) => action.name)).toEqual(["each", "save", "done"]);
    expect(AgentSchema.safeParse({ ...base, triggered_event: ["OTHER"] }).success).toBe(false);
    expect(ActionSchema.safeParse({
      order: "1", name: "each", type: "foreach", items_from: "input.rows", item_key_from: "id",
      foreach_actions: [{ order: "1", name: "human", type: "manual" }],
    }).success).toBe(false);

    const duplicateNested = {
      ...base,
      actions: [{
        ...base.actions[0],
        foreach_actions: [
          { order: "1", name: "first", result_key: "same", type: "logic" },
          { order: "2", name: "second", result_key: "same", type: "logic" },
        ],
      }],
    } as const;
    const duplicateResult = AgentSchema.safeParse(duplicateNested);
    expect(duplicateResult.success).toBe(false);
    if (!duplicateResult.success) {
      expect(duplicateResult.error.issues.map((issue) => issue.message).join(" "))
        .toMatch(/duplicate sibling action key same/);
    }

    const invalidNestedDependency = {
      ...base,
      actions: [{
        ...base.actions[0],
        foreach_actions: [
          { order: "1", name: "first", type: "logic", depends_on: ["later"] },
          { order: "2", name: "later", type: "logic" },
        ],
      }],
    } as const;
    const dependencyResult = AgentSchema.safeParse(invalidNestedDependency);
    expect(dependencyResult.success).toBe(false);
    if (!dependencyResult.success) {
      expect(dependencyResult.error.issues.map((issue) => issue.message).join(" "))
        .toMatch(/prior sibling action in the same scope/);
    }

    expect(AgentSchema.safeParse({
      ...base,
      actions: [
        { order: "1", name: "same", type: "logic" },
        { order: "2", name: "same", type: "logic" },
      ],
    }).success).toBe(false);

    expect(AgentSchema.safeParse({
      ...base,
      actions: [{
        ...base.actions[0],
        foreach_actions: [
          { order: "1", name: "first", type: "logic" },
          { order: "2", name: "second", type: "logic", depends_on: ["first"] },
        ],
      }],
    }).success).toBe(true);
  });

  it("runs items sequentially, exposes named local results, and retains every emit", async () => {
    const order: string[] = [];
    const action = ActionSchema.parse({
      order: "1",
      name: "parse-all",
      type: "foreach",
      items_from: "input.resumes",
      item_as: "resume",
      item_key_from: "resume.id",
      foreach_mode: "sequential",
      foreach_actions: [
        { order: "1", name: "parse-one", result_key: "parsed", type: "tool", on_error: "terminal" },
        { order: "2", name: "is-valid", result_key: "valid", type: "condition", condition: "results.parsed.result.ok == true" },
        { order: "3", name: "emit-one", result_key: "emitted", type: "emit", depends_on: ["valid"], emit_event: "RESUME_PARSED", emit_payload_from: "results.parsed" },
      ],
    });

    const out = await runAction({
      ctx: {
        agentName: "batch-parser",
        actionName: "parse-all",
        correlationId: "cor-1",
        tenantSlug: "tenant",
        event: { name: "BATCH_RECEIVED", data: { resumes: [{ id: "R-1" }, { id: "R-2" }] } },
      },
      action,
      agent: { triggeredEvents: ["RESUME_PARSED"] },
      tenantRegistry: {
        tools: {
          "parse-one": {
            kind: "tool",
            name: "parse-one",
            async handler(ctx) {
              const resume = ctx.locals?.resume as { id: string };
              order.push(resume.id);
              return { data: { id: resume.id, ok: true, parsedName: `candidate-${resume.id}` } };
            },
          },
        },
      },
    });

    expect(out.ok).toBe(true);
    expect(order).toEqual(["R-1", "R-2"]);
    const data = out.data as { count: number; items: Array<{ results: Record<string, unknown>; stepIds: string[] }> };
    expect(data.count).toBe(2);
    expect(data.items[0]!.results.parsed).toMatchObject({ id: "R-1", ok: true });
    expect(data.items[0]!.results.valid).toMatchObject({ evaluated: true });
    expect(data.items[0]!.stepIds).toHaveLength(3);
    expect((out.meta as { emitted: unknown[] }).emitted).toEqual([
      { event: "RESUME_PARSED", payload: { id: "R-1", ok: true, parsedName: "candidate-R-1" } },
      { event: "RESUME_PARSED", payload: { id: "R-2", ok: true, parsedName: "candidate-R-2" } },
    ]);
  });

  it("rejects explicit emit events outside the agent declaration", async () => {
    const out = await runAction({
      ctx: {
        agentName: "a",
        actionName: "emit",
        correlationId: "c",
        tenantSlug: "t",
        event: { name: "IN", data: {} },
        lastResult: { id: "1" },
      },
      action: ActionSchema.parse({ order: "1", name: "emit", type: "emit", emit_event: "INVENTED" }),
      agent: { triggeredEvents: ["DECLARED"] },
    });
    expect(out.ok).toBe(false);
    expect(out.meta).toMatchObject({ error: "emit_event_not_declared" });
  });

  it("stops running later item side effects after a terminal body failure", async () => {
    const failed = await runAction({
      ctx: {
        agentName: "batch", actionName: "each", correlationId: "c", tenantSlug: "t",
        event: { name: "IN", data: { rows: [{ id: "1" }, { id: "2" }] } },
      },
      action: ActionSchema.parse({
        order: "1", name: "each", type: "foreach", items_from: "input.rows", item_key_from: "id",
        foreach_actions: [{ order: "1", name: "missing", type: "tool", on_error: "terminal" }],
      }),
      tenantRegistry: { tools: {} },
    });
    expect(failed.ok).toBe(false);
    const receipts = (failed.data as { receipts: Array<{ skipped?: boolean }> }).receipts;
    expect(receipts[1]).toMatchObject({ skipped: true });
  });

  it("runs nested foreach + invoke with ancestry-stable ids, timeout, policy emits, and receipts", async () => {
    const action = ActionSchema.parse({
      order: "1",
      name: "each-job",
      result_key: "jobs",
      type: "foreach",
      items_from: "input.jobs",
      item_as: "job",
      item_key_from: "job.id",
      foreach_actions: [{
        order: "1",
        name: "each-candidate",
        result_key: "candidates",
        type: "foreach",
        items_from: "locals.job.candidates",
        item_as: "candidate",
        item_key_from: "candidate.id",
        foreach_actions: [{
          order: "1",
          name: "check-candidate",
          result_key: "check",
          type: "invoke",
          invoke: "candidate-checker",
          timeout_s: 2,
          on_error: [
            { when: "code == 'CANDIDATE_REJECTED'", do: "continue", default_result: { accepted: false }, emit_event: "CHILD_FAILED" },
            { default: "terminal", suppress_emit: true },
          ],
        }, {
          order: "2",
          name: "candidate-done",
          result_key: "done",
          type: "emit",
          emit_event: "CANDIDATE_DONE",
          emit_payload_from: "results.check",
        }],
      }],
    });

    const execute = async (jobs: Array<{ id: string; candidates: Array<{ id: string }> }>) => {
      const runIds: string[] = [];
      const invokes: Array<{ stepId: string; target: string; timeoutMs?: number; input: Record<string, unknown> }> = [];
      const out = await runAction({
        ctx: {
          agentName: "nested",
          actionName: "each-job",
          correlationId: "corr-nested",
          tenantSlug: "tenant",
          event: { name: "START", data: { jobs } },
        },
        action,
        agent: { triggeredEvents: ["CANDIDATE_DONE", "CHILD_FAILED"] },
        durableActionRuntime: {
          async run(stepId, operation) {
            runIds.push(stepId);
            return operation();
          },
          async invoke(request) {
            invokes.push(request);
            if (request.input.id === "C-2") {
              throw Object.assign(new Error("candidate rejected"), { code: "CANDIDATE_REJECTED" });
            }
            return { accepted: true, candidateId: request.input.id };
          },
        },
      });
      return { out, runIds, invokes };
    };

    const jobs = [
      { id: "JR/a", candidates: [{ id: "C-1" }, { id: "C-2" }] },
      { id: "JR a", candidates: [{ id: "C-3" }] },
    ];
    const first = await execute(jobs);
    const reordered = await execute([...jobs].reverse().map((job) => ({ ...job, candidates: [...job.candidates].reverse() })));

    expect(first.out.ok).toBe(true);
    expect(first.invokes).toHaveLength(3);
    expect(first.invokes.every((call) => call.target === "candidate-checker" && call.timeoutMs === 2_000)).toBe(true);
    expect(new Set(first.invokes.map((call) => call.stepId)).size).toBe(3);
    expect([...first.invokes.map((call) => call.stepId)].sort()).toEqual(
      [...reordered.invokes.map((call) => call.stepId)].sort(),
    );
    // `JR/a` and `JR a` sanitize to the same text, so distinct ids prove the
    // ancestry hash — not an array index — owns replay identity.
    expect(new Set(first.runIds).size).toBe(first.runIds.length);

    const emitted = (first.out.meta as { emitted: Array<{ event: string }> }).emitted;
    expect(emitted.map((intent) => intent.event)).toEqual([
      "CANDIDATE_DONE",
      "CHILD_FAILED",
      "CANDIDATE_DONE",
      "CANDIDATE_DONE",
    ]);
    const outer = first.out.data as {
      items: Array<{ results: { candidates: { items: Array<{ failures: unknown[]; stepIds: string[] }> } } }>;
    };
    expect(outer.items[0]!.results.candidates.items[1]!.failures).toHaveLength(1);
    expect(outer.items[0]!.results.candidates.items[1]!.stepIds).toHaveLength(2);
  });
});
