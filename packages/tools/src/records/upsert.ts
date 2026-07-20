/**
 * records.upsert — durable business-record persistence. The new-arch-native
 * replacement for the old AO's Neo4j / RAAS-Postgres instance write-back:
 * candidate / resume / job_posting / candidate_match_result / communication_log
 * rows in the `business_records` table (which OUTLIVE the runs that produce
 * them, unlike run-scoped artifacts).
 *
 * Bound as a `type:"tool"` step mid-pipeline. It is PASS-THROUGH: it echoes the
 * upstream step's result so inserting it never starves the next step of its
 * `ctx.lastResult` and never hijacks `_emit` routing (it is always placed
 * non-terminally). Persistence is fail-closed: invalid identity, missing tenant,
 * and DB failures abort the tool step instead of producing a false success.
 *
 * Config (manifest tool_use[].config → ctx.config):
 *   { record_type: "candidate"|"resume"|"job_posting"|"candidate_match_result"
 *                  |"candidate_identity_result"|"communication_log"  (required),
 *     key_field?: string,        // override the business-identity field
 *     candidate_field?: string,  // default "candidate_id"
 *     append?: boolean }         // communication_log: always insert a fresh row
 */

import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  defineTool,
  type ToolContext,
  type ToolWriteProbeExecutionContext,
  type ToolWriteProbeLifecycleInput,
} from "@agentic/agent-kit";
import { getDb, businessRecords, tenants, eq, and } from "@agentic/db";
import type { WriteProbeSafetyContract } from "@agentic/shared";

const recId = (): string => "rec-" + randomUUID().replace(/-/g, "").slice(0, 12);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

export const BUSINESS_RECORD_TYPES = [
  "candidate",
  "resume",
  "job_posting",
  "candidate_match_result",
  "candidate_identity_result",
  "communication_log",
] as const;
export type BusinessRecordType = (typeof BUSINESS_RECORD_TYPES)[number];

const PROBE_FIELD = "_agent_factory_probe";
const PROBE_MARKER_PREFIX = "af-records-marker-";
const PROBE_NAMESPACE_PREFIX = "af-records-namespace-";
const PROBE_TARGET_PREFIX = "af-records-target-";
const PROBE_IDEMPOTENCY_PREFIX = "af-records-idempotency-";

/** Metadata and executable lifecycle are code-owned together. Ontology/tool
 * descriptions can select records.upsert, but cannot weaken these exact
 * canary paths or install a different cleanup callback. */
export const RECORDS_UPSERT_PROBE_SAFETY = {
  testDataContract: {
    kind: "synthetic_canary",
    marker: { kind: "argument", path: `${PROBE_FIELD}.marker`, valuePrefix: PROBE_MARKER_PREFIX },
  },
  idempotency: {
    kind: "argument",
    path: `${PROBE_FIELD}.idempotency_key`,
    valuePrefix: PROBE_IDEMPOTENCY_PREFIX,
  },
  isolation: {
    namespace: { kind: "argument", path: `${PROBE_FIELD}.namespace`, valuePrefix: PROBE_NAMESPACE_PREFIX },
    target: { kind: "argument", path: `${PROBE_FIELD}.target`, valuePrefix: PROBE_TARGET_PREFIX },
  },
  cleanup: { kind: "handler", handler: "records.upsert.canary.cleanup" },
  absenceProof: { kind: "handler", handler: "records.upsert.canary.readback" },
} as const satisfies WriteProbeSafetyContract;

type ProbeEnvelope = {
  schema: "agent-factory-records-upsert-canary/v1";
  marker: string;
  namespace: string;
  target: string;
  idempotency_key: string;
  execution: ToolWriteProbeExecutionContext;
};

type RecordsProbeIdentity = {
  envelope: ProbeEnvelope;
  tenant: { id: string; slug: string; name: string };
  recordId: string;
  recordKey: string;
};

const object = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

