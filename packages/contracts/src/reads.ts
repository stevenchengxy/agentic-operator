import { z } from "zod";

/** Aggregate counts for the sidebar + dashboard KPI strip. */
export const TenantCounts = z.object({
  agents: z.number(),
  runningRuns: z.number(),
  okRuns24h: z.number(),
  failedRuns24h: z.number(),
  events24h: z.number(),
  openTasks: z.number(),
  totalRuns: z.number(),
});
export type TenantCounts = z.infer<typeof TenantCounts>;

/**
 * Per-agent throughput for the dashboard. For the tenant's LIVE workflow,
 * each agent gets the count of DISTINCT subjects it processed and its run
 * count within the rolling window. This is honest across every tenant
 * shape (linear pipeline or not) — unlike a stage "funnel", which only made
 * sense for staged tenants. Sorted by subjects desc; test runs never count.
 */
export const ThroughputAgent = z.object({
  kebabId: z.string(),
  name: z.string(),
  title: z.string(),
  /** Distinct subjects this agent processed in the window. */
  subjects: z.number(),
  /** Total runs (incl. repeats on the same subject) in the window. */
  runs: z.number(),
});
export type ThroughputAgent = z.infer<typeof ThroughputAgent>;

export const ThroughputResult = z.object({
  /** Human window token echoed back: "1h" | "24h" | "7d". */
  window: z.string(),
  /** Window length in milliseconds (source of truth for the query). */
  windowMs: z.number(),
  agents: z.array(ThroughputAgent),
});
export type ThroughputResult = z.infer<typeof ThroughputResult>;

/** Health endpoint — unauthenticated, used by load balancers / `/api/health`. */
export const HealthReport = z.object({
  ok: z.boolean(),
  /** Server wall-clock timestamp at the moment the report was generated (ms). */
  ts: z.number().optional(),
  /** Process uptime in seconds. */
  uptime: z.number().optional(),
  /** apps/api package.json version. Surfaces on the Settings → System pane. */
  version: z.string().optional(),
  /**
   * Current workflow-manifest schema version this api understands. Bumped
   * in lockstep with `@agentic/runtime`'s `CURRENT_SCHEMA_VERSION` so the
   * manifest-import wizard can detect a forward-incompat manifest.
   */
  schemaVersion: z.string().optional(),
  inngest: z.object({
    ok: z.boolean(),
    reachable: z.boolean().optional(),
    note: z.string().optional(),
  }),
  sqlite: z.object({
    ok: z.boolean(),
    sizeBytes: z.number().optional(),
    journalMode: z.string().optional(),
  }),
  disk: z.object({
    ok: z.boolean(),
    logsDir: z.string().optional(),
    freeBytes: z.number().optional(),
  }),
  /**
   * LLM gateway subsystem — exposes the default provider/model so support
   * can confirm a hot-deploy actually picked up the env override (P4-API-04).
   */
  llmGateway: z
    .object({
      ok: z.boolean(),
      defaultProvider: z.string().optional(),
      defaultModel: z.string().optional(),
      providers: z.number().optional(),
      /**
       * #NOMOCK — true when the CONSTRUCTED gateway is the mock (echo) provider, so a mock runtime
       * can never masquerade as real. Ops/UI can surface a persistent "MOCK LLM ACTIVE" banner from
       * one curl instead of trusting the boot log. Distinct from demoMode: mock can be active via a
       * runtime demo toggle even when the boot env said production.
       */
      mock: z.boolean().optional(),
    })
    .optional(),
  /**
   * AGENTIC_DEMO_MODE flag (locked 2026-05-26). Surfaced on /health so the
   * sidebar can render a "DEMO" badge in the UI without depending on the
   * env reaching the browser. Optional so older api builds (without this
   * field) still parse cleanly on a newer web client; the web treats
   * undefined as `false`.
   */
  demoMode: z.boolean().optional(),
  // #SCALE — which pluggable backends are live: blob "fs" | "fs+http" | "fs+s3" | "fs+<custom>";
  // fanout "local" | "redis". Lets ops confirm a config-flip took effect from one curl.
  blobBackend: z.string().optional(),
  fanout: z.string().optional(),
  memoryDriver: z.string().optional(),
});
export type HealthReport = z.infer<typeof HealthReport>;
