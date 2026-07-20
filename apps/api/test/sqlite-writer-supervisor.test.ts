import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  recoverSqliteWriterLeaseAfterProof,
  sqliteWriterLeasePath,
} from "../../../packages/db/src/writer-lease";
import { writerSupervisorCommands } from "../scripts/sqlite-writer-supervisor";

const repoRoot = path.resolve(__dirname, "../../..");
const apiDir = path.join(repoRoot, "apps", "api");
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const supervisorEntrypoint = path.join(
  apiDir,
  "scripts",
  "sqlite-writer-supervisor.ts",
);

function waitFor(predicate: () => boolean, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("timed out waiting for process evidence"));
      setTimeout(poll, 20);
    };
    poll();
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

describe("SQLite writer supervisor process lifecycle", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(path.join(tmpdir(), "agentic-writer-supervisor-"));
    roots.push(root);
    const database = path.join(root, "agentic.db");
    const marker = path.join(root, "server.marker");
    const fakeServer = path.join(root, "fake-server.mjs");
    writeFileSync(database, "");
    writeFileSync(fakeServer, [
      'import { appendFileSync, existsSync, readFileSync } from "node:fs";',
      'const marker = process.env.TEST_WRITER_MARKER;',
      'const leasePath = process.env.AGENTIC_SQLITE_WRITER_LEASE_PATH;',
      'const owner = JSON.parse(readFileSync(leasePath + "/owner.json", "utf8"));',
      'if (!existsSync(leasePath) || owner.token !== process.env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN) process.exit(91);',
      'appendFileSync(marker, "server-started\\n");',
      'let closing = false;',
      'process.on("SIGTERM", () => {',
      '  if (closing) return;',
      '  closing = true;',
      '  appendFileSync(marker, "server-sigterm\\n");',
      '  setTimeout(() => { appendFileSync(marker, "server-closed\\n"); process.exit(0); }, 300);',
      '});',
      'setInterval(() => {}, 1000);',
    ].join("\n"));
    const databaseUrl = `file:${database}`;
    const leasePath = sqliteWriterLeasePath(databaseUrl);
    const stderr: string[] = [];
    const child = spawn(
      process.execPath,
      [
        "--import",
        tsxLoader,
        supervisorEntrypoint,
        "--",
        process.execPath,
        fakeServer,
      ],
      {
        cwd: apiDir,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          TEST_WRITER_MARKER: marker,
          AGENTIC_SQLITE_WRITER_HEARTBEAT_MS: "50",
          AGENTIC_SQLITE_WRITER_CHILD_TERMINATION_MS: "3000",
        },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    return { root, databaseUrl, leasePath, marker, child, stderr };
  }

  it("maps every database CLI writer to an allowlisted supervised child", () => {
    for (const operation of [
      "backup",
      "seed",
      "wipe-runtime",
      "prune-deployments",
      "studio",
    ]) {
      const commands = writerSupervisorCommands(["--db-command", operation]);
      expect(commands.server).not.toBeNull();
      expect(commands.migration.args).toContain(
        path.join(repoRoot, "packages", "db", "src", "migrate.ts"),
      );
    }
    expect(() => writerSupervisorCommands(["--db-command", "unknown"]))
      .toThrow(/requires one of/);
    expect(() => writerSupervisorCommands(["--db-command", "backup", "extra"]))
      .toThrow(/requires one of/);
  });

  it("holds one inode across migration → server and releases only after child close", async () => {
    expect(writerSupervisorCommands(["--migrate-only"]).server).toBeNull();
    const run = fixture();
    try {
      await waitFor(() => existsSync(run.leasePath));
      const initial = statSync(run.leasePath);
      let ownershipGap = false;
      let inodeChanged = false;
      while (!existsSync(run.marker) || !readFileSync(run.marker, "utf8").includes("server-started")) {
        if (!existsSync(run.leasePath)) ownershipGap = true;
        else {
          const current = statSync(run.leasePath);
          if (current.dev !== initial.dev || current.ino !== initial.ino) inodeChanged = true;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(ownershipGap).toBe(false);
      expect(inodeChanged).toBe(false);

      const exited = waitForExit(run.child);
      run.child.kill("SIGTERM");
      await waitFor(() => readFileSync(run.marker, "utf8").includes("server-sigterm"));
      expect(existsSync(run.leasePath)).toBe(true);
      await waitFor(() => readFileSync(run.marker, "utf8").includes("server-closed"));
      const result = await exited;
      expect(result).toEqual({ code: 0, signal: null });
      expect(existsSync(run.leasePath)).toBe(false);
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    }
  }, 30_000);

  it("rejects the writable migration main when no supervisor capability is inherited", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agentic-direct-migration-"));
    roots.push(root);
    const database = path.join(root, "agentic.db");
    writeFileSync(database, "");
    const env = { ...process.env, DATABASE_URL: `file:${database}` };
    delete env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN;
    delete env.AGENTIC_SQLITE_WRITER_LEASE_PATH;
    delete env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID;
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        tsxLoader,
        path.join(repoRoot, "packages", "db", "src", "migrate.ts"),
      ],
      { cwd: path.join(repoRoot, "packages", "db"), env, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/direct SQLite writer startup is forbidden/);
    expect(existsSync(sqliteWriterLeasePath(`file:${database}`))).toBe(false);
  });

  it("terminates the child and retains evidence when heartbeat ownership fails", async () => {
    const run = fixture();
    try {
      await waitFor(() => existsSync(run.marker) && readFileSync(run.marker, "utf8").includes("server-started"));
      const ownerPath = path.join(run.leasePath, "owner.json");
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
      writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: "e".repeat(64) })}\n`);

      const result = await waitForExit(run.child);
      expect(result.code).toBe(1);
      expect(readFileSync(run.marker, "utf8")).toContain("server-sigterm");
      expect(existsSync(run.leasePath)).toBe(true);
      expect(run.stderr.join("")).toMatch(/ownership changed unexpectedly/);
      recoverSqliteWriterLeaseAfterProof(run.databaseUrl);
    } finally {
      if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill("SIGKILL");
    }
  }, 30_000);
});
