/** Tenant-owned compatibility codec for the pre-namespaced RAAS contract. */

export interface LegacyRaasMeta {
  entity_type?: unknown;
  entity_id?: unknown;
  event_id?: unknown;
  source_action?: unknown;
  trace?: unknown;
}

export interface LegacyRaasUnwrapOptions {
  /** Bare or tenant-qualified event name used for event-aware field recovery. */
  eventName?: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function bareEventName(value: string | null | undefined): string {
  const name = value?.trim() ?? "";
  const slash = name.lastIndexOf("/");
  return slash >= 0 ? name.slice(slash + 1) : name;
}

const REQUISITION_ENTITY_EVENTS = new Set([
  "REQUIREMENT_LOGGED",
  "CLARIFICATION_READY",
]);

function isJobRequisitionEntityType(value: unknown): boolean {
  return (
    firstString(value)
      ?.replace(/[^a-z]/gi, "")
      .toLowerCase() === "jobrequisition"
  );
}

/**
 * Convert the old RAAS event.data envelope into the flat shape expected by
 * tenant tools. The old transport metadata remains available under `__raas`.
 * Non-envelope input is returned unchanged.
 *
 * The old JD producer treated envelope.entity_id as the authoritative
 * Job_Requisition id; valid events therefore do not always repeat it inside
 * payload. Recover that field only for the three JD entry events so an entity
 * id from an unrelated event can never be reinterpreted as a requisition.
 */
export function unwrapLegacyRaasEventData(
  input: Record<string, unknown>,
  options: LegacyRaasUnwrapOptions = {},
): Record<string, unknown> {
  const payload = record(input.payload);
  const looksLikeEnvelope =
    payload !== null &&
    ("event_id" in input ||
      "entity_type" in input ||
      "entity_id" in input ||
      "trace" in input);
  if (!looksLikeEnvelope || !payload) return input;

  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (
      key === "payload" ||
      key === "entity_type" ||
      key === "entity_id" ||
      key === "event_id" ||
      key === "source_action" ||
      key === "trace"
    ) {
      continue;
    }
    flat[key] = value;
  }
  Object.assign(flat, payload);

  const eventName = bareEventName(options.eventName);
  if (REQUISITION_ENTITY_EVENTS.has(eventName)) {
    const requisitionId = firstString(
      flat.job_requisition_id,
      flat.requirement_id,
      input.entity_id,
    );
    if (requisitionId) {
      if (flat.job_requisition_id === undefined) {
        flat.job_requisition_id = requisitionId;
      }
      if (flat.requirement_id === undefined) {
        flat.requirement_id = requisitionId;
      }
    }
  } else if (eventName === "JD_REJECTED") {
    const explicitRequisitionId = firstString(
      flat.job_requisition_id,
      flat.requirement_id,
    );
    const requisitionId =
      explicitRequisitionId ??
      (isJobRequisitionEntityType(input.entity_type)
        ? firstString(input.entity_id)
        : undefined);
    if (requisitionId) {
      if (flat.job_requisition_id === undefined)
        flat.job_requisition_id = requisitionId;
      if (flat.requirement_id === undefined)
        flat.requirement_id = requisitionId;
    } else {
      const postingId = firstString(flat.job_posting_id, input.entity_id);
      if (postingId && flat.job_posting_id === undefined) {
        flat.job_posting_id = postingId;
      }
    }
  }

  const trace = record(input.trace);
  const traceId = firstString(trace?.trace_id, trace?.request_id);
  if (traceId && flat.__correlationId === undefined) {
    flat.__correlationId = traceId;
  }

  const subject = firstString(
    flat.subject,
    input.entity_id,
    payload.candidate_id,
    payload.job_requisition_id,
    payload.upload_id,
    payload.resume_id,
  );
  if (subject) flat.subject = subject;

  flat.__raas = {
    entity_type: input.entity_type ?? null,
    entity_id: input.entity_id ?? null,
    event_id: input.event_id ?? null,
    source_action: input.source_action ?? null,
    trace: input.trace ?? null,
  } satisfies LegacyRaasMeta;
  return flat;
}

