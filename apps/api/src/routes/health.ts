import type { FastifyInstance } from "fastify";
import path from "node:path";
import { readFile, stat, statfs } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getRawSqlite } from "@agentic/db";
import type { HealthReport } from "@agentic/contracts";
import { CURRENT_SCHEMA_VERSION, blobBackendStatus } from "@agentic/runtime";
import { getLLMGateway } from "../services/llm";
import { isDemoMode } from "../config/demo-mode.js";
import { fanoutStatus } from "../services/fanout-redis";
import { memoryDriverStatus } from "../services/memory-pgvector";

/** apps/api/package.json — used for the `version` field on the report. */
const apiPackageJsonPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "package.json",
);

let _cachedVersion: string | null = null;
async function readApiVersion(): Promise<string> {
  if (_cachedVersion) return _cachedVersion;
  try {
    const raw = await readFile(apiPackageJsonPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    _cachedVersion = parsed.version ?? "0.0.0";
  } catch {
    _cachedVersion = "0.0.0";
  }
  return _cachedVersion;
}

/**
 * GET /health — unauthenticated, suitable for load balancers / uptime checks.
 * Per DESIGN.md §12, extended for P4-API-04 with `version`, `schemaVersion`,
 * and an `llmGateway` subsystem block so support can confirm a hot-deploy
 * picked up the env override.
 */
export async function healthRoute(app: FastifyInstance) {
  app.get("/health", async (_req, reply) => {
    const [inngest, sqlite, disk, llmGateway, version] = await Promise.all([
      checkInngest(),
      checkSqlite(),
      checkDisk(),
      checkLLMGateway(),
      readApiVersion(),
    ]);
    const ok = inngest.ok && sqlite.ok && disk.ok && llmGateway.ok;
    const report: HealthReport = {
      ok,
      ts: Date.now(),
      uptime: Math.round(process.uptime()),
      version,
      schemaVersion: String(CURRENT_SCHEMA_VERSION),
      inngest,
      sqlite,
      disk,
      llmGateway,
      // AGENTIC_DEMO_MODE — surfaced so the web sidebar can render a "DEMO"
      // badge without reading the api env. Read lazily on every /health
      // request so a hot-reload of the env (uncommon in prod) takes effect
      // without a restart. The web treats undefined as false.
      demoMode: isDemoMode(),
      // #SCALE — pluggable-backend status (config-flip verification from one curl).
      blobBackend: blobBackendStatus(),
      fanout: fanoutStatus(),
      memoryDriver: memoryDriverStatus(),
    };
    return reply.status(ok ? 200 : 503).send(report);
  });
}

async function checkLLMGateway(): Promise<NonNullable<HealthReport["llmGateway"]>> {
  try {
    const g = getLLMGateway();
    return {
      ok: true,
      defaultProvider: g.defaultProvider,
      defaultModel: process.env.LLM_DEFAULT_MODEL ?? undefined,
      providers: g.listProviders().length,
      // #NOMOCK — explicit flag so a mock runtime can never masquerade as real (one curl reveals it).
      mock: g.defaultProvider === "mock",
    };
  } catch {
    return { ok: false };
  }
}

async function checkInngest(): Promise<HealthReport["inngest"]> {
  if (process.env.INNGEST_DEV === "1" || !process.env.INNGEST_BASE_URL) {
    return { ok: true, note: "dev mode" };
  }
  try {
    const r = await fetch(`${process.env.INNGEST_BASE_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return { ok: r.ok, reachable: true };
  } catch {
    return { ok: false, reachable: false };
  }
}

async function checkSqlite(): Promise<HealthReport["sqlite"]> {
  try {
    const dbPath =
      process.env.DATABASE_URL?.replace(/^file:/, "") ?? "./agentic.db";
    const st = await stat(dbPath);
    const sql = getRawSqlite();
    const mode = sql.pragma("journal_mode", { simple: true }) as string;
    sql.prepare("SELECT 1 as ok").get();
    return { ok: true, sizeBytes: st.size, journalMode: mode };
  } catch {
    return { ok: false };
  }
}

async function checkDisk(): Promise<HealthReport["disk"]> {
  const logsDir = process.env.AGENTIC_LOGS_DIR ?? "./logs";
  try {
    const sfs = await statfs(path.resolve(logsDir));
    return {
      ok: true,
      logsDir,
      freeBytes: Number(sfs.bavail) * sfs.bsize,
    };
  } catch {
    return { ok: false, logsDir };
  }
}