function exactProbeExecution(value: ToolWriteProbeExecutionContext): ToolWriteProbeExecutionContext {
  if (
    value.agentName !== "agent-factory-probe"
    || value.actionName !== "records.upsert"
    || value.eventName !== "probe:records.upsert"
    || !/^probe:[a-f0-9]{12}$/.test(value.correlationId)
    || !/^af-probe-[a-f0-9]{24}$/.test(value.tenantSlug)
  ) {
    throw new Error("records.upsert: untrusted Agent Factory probe execution context");
  }
  return {
    agentName: value.agentName,
    actionName: value.actionName,
    correlationId: value.correlationId,
    tenantSlug: value.tenantSlug,
    eventName: value.eventName,
  };
}

function exactProbeEnvelope(
  args: Record<string, unknown>,
  execution: ToolWriteProbeExecutionContext,
  expected?: ToolWriteProbeLifecycleInput["canary"],
): ProbeEnvelope {
  const row = object(args[PROBE_FIELD]);
  const marker = s(row?.marker);
  const namespace = s(row?.namespace);
  const target = s(row?.target);
  const idempotencyKey = s(row?.idempotency_key);
  const suffix = marker.startsWith(PROBE_MARKER_PREFIX)
    ? marker.slice(PROBE_MARKER_PREFIX.length)
    : "";
  const idempotencySuffix = idempotencyKey.startsWith(PROBE_IDEMPOTENCY_PREFIX)
    ? idempotencyKey.slice(PROBE_IDEMPOTENCY_PREFIX.length)
    : "";
  if (
    !/^[a-f0-9]{24}$/.test(suffix)
    || namespace !== `${PROBE_NAMESPACE_PREFIX}${suffix}`
    || target !== `${PROBE_TARGET_PREFIX}${suffix}`
    || !/^[a-f0-9]{64}$/.test(idempotencySuffix)
    || !idempotencySuffix.startsWith(suffix)
  ) {
    throw new Error("records.upsert: invalid or non-isolated write-probe canary");
  }
  if (expected && (
    expected.marker !== marker
    || expected.namespace !== namespace
    || expected.target !== target
    || expected.idempotencyKey !== idempotencyKey
  )) {
    throw new Error("records.upsert: lifecycle canary does not match prepared probe arguments");
  }
  return {
    schema: "agent-factory-records-upsert-canary/v1",
    marker,
    namespace,
    target,
    idempotency_key: idempotencyKey,
    execution: exactProbeExecution(execution),
  };
}

function recordsProbeIdentity(envelope: ProbeEnvelope): RecordsProbeIdentity {
  const digest = createHash("sha256")
    .update(JSON.stringify(envelope), "utf8")
    .digest("hex");
  return {
    envelope,
    tenant: {
      id: `ten-af-records-${digest.slice(0, 20)}`,
      slug: `af-records-${digest.slice(0, 24)}`,
      name: `Agent Factory records.upsert probe ${digest.slice(0, 12)}`,
    },
    recordId: `rec-af-${digest.slice(0, 24)}`,
    recordKey: envelope.target,
  };
}

function probeIdentityFromContext(
  ctx: ToolContext,
  args: Record<string, unknown>,
): RecordsProbeIdentity | undefined {
  if (ctx.agentName !== "agent-factory-probe") return undefined;
  return recordsProbeIdentity(exactProbeEnvelope(args, {
    agentName: ctx.agentName,
    actionName: ctx.actionName,
    correlationId: ctx.correlationId,
    tenantSlug: ctx.tenantSlug,
    eventName: ctx.event?.name ?? "",
  }));
}

