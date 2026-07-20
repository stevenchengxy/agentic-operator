/**
 * Cross-process SQLite writer lease.
 *
 * SQLite WAL is safe for several processes only while every process observes
 * the same database/WAL inode. A host API and a bind-mounted container can
 * otherwise keep different (including unlinked) WAL generations alive. This
 * lease deliberately permits one supervised writer process tree per database.
 *
 * Important: heartbeat age is diagnostic only. A crashed lease is NEVER
 * reclaimed here. Recovery is an explicit operator operation after external
 * lsof, container-inventory and SQLite-integrity proofs.
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";

const LEASE_VERSION = 1 as const;
const OWNER_FILE = "owner.json";
const HEARTBEAT_FILE = "heartbeat.json";
const MAX_RECORD_BYTES = 8 * 1024;

export interface SqliteWriterLeaseOwner {
  version: typeof LEASE_VERSION;
  token: string;
  pid: number;
  databasePath: string;
  acquiredAt: string;
}

export interface SqliteWriterLeaseHeartbeat {
  version: typeof LEASE_VERSION;
  token: string;
  sequence: number;
  heartbeatAt: string;
}

export interface SqliteWriterLeaseSnapshot {
  leasePath: string;
  owner: SqliteWriterLeaseOwner;
  heartbeat: SqliteWriterLeaseHeartbeat;
}

export interface SqliteWriterLease {
  readonly databasePath: string;
  readonly leasePath: string;
  readonly token: string;
  heartbeat(): void;
  release(): void;
}

export interface AcquireSqliteWriterLeaseOptions {
  pid?: number;
  now?: () => Date;
  token?: string;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validOwner(value: unknown): value is SqliteWriterLeaseOwner {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SqliteWriterLeaseOwner>;
  return row.version === LEASE_VERSION
    && validToken(row.token)
    && Number.isSafeInteger(row.pid)
    && Number(row.pid) > 0
    && typeof row.databasePath === "string"
    && path.isAbsolute(row.databasePath)
    && validDate(row.acquiredAt);
}

function validHeartbeat(value: unknown): value is SqliteWriterLeaseHeartbeat {
  if (!value || typeof value !== "object") return false;
  const row = value as Partial<SqliteWriterLeaseHeartbeat>;
  return row.version === LEASE_VERSION
    && validToken(row.token)
    && Number.isSafeInteger(row.sequence)
    && Number(row.sequence) >= 0
    && validDate(row.heartbeatAt);
}

function assertRegularNonSymlink(filename: string, label: string): void {
  const stat = lstatSync(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`SQLite writer lease ${label} must be a regular non-symlink file`);
  }
  if (stat.size > MAX_RECORD_BYTES) {
    throw new Error(`SQLite writer lease ${label} is oversized or malformed`);
  }
}

function readRecord(filename: string, label: string): unknown {
  assertRegularNonSymlink(filename, label);
  // O_NOFOLLOW closes the lstat/open race on platforms that support it.
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(filename, constants.O_RDONLY | noFollow);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) {
      throw new Error(`SQLite writer lease ${label} is malformed`);
    }
    return JSON.parse(readFileSync(fd, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SQLite writer lease")) {
      throw error;
    }
    throw new Error(`SQLite writer lease ${label} is malformed`);
  } finally {
    closeSync(fd);
  }
}

function readOwner(leasePath: string): SqliteWriterLeaseOwner {
  const value = readRecord(path.join(leasePath, OWNER_FILE), "owner record");
  if (!validOwner(value)) throw new Error("SQLite writer lease owner record is malformed");
  return value;
}

function readHeartbeat(leasePath: string): SqliteWriterLeaseHeartbeat {
  const value = readRecord(path.join(leasePath, HEARTBEAT_FILE), "heartbeat record");
  if (!validHeartbeat(value)) {
    throw new Error("SQLite writer lease heartbeat record is malformed");
  }
  return value;
}

function writeNewRecord(filename: string, value: unknown): void {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const fd = openSync(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
    0o600,
  );
  try {
    writeFileSync(fd, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function canonicalDatabasePath(databaseUrl: string, cwd = process.cwd()): string {
  const raw = databaseUrl.startsWith("file:") ? databaseUrl.slice(5) : databaseUrl;
  if (!raw || raw === ":memory:" || raw.startsWith(":memory:")) {
    throw new Error("SQLite writer lease requires a persistent filesystem database");
  }
  const lexical = path.resolve(cwd, raw);
  const parent = realpathSync(path.dirname(lexical));
  const canonical = path.join(parent, path.basename(lexical));
  if (existsSync(canonical)) {
    const databaseStat = lstatSync(canonical);
    if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
      throw new Error("SQLite database must be a regular non-symlink file");
    }
  }
  return canonical;
}

export function sqliteWriterLeasePath(databaseUrl: string, cwd?: string): string {
  return `${canonicalDatabasePath(databaseUrl, cwd)}.writer-lease`;
}

function assertLeaseDirectory(leasePath: string): Stats {
  const stat = lstatSync(leasePath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("SQLite writer lease path must be a real directory, never a symlink");
  }
  return stat;
}

function sameInode(
  left: Pick<Stats, "dev" | "ino">,
  right: Pick<Stats, "dev" | "ino">,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The owner's heartbeat() updates via write-temp → rename. Concurrent
 * inspectors (server child startup, health checks) can legitimately observe
 * that sub-millisecond window, so exactly ONE pattern-conformant temp is
 * protocol state, not corruption. Anything else stays fail-closed. */
