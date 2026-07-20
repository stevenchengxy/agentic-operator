/**
 * Real client-requirement ingestion for the RAAS sync entrypoint.
 *
 * The previous `monitorAndFetchRequirement` binding pointed at `meta.ping` and
 * therefore returned `pong:true` without contacting a client system.  These
 * tools make the boundary explicit and fail closed:
 *
 * - the endpoint and credential are referenced by environment-variable name;
 * - a real HTTP GET must return the versioned receipt below;
 * - deduplication reads the tenant's durable business records;
 * - persistence commits the exact fetched rows in one SQLite transaction.
 */

import { z } from "zod";
import { randomUUID } from "node:crypto";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import {
  and,
  businessRecords,
  eq,
  getDb,
  tenants,
} from "@agentic/db";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;

const RequirementSchema = z
  .object({
    client_role_unique_id: z.string().trim().min(1).max(256),
    client_role_name: z.string().trim().min(1).max(512),
    operation: z.enum(["create", "update", "upsert", "terminate"]),
  })
  .passthrough();

const RequirementBatchSchema = z
  .array(RequirementSchema)
  .max(10_000)
  .superRefine((requirements, ctx) => {
    const seen = new Set<string>();
    requirements.forEach((requirement, index) => {
      if (seen.has(requirement.client_role_unique_id)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "client_role_unique_id"],
          message: "duplicate requirement identity in one receipt",
        });
      }
      seen.add(requirement.client_role_unique_id);
    });
  });

export const RequirementSyncReceiptSchema = z.object({
  schema_version: z.literal(1),
  ok: z.literal(true),
  request_id: z.string().trim().min(1).max(256),
  source_system: z.string().trim().min(1).max(256),
  cursor: z.string().trim().max(2048).nullable().optional(),
  requirements: RequirementBatchSchema,
});

type Requirement = z.infer<typeof RequirementSchema>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function envReference(config: Record<string, unknown>, field: string, fallback: string): string {
  const raw = typeof config[field] === "string" ? config[field].trim() : fallback;
  if (!ENV_NAME.test(raw)) {
    throw new Error(`monitorAndFetchRequirement: ${field} must name an environment variable`);
  }
  return raw;
}

function positiveTimeout(value: unknown): number {
  const parsed = Number(value ?? process.env.RAAS_EXTERNAL_TIMEOUT_MS ?? 30_000);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 300_000) : 30_000;
}

