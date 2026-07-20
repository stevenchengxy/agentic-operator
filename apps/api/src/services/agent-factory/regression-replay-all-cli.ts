import path from "node:path";

import { verifyFactoryRegressionExportBundle } from "./factory-regression-export-bundle";
import { redactRegressionDiagnostic } from "./regression-diagnostic-redaction";
import { replayAllPromotedRegressions } from "./replay-promoted-regressions";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const suppliedRoot =
  argument("--data-root") ??
  process.env.AGENTIC_FACTORY_REGRESSION_DATA_ROOT?.trim();
const exportRunId = argument("--export-run-id");
const exportRunAttempt = argument("--export-run-attempt");
const exportEvent = argument("--export-event");
const expectedRef = argument("--expected-ref");
const expectedSha = argument("--expected-sha") ?? process.env.GITHUB_SHA;
const consumerWorkflow = argument("--consumer-workflow");
const consumerRunId = argument("--consumer-run-id");
const consumerRunAttempt = argument("--consumer-run-attempt");
const requestNonce = argument("--request-nonce");
const highWatermarkStateHash = argument(
  "--expected-high-watermark-state-hash",
);
const signingKey = process.env.FACTORY_REGRESSION_EXPORT_SIGNING_KEY;
if (
  !suppliedRoot ||
  !exportRunId ||
  !exportRunAttempt ||
  !exportEvent ||
  !expectedRef ||
  !signingKey ||
  !process.env.GITHUB_REPOSITORY ||
  !expectedSha ||
  !consumerWorkflow ||
  !consumerRunId ||
  !consumerRunAttempt ||
  !requestNonce ||
  !highWatermarkStateHash
) {
  process.stderr.write(
    "usage: replay:factory-regressions -- --data-root <signed-export> --export-run-id <trusted-run-id> --export-run-attempt <attempt>\n" +
      "The signing key, exact GitHub consumer/export identity, nonce and signed high-watermark are mandatory; missing evidence is not a passing replay.\n",
  );
  process.exitCode = 2;
} else {
  try {
    const root = path.resolve(suppliedRoot);
    const inventory = await verifyFactoryRegressionExportBundle({
      dataRoot: root,
      signingKey,
      expected: {
        repository: process.env.GITHUB_REPOSITORY,
        workflow: ".github/workflows/factory-regression-export.yml",
        event:
          exportEvent === "workflow_dispatch" ? "workflow_dispatch" : "push",
        ref: expectedRef,
        sha: expectedSha,
        runId: exportRunId,
        runAttempt: exportRunAttempt,
        consumerWorkflow: consumerWorkflow as
          | ".github/workflows/ci.yml"
          | ".github/workflows/release.yml"
          | ".github/workflows/factory-regression-export.yml",
        consumerRunId,
        consumerRunAttempt,
        requestNonce,
        highWatermarkStateHash,
      },
    });
    const report = await replayAllPromotedRegressions(root, { inventory });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.pass) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `Factory regression replay blocked: ${redactRegressionDiagnostic(error)}\n`,
    );
    process.exitCode = 1;
  }
}
