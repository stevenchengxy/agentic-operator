import { describe, expect, it } from "vitest";
import {
  inspectWriteProbeSafety,
  prepareWriteProbeCanary,
  readProbeResultPath,
} from "@agentic/shared";

const contract = {
  testDataContract: {
    kind: "synthetic_canary" as const,
    marker: { kind: "argument" as const, path: "probe.marker", valuePrefix: "factory-canary-" },
  },
  idempotency: { kind: "argument" as const, path: "probe.idempotency_key", valuePrefix: "factory-idem-" },
  isolation: {
    namespace: { kind: "argument" as const, path: "probe.namespace", valuePrefix: "factory-ns-" },
    target: { kind: "argument" as const, path: "probe.target", valuePrefix: "factory-target-" },
  },
  cleanup: { kind: "operation" as const, operation: "canary.delete" },
  absenceProof: { kind: "operation" as const, operation: "canary.get" },
};

describe("write probe safety contract", () => {
  it("rejects the legacy idempotency-only metadata for write and dual tools", () => {
    for (const sideEffect of ["write", "dual"] as const) {
      expect(inspectWriteProbeSafety(sideEffect, { idempotency: { kind: "handler" } })).toMatchObject({
        status: "needs_config",
        next: "ask_user",
        missing: expect.arrayContaining([
          "test_data_contract",
          "idempotency_key",
          "canary_namespace",
          "canary_target",
          "cleanup",
          "absence_readback",
        ]),
      });
    }
  });

  it("injects deterministic isolation values and rejects caller overrides", () => {
    const seed = "a".repeat(64);
    const ready = inspectWriteProbeSafety("write", contract);
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("fixture must be ready");
    const prepared = prepareWriteProbeCanary({ args: { id: "r-1" }, contract: ready.contract, seed });
    expect(prepared).toMatchObject({
      ok: true,
      canary: {
        args: {
          id: "r-1",
          probe: {
            marker: `factory-canary-${seed.slice(0, 24)}`,
            namespace: `factory-ns-${seed.slice(0, 24)}`,
            target: `factory-target-${seed.slice(0, 24)}`,
            idempotency_key: `factory-idem-${seed}`,
          },
        },
      },
    });
    expect(prepareWriteProbeCanary({
      args: { probe: { target: "production-row" } },
      contract: ready.contract,
      seed,
    })).toMatchObject({ ok: false, reason: expect.stringContaining("conflicts") });
  });

  it("reads handler idempotency receipts only through a validated dotted path", () => {
    expect(readProbeResultPath({ receipt: { idempotency_key: "idem-1" } }, "receipt.idempotency_key")).toBe("idem-1");
    expect(readProbeResultPath({}, "__proto__.polluted")).toBeUndefined();
  });
});
