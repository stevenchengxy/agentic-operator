/**
 * Process-wide Vitest isolation for mutable workflow-model files.
 *
 * Several API tests intentionally exercise manifest import, workflow save,
 * and hot-swap. Those routes write versioned JSON files under
 * AGENTIC_MODELS_DIR. Pointing tests at the live `models/` tree therefore
 * polluted the developer workspace even after SQLite itself was isolated.
 *
 * Clone the 12 MB fixture tree once, run every test against the clone, then
 * remove it. A content fingerprint makes the suite fail if any test bypasses
 * AGENTIC_MODELS_DIR and mutates the live source tree again.
 */

import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const sourceModels = path.join(repoRoot, "models");
const testFixtureModels = path.join(import.meta.dirname, "fixtures", "manifests");
const testRunRoot =
  process.env.AGENTIC_API_TEST_RUN_ROOT?.trim() ||
  path.join(repoRoot, "data", "test-runs", String(process.pid));
const testModels = path.join(testRunRoot, "models");

function treeFingerprint(root: string): string {
  const hash = createHash("sha256");
  const visit = (dir: string, prefix: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relative = path.posix.join(prefix, entry.name);
      const absolute = path.join(dir, entry.name);
      hash.update(relative);
      if (entry.isDirectory()) {
        hash.update("dir\0");
        visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${readlinkSync(absolute)}\0`);
      } else if (entry.isFile()) {
        hash.update("file\0");
        hash.update(readFileSync(absolute));
      }
    }
  };
  visit(root, "");
  return hash.digest("hex");
}

export default function setup() {
  const liveFingerprint = treeFingerprint(sourceModels);
  rmSync(testRunRoot, { recursive: true, force: true });
  mkdirSync(testRunRoot, { recursive: true });
  cpSync(sourceModels, testModels, { recursive: true, force: true });
  // `__system` manifests are mutable API-test fixtures, not production
  // deployable models. Keeping them under live `models/` previously amassed
  // hundreds of workflow_vN files and let a test-only workflow look like a
  // production runtime. Materialize the canonical happy fixture only inside
  // the isolated clone.
  const systemFixture = JSON.parse(
    readFileSync(path.join(testFixtureModels, "happy-v2.json"), "utf8"),
  ) as { agents: unknown[] };
  const systemFixtureDir = path.join(testModels, "__system-v1");
  mkdirSync(systemFixtureDir, { recursive: true });
  writeFileSync(
    path.join(systemFixtureDir, "workflow_v1.json"),
    `${JSON.stringify(systemFixture.agents, null, 2)}\n`,
    "utf8",
  );

  return () => {
    // A teardown may be delayed after SIGINT; it can only remove this run's
    // unique root and therefore cannot corrupt another active invocation.
    rmSync(testRunRoot, { recursive: true, force: true });
    const after = treeFingerprint(sourceModels);
    if (after !== liveFingerprint) {
      throw new Error(
        "API tests mutated the live models/ tree. All mutable model writes must honor AGENTIC_MODELS_DIR.",
      );
    }
  };
}
