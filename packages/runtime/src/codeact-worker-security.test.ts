import { afterEach, describe, expect, it, vi } from "vitest";

import {
  codeActExecutionGate,
  executeCodeActWorker,
} from "./codeact-worker";
import {
  codeActExecutionReceiptFromMeta,
  makeCodeActExecutionReceipt,
} from "./codeact-receipt";

const originalGeneratedFlag = process.env.FACTORY_EXEC_GENERATED;
const originalTier = process.env.FACTORY_EXEC_TIER;

afterEach(() => {
  if (originalGeneratedFlag === undefined) {
    delete process.env.FACTORY_EXEC_GENERATED;
  } else {
    process.env.FACTORY_EXEC_GENERATED = originalGeneratedFlag;
  }
  if (originalTier === undefined) delete process.env.FACTORY_EXEC_TIER;
  else process.env.FACTORY_EXEC_TIER = originalTier;
});

function options(onRpc = vi.fn(async () => ({}))) {
  return {
    timeoutMs: 2_000,
    memoryMb: 64,
    identity: {
      agentName: "security-probe",
      tenantSlug: "tenant-sb-probe",
      correlationId: "cor-1",
    },
    onRpc,
  };
}

const prototypeEscape = `
  import { defineAgent } from "@agentic/runtime";
  export default defineAgent({ handler: async (input: any) => {
    const key = ["con", "structor"].join("");
    const hostConstructor = Reflect.get(Object.getPrototypeOf(input), key);
    const hostFunction = Reflect.get(hostConstructor, key);
    const proc = hostFunction("return process")();
    return {
      escaped: Boolean(proc?.getBuiltinModule),
      hasFs: Boolean(proc?.getBuiltinModule?.("fs")),
    };
  }});
`;

describe.sequential("CodeAct candidate execution boundary", () => {
  it("is disabled when the operator has not explicitly opted in", async () => {
    delete process.env.FACTORY_EXEC_GENERATED;
    const onRpc = vi.fn(async () => ({}));

    const result = await executeCodeActWorker(prototypeEscape, {}, options(onRpc));

    expect(result).toMatchObject({
      ok: false,
      isolation: "worker_thread",
      failure: "kill_switch",
      workerTerminated: true,
    });
    expect(onRpc).not.toHaveBeenCalled();
  });

  it("does not let an env tier label authorize the real worker/vm escape path", async () => {
    process.env.FACTORY_EXEC_GENERATED = "1";
    // This is intentionally a lie: the implementation below is still a
    // worker_thread. The execution gate uses the implementation's hard-coded
    // actual tier, never this operator label.
    process.env.FACTORY_EXEC_TIER = "container";
    const onRpc = vi.fn(async () => ({}));

    const result = await executeCodeActWorker(prototypeEscape, {}, options(onRpc));

    expect(result).toMatchObject({
      ok: false,
      isolation: "worker_thread",
      failure: "isolation_not_allowed",
      workerTerminated: true,
    });
    expect(result.error).toMatch(/worker_thread\/vm.*not.*security boundary/i);
    expect(onRpc).not.toHaveBeenCalled();
  });

  it("requires both an explicit opt-in and a real safe executor tier", () => {
    expect(codeActExecutionGate("isolated_subprocess", undefined).allowed).toBe(false);
    expect(codeActExecutionGate("isolated_container", "0").allowed).toBe(false);
    expect(codeActExecutionGate("worker_thread", "1")).toMatchObject({
      allowed: false,
      failure: "isolation_not_allowed",
    });
    expect(codeActExecutionGate("isolated_subprocess", "1")).toEqual({
      allowed: true,
      isolation: "isolated_subprocess",
    });
    expect(codeActExecutionGate("isolated_container", "1")).toEqual({
      allowed: true,
      isolation: "isolated_container",
    });
  });

  it("cannot mint or recover a production-verified worker receipt", () => {
    const forged = {
      source: "runtime_codeact" as const,
      codeExecuted: true,
      codeRan: true,
      isolation: "worker_thread" as const,
      codeSha256: "a".repeat(64),
      attestation: "production_verified" as const,
      durationMs: 1,
      failure: null,
    };

    expect(() => makeCodeActExecutionReceipt(forged)).toThrow(
      /isolated subprocess\/container executor/i,
    );
    expect(codeActExecutionReceiptFromMeta({ codeExecutionReceipt: forged })).toBeNull();
  });
});