const HEARTBEAT_TEMP_PATTERN = /^\.heartbeat-[a-f0-9]{64}-\d+\.tmp$/;

function assertExactLeaseFiles(leasePath: string): void {
  const entries = readdirSync(leasePath).sort();
  const extras = entries.filter((name) => name !== HEARTBEAT_FILE && name !== OWNER_FILE);
  if (
    !entries.includes(HEARTBEAT_FILE)
    || !entries.includes(OWNER_FILE)
    || extras.length > 1
    || (extras.length === 1 && !HEARTBEAT_TEMP_PATTERN.test(extras[0]!))
  ) {
    throw new Error("SQLite writer lease directory contains unexpected or incomplete records");
  }
  if (extras.length === 1) {
    assertRegularNonSymlink(path.join(leasePath, extras[0]!), "in-flight heartbeat record");
  }
  assertRegularNonSymlink(path.join(leasePath, OWNER_FILE), "owner record");
  assertRegularNonSymlink(path.join(leasePath, HEARTBEAT_FILE), "heartbeat record");
}

export function inspectSqliteWriterLease(
  databaseUrl: string,
  cwd?: string,
): SqliteWriterLeaseSnapshot | null {
  const databasePath = canonicalDatabasePath(databaseUrl, cwd);
  const leasePath = `${databasePath}.writer-lease`;
  if (!existsSync(leasePath)) return null;
  assertLeaseDirectory(leasePath);
  assertExactLeaseFiles(leasePath);
  const owner = readOwner(leasePath);
  const heartbeat = readHeartbeat(leasePath);
  if (owner.databasePath !== databasePath || heartbeat.token !== owner.token) {
    throw new Error("SQLite writer lease ownership records disagree");
  }
  return { leasePath, owner, heartbeat };
}

function assertOwnedLease(
  leasePath: string,
  databasePath: string,
  token: string,
  inode: Pick<Stats, "dev" | "ino">,
): SqliteWriterLeaseHeartbeat {
  const current = assertLeaseDirectory(leasePath);
  if (!sameInode(current, inode)) {
    throw new Error("SQLite writer lease directory ownership changed unexpectedly");
  }
  assertExactLeaseFiles(leasePath);
  const owner = readOwner(leasePath);
  const heartbeat = readHeartbeat(leasePath);
  if (
    owner.token !== token
    || owner.databasePath !== databasePath
    || heartbeat.token !== token
  ) {
    throw new Error("SQLite writer lease ownership changed unexpectedly");
  }
  return heartbeat;
}

