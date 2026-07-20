import { afterEach, describe, expect, it } from "vitest";

import {
  authorizeProductionGeneratedAgent,
  authorizeProductionCodeAct,
  revalidateProductionCodeActCapability,
  setProductionCodeActAuthorizationVerifier,
  type ProductionCodeActAuthorizationRequest,
} from "./production-codeact-authorization";

const request: ProductionCodeActAuthorizationRequest = {
  executionKind: "codeact",
  tenantId: "ten-capability",
  tenantSlug: "capability",
  domainId: "domain-capability",
  agentSlug: "pure-agent",
  promotionVersionId: "version-1",
  regressionSuiteFingerprint: `regression-suite:v1:${"a".repeat(64)}`,
  codeSha256: "b".repeat(64),
  agentManifestSha256: "c".repeat(64),
  workflowManifestSha256: "d".repeat(64),
};

const claims = {
  ...request,
  authorizationId: "fca-test",
  promotionId: "fpr-test",
  activationPromotionId: "fpr-activation-test",
  deploymentId: "dpl-test",
  workflowVersionId: "wfv-test",
  reviewReceiptId: "review-test",
  activationReviewReceiptId: "review-activation-test",
};

afterEach(() => setProductionCodeActAuthorizationVerifier(null));

describe("production CodeAct opaque capability", () => {
  it("admits an exact declarative generated Agent only through the verifier", async () => {
    const declarative = {
      ...request,
      executionKind: "declarative" as const,
      codeSha256: request.agentManifestSha256,
    };
    let observedKind: string | undefined;
    setProductionCodeActAuthorizationVerifier(async (value) => {
      observedKind = value.executionKind;
      return {
        ...claims,
        ...value,
      };
    });
    await expect(
      authorizeProductionGeneratedAgent(declarative),
    ).resolves.toBeDefined();
    expect(observedKind).toBe("declarative");
  });

  it("cannot be reconstructed from a manifest-shaped object", async () => {
    setProductionCodeActAuthorizationVerifier(async () => claims);
    const capability = await authorizeProductionCodeAct(request);
    expect(
      await revalidateProductionCodeActCapability(capability, request),
    ).toEqual(claims);
    expect(
      await revalidateProductionCodeActCapability(
        { ...capability },
        request,
      ),
    ).toBeNull();
  });

  it("rechecks durable authority on every execution and observes revocation", async () => {
    let live = true;
    setProductionCodeActAuthorizationVerifier(async (_request, purpose) => {
      if (!live && purpose === "execution") {
        throw new Error("deployment rolled back");
      }
      return claims;
    });
    const capability = await authorizeProductionCodeAct(request);
    expect(
      await revalidateProductionCodeActCapability(capability, request),
    ).toEqual(claims);
    live = false;
    expect(
      await revalidateProductionCodeActCapability(capability, request),
    ).toBeNull();
  });

  it("binds the entire manifest in addition to version, suite and code", async () => {
    setProductionCodeActAuthorizationVerifier(async () => claims);
    const capability = await authorizeProductionCodeAct(request);
    expect(
      await revalidateProductionCodeActCapability(capability, {
        ...request,
        agentManifestSha256: "e".repeat(64),
      }),
    ).toBeNull();
    expect(
      await revalidateProductionCodeActCapability(capability, {
        ...request,
        workflowManifestSha256: "f".repeat(64),
      }),
    ).toBeNull();
  });
});
