/**
 * Compatibility boundary for the legacy RAAS-v1 event contract.
 *
 * The old RAAS publisher sends an Inngest-shaped body:
 *
 *   { name: "RESUME_DOWNLOADED", data: {
 *       entity_type, entity_id, event_id, payload: { ... }, trace
 *   } }
 *
 * The new runtime consumes flat business data under `payload` and namespaces
 * event names by tenant.  This module performs that translation only for the
 * `zhaopin` tenant. Other tenants keep the generic `/v1/events` contract.
 */

import { createHash } from "node:crypto";

export const RAAS_TENANT_SLUG = "zhaopin";

type JsonRecord = Record<string, unknown>;

export class RaasIngressError extends Error {
  statusCode: number;
  code: string;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = "RaasIngressError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface NormalizedEventIngest {
  /** Body accepted by `IngestEventBody`. */
  body: unknown;
  /** True when the active tenant is the RAAS-backed recruitment tenant. */
  raasTenant: boolean;
  /** Stable tenant-scoped fallback when RAAS omitted Idempotency-Key. */
  idempotencyKey: string | null;
  /** Whether the old `data`/canonical-envelope shape was observed. */
  legacyShape: boolean;
}

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function isCanonicalEnvelope(value: JsonRecord): boolean {
  if (!record(value.payload)) return false;
  return (
    "entity_id" in value ||
    "entity_type" in value ||
    "event_id" in value ||
    "trace" in value
  );
}

function canonicalEventName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed.includes("/")) return trimmed;

  const slash = trimmed.indexOf("/");
  const namespace = trimmed.slice(0, slash);
  const bare = trimmed.slice(slash + 1);
  if (namespace !== RAAS_TENANT_SLUG) {
    throw new RaasIngressError(
      "raas_tenant_mismatch",
      `RAAS events must use the '${RAAS_TENANT_SLUG}' namespace; received '${namespace}'.`,
      403,
    );
  }
  if (!bare || bare.includes("/")) {
    throw new RaasIngressError(
      "invalid_raas_event_name",
      "RAAS event name must contain exactly one optional tenant prefix.",
    );
  }
  return bare;
}

const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["objectKey", "object_key"],
  ["uploadId", "upload_id"],
  ["hrFolder", "hr_folder"],
  ["employeeId", "employee_id"],
  ["jobRequisitionId", "job_requisition_id"],
  ["jobRequisitionIds", "job_requisition_ids"],
  ["sourceEventName", "source_event_name"],
  ["receivedAt", "received_at"],
  ["resumeFilePath", "resume_file_path"],
  ["claimerEmployeeId", "claimer_employee_id"],
  ["hsmEmployeeId", "hsm_employee_id"],
  ["clientId", "client_id"],
];

const REQUISITION_ENTITY_EVENTS = new Set([
  "REQUIREMENT_LOGGED",
  "CLARIFICATION_READY",
]);

function isJobRequisitionEntityType(value: unknown): boolean {
  return (
    nonEmptyString(value)
      ?.replace(/[^a-z]/gi, "")
      .toLowerCase() === "jobrequisition"
  );
}

function withRaasAliases(input: JsonRecord): JsonRecord {
  const out = { ...input };
  for (const [camel, snake] of ALIASES) {
    if (out[snake] === undefined && out[camel] !== undefined) {
      out[snake] = out[camel];
    }
    // Keep both spellings for old tools/diagnostics while making snake_case
    // authoritative for the migrated recruitment agents.
    if (out[camel] === undefined && out[snake] !== undefined) {
      out[camel] = out[snake];
    }
  }

  // The generated processResume contract names the uploader `recruiter_id`;
  // legacy RAAS calls it employee_id. Preserve both without overwriting an
  // explicitly supplied recruiter_id.
  if (out.recruiter_id === undefined && out.employee_id !== undefined) {
    out.recruiter_id = out.employee_id;
  }
  return out;
}

