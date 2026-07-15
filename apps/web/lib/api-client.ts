/**
 * Typed API client. Server components import this; the api lives at
 * AGENTIC_API_URL (env). Browser-side calls hit the same paths through
 * Next.js rewrites (next.config.ts).
 *
 * Every method runs the response data through its @agentic/contracts Zod
 * schema — which uses z.coerce.date() so ISO strings auto-coerce back to
 * Date objects. A server-component crash here means the api shape drifted.
 */

import { z } from "zod";
import {
  RunRow,
  StepRow,
  EventRow,
  TaskRow,
  DeploymentRow,
  ListAgentRow,
  AgentDetail,
  TenantCounts,
  DagAgent,
  DagEdge,
  type ListRunsQuery,
  type ListEventsQuery,
} from "@agentic/contracts";

const API_URL = process.env.AGENTIC_API_URL ?? "http://localhost:3501";
const API_TOKEN = process.env.AGENTIC_API_TOKEN ?? "";

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string; hint?: string };
}
type ApiResp<T> = ApiOk<T> | ApiErr;

async function call<S extends z.ZodTypeAny>(
  schema: S,
  path: string,
  init: RequestInit & {
    query?: Record<string, string | number | undefined>;
  } = {},
): Promise<z.infer<S>> {
  const url = new URL(path, API_URL);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (API_TOKEN) headers["Authorization"] = `Bearer ${API_TOKEN}`;

  const r = await fetch(url, { ...init, headers, cache: "no-store" });
  const body = (await r.json()) as ApiResp<unknown>;
  if (!body.ok) {
    throw new Error(`api ${path}: ${body.error.code} — ${body.error.message}`);
  }
  return schema.parse(body.data);
}

// ─── Runs ────────────────────────────────────────────────────────────────

const GetRunPayload = z.object({ run: RunRow, steps: z.array(StepRow) });
const ReplayRunPayload = z.union([
  z.object({
    replayed_run: z.string(),
    new_event_id: z.string(),
  }),
  z.object({
    runId: z.string(),
    sessionId: z.string(),
    status: z.literal("queued"),
    definitionHash: z.string(),
    traceUrl: z.string(),
    outputUrl: z.string(),
  }),
]);
const CancelRunPayload = z.object({
  runId: z.string(),
  status: z.string(),
  cancelled: z.boolean(),
  note: z.string(),
});

