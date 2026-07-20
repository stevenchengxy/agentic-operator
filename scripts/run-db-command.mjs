/**
 * Safe, shared launcher for the root `db:*` scripts.
 *
 * Environment precedence is deliberate:
 *   1. Variables already supplied by the caller/deployment.
 *   2. Variables from the repository-root `.env` file.
 *   3. A repository-local SQLite default, only when DATABASE_URL is absent.
 *
 * The child is spawned without a shell. This keeps paths containing spaces as
 * one value and prevents credentials from being interpolated into a command
 * line (or printed by this launcher).
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const here = path.dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = path.resolve(here, "..");

const supervisedDbArgs = (operation) => [
  "--import",
  "tsx",
  "../../apps/api/scripts/sqlite-writer-supervisor.ts",
  "--db-command",
  operation,
];

export const databaseCommands = Object.freeze({
  generate: { binary: "drizzle-kit", args: ["generate"] },
  migrate: {
    binary: "node",
    args: [
      "--import",
      "tsx",
      "../../apps/api/scripts/sqlite-writer-supervisor.ts",
      "--migrate-only",
    ],
  },
  backup: { binary: "node", args: supervisedDbArgs("backup") },
  seed: { binary: "node", args: supervisedDbArgs("seed") },
  "wipe-runtime": { binary: "node", args: supervisedDbArgs("wipe-runtime") },
  "prune-deployments": { binary: "node", args: supervisedDbArgs("prune-deployments") },
  studio: { binary: "node", args: supervisedDbArgs("studio") },
  // Deliberately NOT supervised: recovery must run when the lease cannot be
  // acquired. The module enforces owner-pid-death + lsof open-file proofs and
  // fails closed; it opens no SQLite handle (no native ABI requirement).
  "recover-writer-lease": {
    binary: "node",
    args: ["--import", "tsx", "src/writer-lease-recovery.ts"],
  },
});

function readEnvironmentFile(envFile) {
  try {
    return parseEnv(readFileSync(envFile, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(
      `Unable to load the database environment file at ${envFile}`,
      {
        cause: error,
      },
    );
  }
}

/**
 * Build the child environment without mutating process.env.
 * Exported so precedence/path handling can be regression-tested without
 * opening a database or exposing any secret values in process output.
 */
export function buildDatabaseEnvironment({
  callerEnvironment = process.env,
  root = repositoryRoot,
  envFile = path.join(root, ".env"),
} = {}) {
  const environment = { ...readEnvironmentFile(envFile) };

  // Explicit caller values always win, including an intentionally blank
  // credential (which downstream validation must reject rather than silently
  // replacing with a developer's local .env secret).
  for (const [key, value] of Object.entries(callerEnvironment)) {
    if (value !== undefined) environment[key] = value;
  }

  if (!environment.DATABASE_URL?.trim()) {
    // Keep this as the raw `file:<absolute path>` convention consumed by the
    // SQLite client. Passing it through spawn(env) preserves embedded spaces.
    environment.DATABASE_URL = `file:${path.join(root, "data", "agentic.db")}`;
  }

  if (!environment.AGENTIC_DATA_DIR?.trim()) {
    environment.AGENTIC_DATA_DIR = path.join(root, "data");
  }

  return environment;
}

export async function runDatabaseCommand(operation, options = {}) {
  const command = databaseCommands[operation];
  if (!command) {
    throw new Error(
      `Unknown database command '${operation}'. Expected one of: ${Object.keys(
        databaseCommands,
      ).join(", ")}`,
    );
  }

  const env = buildDatabaseEnvironment(options);
  const root = options.root ?? repositoryRoot;
  const workspace = path.join(root, "packages", "db");
  const binary = command.binary === "node"
    ? process.execPath
    : path.join(
        workspace,
        "node_modules",
        ".bin",
        `${command.binary}${process.platform === "win32" ? ".cmd" : ""}`,
      );

  return await new Promise((resolve, reject) => {
    const child = spawn(binary, command.args, {
      cwd: workspace,
      env,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(
          new Error(`Database command '${operation}' terminated by ${signal}`),
        );
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const exitCode = await runDatabaseCommand(process.argv[2]);
    process.exitCode = exitCode;
  } catch (error) {
    // Errors contain command names/paths only; environment values are never
    // serialized, logged, or added to the process command line.
    console.error(
      `[db] ${error instanceof Error ? error.message : "command failed"}`,
    );
    process.exitCode = 1;
  }
}
