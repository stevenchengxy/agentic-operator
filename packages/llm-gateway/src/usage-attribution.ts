import { AsyncLocalStorage } from "node:async_hooks";
import type { UsageAttribution } from "./types";

const storage = new AsyncLocalStorage<UsageAttribution>();
const MAX_DIMENSION_LENGTH = 256;
const ACTOR_TYPES = new Set(["user", "api_token", "system"]);
const ATTRIBUTION_FIELDS = new Set<keyof UsageAttribution>([
  "billingAccountId",
  "providerAccountId",
  "actorType",
  "actorId",
  "credentialId",
  "providerCredentialId",
  "product",
  "productSurface",
  "productAction",
  "interactionId",
  "functionName",
  "apiRoute",
  "httpMethod",
  "requestId",
  "correlationId",
  "invocationSource",
]);
const ID_FIELDS = new Set<keyof UsageAttribution>([
  "billingAccountId",
  "providerAccountId",
  "actorId",
  "credentialId",
  "providerCredentialId",
  "interactionId",
  "requestId",
  "correlationId",
]);
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

/**
 * Run one request/task inside a non-sensitive usage-attribution context.
 * Callers should pass identifiers and stable operation codes only.
 */
export function runWithUsageAttribution<T>(
  attribution: UsageAttribution,
  fn: () => T,
): T {
  return storage.run(sanitizeUsageAttribution(attribution), fn);
}

export function currentUsageAttribution(): UsageAttribution | undefined {
  return storage.getStore();
}

/** Later arguments win, allowing an explicit ChatRequest to refine API context. */
export function mergeUsageAttribution(
  ...sources: Array<UsageAttribution | undefined>
): UsageAttribution {
  return sanitizeUsageAttribution(
    Object.assign({}, ...sources.filter(Boolean)),
  );
}

/**
 * Bound every exported dimension and discard blank/control-character values.
 * This is intentionally not a generic metadata bag: prompts, headers,
 * credentials, and customer payloads have nowhere to enter the billing log.
 */
export function sanitizeUsageAttribution(
  input: UsageAttribution,
): UsageAttribution {
  const out: UsageAttribution = {};
  for (const [key, value] of Object.entries(input) as Array<
    [keyof UsageAttribution, string | undefined]
  >) {
    // Runtime callers may decode attribution from a durable queue boundary.
    // Keep this a closed schema at runtime as well as in TypeScript so an
    // attacker cannot smuggle an arbitrary metadata bag into usage exports.
    if (!ATTRIBUTION_FIELDS.has(key)) continue;
    if (typeof value !== "string") continue;
    const clean = value
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, MAX_DIMENSION_LENGTH);
    if (!clean) continue;
    if (key === "actorType" && !ACTOR_TYPES.has(clean)) continue;
    if (ID_FIELDS.has(key) && !SAFE_ID.test(clean)) continue;
    (out as Record<string, string>)[key] = clean;
  }
  return out;
}
