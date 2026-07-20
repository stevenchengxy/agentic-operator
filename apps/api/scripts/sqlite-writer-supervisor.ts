/**
 * Owns the one and only writable SQLite process tree for an API lifecycle.
 *
 * The supervisor acquires the canonical lease before migration, retains it
 * while migration hands off to the server, and releases it only after the
 * server child has exited and a final WAL checkpoint/close succeeds.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireSqliteWriterLease,
  checkpointAndCloseDb,
  getRawSqlite,
  type SqliteWriterLease,
} from "@agentic/db";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiDir = path.resolve(here, "..");
const repoRoot = path.resolve(apiDir, "../..");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const migrationEntrypoint = path.join(repoRoot, "packages", "db", "src", "migrate.ts");
const dbSourceDir = path.join(repoRoot, "packages", "db", "src");

const SUPERVISED_DB_COMMANDS = {
  backup: { command: process.execPath, args: ["--import", tsxLoader, path.join(dbSourceDir, "backup.ts")] },
  seed: { command: process.execPath, args: ["--import", tsxLoader, path.join(dbSourceDir, "seed.ts")] },
  "wipe-runtime": { command: process.execPath, args: ["--import", tsxLoader, path.join(dbSourceDir, "wipe-runtime.ts")] },
  "prune-deployments": { command: process.execPath, args: ["--import", tsxLoader, path.join(dbSourceDir, "prune-deployments.ts")] },
  studio: {
    command: path.join(
      repoRoot,
      "packages",
      "db",
      "node_modules",
      ".bin",
      `drizzle-kit${process.platform === "win32" ? ".cmd" : ""}`,
    ),
    args: ["studio"],
  },
} as const;

type SupervisedDbCommand = keyof typeof SUPERVISED_DB_COMMANDS;

type ChildPhase = "migration" | "server";

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function configuredDatabaseUrl(): string {
  const configured = process.env.DATABASE_URL?.trim();
  if (configured) return configured;
  return `file:${path.join(repoRoot, "data", "agentic.db")}`;
}

function serverCommand(argv: string[]): { command: string; args: string[] } {
  if (argv[0] === "--") argv = argv.slice(1);
  if (argv[0] === "--watch") {
    if (argv.length !== 1) throw new Error("--watch does not accept a custom server command");
    return {
      command: process.execPath,
      args: ["--watch", "--import", tsxLoader, "src/server.ts"],
    };
  }
  if (argv.length) return { command: argv[0]!, args: argv.slice(1) };
  return {
    command: process.execPath,
    args: ["--import", tsxLoader, "src/server.ts"],
  };
}

function exitCode(result: ChildResult): number {
  if (typeof result.code === "number") return result.code;
  return result.signal ? 128 : 1;
}

function inheritedLeaseEnv(lease: SqliteWriterLease): NodeJS.ProcessEnv {
  return {
    ...process.env,
    DATABASE_URL: `file:${lease.databasePath}`,
    AGENTIC_SQLITE_WRITER_LEASE_TOKEN: lease.token,
    AGENTIC_SQLITE_WRITER_LEASE_PATH: lease.leasePath,
    AGENTIC_SQLITE_WRITER_SUPERVISOR_PID: String(process.pid),
    AGENTIC_SQLITE_WRITER_SUPERVISED: "1",
  };
}

/** Exposed for lifecycle-contract tests without making the server entrypoint
 * itself importable as a writer. */
export function writerSupervisorCommands(argv: string[]): {
  migration: { command: string; args: string[] };
  server: { command: string; args: string[] } | null;
} {
  const migrateOnly = argv.length === 1 && argv[0] === "--migrate-only";
  let server: { command: string; args: string[] } | null;
  if (migrateOnly) {
    server = null;
  } else if (argv[0] === "--db-command") {
    if (argv.length !== 2 || !(argv[1]! in SUPERVISED_DB_COMMANDS)) {
      throw new Error(
        `--db-command requires one of: ${Object.keys(SUPERVISED_DB_COMMANDS).join(", ")}`,
      );
    }
    const selected = SUPERVISED_DB_COMMANDS[argv[1] as SupervisedDbCommand];
    server = { command: selected.command, args: [...selected.args] };
  } else {
    server = serverCommand([...argv]);
  }
  return {
    migration: {
      command: process.execPath,
      args: ["--import", tsxLoader, migrationEntrypoint],
    },
    server,
  };
}

