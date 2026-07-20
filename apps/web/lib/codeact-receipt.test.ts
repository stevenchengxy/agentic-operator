import { describe, expect, it } from "vitest";
import { getCodeActReceiptView } from "./codeact-receipt";

const sha = "a".repeat(64);

describe("getCodeActReceiptView", () => {
  it("does not turn a manifest execution request into runtime evidence", () => {
    expect(getCodeActReceiptView({ codeExecuted: true })).toBeNull();
    expect(
      getCodeActReceiptView({
        codeExecuted: true,
        codeRan: true,
        codeIsolation: "worker_thread",
      }),
    ).toBeNull();
  });

  it("accepts a successful isolated runtime receipt", () => {
    expect(
      getCodeActReceiptView({
        codeExecuted: true,
        codeRan: true,
        codeIsolation: "worker_thread",
        codeSha256: sha,
        codeAttestation: "production_verified",
        codeExecutionFailure: null,
      }),
    ).toEqual({
      state: "ran",
      codeExecuted: true,
      codeRan: true,
      isolation: "worker_thread",
      sha256: sha,
      attestation: "production_verified",
      failure: null,
    });
  });

  it("distinguishes an executed worker failure from a preflight block", () => {
    expect(
      getCodeActReceiptView({
        codeExecuted: true,
        codeRan: false,
        codeIsolation: "worker_thread",
        codeSha256: sha,
        codeAttestation: "sandbox_verified",
        codeExecutionFailure: "handler_failed",
      })?.state,
    ).toBe("failed");

    expect(
      getCodeActReceiptView({
        codeExecuted: false,
        codeRan: false,
        codeIsolation: null,
        codeSha256: sha,
        codeAttestation: "mismatch",
        codeExecutionFailure: "attestation_mismatch",
      })?.state,
    ).toBe("blocked");
  });

  it("rejects contradictory or incomplete receipt fields", () => {
    expect(
      getCodeActReceiptView({
        codeExecuted: false,
        codeRan: true,
        codeIsolation: null,
        codeSha256: sha,
        codeAttestation: "mismatch",
        codeExecutionFailure: null,
      }),
    ).toBeNull();
    expect(
      getCodeActReceiptView({
        codeExecuted: true,
        codeRan: false,
        codeIsolation: null,
        codeSha256: sha,
        codeAttestation: "production_verified",
        codeExecutionFailure: "worker_crash",
      }),
    ).toBeNull();
  });
});
