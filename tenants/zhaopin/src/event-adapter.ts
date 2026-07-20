import type {
  TenantEventAdapter,
  TenantInboundEvent,
  TenantOutboundEvent,
} from "@agentic/agent-kit";
import {
  unwrapLegacyRaasEventData,
  wrapLegacyRaasEventData,
} from "./legacy-raas-envelope";

function bareEventName(value: string): string {
  const slash = value.lastIndexOf("/");
  return slash >= 0 ? value.slice(slash + 1) : value;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Stable ids required by the pre-existing RAAS Inngest App. They live with
 * the tenant transport adapter instead of teaching generic runtime code about
 * six recruiting actions. */
export const LEGACY_RAAS_FUNCTION_IDS: Readonly<Record<string, string>> = Object.freeze({
  createJD: "create-jd-agent",
  processResume: "resume-parser-agent",
  ruleCheckForCandidateIdentity: "rule-check-candidate-identity-agent",
  ruleCheckForMatchResume: "rule-check-agent",
  matchResume: "match-resume-agent",
  inviteInternalInterview: "interview-inviter-agent",
});

/**
 * The old recruitment event used two file-name aliases. They are a zhaopin
 * transport contract, so translate them at the tenant boundary instead of
 * teaching the reusable filesystem tool about RAAS fields.
 */
export function canonicalizeLegacyRaasInput(
  eventName: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (bareEventName(eventName) !== "RESUME_DOWNLOADED") return data;

  const explicit =
    nonEmptyString(data.filename) ?? nonEmptyString(data.resume_filename);
  const legacyPath = nonEmptyString(data.resume_file_path);
  const fromPath = legacyPath
    ? (legacyPath.split(/[\\/]/).pop() ?? "").trim()
    : undefined;
  const filename = explicit || fromPath;
  if (!filename || data.filename === filename) return data;
  return { ...data, filename };
}

/**
 * 招聘-v1 owns the old RAAS transport shape. The runtime only sees the
 * canonical TenantEventAdapter contract and therefore contains no RAAS
 * envelope branch or event-specific field projection.
 */
export const zhaopinLegacyRaasEventAdapter: TenantEventAdapter = Object.freeze({
  name: "zhaopin.legacy-raas-v1",
  wireEventName: ({
    tenantSlug,
    eventName,
  }: {
    tenantSlug: string;
    eventName: string;
  }) => {
    const prefix = `${tenantSlug}/`;
    return eventName.startsWith(prefix)
      ? eventName.slice(prefix.length)
      : eventName;
  },
  functionId: ({ tenantSlug, agentName }: { tenantSlug: string; agentName: string }) =>
    LEGACY_RAAS_FUNCTION_IDS[agentName] ?? `${tenantSlug}.${agentName}`,
  subjectExpressions: Object.freeze({
    trigger: "event.data.entity_id",
    cancel: "async.data.entity_id",
  }),
  inbound: (input: TenantInboundEvent) => {
    const unwrapped = unwrapLegacyRaasEventData(input.data, {
      eventName: input.eventName,
    });
    return canonicalizeLegacyRaasInput(input.eventName, unwrapped);
  },
  outbound: (input: TenantOutboundEvent) => wrapLegacyRaasEventData(input),
});
