import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
// Every Vitest invocation owns all mutable state. Fixed `data/test-models` and
// `data/agentic.test.db` paths let a delayed teardown from an interrupted or
// concurrent run delete the active suite's fixtures halfway through, turning
// real bootstrap assertions into misleading ENOENT/SQLite failures.
const TEST_RUN_ROOT =
  process.env.AGENTIC_API_TEST_RUN_ROOT?.trim() ||
  path.join(
    REPO_ROOT,
    "data",
    "test-runs",
    `${process.pid}-${Date.now().toString(36)}`,
  );
const TEST_MODELS_DIR = path.join(TEST_RUN_ROOT, "models");
process.env.AGENTIC_API_TEST_RUN_ROOT = TEST_RUN_ROOT;

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/setup.ts"],
    pool: "forks", // ensures the better-sqlite3 binding isn't shared across worker threads
    sequence: { concurrent: false }, // tests use the same SQLite — serialize to avoid lock contention
    // `sequence.concurrent: false` only serializes within a worker. Vitest 4
    // removed poolOptions.singleFork; top-level fileParallelism:false is the
    // supported equivalent and forces one worker. Every suite intentionally
    // shares one isolated SQLite snapshot, so parallel files would race while
    // cloning/applying migrations and could corrupt the test fixture.
    fileParallelism: false,
    // Point every reader/writer at the cloned fixture tree prepared by
    // global-setup. Setting via `env` makes the value visible to test code at
    // module-top-level; setupFiles would be too late for those imports.
    env: {
      AGENTIC_MODELS_DIR: TEST_MODELS_DIR,
      AGENTIC_API_TEST_RUN_ROOT: TEST_RUN_ROOT,
    },
  },
});
