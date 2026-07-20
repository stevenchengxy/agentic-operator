/**
 * Proof-gated recovery of a STALE SQLite writer lease.
 *
 * `acquireSqliteWriterLease` never reclaims an existing lease — by design
 * (heartbeat age proves nothing about a paused or clock-skewed writer). This
 * module codifies the documented operator recovery for the dev workflow and
 * REFUSES unless BOTH proofs pass:
 *   (1) the recorded owner pid is provably dead on this host, and
 *   (2) a full lsof open-descriptor inventory shows NO process holding the
 *       database, its -wal or its -shm.
 * Only then does it call `recoverSqliteWriterLeaseAfterProof`. Any missing or
 * ambiguous proof fails closed with an actionable message. Deliberately
 * STRICTER than production setup: no Docker file-sharing-proxy allowance —
 * any holder at all refuses recovery.
 *
 * CLI: `node --import tsx src/writer-lease-recovery.ts` with DATABASE_URL set
 * (wired as root `pnpm db:recover-writer-lease`; stop-dev.sh runs it
 * best-effort when a lease survives a stack stop). No native/sqlite import —
 * safe to run under any Node ABI.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  inspectSqliteWriterLease,
  recoverSqliteWriterLeaseAfterProof,
} from "./writer-lease";

export interface OpenFileInventory {
  status: number | null;
  stdout: string;
  /** e.g. "ENOENT" when the lsof binary itself is missing. */
  errorCode?: string;
}

export interface RecoverStaleLeaseDeps {
  /** Injectable for tests. Default: process.kill(pid, 0) semantics. */
  isPidAlive?: (pid: number) => boolean;
  /** Injectable for tests. Default: full `lsof -nP -Fpcfn` inventory. */
  observeOpenFiles?: () => OpenFileInventory;
  /** Injectable for tests. Default: `docker inspect` mount sources of ALL
   * containers (running and stopped). `null` = docker unavailable/failed. */
  observeDockerMountSources?: () => string[] | null;
}

export interface RecoverStaleLeaseResult {
  recovered: boolean;
  reason: "no-lease" | "recovered";
  owner?: { pid: number; acquiredAt: string };
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only proof of death. EPERM means the pid exists under
    // another user; any other failure is ambiguous — both stay fail-closed.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function defaultObserveOpenFiles(): OpenFileInventory {
  const result = spawnSync("lsof", ["-nP", "-Fpcfn"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    errorCode: (result.error as NodeJS.ErrnoException | undefined)?.code,
  };
}

export interface DatabaseHolder {
  pid: string;
  command: string;
  /** basename of the matched target, e.g. "agentic.db-wal". */
  file: string;
  /** true when the handle is on the main database file (never excusable). */
  isMainDb: boolean;
}

/** Parse an `lsof -Fpcfn` inventory for holders of the database/-wal/-shm.
 * Matches by path (including a trailing " (deleted)" marker where emitted). */
export function openDatabaseHolders(lsofOutput: string, databasePath: string): DatabaseHolder[] {
  const targets = ["", "-wal", "-shm"].map((suffix) => `${databasePath}${suffix}`);
  let pid = "unknown";
  let command = "unknown";
  const holders = new Map<string, DatabaseHolder>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") pid = value || "unknown";
    else if (field === "c") command = value || "unknown";
    else if (field === "n") {
      const hit = targets.find((target) => value === target || value.startsWith(`${target} `));
      if (hit) {
        const holder: DatabaseHolder = {
          pid,
          command: command.slice(0, 60),
          file: path.basename(hit),
          isMainDb: hit === databasePath,
        };
        holders.set(`${holder.pid}\0${holder.command}\0${holder.file}`, holder);
      }
    }
  }
  return [...holders.values()];
}

export function describeHolder(holder: DatabaseHolder): string {
  return `pid=${holder.pid} command=${holder.command} file=${holder.file}`;
}

/** Docker Desktop's macOS file-sharing proxy (Virtualization.framework) keeps
 * cached READ handles on bind-mounted paths long after the containers exit.
 * Mirrors production setup's allowance, with the same hard limits: only this
 * command, only -wal/-shm (a main-db handle always fails closed), and only
 * after a full Docker mount inventory proves no container — running or
 * stopped — mounts the database. */
const DARWIN_DOCKER_FILE_SHARING_PROXY = /^com\.apple\.Virtualization\./;

function isExcusableDockerProxyHolder(holder: DatabaseHolder): boolean {
  return !holder.isMainDb && DARWIN_DOCKER_FILE_SHARING_PROXY.test(holder.command);
}

