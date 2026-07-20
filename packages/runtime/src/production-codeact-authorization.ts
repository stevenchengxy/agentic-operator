/**
 * Process-local production generated-Agent capability.
 *
 * A workflow manifest is untrusted configuration.  It can request CodeAct,
 * carry hashes, and copy promotion-looking strings, but it cannot manufacture
 * an object present in this module-private WeakMap.  The API installs a
 * verifier that resolves the request against durable promotion state and
 * immutable evidence; only then does this module mint the opaque capability.
 *
 * The filename and CodeAct aliases are retained for compatibility, but
 * declarative generated agents cross this same authorization boundary.
 */

import { createHash } from "node:crypto";
import { canonicalEvidenceJson } from "@agentic/shared";

export function productionCodeActManifestSha256(value: unknown): string {
  return createHash("sha256")
    .update(canonicalEvidenceJson(value), "utf8")
    .digest("hex");
}

export type ProductionGeneratedAgentExecutionKind =
  | "codeact"
  | "declarative";

export interface ProductionGeneratedAgentAuthorizationRequest {
  executionKind: ProductionGeneratedAgentExecutionKind;
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  agentSlug: string;
  promotionVersionId: string;
  regressionSuiteFingerprint: string;
  /** Exact execution identity. For CodeAct this is the handler SHA-256. For a
   * declarative agent it is the complete canonical agent-manifest SHA-256;
   * the durable verifier independently binds the reviewed spec/module files. */
  codeSha256: string;
  /** SHA-256 of the complete canonical agent manifest object loaded by the
   * runtime. This binds actions/tool_use/error policy as well as code bytes. */
  agentManifestSha256: string;
  /** SHA-256 of the complete canonical workflow manifest. This is independently
   * persisted at activation and HMAC-bound by that activation's review receipt. */
  workflowManifestSha256: string;
}

export type ProductionCodeActAuthorizationRequest =
  ProductionGeneratedAgentAuthorizationRequest;

export interface VerifiedProductionGeneratedAgentAuthorization
  extends ProductionGeneratedAgentAuthorizationRequest {
  authorizationId: string;
  /** Immutable evidence promotion and the current activation promotion are
   * distinct when an unchanged historical generated Agent is carried forward. */
  promotionId: string;
  activationPromotionId: string;
  deploymentId: string;
  workflowVersionId: string;
  reviewReceiptId: string;
  activationReviewReceiptId: string;
}

export type VerifiedProductionCodeActAuthorization =
  VerifiedProductionGeneratedAgentAuthorization;

declare const productionCodeActCapabilityBrand: unique symbol;
export interface ProductionCodeActCapability {
  readonly [productionCodeActCapabilityBrand]: true;
}

export type ProductionGeneratedAgentAuthorizationVerifier = (
  request: Readonly<ProductionGeneratedAgentAuthorizationRequest>,
  purpose: "bootstrap" | "execution",
) => Promise<VerifiedProductionGeneratedAgentAuthorization>;

export type ProductionCodeActAuthorizationVerifier =
  ProductionGeneratedAgentAuthorizationVerifier;

let verifier: ProductionCodeActAuthorizationVerifier | null = null;
const capabilities = new WeakMap<
  object,
  VerifiedProductionGeneratedAgentAuthorization
>();

function exactText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(
      `invalid production generated-Agent authorization ${field}`,
    );
  }
  return value;
}