function configuredEndpoint(ctx: ToolContext): {
  endpoint: URL;
  token: string | undefined;
  timeoutMs: number;
} {
  const config = asRecord(ctx.config) ?? {};
  const urlEnv = envReference(
    config,
    "api_url_env",
    "RAAS_CLIENT_REQUIREMENTS_API_URL",
  );
  const tokenEnv = envReference(
    config,
    "token_env",
    "RAAS_CLIENT_REQUIREMENTS_API_TOKEN",
  );
  const rawUrl = process.env[urlEnv]?.trim();
  if (!rawUrl) {
    throw new Error(
      `monitorAndFetchRequirement: required endpoint environment variable ${urlEnv} is not configured`,
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    throw new Error(
      `monitorAndFetchRequirement: ${urlEnv} must contain an absolute URL`,
    );
  }
  if (!/^https?:$/.test(endpoint.protocol)) {
    throw new Error("monitorAndFetchRequirement: endpoint must use http(s)");
  }
  const authScheme = config.auth_scheme === "none" ? "none" : "bearer";
  const token = process.env[tokenEnv]?.trim();
  if (authScheme === "bearer" && !token) {
    throw new Error(
      `monitorAndFetchRequirement: bearer authentication requires ${tokenEnv}`,
    );
  }
  return {
    endpoint,
    token: authScheme === "bearer" ? token : undefined,
    timeoutMs: positiveTimeout(config.timeout_ms),
  };
}

function requestCursor(ctx: ToolContext): { cursor?: string; since?: string } {
  const event = asRecord(ctx.event?.data) ?? {};
  const cursor = typeof event.cursor === "string" ? event.cursor.trim() : "";
  const since = typeof event.since === "string" ? event.since.trim() : "";
  return {
    ...(cursor ? { cursor } : {}),
    ...(since ? { since } : {}),
  };
}

/** Exported for contract tests and external adapter authors. */
export function parseRequirementSyncReceipt(value: unknown) {
  return RequirementSyncReceiptSchema.parse(value);
}

export const monitorAndFetchRequirement = defineTool({
  name: "monitorAndFetchRequirement",
  description:
    "Fetch changed recruiting requirements from the configured client API. " +
    "Requires a real, versioned JSON receipt and never substitutes a ping, fixture, or local sample.",
  output: z.record(z.string(), z.unknown()),
  async handler(ctx) {
    const { endpoint, token, timeoutMs } = configuredEndpoint(ctx);
    for (const [key, value] of Object.entries(requestCursor(ctx))) {
      endpoint.searchParams.set(key, value);
    }
    const response = await fetch(endpoint, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_RECEIPT_BYTES) {
      throw new Error("monitorAndFetchRequirement: upstream receipt exceeds 2 MiB");
    }
    if (!response.ok) {
      throw new Error(
        `monitorAndFetchRequirement: client API returned HTTP ${response.status}`,
      );
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      throw new Error("monitorAndFetchRequirement: client API returned non-JSON data");
    }
    const parsed = RequirementSyncReceiptSchema.safeParse(decoded);
    if (!parsed.success) {
      throw new Error(
        `monitorAndFetchRequirement: ambiguous or invalid receipt (${parsed.error.issues
          .slice(0, 4)
          .map((issue) => `${issue.path.join(".") || "receipt"}: ${issue.message}`)
          .join("; ")})`,
      );
    }
    return {
      data: {
        receipt_schema_version: parsed.data.schema_version,
        upstream_request_id: parsed.data.request_id,
        source_system: parsed.data.source_system,
        next_cursor: parsed.data.cursor ?? null,
        requirements: parsed.data.requirements,
        fetched_count: parsed.data.requirements.length,
        fetched_at: new Date().toISOString(),
      },
      meta: {
        endpointHost: endpoint.host,
        requestId: parsed.data.request_id,
        fetched: parsed.data.requirements.length,
      },
    };
  },
});

function requirementsFromContext(ctx: ToolContext): Requirement[] {
  const candidates = [
    asRecord(ctx.lastResult)?.requirements,
    asRecord(ctx.results?.monitorAndFetchRequirement)?.requirements,
  ];
  const raw = candidates.find(Array.isArray);
  if (!raw) {
    throw new Error(
      `${ctx.actionName}: no validated requirements from monitorAndFetchRequirement`,
    );
  }
  return RequirementBatchSchema.parse(raw);
}

function tenantIdFor(ctx: ToolContext): string {
  const row = getDb()
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, ctx.tenantSlug))
    .all()[0];
  if (!row) throw new Error(`${ctx.actionName}: unknown tenant '${ctx.tenantSlug}'`);
  return row.id;
}

export const checkDeduplicatedRequisition = defineTool({
  name: "checkDeduplicatedRequisition",
  description:
    "Resolve fetched requirement identities against real tenant business_records; returns deterministic create/update/terminate classifications.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const requirements = requirementsFromContext(ctx);
    const tenantId = tenantIdFor(ctx);
    const db = getDb();
    const classified = requirements.map((requirement) => {
      const existing = db
        .select({ id: businessRecords.id })
        .from(businessRecords)
        .where(
          and(
            eq(businessRecords.tenantId, tenantId),
            eq(businessRecords.recordType, "job_posting"),
            eq(
              businessRecords.recordKey,
              requirement.client_role_unique_id,
            ),
          ),
        )
        .all()[0];
      if (requirement.operation === "terminate" && !existing) {
        throw new Error(
          `checkDeduplicatedRequisition: cannot terminate unknown requirement ${requirement.client_role_unique_id}`,
        );
      }
      const decision =
        requirement.operation === "terminate"
          ? "terminate"
          : existing
            ? "update"
            : "create";
      return {
        ...requirement,
        decision,
        matched_record_id: existing?.id ?? null,
      };
    });
    return {
      data: {
        ...(asRecord(ctx.lastResult) ?? {}),
        requirements: classified,
        deduplicated_count: classified.length,
      },
      meta: { checked: classified.length, tenant: ctx.tenantSlug },
    };
  },
});

