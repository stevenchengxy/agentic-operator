/**
 * Shared artifact writer.
 *
 * Both the manifest engine (this package's `step-engine.ts`) and the code
 * engine (`packages/agents/src/run-engine.ts`) write per-step input/output
 * sidecars under `<AGENTIC_ARTIFACTS_DIR>/<runId>/step-N-{input,output}.json`.
 *
 * Previously each engine had its own private copy; the manifest engine had
 * NONE (Audit #3 §10.2, §11.2). Extracting it here closes P0-RT-09 and gives
 * the replay UI a single artifact trail to load.
 */

import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";

export function artifactsRoot(): string {
  return process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts";
}

/**
 * Persist a JSON sidecar for one step's input or output.
 *
 * Returns the absolute path written, suitable for `steps.input_ref` /
 * `steps.output_ref`. Errors propagate to the caller — a failed write is a
 * real problem for replay/debug, not something to silently swallow.
 */
export async function writeArtifact(
  runId: string,
  name: string,
  payload: unknown,
): Promise<string> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId)) {
    throw new Error(`Invalid run id for artifact path: ${runId}`);
  }
  if (!/^[A-Za-z0-9_.-]{1,180}$/.test(name)) {
    throw new Error(`Invalid artifact filename: ${name}`);
  }
  const dir = path.join(artifactsRoot(), runId);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, name);
  const serialized = JSON.stringify(payload, null, 2);
  if (serialized === undefined) {
    throw new TypeError(`Artifact '${name}' has no JSON representation`);
  }
  const tmpPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmpPath, serialized, "utf8");
    await rename(tmpPath, filePath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return filePath;
}