export interface LegacyRaasWireInput {
  eventId: string;
  eventName: string;
  payload: Record<string, unknown>;
  subject?: string | null;
  correlationId?: string | null;
  sourceAgent?: string | null;
  /** Replay-stable ISO timestamp, normally derived from the finalized run. */
  emittedAt?: string | null;
}

export interface LegacyRaasProjection {
  /** AO's flat view, including compatibility aliases needed by downstream agents. */
  flatPayload: Record<string, unknown>;
  /** Strictly selected RAAS payload; never contains AO wrappers or BlobRefs. */
  wirePayload: Record<string, unknown>;
  entityType: string;
  entityId: string | null;
  sourceAction: string | null;
}

const COMMON_ANCHORS = [
  "candidate_id",
  "resume_id",
  "job_requisition_id",
  "job_requisition_ids",
  "client_id",
  "upload_id",
  "employee_id",
  "job_posting_id",
  "candidate_match_result_id",
  "application_id",
  "correlation_id",
  "recruiter_id",
  "sourcing_channel_id",
] as const;

const EVENT_PAYLOAD_FIELDS: Record<string, readonly string[]> = {
  JD_GENERATED: [
    "job_posting_id",
    "job_requisition_id",
    "client_id",
    "jd_content",
  ],
  RESUME_PROCESSED: [
    "upload_id",
    "employee_id",
    "candidate_id",
    "resume_id",
    "job_requisition_id",
    "job_requisition_ids",
    "sourcing_channel_id",
    "client_id",
    "filename",
    "parsedAt",
    "parserVersion",
    "candidate",
    "candidate_expectation",
    "runtime",
  ],
  RESUME_LOCKED_CONFLICT: [
    ...COMMON_ANCHORS,
    "lock_conflict",
    "locked_by",
    "locked_by_employee_id",
    "locked_by_name",
    "reason",
    "error",
  ],
  CANDIDATE_IDENTITY_CHECKED: [
    "upload_id",
    "candidate_id",
    "resume_id",
    "same_person",
    "same_as_candidate_id",
    "dedup_action",
    "matched_rule",
    "matched_tier",
    "needs_review",
    "decision_reason",
    "audit_id",
  ],
  MATCH_RULE_CHECK_PASSED: [
    "candidate_id",
    "resume_id",
    "job_requisition_id",
    "client_id",
    "rule_check_result",
    "rule_check_reason",
    "upload_id",
    "employee_id",
    "audit",
    "rule_check_rules",
    "job_requisition",
    "parsed_resume",
    "parsed_content",
    "runtime_context",
    // Candidate's own expectations (Candidate_Expectation): populated at the
    // RESUME_PROCESSED assembler; matchResume needs it to build the RoboHire
    // `candidatePreferences` input, so it must survive this hop's projection.
    "candidate_expectation",
  ],
  MATCH_RULE_CHECK_FAILED: [
    "candidate_id",
    "resume_id",
    "job_requisition_id",
    "client_id",
    "rule_check_result",
    "rule_check_reason",
    "failed_rules",
    "matching_score",
    "upload_id",
    "success",
    "data",
  ],
  MATCH_PASSED_NEED_INTERVIEW: [
    "job_requisition_id",
    "candidate_id",
    "matching_score",
    "upload_id",
    "job_posting_id",
    "candidate_match_result_id",
    "overall_status",
    "success",
    "data",
    "requestId",
    "savedAs",
    "error",
  ],
  MATCH_PASSED_NO_INTERVIEW: [
    "job_requisition_id",
    "candidate_id",
    "matching_score",
    "upload_id",
    "job_posting_id",
    "candidate_match_result_id",
    "overall_status",
    "success",
    "data",
    "requestId",
    "savedAs",
    "error",
  ],
  MATCH_FAILED: [
    "job_requisition_id",
    "candidate_id",
    "matching_score",
    "upload_id",
    "job_posting_id",
    "candidate_match_result_id",
    "overall_status",
    "success",
    "data",
    "requestId",
    "savedAs",
    "error",
  ],
  INTERVIEW_INVITATION_SENT: [
    "candidate_id",
    "job_requisition_id",
    "application_id",
    "candidate_match_result_id",
    "correlation_id",
    "interview_record_id",
    "communication_log_id",
    "login_url",
    "qrcode_url",
    "user_id",
    "request_introduction_id",
    "gohire_job_id",
    "candidate_email",
    "interview_language",
    "interview_duration_minutes",
    "robohire_request_id",
    "sent_at",
  ],
  INTERVIEW_INVITATION_FAILED: [
    "candidate_id",
    "job_requisition_id",
    "application_id",
    "candidate_match_result_id",
    "correlation_id",
    "error_code",
    "error_message",
    "http_status",
    "robohire_request_id",
    "failed_at",
  ],
};

