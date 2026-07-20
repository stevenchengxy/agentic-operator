import { describe, expect, it } from "vitest";
import {
  INVOKE_CONTRACT_TEST_VECTORS,
  invokeTimeoutMs,
  materializeInvokePayload,
} from "@agentic/shared";
import { ActionSchema } from "./manifest";
import { runAction } from "./step-engine";

describe("canonical invoke contract", () => {
  it("fails closed on a non-integral or non-positive timeout", () => {
    expect(() => invokeTimeoutMs(0.5)).toThrow(/positive integer/);
    expect(() => invokeTimeoutMs(0)).toThrow(/positive integer/);
  });

  it.each(INVOKE_CONTRACT_TEST_VECTORS)("materializes $name", (vector) => {
    expect(materializeInvokePayload(vector.input)).toEqual(vector.expectedPayload);
    expect(invokeTimeoutMs(vector.input.timeoutS)).toBe(vector.expectedTimeoutMs);
  });

  it.each(INVOKE_CONTRACT_TEST_VECTORS)(
    "runtime honors payload and timeout vector: $name",
    async (vector) => {
      let captured:
        | { input: Record<string, unknown>; timeoutMs?: number }
        | undefined;
      const output = await runAction({
        ctx: {
          agentName: "parent",
          actionName: "invoke-child",
          correlationId: vector.input.correlationId ?? "",
          subject:
            typeof vector.input.subject === "string"
              ? vector.input.subject
              : undefined,
          tenantSlug: "tenant",
          event: { name: "START", data: { ...vector.input.eventData } },
          lastResult: vector.input.lastResult,
          results: vector.input.results,
        },
        action: ActionSchema.parse({
          order: "1",
          name: "invoke-child",
          type: "invoke",
          invoke: "child",
          invoke_input: vector.input.invokeInput,
          forward_last_result: vector.input.forwardLastResult,
          forward_results: vector.input.forwardResults,
          timeout_s: vector.input.timeoutS,
        }),
        durableActionRuntime: {
          async run(_stepId, operation) {
            return operation();
          },
          async invoke(request) {
            captured = request;
            return { ok: true };
          },
        },
      });
      expect(output.ok).toBe(true);
      expect(captured?.input).toEqual(vector.expectedPayload);
      expect(captured?.timeoutMs).toBe(vector.expectedTimeoutMs);
    },
  );
});
