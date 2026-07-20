import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDb, llmCalls, usageEvents } from "@agentic/db";

export const USAGE_EXPORT_SCHEMA = "agentic.usage.v1";
const DEFAULT_BATCH_SIZE = 500;

function exportRoot(): string {
  const explicit = process.env.AGENTIC_USAGE_EXPORT_ROOT?.trim();
  if (explicit) return path.resolve(explicit);
  const configuredDataRoot = process.env.AGENTIC_DATA_ROOT?.trim();
  if (configuredDataRoot) {
    return path.resolve(configuredDataRoot, "usage");
  }
  return path.join(
    findWorkspaceRoot(process.cwd()) ?? process.cwd(),
    "data",
    "usage",
  );
}

function findWorkspaceRoot(start: string): string | null {
  let current = path.resolve(start);
  while (true) {
    if (existsSync(path.join(current, "pnpm-workspace.yaml"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function usageExportDirectory(tenantId: string, at: Date): string {
  return path.join(exportRoot(), safeSegment(tenantId), day(at));
}

/**
 * Export pending canonical usage events for one tenant. SQLite remains the
 * source of truth; deterministic sequence-range files make crash recovery
 * idempotent. Files contain normalized counters and IDs only.
 */
export function exportPendingUsageEvents(
  tenantId: string,
  limit = DEFAULT_BATCH_SIZE,
): string[] {
  const rows = getDb()
    .select({ event: usageEvents, call: llmCalls })
    .from(usageEvents)
    .leftJoin(llmCalls, eq(llmCalls.id, usageEvents.llmCallId))
    .where(
      and(eq(usageEvents.tenantId, tenantId), isNull(usageEvents.exportedAt)),
    )
    .orderBy(asc(usageEvents.sequence))
    .limit(Math.max(1, Math.min(5_000, Math.trunc(limit))))
    .all();

  if (rows.length === 0) return [];
  const grouped = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = day(row.event.occurredAt);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }

  const written: string[] = [];
  for (const group of grouped.values()) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    const dir = usageExportDirectory(tenantId, first.event.occurredAt);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const filePath = path.join(
      dir,
      `${String(first.event.sequence).padStart(12, "0")}-${String(last.event.sequence).padStart(12, "0")}.ndjson`,
    );
    const content = `${group
      .map(exportRecord)
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`;

    if (existsSync(filePath)) {
      if (readFileSync(filePath, "utf8") !== content) {
        throw new Error(`usage export collision at ${filePath}`);
      }
    } else {
      const temporary = `${filePath}.tmp-${process.pid}`;
      writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
      const fd = openSync(temporary, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, filePath);
    }

    const exportedAt = new Date();
    getDb()
      .update(usageEvents)
      .set({ exportedAt })
      .where(
        inArray(
          usageEvents.id,
          group.map((row) => row.event.id),
        ),
      )
      .run();
    written.push(filePath);
  }
  return written;
}

function exportRecord(row: {
  event: typeof usageEvents.$inferSelect;
  call: typeof llmCalls.$inferSelect | null;
}) {
  const { event, call } = row;
  return {
    schema: USAGE_EXPORT_SCHEMA,
    event_id: event.id,
    sequence: event.sequence,
    occurred_at: event.occurredAt.toISOString(),
    recorded_at: event.recordedAt.toISOString(),
    event_type: event.eventType,
    status: event.status,
    tenant_id: event.tenantId,
    billing_account_id: event.billingAccountId,
    principal: {
      type: event.actorType,
      id: event.actorId,
      credential_id: event.credentialId,
    },
    attribution: {
      request_id: event.requestId,
      correlation_id: event.correlationId,
      interaction_id: event.interactionId,
      run_id: event.runId,
      step_id: event.stepId,
      product: event.product,
      surface: event.productSurface,
      action: event.productAction,
      function: event.functionName,
      api:
        event.apiRoute || event.httpMethod
          ? { method: event.httpMethod, route: event.apiRoute }
          : null,
      invocation_source: event.invocationSource,
    },
    llm: call
      ? {
          logical_call_id: call.logicalCallId,
          attempt_id: call.id,
          attempt: call.attempt,
          provider: call.provider,
          provider_credential_id: event.providerCredentialId,
          provider_account_id: event.providerAccountId,
          requested_model: call.requestedModel,
          response_model: call.responseModel,
          requested_route: call.requestedRoute,
          effective_route: call.effectiveRoute,
          gateway_instance_id: call.gatewayInstanceId,
          gateway_kind: call.gatewayKind,
          model_family: call.modelFamily,
          task_type: call.taskType,
          matched_task_type: call.matchedTaskType,
          routing_profile_id: call.routingProfileId,
          routing_revision: call.routingRevision,
          resolution_reason: call.resolutionReason,
          fallback_index: call.fallbackIndex,
          transport: call.transport,
          effective_timeout_ms: call.effectiveTimeoutMs,
          overall_deadline_ms: call.overallDeadlineMs,
          effective_controls: call.controlsJson,
          retry_reason: call.retryReason,
          provider_request_id: call.providerRequestId,
          latency_ms: call.latencyMs,
          finish_reason: call.finishReason,
          error_code: call.errorCode,
        }
      : null,
    usage: event.quantityJson,
    provider_cost: {
      currency: event.currency,
      total_nanos: event.providerCostUsdNanos,
      components_nanos: call
        ? {
            input: call.inputUsdNanos,
            cached_input: call.cachedInputUsdNanos,
            cache_write: call.cacheWriteUsdNanos,
            output: call.outputUsdNanos,
          }
        : null,
      source: call?.costSource ?? null,
      liability: event.costLiability,
      price_source: call?.priceSource ?? null,
      price_as_of: call?.priceAsOf ?? null,
    },
    billable_charge: {
      currency: event.currency,
      total_nanos: event.billableChargeUsdNanos,
      rate_card_version: event.rateCardVersion,
    },
  };
}
