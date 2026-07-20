import { describe, expect, it } from "vitest";
import { ActionSchema } from "./manifest";
import { runAction } from "./step-engine";

describe("exact manifest tool dataflow", () => {
  it("passes only authored arguments and maps the raw result", async () => {
    const seen: Record<string, unknown>[] = [];
    const implicitCarry: unknown[] = [];
    const action = ActionSchema.parse({
      order: "1",
      name: "candidate.lookup",
      type: "tool",
      tool_arguments: {
        candidate_id: { from: "input.candidate_id" },
        prior_token: { from: "lastResult.token" },
        source: { const: "agent-factory" },
        optional: { from: "input.absent", required: false },
      },
      result_map: {
        fields: {
          canonical_id: "result.data.id",
          found: "result.data.found",
        },
        include_raw: true,
      },
    });
    const raw = { data: { id: "C-9", found: true }, provider: "real" };
    const output = await runAction({
      ctx: {
        agentName: "identity",
        actionName: "candidate.lookup",
        correlationId: "cor-1",
        tenantSlug: "tenant",
        event: { name: "LOOKUP", data: { candidate_id: "incoming-9", ignored: "must-not-leak" } },
        lastResult: { token: "previous", also_ignored: true },
        results: { other: { value: 1 } },
      },
      action,
      tenantRegistry: {
        tools: {
          "candidate.lookup": {
            kind: "tool",
            name: "candidate.lookup",
            async handler(ctx) {
              seen.push(ctx.event?.data ?? {});
              implicitCarry.push(ctx.lastResult, ctx.results, ctx.locals);
              return { data: raw };
            },
          },
        },
      },
    });

    expect(seen).toEqual([{
      candidate_id: "incoming-9",
      prior_token: "previous",
      source: "agent-factory",
    }]);
    expect(implicitCarry).toEqual([undefined, undefined, undefined]);
    expect(output).toMatchObject({
      ok: true,
      data: { canonical_id: "C-9", found: true, _raw: raw },
      meta: { argumentMode: "explicit", resultMapped: true, rawResultIncluded: true },
    });
  });

  it("fails before dispatch when a required input or result path is absent", async () => {
    let calls = 0;
    const tool = {
      kind: "tool" as const,
      name: "strict.tool",
      async handler() {
        calls++;
        return { data: { present: true } };
      },
    };
    const base = {
      agentName: "strict",
      actionName: "strict.tool",
      correlationId: "c",
      tenantSlug: "tenant",
      event: { name: "IN", data: {} },
    };

    const missingInput = await runAction({
      ctx: base,
      action: ActionSchema.parse({
        order: "1", name: "strict.tool", type: "tool",
        tool_arguments: { id: { from: "input.id" } },
      }),
      tenantRegistry: { tools: { "strict.tool": tool } },
    });
    expect(missingInput).toMatchObject({ ok: false, meta: { error: "tool_arguments_unresolved", path: "input.id" } });
    expect(calls).toBe(0);

    const missingOutput = await runAction({
      ctx: { ...base, event: { name: "IN", data: { id: "1" } } },
      action: ActionSchema.parse({
        order: "1", name: "strict.tool", type: "tool",
        tool_arguments: { id: { from: "input.id" } },
        result_map: { fields: { id: "result.missing" } },
      }),
      tenantRegistry: { tools: { "strict.tool": tool } },
    });
    expect(missingOutput).toMatchObject({ ok: false, data: null, meta: { error: "tool_result_map_unresolved", path: "result.missing" } });
    expect(calls).toBe(1);
  });

  it("keeps old actions compatible but labels their whole-context mode", async () => {
    const output = await runAction({
      ctx: {
        agentName: "legacy", actionName: "legacy.tool", correlationId: "c", tenantSlug: "tenant",
        event: { name: "IN", data: { entire: "payload" } },
      },
      action: ActionSchema.parse({ order: "1", name: "legacy.tool", type: "tool" }),
      tenantRegistry: {
        tools: {
          "legacy.tool": { kind: "tool", name: "legacy.tool", async handler(ctx) { return { data: ctx.event?.data }; } },
        },
      },
    });
    expect(output).toMatchObject({ ok: true, data: { entire: "payload" }, meta: { argumentMode: "legacy_whole_context" } });
  });

  it("rejects unsafe/unrooted templates at manifest load", () => {
    expect(ActionSchema.safeParse({
      order: "1", name: "bad", type: "tool", tool_arguments: { id: { from: "candidate_id" } },
    }).success).toBe(false);
    expect(ActionSchema.safeParse({
      order: "1", name: "bad", type: "tool", tool_arguments: { id: "input.id" },
    }).success).toBe(false);
    expect(ActionSchema.safeParse({
      order: "1", name: "bad", type: "tool", result_map: { fields: { id: "data.id" } },
    }).success).toBe(false);
    expect(ActionSchema.safeParse({
      order: "1", name: "bad", type: "logic", tool_arguments: { id: { from: "input.id" } },
    }).success).toBe(false);
  });
});