const INTERNAL_NESTED_KEYS = new Set([
  "last_result",
  "_meta",
  "__raas",
  "__correlationId",
  "__triggerEventId",
  "content_base64",
  "file_base64",
  "pdf_base64",
  "raw_base64",
]);

function sanitizeWireValue(
  value: unknown,
  seen: WeakSet<object> = new WeakSet(),
): unknown | undefined {
  if (
    value === null ||
    ["string", "number", "boolean"].includes(typeof value)
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const output: unknown[] = [];
    for (const item of value) {
      const safe = sanitizeWireValue(item, seen);
      if (safe !== undefined) output.push(safe);
    }
    return output;
  }
  const obj = record(value);
  if (!obj) return undefined;
  if (obj.__ref === "blob") return undefined;
  if (seen.has(obj)) return undefined;
  seen.add(obj);
  const output: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(obj)) {
    if (key.startsWith("__") || INTERNAL_NESTED_KEYS.has(key)) continue;
    const safe = sanitizeWireValue(nested, seen);
    if (safe !== undefined) output[key] = safe;
  }
  seen.delete(obj);
  return output;
}

function pickWirePayload(
  eventName: string,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fields = EVENT_PAYLOAD_FIELDS[eventName];
  if (!fields) {
    throw new Error(
      `legacy RAAS outbound projection is not declared for event ${eventName}`,
    );
  }
  const output: Record<string, unknown> = {};
  for (const key of fields) {
    if (payload[key] === undefined) continue;
    const safe = sanitizeWireValue(payload[key]);
    if (safe !== undefined) output[key] = safe;
  }
  return output;
}

function nestedSources(
  payload: Record<string, unknown>,
): Record<string, unknown>[] {
  const sources = [payload];
  for (const candidate of [payload.last_result, payload.data]) {
    const value = record(candidate);
    if (value) {
      sources.push(value);
      const nested = record(value.data);
      if (nested) sources.push(nested);
    }
  }
  return sources;
}

function findString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const source of nestedSources(payload)) {
    const found = firstString(...keys.map((key) => source[key]));
    if (found) return found;
  }
  return undefined;
}

function findNumber(
  payload: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const source of nestedSources(payload)) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim()) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return undefined;
}

function setStringAlias(
  payload: Record<string, unknown>,
  target: string,
  ...aliases: string[]
): void {
  if (payload[target] !== undefined) return;
  const value = findString(payload, ...aliases);
  if (value !== undefined) payload[target] = value;
}

function normalizeCommonAliases(payload: Record<string, unknown>): void {
  setStringAlias(payload, "candidate_id", "candidateId");
  setStringAlias(payload, "resume_id", "resumeId");
  setStringAlias(
    payload,
    "job_requisition_id",
    "jobRequisitionId",
    "requisition_id",
    "requirement_id",
  );
  setStringAlias(payload, "client_id", "clientId");
  setStringAlias(payload, "upload_id", "uploadId");
  setStringAlias(payload, "employee_id", "employeeId");
  setStringAlias(payload, "job_posting_id", "jobPostingId");
  setStringAlias(
    payload,
    "candidate_match_result_id",
    "candidateMatchResultId",
  );
  setStringAlias(payload, "application_id", "applicationId");
  setStringAlias(payload, "correlation_id", "correlationId");
  setStringAlias(payload, "interview_record_id", "interviewRecordId");
  setStringAlias(payload, "communication_log_id", "communicationLogId");
  setStringAlias(
    payload,
    "robohire_request_id",
    "robohireRequestId",
    "requestId",
    "request_id",
  );
}

