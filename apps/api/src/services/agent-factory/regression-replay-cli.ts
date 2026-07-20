import { replayRegressionArtifact } from "./regression-artifact";
import {
  redactRegressionDiagnostic,
  redactRegressionReplayResult,
} from "./regression-diagnostic-redaction";

const artifact = process.argv[2];
if (!artifact) {
  process.stderr.write(
    "usage: pnpm --filter @agentic/api replay:factory-regression -- <regression.json> [slug ...]\n",
  );
  process.exitCode = 2;
} else {
  try {
    const result = await replayRegressionArtifact(
      artifact,
      process.argv.slice(3),
    );
    process.stdout.write(
      `${JSON.stringify(redactRegressionReplayResult(result), null, 2)}\n`,
    );
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `Factory regression replay blocked: ${redactRegressionDiagnostic(error)}\n`,
    );
    process.exitCode = 1;
  }
}
