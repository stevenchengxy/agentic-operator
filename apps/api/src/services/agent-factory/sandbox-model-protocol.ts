import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { canonicalEvidenceJson } from "@agentic/agent-factory";

export const SANDBOX_MODEL_RESERVATION_HEADER =
  "x-agentic-sandbox-model-total-reservation";
export const SANDBOX_MODEL_MAX_CALLS_HEADER =
  "x-agentic-sandbox-model-max-calls";
export const SANDBOX_MODEL_MAX_TOTAL_HEADER =
  "x-agentic-sandbox-model-max-total-tokens";
export const SANDBOX_MODEL_RESPONSE_SIGNATURE_HEADER =
  "x-agentic-sandbox-model-response-signature";

export interface SandboxModelSignedResponse {
  attemptId: string;
  bundleHash: string;
  targetTenantId: string;
  targetTenantSlug: string;
  requestDigest: string;
  statusCode: number;
  reservation: number | null;
  maxCalls: number;
  maxTotalTokens: number;
  body: unknown;
}

const RESPONSE_SIGNATURE_PREFIX = "sandbox-model-response:v1:";

export function sandboxModelRequestDigest(input: {
  attemptId: string;
  bundleHash: string;
  targetTenantId: string;
  targetTenantSlug: string;
  requestId: string;
  request: unknown;
}): string {
  return `sandbox-model-request:v1:${createHash("sha256")
    .update(canonicalEvidenceJson({
      schema: "agent-factory-sandbox-model-request/v1",
      ...input,
    }), "utf8")
    .digest("hex")}`;
}

/** Message-level integrity for the one intentionally permitted internal HTTP
 * edge. The HMAC binds body, status, attempt/bundle/tenant identity and every
 * budget header the workload uses for accounting. */
export function sandboxModelResponseSignature(
  secret: string,
  response: SandboxModelSignedResponse,
): string {
  const digest = createHmac("sha256", secret)
    .update(canonicalEvidenceJson({
      schema: "agent-factory-sandbox-model-response/v1",
      ...response,
    }), "utf8")
    .digest("hex");
  return `${RESPONSE_SIGNATURE_PREFIX}${digest}`;
}

export function verifySandboxModelResponseSignature(
  signature: string | null | undefined,
  secret: string,
  response: SandboxModelSignedResponse,
): boolean {
  if (!signature?.startsWith(RESPONSE_SIGNATURE_PREFIX)) return false;
  const supplied = signature.slice(RESPONSE_SIGNATURE_PREFIX.length);
  if (!/^[a-f0-9]{64}$/.test(supplied)) return false;
  const expected = sandboxModelResponseSignature(secret, response)
    .slice(RESPONSE_SIGNATURE_PREFIX.length);
  return timingSafeEqual(Buffer.from(supplied, "hex"), Buffer.from(expected, "hex"));
}