function validateRequest<T extends ProductionGeneratedAgentAuthorizationRequest>(
  value: T,
): T {
  if (
    value.executionKind !== "codeact" &&
    value.executionKind !== "declarative"
  ) {
    throw new Error("invalid production generated-Agent execution kind");
  }
  exactText(value.tenantId, "tenantId");
  exactText(value.tenantSlug, "tenantSlug");
  exactText(value.domainId, "domainId");
  exactText(value.agentSlug, "agentSlug");
  exactText(value.promotionVersionId, "promotionVersionId");
  if (!value.regressionSuiteFingerprint.startsWith("regression-suite:v1:")) {
    throw new Error(
      "invalid production generated-Agent authorization regression suite",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(value.codeSha256)) {
    throw new Error(
      "invalid production generated-Agent authorization execution hash",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(value.agentManifestSha256)) {
    throw new Error(
      "invalid production generated-Agent authorization manifest hash",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(value.workflowManifestSha256)) {
    throw new Error(
      "invalid production generated-Agent authorization workflow hash",
    );
  }
  return value;
}

/** Install the trusted control-plane verifier before tenant bootstrap. */
export function setProductionGeneratedAgentAuthorizationVerifier(
  next: ProductionGeneratedAgentAuthorizationVerifier | null,
): void {
  verifier = next;
}

/** Compatibility alias for existing CodeAct composition code. */
export const setProductionCodeActAuthorizationVerifier =
  setProductionGeneratedAgentAuthorizationVerifier;

/** Resolve durable evidence and mint an opaque, identity-bound capability. */
export async function authorizeProductionGeneratedAgent(
  request: ProductionGeneratedAgentAuthorizationRequest,
): Promise<ProductionCodeActCapability> {
  const expected = validateRequest({ ...request });
  if (!verifier) {
    throw new Error(
      `production generated-Agent authorization verifier is unavailable for ${expected.tenantSlug}/${expected.agentSlug}`,
    );
  }
  const verified = validateRequest(
    await verifier(Object.freeze(expected), "bootstrap"),
  );
  for (const field of [
    "executionKind",
    "tenantId",
    "tenantSlug",
    "domainId",
    "agentSlug",
    "promotionVersionId",
    "regressionSuiteFingerprint",
    "codeSha256",
    "agentManifestSha256",
    "workflowManifestSha256",
  ] as const) {
    if (verified[field] !== expected[field]) {
      throw new Error(
        `production generated-Agent durable authorization changed ${field} for ${expected.agentSlug}`,
      );
    }
  }
  exactText(verified.authorizationId, "authorizationId");
  exactText(verified.promotionId, "promotionId");
  exactText(verified.activationPromotionId, "activationPromotionId");
  exactText(verified.deploymentId, "deploymentId");
  exactText(verified.workflowVersionId, "workflowVersionId");
  exactText(verified.reviewReceiptId, "reviewReceiptId");
  exactText(verified.activationReviewReceiptId, "activationReviewReceiptId");
  const capability = Object.freeze(Object.create(null)) as ProductionCodeActCapability;
  capabilities.set(capability as object, Object.freeze({ ...verified }));
  return capability;
}

/** Compatibility entry point used at the CodeAct execution boundary. */
export async function authorizeProductionCodeAct(
  request: ProductionCodeActAuthorizationRequest,
): Promise<ProductionCodeActCapability> {
  if (request.executionKind !== "codeact") {
    throw new Error("authorizeProductionCodeAct requires executionKind=codeact");
  }
  return authorizeProductionGeneratedAgent(request);
}

/**
 * Validate the opaque object at the final execution boundary.  Returning the
 * immutable claims lets the caller use trusted hashes/provenance instead of
 * reading the equivalent strings back from the manifest.
 */
function localCapabilityClaims(
  capability: ProductionCodeActCapability | undefined,
  expected: ProductionGeneratedAgentAuthorizationRequest,
): VerifiedProductionGeneratedAgentAuthorization | null {
  if (!capability || typeof capability !== "object") return null;
  const claims = capabilities.get(capability as object);
  if (!claims) return null;
  const request = validateRequest({ ...expected });
  return claims.executionKind === request.executionKind &&
    claims.tenantId === request.tenantId &&
    claims.tenantSlug === request.tenantSlug &&
    claims.domainId === request.domainId &&
    claims.agentSlug === request.agentSlug &&
    claims.promotionVersionId === request.promotionVersionId &&
    claims.regressionSuiteFingerprint === request.regressionSuiteFingerprint &&
    claims.codeSha256 === request.codeSha256
    && claims.agentManifestSha256 === request.agentManifestSha256
    && claims.workflowManifestSha256 === request.workflowManifestSha256
    ? claims
    : null;
}

/** Re-check durable authority at a generated-Agent execution boundary. A
 * process-local capability is not perpetual permission: deployment rollback,
 * ledger deletion, artifact tampering, or receipt revocation must take effect
 * without restarting the worker. */
export async function revalidateProductionGeneratedAgentCapability(
  capability: ProductionCodeActCapability | undefined,
  expected: ProductionGeneratedAgentAuthorizationRequest,
): Promise<VerifiedProductionGeneratedAgentAuthorization | null> {
  const local = localCapabilityClaims(capability, expected);
  if (!local || !verifier) return null;
  let durable: VerifiedProductionCodeActAuthorization;
  try {
    durable = validateRequest(
      await verifier(Object.freeze({ ...expected }), "execution"),
    );
  } catch {
    return null;
  }
  for (const field of [
    "executionKind",
    "tenantId",
    "tenantSlug",
    "domainId",
    "agentSlug",
    "promotionVersionId",
    "regressionSuiteFingerprint",
    "codeSha256",
    "agentManifestSha256",
    "workflowManifestSha256",
    "authorizationId",
    "promotionId",
    "activationPromotionId",
    "deploymentId",
    "workflowVersionId",
    "reviewReceiptId",
    "activationReviewReceiptId",
  ] as const) {
    if (durable[field] !== local[field]) return null;
  }
  return local;
}

export async function revalidateProductionCodeActCapability(
  capability: ProductionCodeActCapability | undefined,
  expected: ProductionCodeActAuthorizationRequest,
): Promise<VerifiedProductionCodeActAuthorization | null> {
  if (expected.executionKind !== "codeact") return null;
  return revalidateProductionGeneratedAgentCapability(capability, expected);
}