export function validateRaasBucket(bucket: string): void {
  if (
    Buffer.byteLength(bucket, "utf8") < 3 ||
    Buffer.byteLength(bucket, "utf8") > 63 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9]$/.test(bucket) ||
    bucket.includes("..")
  ) {
    throw new RaasIngressError(
      "invalid_raas_bucket",
      "RESUME_DOWNLOADED bucket is not a safe S3/MinIO bucket name.",
    );
  }
}

export function validateRaasObjectKey(objectKey: string): void {
  if (
    !objectKey ||
    Buffer.byteLength(objectKey, "utf8") > 1024 ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(objectKey)
  ) {
    throw new RaasIngressError(
      "invalid_raas_object_key",
      "RESUME_DOWNLOADED object_key is empty, oversized, absolute, or contains unsafe characters.",
    );
  }

  // RAAS documents object_key as already URL-decoded. Reject encoded traversal
  // as well so an intermediary cannot turn a harmless-looking key into ../.
  let decoded = objectKey;
  try {
    decoded = decodeURIComponent(objectKey);
  } catch {
    throw new RaasIngressError(
      "invalid_raas_object_key",
      "RESUME_DOWNLOADED object_key contains malformed percent encoding.",
    );
  }
  for (const candidate of [objectKey, decoded]) {
    const parts = candidate.split("/");
    if (parts.some((part) => part === "" || part === "." || part === "..")) {
      throw new RaasIngressError(
        "invalid_raas_object_key",
        "RESUME_DOWNLOADED object_key contains an empty or traversal path segment.",
      );
    }
  }
}

function validateResumeDownloaded(
  eventName: string,
  payload: JsonRecord,
  canonicalEnvelope: boolean,
): void {
  if (eventName !== "RESUME_DOWNLOADED") return;

  const uploadId = nonEmptyString(payload.upload_id);
  const bucket = nonEmptyString(payload.bucket);
  const objectKey = nonEmptyString(payload.object_key);
  const hasRemoteTransport =
    canonicalEnvelope || bucket !== null || objectKey !== null;

  // Keep the new local-inbox contract working (`resume_file_path` only), but
  // apply the exact old RAAS requirements whenever its remote transport shape
  // is present. Partial remote coordinates are never guessed.
  if (hasRemoteTransport && (!uploadId || !bucket || !objectKey)) {
    throw new RaasIngressError(
      "invalid_raas_resume_transport",
      "Legacy RESUME_DOWNLOADED requires non-empty upload_id, bucket, and object_key.",
    );
  }
  if (bucket) validateRaasBucket(bucket);
  if (objectKey) validateRaasObjectKey(objectKey);
}