function assertExactProbeContract(input: ToolWriteProbeLifecycleInput): RecordsProbeIdentity {
  const contract = input.contract;
  if (
    input.toolName !== "records.upsert"
    || contract.testDataContract.marker.path !== RECORDS_UPSERT_PROBE_SAFETY.testDataContract.marker.path
    || contract.testDataContract.marker.valuePrefix !== PROBE_MARKER_PREFIX
    || contract.idempotency.kind !== "argument"
    || contract.idempotency.path !== RECORDS_UPSERT_PROBE_SAFETY.idempotency.path
    || contract.idempotency.valuePrefix !== PROBE_IDEMPOTENCY_PREFIX
    || contract.isolation.namespace.path !== RECORDS_UPSERT_PROBE_SAFETY.isolation.namespace.path
    || contract.isolation.namespace.valuePrefix !== PROBE_NAMESPACE_PREFIX
    || contract.isolation.target.path !== RECORDS_UPSERT_PROBE_SAFETY.isolation.target.path
    || contract.isolation.target.valuePrefix !== PROBE_TARGET_PREFIX
    || contract.cleanup.kind !== "handler"
    || contract.cleanup.handler !== RECORDS_UPSERT_PROBE_SAFETY.cleanup.handler
    || contract.absenceProof.kind !== "handler"
    || contract.absenceProof.handler !== RECORDS_UPSERT_PROBE_SAFETY.absenceProof.handler
  ) {
    throw new Error("records.upsert: lifecycle refused a different probe safety contract");
  }
  parseRecordType(input.config.record_type);
  return recordsProbeIdentity(
    exactProbeEnvelope(input.args, input.execution, input.canary),
  );
}

function probeData(value: unknown): ProbeEnvelope | undefined {
  const row = object(value);
  const candidate = object(row?.[PROBE_FIELD]);
  if (!candidate) return undefined;
  return candidate as unknown as ProbeEnvelope;
}

function matchesProbeRow(value: unknown, expected: ProbeEnvelope): boolean {
  const actual = probeData(value);
  return !!actual && JSON.stringify(actual) === JSON.stringify(expected);
}

function createResultRecordId(value: unknown): string | undefined {
  const root = object(value);
  const nested = object(root?.data);
  const receipt = object(nested?._record ?? root?._record);
  const id = receipt?.record_id;
  return typeof id === "string" && id ? id : undefined;
}

/** A real lifecycle for the local durable-record adapter. It creates only in
 * a cryptographically-derived synthetic tenant and refuses cleanup unless the
 * tenant/type/key plus every canary isolation field match exactly. */
export const recordsUpsertWriteProbeLifecycle = {
  identity: { id: "records.upsert/write-probe", revision: "1" },
  async cleanup(input: ToolWriteProbeLifecycleInput) {
    const probe = assertExactProbeContract(input);
    const recordType = parseRecordType(input.config.record_type);
    const receiptId = createResultRecordId(input.createResult);
    if (receiptId && receiptId !== probe.recordId) {
      throw new Error("records.upsert: create receipt does not belong to this canary");
    }
    return getDb().transaction((tx) => {
      const tenant = tx.select().from(tenants)
        .where(eq(tenants.slug, probe.tenant.slug)).all()[0];
      if (!tenant) return { completed: true, evidence: { matched: true, deleted: false, tenantRemoved: false } };
      if (
        tenant.id !== probe.tenant.id
        || tenant.name !== probe.tenant.name
      ) throw new Error("records.upsert: synthetic probe tenant identity mismatch");
      const row = tx.select().from(businessRecords).where(and(
        eq(businessRecords.tenantId, probe.tenant.id),
        eq(businessRecords.recordType, recordType),
        eq(businessRecords.recordKey, probe.recordKey),
      )).all()[0];
      if (row) {
        if (row.id !== probe.recordId || !matchesProbeRow(row.dataJson, probe.envelope)) {
          throw new Error("records.upsert: refusing cleanup because persisted canary fields do not all match");
        }
        const deleted = tx.delete(businessRecords).where(and(
          eq(businessRecords.id, probe.recordId),
          eq(businessRecords.tenantId, probe.tenant.id),
          eq(businessRecords.recordType, recordType),
          eq(businessRecords.recordKey, probe.recordKey),
        )).run() as { changes?: number };
        if ((deleted.changes ?? 0) !== 1) {
          throw new Error("records.upsert: exact canary cleanup did not delete one row");
        }
      }
      const remaining = tx.select({ id: businessRecords.id }).from(businessRecords)
        .where(eq(businessRecords.tenantId, probe.tenant.id)).all();
      if (remaining.length) {
        throw new Error("records.upsert: synthetic probe tenant contains unrelated records");
      }
      const tenantDeleted = tx.delete(tenants).where(and(
        eq(tenants.id, probe.tenant.id),
        eq(tenants.slug, probe.tenant.slug),
        eq(tenants.name, probe.tenant.name),
      )).run() as { changes?: number };
      if ((tenantDeleted.changes ?? 0) !== 1) {
        throw new Error("records.upsert: synthetic probe tenant cleanup failed");
      }
      return { completed: true, evidence: { matched: true, deleted: !!row, tenantRemoved: true } };
    });
  },
  async readback(input: ToolWriteProbeLifecycleInput) {
    const probe = assertExactProbeContract(input);
    const recordType = parseRecordType(input.config.record_type);
    const tenant = getDb().select().from(tenants)
      .where(eq(tenants.slug, probe.tenant.slug)).all()[0];
    if (!tenant) return { absent: true, evidence: { tenantAbsent: true, rowAbsent: true } };
    if (tenant.id !== probe.tenant.id || tenant.name !== probe.tenant.name) {
      return { absent: false, evidence: { tenantIdentityMismatch: true } };
    }
    const row = getDb().select().from(businessRecords).where(and(
      eq(businessRecords.tenantId, probe.tenant.id),
      eq(businessRecords.recordType, recordType),
      eq(businessRecords.recordKey, probe.recordKey),
    )).all()[0];
    if (!row) return { absent: true, evidence: { tenantAbsent: false, rowAbsent: true } };
    return {
      absent: false,
      evidence: {
        rowAbsent: false,
        exactCanaryStillPresent:
          row.id === probe.recordId && matchesProbeRow(row.dataJson, probe.envelope),
      },
    };
  },
} as const;