export const persistRequisitionData = defineTool({
  name: "persistRequisitionData",
  description:
    "Atomically persist the exact validated client requirement batch to tenant business_records and return a database-backed receipt.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const requirements = requirementsFromContext(ctx);
    const tenantId = tenantIdFor(ctx);
    const now = new Date();
    const receipt = getDb().transaction((tx) => {
      let created = 0;
      let updated = 0;
      let terminated = 0;
      const records: Array<{
        record_id: string;
        record_key: string;
        operation: "create" | "update" | "terminate";
      }> = [];
      for (const requirement of requirements) {
        const recordKey = requirement.client_role_unique_id;
        const existing = tx
          .select({ id: businessRecords.id })
          .from(businessRecords)
          .where(
            and(
              eq(businessRecords.tenantId, tenantId),
              eq(businessRecords.recordType, "job_posting"),
              eq(businessRecords.recordKey, recordKey),
            ),
          )
          .all()[0];
        const isTermination = requirement.operation === "terminate";
        if (isTermination && !existing) {
          throw new Error(
            `persistRequisitionData: cannot terminate unknown requirement ${recordKey}`,
          );
        }
        const operation: "create" | "update" | "terminate" = isTermination
          ? "terminate"
          : existing
            ? "update"
            : "create";
        const dataJson = {
          ...requirement,
          sync_status: isTermination ? "terminated" : "active",
          synced_at: now.toISOString(),
          upstream_request_id:
            asRecord(ctx.results?.monitorAndFetchRequirement)
              ?.upstream_request_id ?? null,
        };
        let recordId = existing?.id;
        if (recordId) {
          const changed = tx
            .update(businessRecords)
            .set({
              dataJson,
              subject: ctx.subject ?? recordKey,
              correlationId: ctx.correlationId ?? null,
              runId: ctx.runId ?? null,
              sourceAgent: ctx.agentName ?? null,
              updatedAt: now,
            })
            .where(eq(businessRecords.id, recordId))
            .run() as { changes?: number };
          if ((changed.changes ?? 0) !== 1) {
            throw new Error(
              `persistRequisitionData: database did not update ${recordKey}`,
            );
          }
          if (isTermination) terminated += 1;
          else updated += 1;
        } else {
          recordId = `rec-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
          tx.insert(businessRecords)
            .values({
              id: recordId,
              tenantId,
              recordType: "job_posting",
              recordKey,
              subject: ctx.subject ?? recordKey,
              candidateId: null,
              correlationId: ctx.correlationId ?? null,
              runId: ctx.runId ?? null,
              sourceAgent: ctx.agentName ?? null,
              dataJson,
              createdAt: now,
              updatedAt: now,
            })
            .run();
          created += 1;
        }
        records.push({ record_id: recordId, record_key: recordKey, operation });
      }
      return { created, updated, terminated, records };
    });

    return {
      data: {
        persisted: true,
        persisted_count: receipt.records.length,
        created_count: receipt.created,
        updated_count: receipt.updated,
        terminated_count: receipt.terminated,
        records: receipt.records,
        _emit: "REQUIREMENT_SYNCED",
      },
      meta: { transaction: true, persisted: receipt.records.length },
    };
  },
});