function idempotencyKey(
  eventName: string,
  externalEventId: string | null,
  payload: JsonRecord,
): string | null {
  const candidates: Array<[string, string | null]> = [
    ["event", externalEventId],
    ["etag", nonEmptyString(payload.etag)?.replace(/^\"|\"$/g, "") ?? null],
    ["upload", nonEmptyString(payload.upload_id)],
  ];
  const hit = candidates.find(([, value]) => Boolean(value));
  if (!hit?.[1]) return null;
  const raw = `raas:${eventName}:${hit[0]}:${hit[1]}`;
  if (raw.length <= 255) return raw;
  return `raas:${eventName}:sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

/**
 * Normalize `/v1/events` input. This is intentionally pure: resume bytes are
 * fetched only after idempotency lookup in `raas-resume-fetch.ts`.
 */
export function normalizeEventIngestBody(
  input: unknown,
  tenantSlug: string,
): NormalizedEventIngest {
  if (tenantSlug !== RAAS_TENANT_SLUG) {
    return {
      body: input,
      raasTenant: false,
      idempotencyKey: null,
      legacyShape: false,
    };
  }

  const root = record(input);
  if (!root) {
    throw new RaasIngressError(
      "invalid_raas_event",
      "RAAS event body must be a JSON object.",
    );
  }
  const rawName = nonEmptyString(root.name);
  if (!rawName) {
    throw new RaasIngressError(
      "invalid_raas_event",
      "RAAS event body requires a non-empty name.",
    );
  }
  const name = canonicalEventName(rawName);

  const data = record(root.data);
  const rootEnvelope = isCanonicalEnvelope(root) ? root : null;
  const dataEnvelope = data && isCanonicalEnvelope(data) ? data : null;
  if (rootEnvelope && dataEnvelope) {
    throw new RaasIngressError(
      "ambiguous_raas_event",
      "RAAS event contains canonical envelopes at both the root and data layers.",
    );
  }
  if (
    !rootEnvelope &&
    !dataEnvelope &&
    root.payload !== undefined &&
    root.data !== undefined
  ) {
    throw new RaasIngressError(
      "ambiguous_raas_event",
      "RAAS event must use either payload or legacy data, not both.",
    );
  }

  const envelope = dataEnvelope ?? rootEnvelope;
  const rawPayload = envelope
    ? record(envelope.payload)
    : (record(root.payload) ?? data ?? {});
  if (!rawPayload) {
    throw new RaasIngressError(
      "invalid_raas_payload",
      "RAAS event payload/data must be a JSON object.",
    );
  }
  const payload = withRaasAliases(rawPayload);
  const envelopeEntityId = envelope ? nonEmptyString(envelope.entity_id) : null;
  if (envelopeEntityId && REQUISITION_ENTITY_EVENTS.has(name)) {
    if (payload.job_requisition_id === undefined) {
      payload.job_requisition_id = envelopeEntityId;
    }
    if (payload.requirement_id === undefined) {
      payload.requirement_id = envelopeEntityId;
    }
  } else if (envelopeEntityId && name === "JD_REJECTED") {
    const explicitRequisitionId =
      nonEmptyString(payload.job_requisition_id) ??
      nonEmptyString(payload.requirement_id);
    const requisitionId =
      explicitRequisitionId ??
      (isJobRequisitionEntityType(envelope?.entity_type)
        ? envelopeEntityId
        : null);
    if (requisitionId) {
      if (payload.job_requisition_id === undefined)
        payload.job_requisition_id = requisitionId;
      if (payload.requirement_id === undefined)
        payload.requirement_id = requisitionId;
    } else if (payload.job_posting_id === undefined) {
      // HSM review events are anchored on JobPosting. The createJD loader
      // resolves this id back to its authoritative JobRequisition in PG.
      payload.job_posting_id = envelopeEntityId;
    }
  }
  const trace = envelope ? record(envelope.trace) : null;
  const traceId =
    nonEmptyString(trace?.trace_id) ?? nonEmptyString(trace?.request_id);
  if (traceId && payload.__correlationId === undefined) {
    payload.__correlationId = traceId;
  }
  validateResumeDownloaded(name, payload, Boolean(envelope));

  const externalEventId = envelope ? nonEmptyString(envelope.event_id) : null;
  const legacyShape = Boolean(envelope || root.data !== undefined);
  if (legacyShape) {
    const existingMeta = record(payload.__raas) ?? {};
    payload.__raas = {
      ...existingMeta,
      protocol: "raas-v1",
      external_event_id: externalEventId,
      entity_type: envelope ? nonEmptyString(envelope.entity_type) : null,
      entity_id: envelope ? nonEmptyString(envelope.entity_id) : null,
      source_action: envelope ? nonEmptyString(envelope.source_action) : null,
      trace,
    };
  }

  const rootSubject = nonEmptyString(root.subject);
  const entitySubject = envelopeEntityId;
  const subject =
    rootSubject ??
    entitySubject ??
    nonEmptyString(payload.upload_id) ??
    undefined;
  const source =
    root.source === "operator" ||
    root.source === "system" ||
    root.source === "external"
      ? root.source
      : "external";

  return {
    body: {
      name,
      ...(subject ? { subject } : {}),
      payload,
      ...(typeof root.test === "boolean" ? { test: root.test } : {}),
      source,
    },
    raasTenant: true,
    idempotencyKey: idempotencyKey(name, externalEventId, payload),
    legacyShape,
  };
}