export function parseRecordType(value: unknown): BusinessRecordType {
  const raw = s(value).trim();
  if (!raw) {
    throw new Error(
      `records.upsert: config.record_type is required (${BUSINESS_RECORD_TYPES.join(" | ")})`,
    );
  }
  if (!(BUSINESS_RECORD_TYPES as readonly string[]).includes(raw)) {
    throw new Error(
      `records.upsert: unsupported record_type '${raw}' (expected ${BUSINESS_RECORD_TYPES.join(" | ")})`,
    );
  }
  return raw as BusinessRecordType;
}

function sources(ctx: ToolContext): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(v as Record<string, unknown>);
      const d = (v as Record<string, unknown>).data;
      if (d && typeof d === "object" && !Array.isArray(d)) out.push(d as Record<string, unknown>);
    }
  };
  push(ctx.lastResult);
  push(ctx.event?.data);
  return out;
}

function pick(srcs: Record<string, unknown>[], keys: string[]): string {
  for (const src of srcs) {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return "";
}

export function deriveRecordKey(
  recordType: BusinessRecordType,
  snapshot: Record<string, unknown>,
  candidateId: string,
  cfg: Record<string, unknown>,
): string {
  const keyField = s(cfg.key_field);
  if (keyField) {
    const configuredKey = s(snapshot[keyField]).trim();
    if (!configuredKey) {
      throw new Error(
        `records.upsert: configured key_field '${keyField}' is missing from the business payload`,
      );
    }
    return configuredKey;
  }
  const jr = s(snapshot.job_requisition_id) || s(snapshot.requisition_id);
  const email = s(snapshot.email);
  const phone = s(snapshot.phone);
  switch (recordType) {
    case "candidate": {
      const identity = candidateId || email || phone;
      if (!identity) {
        throw new Error(
          "records.upsert: candidate requires candidate_id, candidateId, email, phone, or a populated key_field",
        );
      }
      return identity;
    }
    case "resume": {
      const resumeId = s(snapshot.resume_id).trim();
      const identity = resumeId || candidateId || email;
      if (!identity) {
        throw new Error(
          "records.upsert: resume requires resume_id, candidate_id/candidateId, email, or a populated key_field",
        );
      }
      return resumeId || `res:${identity}`;
    }
    case "job_posting": {
      const identity = jr || s(snapshot.job_posting_id).trim();
      if (!identity) {
        throw new Error(
          "records.upsert: job_posting requires job_requisition_id/requisition_id/job_posting_id or a populated key_field",
        );
      }
      return identity;
    }
    case "candidate_match_result": {
      const candidateIdentity = candidateId || email;
      if (!candidateIdentity || !jr) {
        throw new Error(
          "records.upsert: candidate_match_result requires both a candidate identity and job_requisition_id/requisition_id",
        );
      }
      return `${candidateIdentity}:${jr}`;
    }
    case "candidate_identity_result": {
      const explicit = s(snapshot.candidate_identity_result_id).trim();
      if (explicit) return explicit;
      const resumeId = s(snapshot.resume_id).trim();
      if (!candidateId || !resumeId) {
        throw new Error(
          "records.upsert: candidate_identity_result requires candidate_identity_result_id or both candidate_id and resume_id",
        );
      }
      return `${candidateId}:${resumeId}`;
    }
    case "communication_log":
      return recId();
  }
}

export function canonicalizeRecordSnapshot(
  recordType: BusinessRecordType,
  snapshot: Record<string, unknown>,
  recordKey: string,
): Record<string, unknown> {
  if (
    recordType === "candidate_identity_result" &&
    !s(snapshot.candidate_identity_result_id).trim()
  ) {
    return {
      ...snapshot,
      candidate_identity_result_id: recordKey,
    };
  }
  return snapshot;
}

export const recordsUpsert = defineTool({
  name: "records.upsert",
  description:
    "Persist a durable business record (candidate / resume / job_posting / " +
    "candidate_match_result / candidate_identity_result / communication_log) from the current step's data, " +
    "tagged to the run / correlation / candidate. Pass-through (echoes the " +
    "upstream result) so it can sit mid-pipeline without breaking routing. " +
    "Config: { record_type (required), key_field?, candidate_field?, append? }. " +
    "Fails when identity/tenant/persistence is invalid; never reports a synthetic upsert.",
  output: z.record(z.string(), z.unknown()),
  factoryWriteProbeLifecycle: recordsUpsertWriteProbeLifecycle,
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const cfg = (ctx.config ?? {}) as Record<string, unknown>;
    const recordType = parseRecordType(cfg.record_type);
    const srcs = sources(ctx);

    // Business snapshot: earlier sources (lastResult) win over later (event.data).
    const snapshot: Record<string, unknown> = {};
    for (let i = srcs.length - 1; i >= 0; i--) Object.assign(snapshot, srcs[i]);
    delete snapshot._emit;
    delete snapshot._record;

    // A probe is accepted only under the exact integration-probe execution
    // context and only when all four code-owned canary values agree. Its
    // persisted payload is rebuilt from those values so caller data/PII can
    // never leak into a disposable test row.
    const probe = probeIdentityFromContext(ctx, snapshot);

    const candidateField = s(cfg.candidate_field) || "candidate_id";
    const candidateId = probe
      ? ""
      : pick(srcs, [candidateField, "candidate_id", "candidateId"]);
    const recordKey = probe
      ? probe.recordKey
      : deriveRecordKey(recordType, snapshot, candidateId, cfg);
    const canonicalSnapshot = probe
      ? { [PROBE_FIELD]: probe.envelope }
      : canonicalizeRecordSnapshot(recordType, snapshot, recordKey);
    // append mode is intentionally disabled for a canary. A retry must target
    // the same unique row; it may never manufacture additional log rows.
    const append = probe ? false : cfg.append === true;

    const db = getDb();
    if (probe) {
      const recordId = db.transaction((tx) => {
        const existingProbeTenant = tx.select().from(tenants)
          .where(eq(tenants.slug, probe.tenant.slug)).all()[0];
        if (!existingProbeTenant) {
          tx.insert(tenants).values(probe.tenant).run();
        } else if (
          existingProbeTenant.id !== probe.tenant.id
          || existingProbeTenant.name !== probe.tenant.name
        ) {
          throw new Error("records.upsert: refusing to reuse a non-matching synthetic probe tenant");
        }
        const existingProbe = tx.select().from(businessRecords).where(and(
          eq(businessRecords.tenantId, probe.tenant.id),
          eq(businessRecords.recordType, recordType),
          eq(businessRecords.recordKey, probe.recordKey),
        )).all()[0];
        const probeBase = {
          tenantId: probe.tenant.id,
          recordType,
          recordKey: probe.recordKey,
          subject: null,
          candidateId: null,
          correlationId: probe.envelope.execution.correlationId,
          runId: null,
          sourceAgent: probe.envelope.execution.agentName,
          dataJson: canonicalSnapshot,
        };
        if (existingProbe) {
          if (
            existingProbe.id !== probe.recordId
            || !matchesProbeRow(existingProbe.dataJson, probe.envelope)
          ) {
            throw new Error("records.upsert: refusing to overwrite a non-matching row during canary retry");
          }
          tx.update(businessRecords).set({ ...probeBase, updatedAt: new Date() })
            .where(and(
              eq(businessRecords.id, probe.recordId),
              eq(businessRecords.tenantId, probe.tenant.id),
              eq(businessRecords.recordType, recordType),
              eq(businessRecords.recordKey, probe.recordKey),
            )).run();
        } else {
          tx.insert(businessRecords).values({ id: probe.recordId, ...probeBase }).run();
        }
        return probe.recordId;
      });
      return {
        data: {
          [PROBE_FIELD]: probe.envelope,
          ...(recordType === "candidate_identity_result"
            ? { candidate_identity_result_id: recordKey }
            : {}),
          _record: {
            record_id: recordId,
            record_type: recordType,
            record_key: recordKey,
            upserted: true,
          },
        },
      };
    }
    let recordId = recId();
    const tRow = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, ctx.tenantSlug))
      .all()[0];
    if (!tRow) {
      throw new Error(`records.upsert: tenant '${ctx.tenantSlug}' does not exist`);
    }
    const tenantId = tRow.id;
    // business_records.data_json is a drizzle `mode:"json"` column — pass the
    // OBJECT (drizzle serializes it once). Passing JSON.stringify(snapshot)
    // here would double-encode it (a JSON string of a JSON string).
    const dataJson = canonicalSnapshot;
    const base = {
      tenantId,
      recordType,
      recordKey,
      subject: ctx.subject ?? null,
      candidateId: candidateId || null,
      correlationId: ctx.correlationId ?? null,
      runId: ctx.runId ?? null,
      sourceAgent: ctx.agentName ?? null,
      dataJson,
    };
    const existing = append
      ? undefined
      : db
          .select({ id: businessRecords.id })
          .from(businessRecords)
          .where(
            and(
              eq(businessRecords.tenantId, tenantId),
              eq(businessRecords.recordType, recordType),
              eq(businessRecords.recordKey, recordKey),
            ),
          )
          .all()[0];
    if (existing) {
      recordId = existing.id;
      db.update(businessRecords)
        .set({ ...base, updatedAt: new Date() })
        .where(eq(businessRecords.id, existing.id))
        .run();
    } else {
      db.insert(businessRecords).values({ id: recordId, ...base }).run();
    }

    // PASS-THROUGH: echo the incoming result so the next step's lastResult is
    // unchanged (dedup/route/decide read it) and selectEmittedEvent is not
    // hijacked (this step is always non-terminal).
    const passthrough =
      ctx.lastResult && typeof ctx.lastResult === "object" && !Array.isArray(ctx.lastResult)
        ? { ...(ctx.lastResult as Record<string, unknown>) }
        : {};
    return {
      data: {
        ...passthrough,
        ...(recordType === "candidate_identity_result"
          ? { candidate_identity_result_id: recordKey }
          : {}),
        _record: { record_id: recordId, record_type: recordType, record_key: recordKey, upserted: true },
      },
    };
  },
});
