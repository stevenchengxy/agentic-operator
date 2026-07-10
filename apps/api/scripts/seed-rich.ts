/**
 * Rich pre-loaded fixtures from the handoff data.js + ontology models.
 *
 * Per RF-1.7: makes a fresh boot look like a working operator console with
 * 67 historical runs, 140 events, 7 tasks (1 open), 6 deployments, and the
 * sample log file. Re-running this script is idempotent.
 *
 * Sources:
 *   - /Users/kenny/CSI-AICOE/agentic-operator/agentic-operator-handoff/project/data.js
 *   - /Users/kenny/CSI-AICOE/agentic-operator/models/RAAS-v1/{events,objects,rules}.json
 *
 * The data.js file uses `window.*` assignments and Date.now() arithmetic for
 * timestamps. We set up a fake `window` global, eval the file, then read off
 * the assignments. Re-evaluating each seed run re-anchors timestamps to
 * Date.now(), so the fixtures stay "fresh" indefinitely.
 */

import { readFile, mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { and, eq } from "drizzle-orm";
import {
  agents as agentsTable,
  agentVersions as agentVersionsTable,
  deployments as deploymentsTable,
  events as eventsTable,
  eventTypes,
  getDb,
  runs as runsTable,
  tasks as tasksTable,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";

const HANDOFF_DATA_JS =
  "/Users/kenny/CSI-AICOE/agentic-operator/agentic-operator-handoff/project/data.js";
const TENANT_SLUG = "raas";

interface RaasAgent {
  id: string;
  name: string;
  title: string;
  description?: string;
  model?: string;
  actor: "Agent" | "Human";
  triggers: string[];
  emits: string[];
}
interface RaasEventType {
  name: string;
  category: string;
  color: string;
}
interface RaasRun {
  id: string;
  agentId: string;
  agentName: string;
  agentTitle: string;
  actor: string;
  status: "running" | "ok" | "failed" | "waiting";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  triggerEvent: string;
  subject: string;
  emittedEvent?: string | null;
  tokensIn?: number;
  tokensOut?: number;
  model?: string;
  errorMessage?: string | null;
}
interface RaasEventStreamEntry {
  id: string;
  name: string;
  category: string;
  color: string;
  at: number;
  source: string;
  sourceTitle: string;
  subject: string;
  payloadBytes: number;
}
interface RaasTask {
  id: string;
  type: string;
  title: string;
  agentId: string;
  priority?: "low" | "medium" | "high";
  status?: "open" | "resolved" | "snoozed";
  createdAt?: number;
  payload?: Record<string, unknown>;
}
interface RaasDeployment {
  id: string;
  version: string;
  agent: string;
  status: "live" | "rolled-back" | "pending";
  by: string;
  at: number;
  note: string;
}
interface RaasFixtures {
  TENANTS?: unknown[];
  RAAS_AGENTS?: RaasAgent[];
  RAAS_EVENTS?: RaasEventType[];
  RAAS_STAGES?: Array<{ id: number; label: string }>;
  RAAS_REQS?: unknown[];
  RAAS_CANDIDATES?: unknown[];
  RAAS_RUNS?: RaasRun[];
  RAAS_EVENT_STREAM?: RaasEventStreamEntry[];
  RAAS_TASKS?: RaasTask[];
  RAAS_SAMPLE_LOG?: string;
  RAAS_DEPLOYMENTS?: RaasDeployment[];
}

async function loadRaasFixtures(): Promise<RaasFixtures> {
  const src = await readFile(HANDOFF_DATA_JS, "utf8");
  const win: RaasFixtures = {};
  const ctx = vm.createContext({
    window: win,
    Date,
    Math,
    JSON,
    console: { log: () => {}, warn: () => {}, error: () => {} },
  });
  vm.runInContext(src, ctx, { filename: HANDOFF_DATA_JS });
  return win;
}

async function resolveTenantId(slug: string): Promise<string | null> {
  const db = getDb();
  return db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0]?.id ?? null;
}

async function resolveLiveWorkflowVersion(
  tenantId: string,
): Promise<{ workflowId: string; versionId: string } | null> {
  const db = getDb();
  const row = db
    .select({
      workflowId: workflows.id,
      versionId: workflowVersions.id,
    })
    .from(workflows)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.workflowId, workflows.id),
    )
    .where(eq(workflows.tenantId, tenantId))
    .all()[0];
  return row ?? null;
}

