/**
 * SQLite client with WAL mode + edge-runtime guard.
 *
 * Risk #2 from build plan: better-sqlite3 is a native module and CANNOT run
 * on Edge runtime. Any Next.js route that imports this file (directly or
 * transitively) must declare `export const runtime = 'nodejs'`.
 *
 * We enforce this with a runtime check — if anything imports this module in
 * an edge context we throw before any query runs, surfacing the mistake
 * loudly instead of producing a cryptic native-binding error.
 */

import path from "node:path";
import fs from "node:fs";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import { schema } from "./schema";
import {
  assertInheritedSqliteWriterLease,
  inspectSqliteWriterLease,
} from "./writer-lease";

// Pre-resolve the .node file path. better-sqlite3's `bindings` loader walks
// the JS stack to find its native binding, which fails in webpack contexts
// where webpack-compiled frames have null fileNames. Passing `nativeBinding`
// skips `bindings` entirely (better-sqlite3 then uses __non_webpack_require__).
// Strategy: walk up from process.cwd() looking for node_modules; check both
// hoisted (node_modules/better-sqlite3) and pnpm (.pnpm/better-sqlite3@*) layouts.
function resolveNativeBinding(): string {
  // Allow override (production may install to a non-standard location).
  if (process.env.AGENTIC_SQLITE_BINDING)
    return process.env.AGENTIC_SQLITE_BINDING;

  let dir = process.cwd();
  while (true) {
    const nm = path.join(dir, "node_modules");
    // Hoisted layout
    const hoisted = path.join(
      nm,
      "better-sqlite3",
      "build",
      "Release",
      "better_sqlite3.node",
    );
    if (fs.existsSync(hoisted)) return hoisted;
    // pnpm layout
    const pnpm = path.join(nm, ".pnpm");
    if (fs.existsSync(pnpm)) {
      const candidates = fs
        .readdirSync(pnpm)
        .filter((d) => d.startsWith("better-sqlite3@"));
      for (const c of candidates) {
        const p = path.join(
          pnpm,
          c,
          "node_modules",
          "better-sqlite3",
          "build",
          "Release",
          "better_sqlite3.node",
        );
        if (fs.existsSync(p)) return p;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // root
    dir = parent;
  }
  throw new Error(
    "[db/client] could not locate better_sqlite3.node — set AGENTIC_SQLITE_BINDING env",
  );
}

const NATIVE_BINDING_PATH = resolveNativeBinding();

export type DB = BetterSQLite3Database<typeof schema>;

let _db: DB | null = null;
let _sqlite: DatabaseInstance | null = null;

function assertNodeRuntime() {
  // Edge runtime exposes globals like `EdgeRuntime` or `__nccwpck_require__`.
  // Cheap, fast, runs only once per process.
  if (
    typeof (globalThis as { EdgeRuntime?: string }).EdgeRuntime === "string"
  ) {
    throw new Error(
      "@agentic/db cannot run in Edge runtime. Add " +
        "`export const runtime = 'nodejs'` to the importing route.",
    );
  }
}

function databasePath(): string {
  const env = process.env.DATABASE_URL;
  if (env) {
    return env.startsWith("file:") ? env.slice(5) : env;
  }
  // No env — walk up from cwd looking for the monorepo's data/agentic.db
  // (RF-1.5 convention) or the legacy packages/db/agentic.db location.
  let dir = process.cwd();
  const candidates = [
    ["data", "agentic.db"],
    ["packages", "db", "agentic.db"],
  ];
  while (true) {
    for (const segs of candidates) {
      const candidate = path.join(dir, ...segs);
      if (fs.existsSync(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "./agentic.db";
}

function databaseReadOnly(): boolean {
  const configured =
    process.env.AGENTIC_DATABASE_READONLY?.trim().toLowerCase();
  if (!configured || configured === "0" || configured === "false") return false;
  if (configured === "1" || configured === "true") return true;
  throw new Error("AGENTIC_DATABASE_READONLY must be 1/true or 0/false");
}

function isExactMemoryDatabase(dbPath: string): boolean {
  return dbPath === ":memory:";
}

/**
 * Vitest needs writable, invocation-scoped fixture databases without starting a
 * second production-style supervisor for every test file. This is an explicit
 * capability, not a NODE_ENV shortcut: all three conditions must hold and a
 * filesystem database must remain under the canonical test-run root.
 */
function assertExplicitTestWriter(dbPath: string): void {
  if (process.env.AGENTIC_SQLITE_TEST_WRITER?.trim() !== "1") {
    throw new Error("SQLite writable startup requires the canonical writer lease");
  }
  if (process.env.NODE_ENV?.trim() !== "test") {
    throw new Error("AGENTIC_SQLITE_TEST_WRITER is permitted only when NODE_ENV=test");
  }
  if (isExactMemoryDatabase(dbPath)) return;

  const configuredRoot = process.env.AGENTIC_API_TEST_RUN_ROOT?.trim();
  if (!configuredRoot) {
    throw new Error(
      "AGENTIC_SQLITE_TEST_WRITER requires AGENTIC_API_TEST_RUN_ROOT for filesystem databases",
    );
  }
  let canonicalRoot: string;
  let canonicalDatabase: string;
  try {
    canonicalRoot = fs.realpathSync(configuredRoot);
    const lexicalDatabase = path.resolve(dbPath);
    const canonicalParent = fs.realpathSync(path.dirname(lexicalDatabase));
    canonicalDatabase = path.join(canonicalParent, path.basename(lexicalDatabase));
    if (fs.existsSync(canonicalDatabase)) {
      const stat = fs.lstatSync(canonicalDatabase);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("test SQLite database must be a regular non-symlink file");
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("test SQLite")) throw error;
    throw new Error("test SQLite database and test-run root must be canonicalizable");
  }
  const relative = path.relative(canonicalRoot, canonicalDatabase);
  if (
    relative === ""
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error("AGENTIC_SQLITE_TEST_WRITER database must stay inside AGENTIC_API_TEST_RUN_ROOT");
  }
}

function assertWritableDatabaseAuthorized(dbPath: string): void {
  const inheritedFields = [
    process.env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN?.trim(),
    process.env.AGENTIC_SQLITE_WRITER_LEASE_PATH?.trim(),
    process.env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID?.trim(),
  ];
  // A real supervisor capability always wins, including in process-level
  // lifecycle tests whose parent also carries the explicit test capability.
  // Partial or mismatched capabilities never fall through to the test bypass.
  if (inheritedFields.some(Boolean)) {
    assertInheritedSqliteWriterLease(`file:${dbPath}`);
    return;
  }
  if (!isExactMemoryDatabase(dbPath)) {
    if (inspectSqliteWriterLease(`file:${dbPath}`)) {
      throw new Error(
        "SQLite writer lease exists but this process did not inherit its exact capability",
      );
    }
  }
  if (process.env.AGENTIC_SQLITE_TEST_WRITER?.trim() === "1") {
    assertExplicitTestWriter(dbPath);
    return;
  }
  // Reuse the canonical error and validation path for ordinary unauthorized
  // writers instead of maintaining a weaker client-only approximation.
  assertInheritedSqliteWriterLease(`file:${dbPath}`);
}

export function getDb(): DB {
  if (_db) return _db;
  assertNodeRuntime();

  const dbPath = databasePath();
  const readonly = databaseReadOnly();
  if (!readonly) assertWritableDatabaseAuthorized(dbPath);
  _sqlite = new Database(dbPath, {
    nativeBinding: NATIVE_BINDING_PATH,
    readonly,
    fileMustExist: readonly,
  });
  if (readonly) {
    // Evidence exporters must not rewrite the journal mode or persist any
    // accidental statement. query_only is connection-local defense in depth;
    // better-sqlite3's readonly handle is the filesystem-level enforcement.
    _sqlite.pragma("query_only = ON");
  } else {
    // WAL mode is the central correctness requirement — without it the first
    // writer holds an exclusive lock and other connections block.
    _sqlite.pragma("journal_mode = WAL");
    _sqlite.pragma("synchronous = NORMAL");
  }
  _sqlite.pragma("foreign_keys = ON");
  _sqlite.pragma("busy_timeout = 5000");

  _db = drizzle(_sqlite, { schema });
  return _db;
}

/** For migrations / test teardown — closes the connection cleanly. */
export function closeDb() {
  if (!_sqlite) return;
  const sqlite = _sqlite;
  try {
    sqlite.close();
  } finally {
    _sqlite = null;
    _db = null;
  }
}

/**
 * Flush WAL into the main database and close the singleton connection.
 *
 * A busy checkpoint is a data-safety failure during writer hand-off, not a
 * best-effort cleanup condition. The handle is still closed, but the caller
 * receives the error and must retain its process-level writer lease.
 */
export function checkpointAndCloseDb(): void {
  if (!_sqlite) return;
  const sqlite = _sqlite;
  const failures: unknown[] = [];
  try {
    if (!databaseReadOnly()) {
      const rows = sqlite.pragma("wal_checkpoint(TRUNCATE)") as Array<{
        busy?: unknown;
        log?: unknown;
        checkpointed?: unknown;
      }>;
      const row = rows[0];
      const busy = Number(row?.busy);
      if (!row || !Number.isSafeInteger(busy) || busy !== 0) {
        throw new Error(
          `SQLite WAL checkpoint did not complete exclusively (busy=${String(row?.busy ?? "unknown")})`,
        );
      }
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    sqlite.close();
  } catch (error) {
    failures.push(error);
  } finally {
    _sqlite = null;
    _db = null;
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "SQLite checkpoint and close both failed");
  }
}

/** Direct SQLite handle — only for migration runner. Prefer getDb() in app code. */
export function getRawSqlite(): DatabaseInstance {
  if (!_sqlite) getDb();
  return _sqlite!;
}

/**
 * Apply drizzle migrations from the given folder against the singleton DB.
 *
 * Used by tests that bootstrap the DB without going through the full api boot
 * sequence (tc-16, tc-17, tc-30). Production code applies migrations via the
 * dedicated `pnpm db:migrate` script (`migrate.ts`); this helper just exposes
 * the same operation as a callable function for in-process callers.
 *
 * Idempotent: drizzle's migrator tracks applied migrations in
 * `__drizzle_migrations` so re-running is a no-op.
 */
export function runMigrations(migrationsFolder: string): void {
  drizzleMigrate(getDb(), { migrationsFolder });
}
