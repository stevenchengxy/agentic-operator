import path from "node:path";

import { exportFactoryRegressionBundle } from "./factory-regression-export-bundle";
import { redactRegressionDiagnostic } from "./regression-diagnostic-redaction";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dataRoot =
  argument("--data-root") ?? process.env.AGENTIC_DATA_ROOT?.trim();
const outputRoot = argument("--output");
const key = process.env.FACTORY_REGRESSION_EXPORT_SIGNING_KEY;
const databaseReadOnly = ["1", "true"].includes(
  process.env.AGENTIC_DATABASE_READONLY?.trim().toLowerCase() ?? "",
);

if (!dataRoot || !outputRoot || !key || !databaseReadOnly) {
  process.stderr.write(
    "Factory regression export requires --data-root, --output, FACTORY_REGRESSION_EXPORT_SIGNING_KEY and AGENTIC_DATABASE_READONLY=1.\n",
  );
  process.exitCode = 2;
} else {
  try {
    const manifest = await exportFactoryRegressionBundle({
      dataRoot: path.resolve(dataRoot),
      outputRoot: path.resolve(outputRoot),
      signingKey: key,
      source: {
        repository: process.env.GITHUB_REPOSITORY ?? "",
        workflow: ".github/workflows/factory-regression-export.yml",
        event:
          process.env.GITHUB_EVENT_NAME === "workflow_dispatch"
            ? "workflow_dispatch"
            : "push",
        ref: process.env.GITHUB_REF ?? "",
        sha: process.env.GITHUB_SHA ?? "",
        runId: process.env.GITHUB_RUN_ID ?? "",
        runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
        consumerWorkflow: (process.env
          .FACTORY_REGRESSION_EXPORT_CONSUMER_WORKFLOW ??
          ".github/workflows/factory-regression-export.yml") as
          | ".github/workflows/ci.yml"
          | ".github/workflows/release.yml"
          | ".github/workflows/factory-regression-export.yml",
        consumerRunId:
          process.env.FACTORY_REGRESSION_EXPORT_CONSUMER_RUN_ID ??
          process.env.GITHUB_RUN_ID ??
          "",
        consumerRunAttempt:
          process.env.FACTORY_REGRESSION_EXPORT_CONSUMER_RUN_ATTEMPT ??
          process.env.GITHUB_RUN_ATTEMPT ??
          "",
        requestNonce:
          process.env.FACTORY_REGRESSION_EXPORT_REQUEST_NONCE ??
          `standalone-${process.env.GITHUB_RUN_ID ?? "missing"}-${
            process.env.GITHUB_RUN_ATTEMPT ?? "missing"
          }`,
      },
      ...(process.env.FACTORY_REGRESSION_EXPORT_TTL_SECONDS
        ? {
            ttlSeconds: Number(
              process.env.FACTORY_REGRESSION_EXPORT_TTL_SECONDS,
            ),
          }
        : {}),
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          schema: manifest.schema,
          createdAt: manifest.createdAt,
          expiresAt: manifest.expiresAt,
          source: manifest.source,
          committedCount: manifest.highWatermark.committedCount,
          ledgerDigest: manifest.highWatermark.ledgerDigest,
          files: manifest.files.length,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `Factory regression export failed: ${redactRegressionDiagnostic(error)}\n`,
    );
    process.exitCode = 1;
  }
}
