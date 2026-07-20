import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireSqliteWriterLease,
  assertInheritedSqliteWriterLease,
  inspectSqliteWriterLease,
  recoverSqliteWriterLeaseAfterProof,
  sqliteWriterLeasePath,
} from "../../../packages/db/src/writer-lease";
import {
  openDatabaseHolders,
  recoverStaleSqliteWriterLease,
} from "../../../packages/db/src/writer-lease-recovery";
import { checkSqlite } from "../src/routes/health";

describe("canonical SQLite writer lease", () => {
  let root = "";
  let database = "";
  let databaseUrl = "";

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agentic-sqlite-writer-lease-"));
    database = path.join(root, "agentic.db");
    databaseUrl = `file:${database}`;
    writeFileSync(database, "fixture\n", { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("serializes concurrent writers and never steals an expired heartbeat", () => {
    let now = new Date("2026-07-16T00:00:00.000Z");
    const first = acquireSqliteWriterLease(databaseUrl, { now: () => now });
    const initial = inspectSqliteWriterLease(databaseUrl);
    expect(initial?.owner.token).toBe(first.token);

    now = new Date("2036-07-16T00:00:00.000Z");
    expect(() => acquireSqliteWriterLease(databaseUrl, { now: () => now })).toThrow(
      /heartbeat expiry never grants recovery authority/,
    );
    expect(inspectSqliteWriterLease(databaseUrl)?.owner.token).toBe(first.token);

    first.heartbeat();
    expect(inspectSqliteWriterLease(databaseUrl)?.heartbeat.sequence).toBe(1);
    first.release();
    expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(false);
  });

  it("fails closed on malformed directories and lease-path symlinks", () => {
    const leasePath = sqliteWriterLeasePath(databaseUrl);
    mkdirSync(leasePath);
    writeFileSync(path.join(leasePath, "owner.json"), "not-json\n");
    expect(() => acquireSqliteWriterLease(databaseUrl)).toThrow(
      /unexpected or incomplete records/,
    );
    rmSync(leasePath, { recursive: true });

    const target = path.join(root, "attacker-directory");
    mkdirSync(target);
    symlinkSync(target, leasePath);
    expect(() => acquireSqliteWriterLease(databaseUrl)).toThrow(/never a symlink/);
    expect(() => recoverSqliteWriterLeaseAfterProof(databaseUrl)).toThrow(/never a symlink/);
  });

  it("detects owner-token replacement on heartbeat and token-safe release", () => {
    const lease = acquireSqliteWriterLease(databaseUrl);
    const ownerPath = path.join(lease.leasePath, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
    writeFileSync(ownerPath, `${JSON.stringify({
      ...owner,
      token: "b".repeat(64),
    })}\n`);

    expect(() => lease.heartbeat()).toThrow(/ownership changed unexpectedly/);
    expect(() => lease.release()).toThrow(/ownership changed unexpectedly/);
    expect(existsSync(lease.leasePath)).toBe(true);
    // This primitive represents an already-completed external proof in this
    // unit test; production setup performs lsof/Docker/integrity first.
    expect(recoverSqliteWriterLeaseAfterProof(databaseUrl)).toBe(true);
  });

  it("validates an inherited child capability against the canonical owner", () => {
    const lease = acquireSqliteWriterLease(databaseUrl, { pid: 4242 });
    const env: NodeJS.ProcessEnv = {
      AGENTIC_SQLITE_WRITER_LEASE_TOKEN: lease.token,
      AGENTIC_SQLITE_WRITER_LEASE_PATH: lease.leasePath,
      AGENTIC_SQLITE_WRITER_SUPERVISOR_PID: "4242",
    };
    expect(assertInheritedSqliteWriterLease(databaseUrl, env).owner.pid).toBe(4242);
    expect(() => assertInheritedSqliteWriterLease(databaseUrl, {
      ...env,
      AGENTIC_SQLITE_WRITER_LEASE_TOKEN: "c".repeat(64),
    })).toThrow(/does not match the canonical owner/);
    expect(() => assertInheritedSqliteWriterLease(databaseUrl, {})).toThrow(
      /direct SQLite writer startup is forbidden/,
    );
    lease.release();
  });

  it("explicit recovery refuses unknown entries instead of recursive deletion", () => {
    const lease = acquireSqliteWriterLease(databaseUrl);
    writeFileSync(path.join(lease.leasePath, "unknown"), "evidence\n");
    expect(() => recoverSqliteWriterLeaseAfterProof(databaseUrl)).toThrow(
      /unexpected entry "unknown"/,
    );
    expect(existsSync(lease.leasePath)).toBe(true);
  });
});

describe("SQLite writer lease readiness", () => {
  it("turns non-ready immediately when the supervised owner token changes", async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("test DATABASE_URL is unavailable");
    const lease = acquireSqliteWriterLease(databaseUrl);
    const previous = {
      supervised: process.env.AGENTIC_SQLITE_WRITER_SUPERVISED,
      token: process.env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN,
      leasePath: process.env.AGENTIC_SQLITE_WRITER_LEASE_PATH,
      supervisorPid: process.env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID,
    };
    process.env.AGENTIC_SQLITE_WRITER_SUPERVISED = "1";
    process.env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN = lease.token;
    process.env.AGENTIC_SQLITE_WRITER_LEASE_PATH = lease.leasePath;
    process.env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID = String(process.pid);
    try {
      expect((await checkSqlite()).ok).toBe(true);
      const ownerPath = path.join(lease.leasePath, "owner.json");
      const owner = JSON.parse(readFileSync(ownerPath, "utf8")) as Record<string, unknown>;
      writeFileSync(ownerPath, `${JSON.stringify({ ...owner, token: "d".repeat(64) })}\n`);
      expect(await checkSqlite()).toMatchObject({ ok: false });
    } finally {
      recoverSqliteWriterLeaseAfterProof(databaseUrl);
      for (const [name, value] of [
        ["AGENTIC_SQLITE_WRITER_SUPERVISED", previous.supervised],
        ["AGENTIC_SQLITE_WRITER_LEASE_TOKEN", previous.token],
        ["AGENTIC_SQLITE_WRITER_LEASE_PATH", previous.leasePath],
        ["AGENTIC_SQLITE_WRITER_SUPERVISOR_PID", previous.supervisorPid],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe("proof-gated stale-lease recovery (dev self-heal)", () => {
  let root = "";
  let database = "";
  let databaseUrl = "";
  const cleanInventory = () => ({ status: 0 as number | null, stdout: "p1\ncsomething\nfcwd\nn/somewhere/else\n" });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "agentic-sqlite-writer-recovery-"));
    database = path.join(root, "agentic.db");
    databaseUrl = `file:${database}`;
    writeFileSync(database, "fixture\n", { mode: 0o600 });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Simulate a crashed supervisor: acquire, then drop the handle without release(). */
  const strandLease = () => acquireSqliteWriterLease(databaseUrl);

  it("is a no-op when no lease exists", () => {
    expect(recoverStaleSqliteWriterLease(databaseUrl)).toEqual({ recovered: false, reason: "no-lease" });
  });

  it("refuses while the recorded owner pid is alive, and leaves the lease intact", () => {
    strandLease();
    expect(() =>
      recoverStaleSqliteWriterLease(databaseUrl, { isPidAlive: () => true, observeOpenFiles: cleanInventory }),
    ).toThrow(/still alive; refusing recovery/);
    expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(true);
  });

  it("refuses when lsof is missing or fails (proof required, fail closed)", () => {
    strandLease();
    expect(() =>
      recoverStaleSqliteWriterLease(databaseUrl, {
        isPidAlive: () => false,
        observeOpenFiles: () => ({ status: null, stdout: "", errorCode: "ENOENT" }),
      }),
    ).toThrow(/lsof is required/);
    expect(() =>
      recoverStaleSqliteWriterLease(databaseUrl, {
        isPidAlive: () => false,
        observeOpenFiles: () => ({ status: 1, stdout: "" }),
      }),
    ).toThrow(/could not complete/);
    expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(true);
  });

  it("refuses when any process still holds the database/-wal/-shm open", () => {
    strandLease();
    // lsof reports canonical kernel paths (macOS: /var → /private/var), which is
    // also what owner.databasePath records — emit the canonical form here.
    const canonical = realpathSync(database);
    const holderInventory = () => ({
      status: 0 as number | null,
      stdout: `p4242\ncnode\nf12\nn${canonical}-wal\n`,
    });
    expect(() =>
      recoverStaleSqliteWriterLease(databaseUrl, { isPidAlive: () => false, observeOpenFiles: holderInventory }),
    ).toThrow(/still hold the SQLite database open/);
    expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(true);
  });

  it("recovers only with both proofs: owner dead + clean open-file inventory", () => {
    strandLease();
    const result = recoverStaleSqliteWriterLease(databaseUrl, {
      isPidAlive: () => false,
      observeOpenFiles: cleanInventory,
    });
    expect(result.recovered).toBe(true);
    expect(result.owner?.pid).toBe(process.pid);
    expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(false);
    // And a fresh writer can acquire again — the wedge is gone.
    const next = acquireSqliteWriterLease(databaseUrl);
    next.release();
  });

  it("openDatabaseHolders matches db/-wal/-shm (incl. trailing markers) and ignores others", () => {
    const out = [
      "p10", "cnode", "f12", `n${database}`,
      "p11", "cnode", "f13", `n${database}-wal (deleted)`,
      "p12", "cother", "f14", "n/unrelated/agentic.db",
    ].join("\n");
    const holders = openDatabaseHolders(out, database);
    expect(holders).toHaveLength(2);
    expect(holders[0]).toMatchObject({ pid: "10", file: "agentic.db", isMainDb: true });
    expect(holders[1]).toMatchObject({ pid: "11", file: "agentic.db-wal", isMainDb: false });
  });

  describe("in-flight heartbeat temp tolerance (the startup-race fix)", () => {
    const tempName = (seq: number) => `.heartbeat-${"a".repeat(64)}-${seq}.tmp`;

    it("inspect tolerates exactly one protocol-conformant temp beside owner/heartbeat", () => {
      const lease = strandLease();
      writeFileSync(path.join(lease.leasePath, tempName(2)), "{}\n", { mode: 0o600 });
      // The race: a concurrent inspector (server-child startup / health check)
      // observes the write→rename window and must NOT fail closed on it.
      expect(inspectSqliteWriterLease(databaseUrl)?.owner.token).toBe(lease.token);
    });

    it("still fails closed on a foreign extra file or on two temps", () => {
      const lease = strandLease();
      writeFileSync(path.join(lease.leasePath, "evil.txt"), "x\n");
      expect(() => inspectSqliteWriterLease(databaseUrl)).toThrow(/unexpected or incomplete/);
      rmSync(path.join(lease.leasePath, "evil.txt"));
      writeFileSync(path.join(lease.leasePath, tempName(2)), "{}\n");
      writeFileSync(path.join(lease.leasePath, tempName(3)), "{}\n");
      expect(() => inspectSqliteWriterLease(databaseUrl)).toThrow(/unexpected or incomplete/);
    });

    it("proof-gated recovery clears a crashed owner's leftover temp too", () => {
      const lease = strandLease();
      writeFileSync(path.join(lease.leasePath, tempName(7)), "{}\n", { mode: 0o600 });
      const result = recoverStaleSqliteWriterLease(databaseUrl, {
        isPidAlive: () => false,
        observeOpenFiles: cleanInventory,
      });
      expect(result.recovered).toBe(true);
      expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(false);
    });
  });

  describe("macOS Docker file-sharing proxy allowance (mirrors production setup, dev-grade)", () => {
    const canonicalDb = () => realpathSync(database);
    const proxyInventory = (file: string) => () => ({
      status: 0 as number | null,
      stdout: `p80076\nccom.apple.Virtualization.VirtualMachine\nf925\nn${canonicalDb()}${file}\n`,
    });

    it("excuses cached proxy handles on -wal/-shm ONLY when no container mounts the db", () => {
      strandLease();
      const result = recoverStaleSqliteWriterLease(databaseUrl, {
        isPidAlive: () => false,
        observeOpenFiles: proxyInventory("-wal"),
        observeDockerMountSources: () => ["/somewhere/else", "/var/lib/docker/volumes/x/_data"],
      });
      expect(result.recovered).toBe(true);
      expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(false);
    });

    it("NEVER excuses a proxy handle on the main database file", () => {
      strandLease();
      expect(() =>
        recoverStaleSqliteWriterLease(databaseUrl, {
          isPidAlive: () => false,
          observeOpenFiles: proxyInventory(""),
          observeDockerMountSources: () => [],
        }),
      ).toThrow(/still hold the SQLite database open/);
      expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(true);
    });

    it("refuses when a container (running or stopped) mounts the database path", () => {
      strandLease();
      expect(() =>
        recoverStaleSqliteWriterLease(databaseUrl, {
          isPidAlive: () => false,
          observeOpenFiles: proxyInventory("-shm"),
          observeDockerMountSources: () => [path.dirname(canonicalDb())],
        }),
      ).toThrow(/Docker container mounts the database path/);
      expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(true);
    });

    it("refuses when the Docker inventory itself cannot be verified", () => {
      strandLease();
      expect(() =>
        recoverStaleSqliteWriterLease(databaseUrl, {
          isPidAlive: () => false,
          observeOpenFiles: proxyInventory("-wal"),
          observeDockerMountSources: () => null,
        }),
      ).toThrow(/mount inventory could not be verified/);
      expect(existsSync(sqliteWriterLeasePath(databaseUrl))).toBe(true);
    });
  });
});
