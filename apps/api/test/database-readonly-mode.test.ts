import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  acquireSqliteWriterLease,
  closeDb,
  getRawSqlite,
} from "@agentic/db";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const previousDatabaseUrl = process.env.DATABASE_URL;
const previousReadOnly = process.env.AGENTIC_DATABASE_READONLY;
const previousNodeEnv = process.env.NODE_ENV;
const previousTestWriter = process.env.AGENTIC_SQLITE_TEST_WRITER;
const previousTestRunRoot = process.env.AGENTIC_API_TEST_RUN_ROOT;
const previousLeaseToken = process.env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN;
const previousLeasePath = process.env.AGENTIC_SQLITE_WRITER_LEASE_PATH;
const previousSupervisorPid = process.env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID;

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureExplicitTestWriter(root: string, database: string): void {
  process.env.NODE_ENV = "test";
  process.env.AGENTIC_SQLITE_TEST_WRITER = "1";
  process.env.AGENTIC_API_TEST_RUN_ROOT = root;
  process.env.AGENTIC_DATABASE_READONLY = "0";
  process.env.DATABASE_URL = database;
  delete process.env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN;
  delete process.env.AGENTIC_SQLITE_WRITER_LEASE_PATH;
  delete process.env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID;
}

afterEach(async () => {
  closeDb();
  restoreEnv("DATABASE_URL", previousDatabaseUrl);
  restoreEnv("AGENTIC_DATABASE_READONLY", previousReadOnly);
  restoreEnv("NODE_ENV", previousNodeEnv);
  restoreEnv("AGENTIC_SQLITE_TEST_WRITER", previousTestWriter);
  restoreEnv("AGENTIC_API_TEST_RUN_ROOT", previousTestRunRoot);
  restoreEnv("AGENTIC_SQLITE_WRITER_LEASE_TOKEN", previousLeaseToken);
  restoreEnv("AGENTIC_SQLITE_WRITER_LEASE_PATH", previousLeasePath);
  restoreEnv("AGENTIC_SQLITE_WRITER_SUPERVISOR_PID", previousSupervisorPid);
  for (const root of temporaryRoots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe("SQLite client writer authorization", () => {
  it("rejects a read-write handle when neither a lease nor explicit test capability exists", async () => {
    closeDb();
    const root = await temporaryDirectory("agentic-unleased-db-");
    process.env.DATABASE_URL = path.join(root, "unleased.db");
    process.env.AGENTIC_DATABASE_READONLY = "0";
    process.env.NODE_ENV = "production";
    delete process.env.AGENTIC_SQLITE_TEST_WRITER;
    delete process.env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN;
    delete process.env.AGENTIC_SQLITE_WRITER_LEASE_PATH;
    delete process.env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID;

    expect(() => getRawSqlite()).toThrow(/writer lease|writer startup/i);

    process.env.AGENTIC_SQLITE_TEST_WRITER = "1";
    process.env.AGENTIC_API_TEST_RUN_ROOT = root;
    expect(() => getRawSqlite()).toThrow(/permitted only when NODE_ENV=test/);
  });

  it("opens an existing database query-only and rejects writes", async () => {
    closeDb();
    const root = await temporaryDirectory("agentic-readonly-db-");
    const database = path.join(root, "evidence.db");
    configureExplicitTestWriter(root, database);
    const writable = getRawSqlite();
    writable.exec("CREATE TABLE evidence (id TEXT PRIMARY KEY)");
    writable.prepare("INSERT INTO evidence (id) VALUES (?)").run("proof-1");
    closeDb();

    delete process.env.AGENTIC_SQLITE_TEST_WRITER;
    delete process.env.AGENTIC_API_TEST_RUN_ROOT;
    process.env.AGENTIC_DATABASE_READONLY = "1";
    const readonly = getRawSqlite();
    expect(readonly.pragma("query_only", { simple: true })).toBe(1);
    expect(readonly.prepare("SELECT id FROM evidence").pluck().all()).toEqual([
      "proof-1",
    ]);
    expect(() =>
      readonly.prepare("INSERT INTO evidence (id) VALUES (?)").run("proof-2"),
    ).toThrow();
  });

  it("accepts the exact canonical writer lease", async () => {
    closeDb();
    const root = await temporaryDirectory("agentic-leased-db-");
    const database = path.join(root, "leased.db");
    const lease = acquireSqliteWriterLease(`file:${database}`, { pid: process.pid });
    process.env.NODE_ENV = "production";
    process.env.DATABASE_URL = `file:${database}`;
    process.env.AGENTIC_DATABASE_READONLY = "0";
    process.env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN = lease.token;
    process.env.AGENTIC_SQLITE_WRITER_LEASE_PATH = lease.leasePath;
    process.env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID = String(process.pid);
    delete process.env.AGENTIC_SQLITE_TEST_WRITER;
    try {
      const sqlite = getRawSqlite();
      sqlite.exec("CREATE TABLE leased (id TEXT PRIMARY KEY)");
    } finally {
      closeDb();
      lease.release();
    }
  });

  it("allows only explicit in-root test writers and rejects path escape", async () => {
    closeDb();
    const root = await temporaryDirectory("agentic-test-writer-root-");
    const inside = path.join(root, "inside.db");
    configureExplicitTestWriter(root, inside);
    getRawSqlite().exec("CREATE TABLE inside_test (id TEXT)");
    closeDb();

    const outsideRoot = await temporaryDirectory("agentic-test-writer-outside-");
    process.env.DATABASE_URL = path.join(outsideRoot, "outside.db");
    expect(() => getRawSqlite()).toThrow(/must stay inside AGENTIC_API_TEST_RUN_ROOT/);

    const escape = path.join(root, "escape");
    await fs.symlink(outsideRoot, escape, "dir");
    process.env.DATABASE_URL = path.join(escape, "symlink-escape.db");
    expect(() => getRawSqlite()).toThrow(/must stay inside AGENTIC_API_TEST_RUN_ROOT/);
  });

  it("allows :memory: only through the explicit test capability", async () => {
    closeDb();
    const root = await temporaryDirectory("agentic-memory-writer-root-");
    configureExplicitTestWriter(root, ":memory:");
    getRawSqlite().exec("CREATE TABLE memory_test (id TEXT)");
    closeDb();

    delete process.env.AGENTIC_SQLITE_TEST_WRITER;
    expect(() => getRawSqlite()).toThrow(/writer lease|writer startup/i);
  });
});