async function buildAgentNameToIdMap(workflowId: string) {
  const db = getDb();
  const map = new Map<string, string>();
  for (const a of db
    .select({ id: agentsTable.id, name: agentsTable.name, kebabId: agentsTable.kebabId })
    .from(agentsTable)
    .where(eq(agentsTable.workflowId, workflowId))
    .all()) {
    map.set(a.name, a.id);
    map.set(a.kebabId, a.id); // also map kebab IDs for tasks/deployments
  }
  return map;
}

async function seedEventTypes(tenantId: string, fixtures: RaasFixtures) {
  const db = getDb();
  let inserted = 0;
  for (const e of fixtures.RAAS_EVENTS ?? []) {
    const exists = db
      .select()
      .from(eventTypes)
      .where(
        and(eq(eventTypes.tenantId, tenantId), eq(eventTypes.name, e.name)),
      )
      .all()[0];
    if (exists) continue;
    db.insert(eventTypes)
      .values({
        tenantId,
        name: e.name,
        category: e.category,
        color: e.color,
      })
      .run();
    inserted++;
  }
  return inserted;
}

async function seedRuns(
  tenantId: string,
  fixtures: RaasFixtures,
  agentMap: Map<string, string>,
) {
  const db = getDb();
  let inserted = 0;
  let skipped = 0;
  for (const r of fixtures.RAAS_RUNS ?? []) {
    const exists = db
      .select({ id: runsTable.id })
      .from(runsTable)
      .where(eq(runsTable.id, r.id))
      .all()[0];
    if (exists) {
      skipped++;
      continue;
    }
    const agentId = agentMap.get(r.agentName) ?? agentMap.get(r.agentId);
    if (!agentId) {
      skipped++;
      continue; // skip if no matching agent (manualEntry has no kebab match)
    }
    db.insert(runsTable)
      .values({
        id: r.id,
        tenantId,
        agentId,
        agentVersionId: null,
        triggerEventId: null,
        status: r.status,
        startedAt: r.startedAt ? new Date(r.startedAt) : null,
        endedAt: r.endedAt ? new Date(r.endedAt) : null,
        durationMs: r.durationMs ?? null,
        tokensIn: r.tokensIn ?? null,
        tokensOut: r.tokensOut ?? null,
        model: r.model ?? null,
        emittedEventId: null,
        errorMessage: r.errorMessage ?? null,
        logPath: null,
        correlationId: r.id, // use run id as correlation for seeded rows
        subject: r.subject,
      })
      .run();
    inserted++;
  }
  return { inserted, skipped };
}

async function seedEventStream(
  tenantId: string,
  fixtures: RaasFixtures,
  agentMap: Map<string, string>,
) {
  const db = getDb();
  let inserted = 0;
  for (const e of fixtures.RAAS_EVENT_STREAM ?? []) {
    const exists = db
      .select({ id: eventsTable.id })
      .from(eventsTable)
      .where(eq(eventsTable.id, e.id))
      .all()[0];
    if (exists) continue;
    const sourceAgentId = agentMap.get(e.source);
    db.insert(eventsTable)
      .values({
        id: e.id,
        tenantId,
        name: e.name,
        category: e.category,
        sourceAgentId: sourceAgentId ?? null,
        subject: e.subject,
        receivedAt: new Date(e.at),
        payloadRef: null,
      })
      .run();
    inserted++;
  }
  return inserted;
}

async function seedTasks(
  tenantId: string,
  fixtures: RaasFixtures,
  agentMap: Map<string, string>,
) {
  const db = getDb();
  let inserted = 0;
  for (const t of fixtures.RAAS_TASKS ?? []) {
    const exists = db
      .select({ id: tasksTable.id })
      .from(tasksTable)
      .where(eq(tasksTable.id, t.id))
      .all()[0];
    if (exists) continue;
    // Map agentId (kebab) → DB agent id (used only for context, not FK)
    // data.js uses "med" for medium — normalize to schema enum.
    const priority: "low" | "medium" | "high" =
      t.priority === ("med" as never)
        ? "medium"
        : ((t.priority ?? "medium") as "low" | "medium" | "high");
    db.insert(tasksTable)
      .values({
        id: t.id,
        tenantId,
        runId: null,
        type: t.type,
        title: t.title,
        priority,
        status: t.status ?? "open",
        createdAt: t.createdAt ? new Date(t.createdAt) : new Date(),
        payloadJson: (t.payload ?? { agentId: t.agentId }) as never,
      })
      .run();
    inserted++;
  }
  return inserted;
}