function defaultObserveDockerMountSources(): string[] | null {
  const list = spawnSync("docker", ["ps", "-aq"], { encoding: "utf8" });
  if (list.error || list.status !== 0) return null;
  const ids = list.stdout.split(/\s+/).filter(Boolean);
  if (!ids.length) return [];
  const inspect = spawnSync(
    "docker",
    ["inspect", "--format", "{{range .Mounts}}{{.Source}}\n{{end}}", ...ids],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  if (inspect.error || inspect.status !== 0) return null;
  return inspect.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** A mount endangers the database when its source is the db file itself or
 * any ancestor directory of it (a bind mount of data/ exposes the db). */
export function mountSourceCoversDatabase(source: string, databasePath: string): boolean {
  const normalized = path.resolve(source);
  if (normalized === databasePath) return true;
  return databasePath.startsWith(`${normalized}${path.sep}`);
}

/**
 * Recover a stale writer lease after liveness + open-file proofs.
 * Returns `{recovered:false, reason:"no-lease"}` when there is nothing to do;
 * throws (lease untouched) whenever any proof fails.
 */
export function recoverStaleSqliteWriterLease(
  databaseUrl: string,
  deps: RecoverStaleLeaseDeps = {},
): RecoverStaleLeaseResult {
  // inspect() itself fails closed on malformed/symlinked lease contents.
  const snapshot = inspectSqliteWriterLease(databaseUrl);
  if (!snapshot) return { recovered: false, reason: "no-lease" };

  const isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
  if (isPidAlive(snapshot.owner.pid)) {
    throw new Error(
      `SQLite writer lease owner pid=${snapshot.owner.pid} is still alive; refusing recovery — stop that process first`,
    );
  }

  const observe = deps.observeOpenFiles ?? defaultObserveOpenFiles;
  const inventory = observe();
  if (inventory.errorCode === "ENOENT") {
    throw new Error("lsof is required to prove the database is unused; install lsof and retry");
  }
  if (inventory.errorCode || inventory.status !== 0) {
    throw new Error("lsof could not complete the open-file proof; refusing recovery");
  }
  const holders = openDatabaseHolders(inventory.stdout, snapshot.owner.databasePath);
  const real = holders.filter((holder) => !isExcusableDockerProxyHolder(holder));
  if (real.length) {
    throw new Error(
      `process(es) still hold the SQLite database open (${real.map(describeHolder).join("; ")}); refusing recovery`,
    );
  }
  const proxyRelics = holders.filter(isExcusableDockerProxyHolder);
  if (proxyRelics.length) {
    // The allowance itself needs a proof: no container — running or stopped —
    // may mount the database (or an ancestor dir). Docker unavailable → the
    // relic handles cannot be attributed → fail closed.
    const observeDocker = deps.observeDockerMountSources ?? defaultObserveDockerMountSources;
    const mounts = observeDocker();
    if (mounts === null) {
      throw new Error(
        `Docker file-sharing proxy holds ${proxyRelics.map((h) => h.file).join("/")} and the Docker mount inventory could not be verified; refusing recovery`,
      );
    }
    const covering = mounts.filter((source) =>
      mountSourceCoversDatabase(source, snapshot.owner.databasePath));
    if (covering.length) {
      throw new Error(
        `a Docker container mounts the database path (${covering[0]}); stop/remove it first — refusing recovery`,
      );
    }
    console.log(
      `[writer-lease] ignoring ${proxyRelics.length} cached macOS Docker file-sharing handle(s) on -wal/-shm (no container mounts the database)`,
    );
  }

  recoverSqliteWriterLeaseAfterProof(databaseUrl);
  return {
    recovered: true,
    reason: "recovered",
    owner: { pid: snapshot.owner.pid, acquiredAt: snapshot.owner.acquiredAt },
  };
}

const isMain = path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
if (isMain) {
  const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
  try {
    if (!databaseUrl) throw new Error("DATABASE_URL is required");
    const result = recoverStaleSqliteWriterLease(databaseUrl);
    if (result.reason === "no-lease") {
      console.log("[writer-lease] no lease present; nothing to recover");
    } else {
      console.log(
        `[writer-lease] recovered stale lease (dead owner pid=${result.owner?.pid}, acquiredAt=${result.owner?.acquiredAt})`,
      );
    }
  } catch (error) {
    console.error(`[writer-lease] ${String((error as Error)?.message ?? error)}`);
    process.exitCode = 1;
  }
}