function installParentLeaseCapability(lease: SqliteWriterLease): () => void {
  const values: Record<string, string> = {
    DATABASE_URL: `file:${lease.databasePath}`,
    AGENTIC_SQLITE_WRITER_LEASE_TOKEN: lease.token,
    AGENTIC_SQLITE_WRITER_LEASE_PATH: lease.leasePath,
    AGENTIC_SQLITE_WRITER_SUPERVISOR_PID: String(process.pid),
    AGENTIC_SQLITE_WRITER_SUPERVISED: "1",
  };
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

export async function runSqliteWriterSupervisor(argv = process.argv.slice(2)): Promise<number> {
  const databaseUrl = configuredDatabaseUrl();
  const commands = writerSupervisorCommands(argv);
  const heartbeatMs = positiveInteger("AGENTIC_SQLITE_WRITER_HEARTBEAT_MS", 5_000);
  const childTerminationMs = positiveInteger(
    "AGENTIC_SQLITE_WRITER_CHILD_TERMINATION_MS",
    15_000,
  );
  const lease = acquireSqliteWriterLease(databaseUrl);
  // Runtime mutations of process.env are inherited only by the two children we
  // explicitly spawn. They are not part of a Docker container's configured
  // environment, so an unrelated `docker exec` receives no writer capability.
  const restoreParentLeaseCapability = installParentLeaseCapability(lease);
  const childEnv = inheritedLeaseEnv(lease);

  let currentChild: ChildProcess | null = null;
  let currentPhase: ChildPhase | null = null;
  let shutdownSignal: NodeJS.Signals | null = null;
  let heartbeatFailure: Error | null = null;
  let terminationTimer: NodeJS.Timeout | null = null;
  let finalized = false;

  const terminateCurrentChild = (signal: NodeJS.Signals) => {
    const child = currentChild;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    if (!terminationTimer) {
      terminationTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, childTerminationMs);
      terminationTimer.unref();
    }
  };

  const onSignal = (signal: NodeJS.Signals) => {
    if (shutdownSignal) return;
    shutdownSignal = signal;
    terminateCurrentChild(signal);
  };
  const sigterm = () => onSignal("SIGTERM");
  const sigint = () => onSignal("SIGINT");
  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);

  const heartbeatTimer = setInterval(() => {
    if (heartbeatFailure || finalized) return;
    try {
      lease.heartbeat();
    } catch (error) {
      heartbeatFailure = error instanceof Error ? error : new Error(String(error));
      // Continuing to write after heartbeat/ownership failure is forbidden.
      // SIGTERM gives the child an opportunity to close SQLite; SIGKILL is the
      // bounded fallback and the lease is deliberately retained for recovery.
      terminateCurrentChild("SIGTERM");
    }
  }, heartbeatMs);
  heartbeatTimer.unref();

  const runChild = (
    phase: ChildPhase,
    command: string,
    args: string[],
  ): Promise<ChildResult> => {
    if (heartbeatFailure) return Promise.reject(heartbeatFailure);
    if (shutdownSignal) return Promise.resolve({ code: 0, signal: shutdownSignal });
    currentPhase = phase;
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: phase === "migration" ? path.dirname(migrationEntrypoint) : apiDir,
        env: childEnv,
        stdio: "inherit",
      });
      currentChild = child;
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (terminationTimer) {
          clearTimeout(terminationTimer);
          terminationTimer = null;
        }
        currentChild = null;
        currentPhase = null;
        resolve({ code, signal });
      });
    });
  };

  const checkpointAndRelease = () => {
    if (heartbeatFailure) throw heartbeatFailure;
    // A final heartbeat proves ownership immediately before touching the WAL.
    lease.heartbeat();
    getRawSqlite();
    checkpointAndCloseDb();
    lease.heartbeat();
    lease.release();
    finalized = true;
  };

  try {
    const migration = await runChild(
      "migration",
      commands.migration.command,
      commands.migration.args,
    );
    if (heartbeatFailure) throw heartbeatFailure;
    if (shutdownSignal) {
      checkpointAndRelease();
      return 0;
    }
    if (exitCode(migration) !== 0) {
      checkpointAndRelease();
      return exitCode(migration);
    }

    if (!commands.server) {
      checkpointAndRelease();
      return 0;
    }

    // Same lease, no unlock/relock window between migration and server.
    lease.heartbeat();
    const server = await runChild(
      "server",
      commands.server.command,
      commands.server.args,
    );
    if (heartbeatFailure) throw heartbeatFailure;
    checkpointAndRelease();
    return shutdownSignal ? 0 : exitCode(server);
  } catch (error) {
    // If ownership is still healthy and no child remains, make a safe explicit
    // hand-off. Ownership/heartbeat failures retain the lease fail-closed.
    if (!heartbeatFailure && !currentChild && !finalized) {
      try {
        checkpointAndRelease();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `SQLite writer supervisor failed during ${currentPhase ?? "startup"} and cleanup`,
        );
      }
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
    if (terminationTimer) clearTimeout(terminationTimer);
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigint);
    restoreParentLeaseCapability();
  }
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  runSqliteWriterSupervisor().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(
        `[sqlite-writer-supervisor] ${String((error as Error)?.message ?? error)}`,
      );
      process.exitCode = 1;
    },
  );
}