async function seedDeployments(tenantId: string, fixtures: RaasFixtures) {
  const db = getDb();
  // We need a workflow_version_id for the FK. Use the live one. Each seeded
  // deployment row points at the same WFV — they're historical labels only.
  const wf = await resolveLiveWorkflowVersion(tenantId);
  if (!wf) return 0;
  let inserted = 0;
  for (const d of fixtures.RAAS_DEPLOYMENTS ?? []) {
    const exists = db
      .select({ id: deploymentsTable.id })
      .from(deploymentsTable)
      .where(eq(deploymentsTable.id, d.id))
      .all()[0];
    if (exists) continue;
    const status =
      d.status === "rolled-back" ? "rolled_back" : (d.status as "live" | "pending");
    db.insert(deploymentsTable)
      .values({
        id: d.id,
        tenantId,
        target: "workflow",
        versionId: wf.versionId,
        status,
        deployedBy: null,
        deployedAt: new Date(d.at),
        note: `${d.version} · ${d.agent} · by ${d.by} — ${d.note}`,
      })
      .run();
    inserted++;
  }
  return inserted;
}

/**
 * Overlay English title + description from handoff data.js onto the
 * agents created from the canonical models manifest (which has Chinese
 * text). Lets the operator console match the prototype's English UI
 * without touching the canonical model files.
 */
async function seedAgentMetadata(workflowId: string, fixtures: RaasFixtures) {
  const db = getDb();
  let touched = 0;
  for (const a of fixtures.RAAS_AGENTS ?? []) {
    // Match on the agent's numeric id (kebab_id in our DB, e.g. "1-2", "2", "14-3")
    const row = db
      .select({ id: agentsTable.id, title: agentsTable.title })
      .from(agentsTable)
      .where(
        and(eq(agentsTable.workflowId, workflowId), eq(agentsTable.kebabId, a.id)),
      )
      .all()[0];
    if (!row) continue;

    // 1) Update agents.title if it's still the auto-default (== name)
    if (a.title && row.title !== a.title) {
      db.update(agentsTable)
        .set({ title: a.title })
        .where(eq(agentsTable.id, row.id))
        .run();
    }

    // 2) Merge English description (+ model) into the latest agent_version manifest
    if (a.description) {
      const ver = db
        .select({
          id: agentVersionsTable.id,
          manifestJson: agentVersionsTable.manifestJson,
        })
        .from(agentVersionsTable)
        .where(eq(agentVersionsTable.agentId, row.id))
        .all();
      for (const v of ver) {
        const m = (v.manifestJson ?? {}) as Record<string, unknown>;
        m.description = a.description;
        if (a.model) m.model = a.model;
        if (a.title) m.title = a.title;
        db.update(agentVersionsTable)
          .set({ manifestJson: m as never })
          .where(eq(agentVersionsTable.id, v.id))
          .run();
      }
    }
    touched++;
  }
  return touched;
}

async function writeSampleLog(fixtures: RaasFixtures) {
  if (!fixtures.RAAS_SAMPLE_LOG) return null;
  const logRoot = process.env.AGENTIC_LOGS_DIR ?? "./data/logs";
  const today = new Date();
  const y = today.getUTCFullYear();
  const m = String(today.getUTCMonth() + 1).padStart(2, "0");
  const d = String(today.getUTCDate()).padStart(2, "0");
  const dir = path.resolve(logRoot, TENANT_SLUG, "runs", `${y}-${m}-${d}`);
  await mkdir(dir, { recursive: true });
  // The sample log references run-01000. Match that ID if present in seeded runs.
  const runId = "run-01000";
  const filePath = path.join(dir, `${runId}.log`);
  try {
    await access(filePath);
    return { path: filePath, written: false };
  } catch {
    // doesn't exist — write it
  }
  await writeFile(filePath, fixtures.RAAS_SAMPLE_LOG + "\n", "utf8");
  return { path: filePath, written: true };
}

export interface SeedRichResult {
  ok: boolean;
  reason?: "tenant_not_seeded" | "no_workflow_version" | "data_js_missing" | "failed";
  parsed?: {
    agents: number;
    eventTypes: number;
    runs: number;
    events: number;
    tasks: number;
    deployments: number;
  };
  inserted?: {
    eventTypes: number;
    agentMetadata: number;
    runs: number;
    runsSkipped: number;
    events: number;
    tasks: number;
    deployments: number;
  };
  sampleLog?: { path: string; written: boolean } | null;
}

/**
 * Programmatic entry point for both the CLI (`pnpm seed:rich`) and the
 * boot-time demo-mode hydration (`apps/api/src/services/demo-seed.ts`).
 *
 * Idempotent on a per-row basis: every insert helper does an `exists`
 * check by primary key before writing, so calling this on a partially-
 * seeded DB is safe.
 *
 * Failures bubble as `{ ok:false, reason }` rather than `process.exit`
 * so the api boot path can degrade cleanly to "demo mode requested but
 * tenant/workflow not ready" without crashing.
 */
