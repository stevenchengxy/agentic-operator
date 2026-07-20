import { describe, expect, it } from "vitest";

import {
  parseDeclarativeHttpContract,
  validateDeclarativeExamplesAgainstContract,
} from "./declarative-tool-spec";

describe("declarative HTTP example reconciliation", () => {
  it("accepts multipart examples whose request paths and nested response contract agree", () => {
    const contract = parseDeclarativeHttpContract({
      method: "POST",
      requestSpec: {
        encoding: "multipart",
        files: [{ field: "resume", base64_path: "file.base64", required: true }],
      },
      responseSpec: {
        assertions: [{ path: "meta.stage", op: "eq", value: "done", failure: "retryable", code: "STAGE_NOT_DONE" }],
        mappings: { score: "data.overall.score", candidateId: "data.candidate.id" },
      },
      examples: [{
        request: { file: { base64: "Zg==" } },
        response: { meta: { stage: "done" }, data: { overall: { score: 88 }, candidate: { id: "c-1" } } },
        source: "probe",
      }],
    });
    expect(contract.ok).toBe(true);
    if (!contract.ok) return;
    expect(validateDeclarativeExamplesAgainstContract(contract)).toEqual({ ok: true, errors: [] });
  });

  it("rejects a draft whose mapping or assertion contradicts captured evidence", () => {
    const contract = parseDeclarativeHttpContract({
      method: "POST",
      requestSpec: { encoding: "json", body_path: "payload" },
      responseSpec: {
        assertions: [{ path: "success", op: "eq", value: true, failure: "terminal", code: "NOT_SUCCESS" }],
        mappings: { score: "data.score" },
      },
      examples: [{ request: {}, response: { success: false, data: {} }, source: "human" }],
    });
    expect(contract.ok).toBe(true);
    if (!contract.ok) return;
    const result = validateDeclarativeExamplesAgainstContract(contract);
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("request_spec.body_path payload"),
      expect.stringContaining("assertion NOT_SUCCESS"),
      expect.stringContaining("mapping score"),
    ]));
  });

  it("supports root and array paths while rejecting a missing unwrap path", () => {
    const good = parseDeclarativeHttpContract({
      method: "GET",
      responseSpec: { unwrap_path: "items.0" },
      examples: [{ request: {}, response: { items: [{ id: "x" }] }, source: "documentation" }],
    });
    expect(good.ok).toBe(true);
    if (good.ok) expect(validateDeclarativeExamplesAgainstContract(good).ok).toBe(true);

    const bad = parseDeclarativeHttpContract({
      method: "GET",
      responseSpec: { unwrap_path: "data.missing" },
      examples: [{ request: {}, response: { data: {} }, source: "documentation" }],
    });
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(validateDeclarativeExamplesAgainstContract(bad).errors[0]).toContain("unwrap_path data.missing");
  });
});
