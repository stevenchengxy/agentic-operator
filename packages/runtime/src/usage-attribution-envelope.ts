import {
  mergeUsageAttribution,
  sanitizeUsageAttribution,
  type UsageAttribution,
} from "@agentic/llm-gateway";

/**
 * Inngest-only metadata key. Public event payload builders and the event
 * ledger both remove every top-level `__*` field before persistence.
 */
export const PRIVATE_USAGE_ATTRIBUTION_FIELD = "__usageAttribution";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Produce the private transport fragment used by authenticated API ingress.
 * Empty attribution is omitted rather than writing a meaningless object.
 */
export function privateUsageAttributionMetadata(
  attribution: UsageAttribution | undefined,
): Record<string, unknown> {
  if (!attribution) return {};
  const sanitized = sanitizeUsageAttribution(attribution);
  if (Object.keys(sanitized).length === 0) return {};
  return { [PRIVATE_USAGE_ATTRIBUTION_FIELD]: sanitized };
}

/**
 * Decode queue metadata defensively. The authenticated tenant registered for
 * the Inngest function is authoritative: a forged or stale billing account in
 * an envelope can never redirect usage to another account.
 */
export function usageAttributionFromDeliveryData(
  data: Record<string, unknown>,
  trustedTenantId: string,
): UsageAttribution {
  const raw = data[PRIVATE_USAGE_ATTRIBUTION_FIELD];
  const decoded = isRecord(raw)
    ? sanitizeUsageAttribution(raw as UsageAttribution)
    : {};
  return mergeUsageAttribution(decoded, {
    billingAccountId: trustedTenantId,
  });
}