export async function runSeedRich(opts: {
  logger?: { info: (msg: string) => void; warn?: (msg: string) => void };
} = {}): Promise<SeedRichResult> {
  const log = opts.logger ?? {
    info: (msg: string) => console.log(msg),
    warn: (msg: string) => console.warn(msg),
  };
  log.info("[seed-rich] loading handoff data.js …");
  let fixtures: RaasFixtures;
  try {
    fixtures = await loadRaasFixtures();
  } catch (err) {
    log.warn?.(`[seed-rich] data.js read failed: ${String(err)}`);
    return { ok: false, reason: "data_js_missing" };
  }
  log.info(
    `[seed-rich] parsed: ${fixtures.RAAS_AGENTS?.length ?? 0} agents · ` +
      `${fixtures.RAAS_EVENTS?.length ?? 0} event types · ` +
      `${fixtures.RAAS_RUNS?.length ?? 0} runs · ` +
      `${fixtures.RAAS_EVENT_STREAM?.length ?? 0} events · ` +
      `${fixtures.RAAS_TASKS?.length ?? 0} tasks · ` +
      `${fixtures.RAAS_DEPLOYMENTS?.length ?? 0} deployments`,
  );

  const tenantId = await resolveTenantId(TENANT_SLUG);
  if (!tenantId) {
    log.warn?.(
      `[seed-rich] tenant slug=${TENANT_SLUG} not found in DB — run \`pnpm db:seed\` first`,
    );
    return { ok: false, reason: "tenant_not_seeded" };
  }
  const wf = await resolveLiveWorkflowVersion(tenantId);
  if (!wf) {
    log.warn?.(
      `[seed-rich] no workflow version for tenant ${TENANT_SLUG} — boot api once first so bootstrap registers the manifest`,
    );
    return { ok: false, reason: "no_workflow_version" };
  }
  const agentMap = await buildAgentNameToIdMap(wf.workflowId);
  log.info(
    `[seed-rich] tenant ${TENANT_SLUG} → ${tenantId}, ${agentMap.size / 2} agents resolved`,
  );

  const eventTypeCount = await seedEventTypes(tenantId, fixtures);
  const agentMetaCount = await seedAgentMetadata(wf.workflowId, fixtures);
  const { inserted: runsIns, skipped: runsSkip } = await seedRuns(
    tenantId,
    fixtures,
    agentMap,
  );
  const eventsIns = await seedEventStream(tenantId, fixtures, agentMap);
  const tasksIns = await seedTasks(tenantId, fixtures, agentMap);
  const deploysIns = await seedDeployments(tenantId, fixtures);
  const sampleLog = await writeSampleLog(fixtures);

  log.info(
    `[seed-rich] inserted: ${eventTypeCount} event types · ${agentMetaCount} agent metadata · ${runsIns} runs (${runsSkip} skipped) · ${eventsIns} events · ${tasksIns} tasks · ${deploysIns} deployments`,
  );
  if (sampleLog) {
    log.info(
      `[seed-rich] sample log: ${sampleLog.written ? "wrote" : "exists"} ${sampleLog.path}`,
    );
  }
  log.info("[seed-rich] done");

  return {
    ok: true,
    parsed: {
      agents: fixtures.RAAS_AGENTS?.length ?? 0,
      eventTypes: fixtures.RAAS_EVENTS?.length ?? 0,
      runs: fixtures.RAAS_RUNS?.length ?? 0,
      events: fixtures.RAAS_EVENT_STREAM?.length ?? 0,
      tasks: fixtures.RAAS_TASKS?.length ?? 0,
      deployments: fixtures.RAAS_DEPLOYMENTS?.length ?? 0,
    },
    inserted: {
      eventTypes: eventTypeCount,
      agentMetadata: agentMetaCount,
      runs: runsIns,
      runsSkipped: runsSkip,
      events: eventsIns,
      tasks: tasksIns,
      deployments: deploysIns,
    },
    sampleLog,
  };
}

// Only run when invoked as a CLI (`pnpm seed:rich`). When imported by the
// demo-mode bootstrap, the export above is used instead so the api can keep
// the process alive after seeding completes.
const isMain =
  !!process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  runSeedRich()
    .then((result) => {
      if (!result.ok) process.exit(1);
    })
    .catch((err) => {
      console.error("[seed-rich] failed", err);
      process.exit(1);
    });
}