export const runs = {
  list: (
    opts: z.input<typeof import("@agentic/contracts").ListRunsQuery> = {},
  ) => call(z.array(RunRow), "/v1/runs", { query: opts as never }),
  get: (id: string) =>
    call(GetRunPayload, `/v1/runs/${encodeURIComponent(id)}`),
  replay: (id: string) =>
    call(ReplayRunPayload, `/v1/runs/${encodeURIComponent(id)}/replay`, {
      method: "POST",
    }),
  cancel: (id: string) =>
    call(CancelRunPayload, `/v1/runs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
};

// ─── Events ──────────────────────────────────────────────────────────────

const IngestPayload = z.object({ event_id: z.string(), name: z.string() });
const ReplayEventPayload = z.object({
  replayed: z.string(),
  new_event_id: z.string(),
});

export const events = {
  list: (
    opts: z.input<typeof import("@agentic/contracts").ListEventsQuery> = {},
  ) => call(z.array(EventRow), "/v1/events", { query: opts as never }),
  ingest: (body: {
    name: string;
    subject?: string;
    payload?: Record<string, unknown>;
  }) =>
    call(IngestPayload, "/v1/events", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  replay: (id: string) =>
    call(ReplayEventPayload, `/v1/events/${encodeURIComponent(id)}/replay`, {
      method: "POST",
    }),
};

// ─── Tasks ───────────────────────────────────────────────────────────────

const ResolvePayload = z.object({
  task_id: z.string(),
  decision: z.enum(["approve", "reject"]),
});

export const tasks = {
  list: () => call(z.array(TaskRow), "/v1/tasks"),
  get: (id: string) => call(TaskRow, `/v1/tasks/${encodeURIComponent(id)}`),
  resolve: (
    id: string,
    body: { decision: "approve" | "reject"; payload?: unknown },
  ) =>
    call(ResolvePayload, `/v1/tasks/${encodeURIComponent(id)}/resolve`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

// ─── Agents ──────────────────────────────────────────────────────────────

const AgentDetailWithRuns = AgentDetail.extend({
  recentRuns: z.array(
    z.object({
      id: z.string(),
      status: z.string(),
      subject: z.string().nullable(),
      startedAt: z.coerce.date().nullable(),
      durationMs: z.number().nullable(),
    }),
  ),
});

const ManifestUploadPayload = z.object({
  workflow_version_id: z.string(),
  version: z.string(),
  diff: z.object({
    added: z.array(z.string()),
    modified: z.array(z.string()),
    removed: z.array(z.string()),
    prior_version: z.string().nullable(),
  }),
  note: z.string(),
});

export const agents = {
  list: () => call(z.array(ListAgentRow), "/v1/agents"),
  get: (kebab: string) =>
    call(AgentDetailWithRuns, `/v1/agents/${encodeURIComponent(kebab)}`),
  uploadManifest: (body: {
    manifest: unknown[];
    actions?: unknown[];
    note?: string;
    workflowSlug?: string;
  }) =>
    call(ManifestUploadPayload, "/v1/agents", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

// ─── Deployments ─────────────────────────────────────────────────────────

const DeploymentsListPayload = z.object({
  list: z.array(DeploymentRow),
  live: DeploymentRow.nullable(),
});
const RollbackPayload = z.object({
  deployment_id: z.string(),
  status: z.literal("live"),
  note: z.string(),
});

export const deployments = {
  list: () => call(DeploymentsListPayload, "/v1/deployments"),
  rollback: (id: string) =>
    call(
      RollbackPayload,
      `/v1/deployments/${encodeURIComponent(id)}/rollback`,
      { method: "POST" },
    ),
};

// ─── Workflows / counts ──────────────────────────────────────────────────

const DagPayload = z.object({
  agents: z.array(DagAgent),
  edges: z.array(DagEdge),
  workflowVersion: z.string(),
});

export const workflows = {
  dag: () => call(DagPayload, "/v1/workflows/dag"),
};

export const counts = () => call(TenantCounts, "/v1/counts");

// ─── Ontology (event_types + entity_types catalogs) ──────────────────────

const EventTypeRow = z.object({
  name: z.string(),
  category: z.string().nullable(),
  color: z.string().nullable(),
  description: z.string().nullable(),
});
export type EventTypeRow = z.infer<typeof EventTypeRow>;

const EntityTypeRow = z.object({
  entityId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  primaryKeyName: z.string().nullable(),
});
export type EntityTypeRow = z.infer<typeof EntityTypeRow>;

export const ontology = {
  eventTypes: () => call(z.array(EventTypeRow), "/v1/event-types"),
  entityTypes: () => call(z.array(EntityTypeRow), "/v1/entity-types"),
};

// ─── Manifest import wizard ──────────────────────────────────────────────
// TODO: swap to @agentic/contracts ManifestImport* once exported. The shapes
// below are defined inline because backend Zod is still in flight; the SPA
// uses raw fetch() and these helpers exist purely so any future
// Next-side caller has a typed entrypoint (matches the file-map promise in
// docs/impl/import-workflow-manifest.md).

const ManifestIssue = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(["error", "warning", "info"]),
  code: z.string(),
});

const ManifestConflictResolution = z.object({
  path: z.string(),
  action: z.enum(["accept_suggestion", "skip", "override"]),
  override_value: z.unknown().optional(),
});

const ManifestConflict = z.object({
  path: z.string(),
  type: z.string(),
  severity: z.enum(["block", "warn"]),
  detail: z.string(),
  suggestion: z.string().optional(),
  auto_fix: ManifestConflictResolution.optional(),
});

const ManifestImportDiff = z.object({
  added: z.array(z.string()).default([]),
  removed: z.array(z.string()).default([]),
  modified: z.array(z.string()).default([]),
  prior_version: z.string().nullable().optional(),
});

const ManifestImportPreview = z.object({
  ok: z.boolean(),
  schema_version: z.number(),
  parsed: z.object({
    agents: z.number(),
    events: z.number(),
    actions: z.number(),
  }),
  issues: z.array(ManifestIssue).default([]),
  conflicts: z.array(ManifestConflict).default([]),
  diff: ManifestImportDiff,
  prior: z
    .object({
      version: z.string().nullable(),
      version_label: z.string().nullable(),
      deployed_at: z.number().nullable(),
      agents: z.number(),
      live_deployment_id: z.string().nullable(),
    })
    .optional(),
  deployment_id: z.string(),
  elapsed_ms: z.number(),
});

const ManifestImportCommit = z.object({
  ok: z.literal(true),
  workflow_version_id: z.string(),
  version: z.string(),
  deployment_id: z.string(),
  target: z.enum(["staging", "production"]),
  inngest_fns_registered: z.number(),
  file_written: z.string(),
  prior_deployment_id: z.string().nullable(),
  note: z.string(),
  elapsed_ms: z.number(),
});

const ManifestFetchUrlPayload = z.object({
  workflow: z.unknown(),
  actions: z.array(z.unknown()).optional(),
});

const ManifestImportResponse = z.union([
  ManifestImportPreview,
  ManifestImportCommit,
]);

type ManifestImportBody =
  | {
      mode: "validate";
      workflow: unknown;
      actions?: unknown[];
    }
  | {
      mode: "commit";
      workflow: unknown;
      actions?: unknown[];
      target: "production";
      deployment_id: string;
      conflict_resolutions: z.infer<typeof ManifestConflictResolution>[];
      confirm_overwrite: boolean;
      note?: string;
    };

export const manifest = {
  import: (slug: string, body: ManifestImportBody) =>
    call(
      ManifestImportResponse,
      `/v1/tenants/${encodeURIComponent(slug)}/manifest-import`,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    ),
  fetchUrl: (slug: string, url: string) =>
    call(
      ManifestFetchUrlPayload,
      `/v1/tenants/${encodeURIComponent(slug)}/manifest-import/fetch-url`,
      { method: "POST", body: JSON.stringify({ url }) },
    ),
};
