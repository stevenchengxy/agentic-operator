import { createHmac, randomBytes } from "node:crypto";

import type { RegressionReplayResult } from "./regression-artifact";

export type RegressionDiagnosticCategory =
  | "artifact"
  | "cassette"
  | "fixture"
  | "integrity"
  | "inventory"
  | "ledger"
  | "execution"
  | "assertion"
  | "configuration"
  | "unknown";

// Per-process salt keeps references stable inside one CLI report while making
// low-entropy fixture values and credentials resistant to offline guessing.
const diagnosticReferenceKey = randomBytes(32);

function categoryFor(message: string): RegressionDiagnosticCategory {
  const value = message.toLowerCase();
  if (/inventory|live factory|production deployment/.test(value))
    return "inventory";
  if (/ledger|promotion|high-watermark|committed|pending/.test(value))
    return "ledger";
  if (/cassette|probe evidence/.test(value)) return "cassette";
  if (/fixture|asset|binary/.test(value)) return "fixture";
  if (/fingerprint|hash|drift|mismatch|receipt|schema/.test(value))
    return "integrity";
  if (/artifact|module|spec|version|draft/.test(value)) return "artifact";
  if (/expected|forbidden|emit|assert/.test(value)) return "assertion";
  if (/worker|execution|timeout|ran|runtime|codeact/.test(value))
    return "execution";
  if (/config|source|workflow|ref|commit|sign|expired|missing/.test(value))
    return "configuration";
  return "unknown";
}

/**
 * Diagnostics written to CI logs never echo model output, fixture values,
 * absolute paths, cassette bodies, credentials or arbitrary worker errors.
 * The run-local reference correlates duplicate failures in one report without
 * turning a low-entropy secret into a reusable, dictionary-attackable digest.
 */
export function redactRegressionDiagnostic(value: unknown): string {
  const raw = String(value ?? "");
  const reference = createHmac("sha256", diagnosticReferenceKey)
    .update(raw, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `regression_${categoryFor(raw)} [ref:${reference}]`;
}

export function redactRegressionReplayResult(
  result: RegressionReplayResult,
): RegressionReplayResult {
  return {
    ...result,
    artifact: result.artifact ? "[withheld-artifact-path]" : "",
    errors: result.errors.map(redactRegressionDiagnostic),
    results: result.results.map((entry) => ({
      ...entry,
      reasons: entry.reasons.map(redactRegressionDiagnostic),
    })),
  };
}