function assertOwnedLeaseWithHeartbeatTemp(
  leasePath: string,
  databasePath: string,
  token: string,
  inode: Pick<Stats, "dev" | "ino">,
  temporary: string,
): void {
  const current = assertLeaseDirectory(leasePath);
  if (!sameInode(current, inode)) {
    throw new Error("SQLite writer lease directory ownership changed unexpectedly");
  }
  const temporaryName = path.basename(temporary);
  const entries = readdirSync(leasePath).sort();
  const expected = [HEARTBEAT_FILE, OWNER_FILE, temporaryName].sort();
  if (entries.length !== expected.length || entries.some((name, index) => name !== expected[index])) {
    throw new Error("SQLite writer lease changed during heartbeat update");
  }
  assertRegularNonSymlink(temporary, "temporary heartbeat record");
  const owner = readOwner(leasePath);
  const heartbeat = readHeartbeat(leasePath);
  if (
    owner.token !== token
    || owner.databasePath !== databasePath
    || heartbeat.token !== token
  ) {
    throw new Error("SQLite writer lease ownership changed unexpectedly");
  }
}

/** Atomically acquires the canonical lease directory. Existing leases are
 * never reclaimed, regardless of PID state or heartbeat age. */
export function acquireSqliteWriterLease(
  databaseUrl: string,
  options: AcquireSqliteWriterLeaseOptions = {},
): SqliteWriterLease {
  const databasePath = canonicalDatabasePath(databaseUrl);
  const leasePath = `${databasePath}.writer-lease`;
  const token = options.token ?? randomBytes(32).toString("hex");
  const pid = options.pid ?? process.pid;
  const now = options.now ?? (() => new Date());
  if (!validToken(token)) throw new Error("SQLite writer lease token must be 32-byte lowercase hex");
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("SQLite writer lease pid is invalid");

  try {
    mkdirSync(leasePath, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Validate for an actionable distinction, but never steal either a valid
    // or malformed existing lease.
    inspectSqliteWriterLease(databasePath);
    throw new Error(
      `SQLite writer lease is already held at ${leasePath}; heartbeat expiry never grants recovery authority`,
    );
  }

  const inode = assertLeaseDirectory(leasePath);
  const timestamp = now().toISOString();
  const owner: SqliteWriterLeaseOwner = {
    version: LEASE_VERSION,
    token,
    pid,
    databasePath,
    acquiredAt: timestamp,
  };
  let sequence = 0;
  let released = false;
  try {
    writeNewRecord(path.join(leasePath, OWNER_FILE), owner);
    writeNewRecord(path.join(leasePath, HEARTBEAT_FILE), {
      version: LEASE_VERSION,
      token,
      sequence,
      heartbeatAt: timestamp,
    } satisfies SqliteWriterLeaseHeartbeat);
  } catch (error) {
    // We just created this inode and no usable lease was published. Remove
    // only known regular files; a replacement/symlink is left fail-closed.
    try {
      const current = assertLeaseDirectory(leasePath);
      if (sameInode(current, inode)) {
        for (const name of [OWNER_FILE, HEARTBEAT_FILE]) {
          const filename = path.join(leasePath, name);
          if (existsSync(filename) && lstatSync(filename).isFile()) unlinkSync(filename);
        }
        if (readdirSync(leasePath).length === 0) rmdirSync(leasePath);
      }
    } catch {
      // Preserve the failed lease as evidence rather than recursively deleting
      // anything whose ownership can no longer be proven.
    }
    throw error;
  }

  return {
    databasePath,
    leasePath,
    token,
    heartbeat() {
      if (released) throw new Error("SQLite writer lease was already released");
      const previous = assertOwnedLease(leasePath, databasePath, token, inode);
      sequence = Math.max(sequence, previous.sequence) + 1;
      const temporary = path.join(leasePath, `.heartbeat-${token}-${sequence}.tmp`);
      try {
        writeNewRecord(temporary, {
          version: LEASE_VERSION,
          token,
          sequence,
          heartbeatAt: now().toISOString(),
        } satisfies SqliteWriterLeaseHeartbeat);
        // Refuse to replace a symlink or a record belonging to a different
        // owner. rename(2) then makes the heartbeat update atomic to readers.
        assertOwnedLeaseWithHeartbeatTemp(
          leasePath,
          databasePath,
          token,
          inode,
          temporary,
        );
        renameSync(temporary, path.join(leasePath, HEARTBEAT_FILE));
        assertOwnedLease(leasePath, databasePath, token, inode);
      } catch (error) {
        try {
          if (existsSync(temporary) && lstatSync(temporary).isFile()) unlinkSync(temporary);
        } catch {
          // A suspicious temp-path ownership change is intentionally retained.
        }
        throw error;
      }
    },
    release() {
      if (released) return;
      assertOwnedLease(leasePath, databasePath, token, inode);
      const releasingPath = `${leasePath}.release-${token}`;
      if (existsSync(releasingPath)) {
        throw new Error("SQLite writer lease release quarantine already exists");
      }
      renameSync(leasePath, releasingPath);
      const moved = assertLeaseDirectory(releasingPath);
      if (!sameInode(moved, inode)) {
        throw new Error("SQLite writer lease ownership changed during release");
      }
      const movedOwner = readOwner(releasingPath);
      const movedHeartbeat = readHeartbeat(releasingPath);
      if (movedOwner.token !== token || movedHeartbeat.token !== token) {
        throw new Error("SQLite writer lease token changed during release");
      }
      unlinkSync(path.join(releasingPath, HEARTBEAT_FILE));
      unlinkSync(path.join(releasingPath, OWNER_FILE));
      rmdirSync(releasingPath);
      released = true;
    },
  };
}

/** Validate the supervisor capability inherited by a writer child. */
export function assertInheritedSqliteWriterLease(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): SqliteWriterLeaseSnapshot {
  const token = env.AGENTIC_SQLITE_WRITER_LEASE_TOKEN?.trim();
  const ownerPid = Number(env.AGENTIC_SQLITE_WRITER_SUPERVISOR_PID);
  const expectedPath = env.AGENTIC_SQLITE_WRITER_LEASE_PATH?.trim();
  if (!validToken(token) || !Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !expectedPath) {
    throw new Error(
      "direct SQLite writer startup is forbidden; run the API through the SQLite writer supervisor",
    );
  }
  const snapshot = inspectSqliteWriterLease(databaseUrl);
  if (
    !snapshot
    || snapshot.leasePath !== expectedPath
    || snapshot.owner.token !== token
    || snapshot.owner.pid !== ownerPid
  ) {
    throw new Error("inherited SQLite writer lease does not match the canonical owner");
  }
  return snapshot;
}

/**
 * Destructive lease cleanup primitive for an operator recovery workflow.
 * This function performs no liveness proof itself and must only be called by
 * setup after lsof, Docker inventory and SQLite integrity all pass. Symlinks,
 * nested directories and unknown files remain fail-closed even in recovery.
 */
export function recoverSqliteWriterLeaseAfterProof(databaseUrl: string): boolean {
  const databasePath = canonicalDatabasePath(databaseUrl);
  const leasePath = `${databasePath}.writer-lease`;
  if (!existsSync(leasePath)) return false;
  assertLeaseDirectory(leasePath);
  const entries = readdirSync(leasePath);
  const allowed = new Set([OWNER_FILE, HEARTBEAT_FILE]);
  for (const name of entries) {
    // A crashed owner can leave its in-flight heartbeat temp behind; that is
    // protocol debris (strictly pattern-checked), safe for recovery to remove.
    if (!allowed.has(name) && !HEARTBEAT_TEMP_PATTERN.test(name)) {
      throw new Error(`SQLite writer lease recovery found unexpected entry ${JSON.stringify(name)}`);
    }
    assertRegularNonSymlink(path.join(leasePath, name), `${name} recovery record`);
  }
  const recoveryToken = randomBytes(32).toString("hex");
  const recoveryPath = `${leasePath}.operator-recovery-${recoveryToken}`;
  renameSync(leasePath, recoveryPath);
  for (const name of entries) unlinkSync(path.join(recoveryPath, name));
  rmdirSync(recoveryPath);
  return true;
}