const INVITATION_ERROR_CODES = new Set([
  "MISSING_PAYLOAD",
  "BACKFILL_FAILED",
  "ROBOHIRE_4XX",
  "ROBOHIRE_QUOTA",
  "ROBOHIRE_5XX",
  "GOHIRE_REJECTED",
  "PERSISTENCE_WARNING",
  "UNKNOWN",
]);

/**
 * Project an assembled AO payload onto the old RAAS event contract.
 *
 * `flatPayload` deliberately remains rich because the next AO agent consumes
 * the same shared-Inngest event. `wirePayload` is an event-specific allowlist:
 * it is safe for unchanged RAAS consumers and cannot expose fs.readFromInbox
 * base64, AO last_result metadata, or a local-only BlobRef.
 */
export function projectLegacyRaasEvent(
  input: LegacyRaasWireInput,
): LegacyRaasProjection {
  const eventName = bareEventName(input.eventName);
  const payload: Record<string, unknown> = { ...input.payload };
  normalizeCommonAliases(payload);

  let entityType = "WorkflowEntity";
  let entityId =
    firstString(
      input.subject,
      payload.candidate_id,
      payload.job_requisition_id,
      payload.upload_id,
      payload.resume_id,
    ) ?? null;
  let sourceAction = input.sourceAgent ?? null;

  if (eventName === "JD_GENERATED") {
    setStringAlias(payload, "jd_content", "jdContent", "jd");
    if (payload.client_id === undefined) payload.client_id = null;
    entityType = "Job_Posting";
    entityId = firstString(payload.job_posting_id) ?? null;
    sourceAction = "createJD";
  } else if (
    eventName === "MATCH_RULE_CHECK_PASSED" ||
    eventName === "MATCH_RULE_CHECK_FAILED"
  ) {
    if (payload.candidate_id === undefined) payload.candidate_id = null;
    if (payload.resume_id === undefined) payload.resume_id = null;
    if (payload.upload_id === undefined) payload.upload_id = null;
    if (eventName === "MATCH_RULE_CHECK_PASSED") {
      payload.rule_check_result = "通过";
      if (payload.rule_check_reason === undefined)
        payload.rule_check_reason = "";
      if (
        payload.rule_check_rules === undefined &&
        Array.isArray(payload.rule_results)
      ) {
        payload.rule_check_rules = payload.rule_results;
      }
    } else {
      payload.rule_check_result = "未通过";
      if (payload.rule_check_reason === undefined) {
        payload.rule_check_reason =
          findString(payload, "reason", "decision_reason", "error") ?? "";
      }
      if (!Array.isArray(payload.failed_rules)) payload.failed_rules = [];
      payload.matching_score = null;
      payload.success = false;
    }
    entityType = "Candidate";
    entityId = firstString(payload.candidate_id) ?? null;
    sourceAction = "ruleCheckForMatchResume";
  } else if (
    eventName === "MATCH_PASSED_NEED_INTERVIEW" ||
    eventName === "MATCH_PASSED_NO_INTERVIEW" ||
    eventName === "MATCH_FAILED"
  ) {
    payload.matching_score =
      findNumber(
        payload,
        "matching_score",
        "match_score",
        "matchScore",
        "overall_match_score",
        "overallMatchScore",
      ) ?? null;
    if (payload.candidate_id === undefined) payload.candidate_id = null;
    if (payload.upload_id === undefined) payload.upload_id = null;
    if (payload.job_posting_id === undefined) payload.job_posting_id = null;
    if (payload.candidate_match_result_id === undefined) {
      payload.candidate_match_result_id = null;
    }
    payload.overall_status = eventName === "MATCH_FAILED" ? "不匹配" : "匹配";
    if (payload.success === undefined) {
      payload.success = eventName !== "MATCH_FAILED";
    }
    if (payload.requestId === undefined) {
      const requestId = findString(payload, "request_id");
      if (requestId) payload.requestId = requestId;
    }
    entityType = "Candidate";
    entityId = firstString(payload.candidate_id) ?? null;
    sourceAction = "matchResume";
  } else if (eventName === "INTERVIEW_INVITATION_SENT") {
    if (payload.correlation_id === undefined && input.correlationId) {
      payload.correlation_id = input.correlationId;
    }
    setStringAlias(payload, "login_url", "loginUrl", "interview_link");
    setStringAlias(payload, "qrcode_url", "qrcodeUrl");
    setStringAlias(payload, "request_introduction_id", "requestIntroductionId");
    setStringAlias(payload, "gohire_job_id", "gohireJobId");
    setStringAlias(payload, "candidate_email", "candidateEmail", "to");
    setStringAlias(payload, "interview_language", "interviewLanguage");
    if (payload.interview_duration_minutes === undefined) {
      const duration = findNumber(
        payload,
        "interview_duration_minutes",
        "interview_duration",
        "durationMinutes",
      );
      if (duration !== undefined) payload.interview_duration_minutes = duration;
    }
    if (payload.user_id === undefined) {
      for (const source of nestedSources(payload)) {
        const userId = source.userId;
        if (
          typeof userId === "string" ||
          typeof userId === "number" ||
          userId === null
        ) {
          payload.user_id = userId;
          break;
        }
      }
    }
    for (const key of [
      "login_url",
      "qrcode_url",
      "user_id",
      "request_introduction_id",
      "gohire_job_id",
      "candidate_email",
      "interview_language",
      "interview_duration_minutes",
      "robohire_request_id",
    ]) {
      if (payload[key] === undefined) payload[key] = null;
    }
    if (payload.sent_at === undefined && input.emittedAt) {
      payload.sent_at = input.emittedAt;
    }
    entityType = "Interview_Record";
    entityId = firstString(payload.interview_record_id) ?? null;
    sourceAction = "inviteInternalInterview";
  } else if (eventName === "INTERVIEW_INVITATION_FAILED") {
    if (payload.correlation_id === undefined && input.correlationId) {
      payload.correlation_id = input.correlationId;
    }
    const errorCode = firstString(payload.error_code);
    payload.error_code =
      errorCode && INVITATION_ERROR_CODES.has(errorCode)
        ? errorCode
        : "UNKNOWN";
    if (payload.error_message === undefined) {
      payload.error_message =
        findString(payload, "reason", "error", "note") ??
        "Interview invitation failed";
    }
    if (payload.http_status === undefined) {
      const status = findNumber(payload, "status");
      if (status !== undefined) payload.http_status = status;
    }
    if (payload.failed_at === undefined && input.emittedAt) {
      payload.failed_at = input.emittedAt;
    }
    entityType = "Candidate";
    entityId = firstString(payload.candidate_id) ?? null;
    sourceAction = "inviteInternalInterview";
  } else if (
    eventName === "RESUME_PROCESSED" ||
    eventName === "RESUME_LOCKED_CONFLICT" ||
    eventName === "CANDIDATE_IDENTITY_CHECKED"
  ) {
    entityType = "Candidate";
    entityId = firstString(payload.candidate_id, input.subject) ?? null;
  }

  return {
    flatPayload: payload,
    wirePayload: pickWirePayload(eventName, payload),
    entityType,
    entityId,
    sourceAction,
  };
}

/**
 * Build the canonical old-RAAS envelope. The nested, event-specific payload is
 * the only business-data boundary: spreading the runtime's full flat carry at
 * the top level would bypass the allow-list and leak internal results, blob
 * bytes, or future fields to the shared broker. The inbound tenant adapter
 * restores a flat canonical view for migrated zhaopin agents.
 */
export function wrapLegacyRaasEventData(
  input: LegacyRaasWireInput,
): Record<string, unknown> {
  const projection = projectLegacyRaasEvent(input);
  return {
    entity_type: projection.entityType,
    entity_id: projection.entityId,
    event_id: input.eventId,
    payload: projection.wirePayload,
    source_action: projection.sourceAction,
    trace: {
      trace_id: input.correlationId ?? null,
      request_id: input.eventId,
      workflow_id: null,
      parent_trace_id: null,
      event_name: bareEventName(input.eventName),
    },
  };
}
