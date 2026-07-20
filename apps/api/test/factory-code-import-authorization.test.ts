import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  productionCodeActManifestSha256,
  WorkflowManifestSchema,
} from "@agentic/runtime";

import {
  __test,
  createFactoryPromotionImportAuthorization,
  productionGeneratedCodeImportIssues,
} from "../src/services/manifest-import";

const ctx = { tenantId: "ten-code-import", tenantSlug: "production" };

function workflow(code: string, expected = createHash("sha256").update(code, "utf8").digest("hex"), id = "generated-agent") {
  return WorkflowManifestSchema.parse([{
    id,
    name: id,
    actor: ["Agent"],
    trigger: ["START"],
    actions: [{ order: "1", name: "run", description: "", type: "logic" }],
    triggered_event: ["DONE"],
    generated: true,
    factory_domain_id: "domain-code-import",
    factory_target_domain_id: "domain-code-import",
    factory_execution_scope: {
      kind: "production",
      target_domain_id: "domain-code-import",
    },
    factory_promotion_version_id: "v-immutable-1",
    factory_regression_suite_fingerprint: `regression-suite:v1:${"c".repeat(64)}`,
    codeExecuted: true,
    typescript_code: code,
    code_attestation: { allow_production: true, expected_sha256: expected },
  }]);
}

function mint(manifest: unknown, selectedSlugs = ["generated-agent"]) {
  return createFactoryPromotionImportAuthorization({
    tenantId: ctx.tenantId,
    workflow: manifest,
    receiptId: "review-12345678",
    receiptSignature: "a".repeat(64),
    versionId: "v-immutable-1",
    selectionHash: `promotion-selection:v1:${"b".repeat(64)}`,
    candidateManifestHash: `manifest:v1:${productionCodeActManifestSha256(manifest)}`,
    regressionSuiteFingerprint: `regression-suite:v1:${"c".repeat(64)}`,
    selectedSlugs,
    promotion: {
      promotionId: "fpr-12345678",
      tenantId: ctx.tenantId,
      domain: "domain-code-import",
      versionId: "v-immutable-1",
      artifact: "factory-drafts/domain-code-import/versions/v-immutable-1/regression.json",
      suiteFingerprint: `regression-suite:v1:${"c".repeat(64)}`,
      reviewReceiptId: "review-12345678",
      recordHash: `factory-promotion-regression:v2:${"d".repeat(64)}`,
      slugs: selectedSlugs,
    },
  });
}

describe("factory-only production generated-Agent import authorization", () => {
  const code = `export const agent = defineAgent({ async handler(input, ctx) { ctx.emit("DONE", input); return input; } });`;

  it("allows the exact workflow only with the opaque verified-promotion capability", () => {
    const manifest = workflow(code);
    const authorization = mint(manifest);
    expect(productionGeneratedCodeImportIssues({ manifest, rawWorkflow: manifest, ctx, authorization })).toEqual([]);
  });

  it("rejects an externally supplied exact hash and a copied look-alike authorization", () => {
    const manifest = workflow(code);
    const authorization = mint(manifest);
    expect(productionGeneratedCodeImportIssues({ manifest, rawWorkflow: manifest, ctx })).toEqual([
      expect.objectContaining({ code: "production_generated_code_attestation_untrusted" }),
    ]);
    expect(productionGeneratedCodeImportIssues({
      manifest,
      rawWorkflow: manifest,
      ctx,
      authorization: { ...authorization },
    })).toEqual([
      expect.objectContaining({ code: "production_generated_code_attestation_untrusted" }),
    ]);
  });

  it("rejects wrong exact bytes before checking signing provenance", () => {
    const manifest = workflow(code, "0".repeat(64));
    expect(productionGeneratedCodeImportIssues({ manifest, rawWorkflow: manifest, ctx })).toEqual([
      expect.objectContaining({ code: "production_generated_code_hash_mismatch" }),
    ]);
  });

  it("authorizes only the chosen agents in an additive manifest", () => {
    const chosen = workflow(code)[0]!;
    const historical = workflow(code.replace("DONE", "OLD_DONE"), undefined, "historical-code")[0]!;
    const manifest = WorkflowManifestSchema.parse([chosen, historical]);
    const authorization = mint(manifest, ["generated-agent"]);
    expect(
      productionGeneratedCodeImportIssues({
        manifest,
        rawWorkflow: manifest,
        ctx,
        authorization,
      }),
    ).toEqual([
      expect.objectContaining({
        path: "agents.1.code_attestation",
        code: "production_generated_code_attestation_untrusted",
      }),
    ]);
  });

  it("accepts an unchanged historical agent only with its independently verified manifest hash", () => {
    const chosen = workflow(code)[0]!;
    const historical = workflow(
      code.replace("DONE", "OLD_DONE"),
      undefined,
      "historical-code",
    )[0]!;
    const manifest = WorkflowManifestSchema.parse([chosen, historical]);
    const authorization = mint(manifest, ["generated-agent"]);
    expect(
      productionGeneratedCodeImportIssues({
        manifest,
        rawWorkflow: manifest,
        ctx,
        authorization,
        historicalAuthorizedAgentManifestSha256: {
          "historical-code": productionCodeActManifestSha256(historical),
        },
      }),
    ).toEqual([]);

    const edited = WorkflowManifestSchema.parse([
      chosen,
      {
        ...historical,
        actions: [
          ...historical.actions,
          { order: "2", name: "new-policy", description: "", type: "logic" },
        ],
      },
    ]);
    expect(
      productionGeneratedCodeImportIssues({
        manifest: edited,
        rawWorkflow: edited,
        ctx,
        authorization,
        historicalAuthorizedAgentManifestSha256: {
          "historical-code": productionCodeActManifestSha256(historical),
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        path: "agents.1.code_attestation",
        code: "production_generated_code_attestation_untrusted",
      }),
    );
  });

  it("mints a fresh deployment row that keeps historical evidence but uses the current activation", () => {
    const chosen = workflow(code)[0]!;
    const historical = workflow(
      code.replace("DONE", "OLD_DONE"),
      undefined,
      "historical-code",
    )[0]!;
    const manifest = WorkflowManifestSchema.parse([chosen, historical]);
    const authorization = mint(manifest, ["generated-agent"]);
    const rows = __test.factoryCodeActAuthorizationRows({
      ctx,
      authorization,
      deploymentId: "dpl-current",
      workflowVersionId: "wfv-current",
      historical: {
        "historical-code": {
          executionKind: "codeact",
          evidencePromotionId: "fpr-original-a",
          tenantId: ctx.tenantId,
          tenantSlug: ctx.tenantSlug,
          domainId: "domain-original-a",
          agentSlug: "historical-code",
          promotionVersionId: "version-original-a",
          regressionSuiteFingerprint: `regression-suite:v1:${"1".repeat(64)}`,
          codeSha256: createHash("sha256")
            .update(historical.typescript_code!, "utf8")
            .digest("hex"),
          agentManifestSha256:
            productionCodeActManifestSha256(historical),
          evidenceReviewReceiptId: "review-original-a",
          evidenceReviewSelectionHash: `promotion-selection:v1:${"2".repeat(64)}`,
          regressionArtifact: "factory-drafts/a/regression.json",
          evidencePromotionRecordHash: `factory-promotion-regression:v2:${"3".repeat(64)}`,
        },
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.agentSlug === "historical-code"))
      .toMatchObject({
        promotionId: "fpr-original-a",
        reviewReceiptId: "review-original-a",
        deploymentId: "dpl-current",
        workflowVersionId: "wfv-current",
        activationPromotionId: "fpr-12345678",
        activationReviewReceiptId: "review-12345678",
        workflowManifestSha256: authorization.workflowManifestSha256,
      });
    expect(rows.find((row) => row.agentSlug === "generated-agent"))
      .toMatchObject({
        promotionId: "fpr-12345678",
        activationPromotionId: "fpr-12345678",
        deploymentId: "dpl-current",
      });
  });

  it("rejects a current-promotion capability when any signed workflow content drifts", () => {
    const manifest = workflow(code);
    const authorization = mint(manifest);
    const drifted = WorkflowManifestSchema.parse([
      {
        ...manifest[0]!,
        triggered_event: ["DIFFERENT_DONE"],
      },
    ]);
    expect(
      productionGeneratedCodeImportIssues({
        manifest: drifted,
        rawWorkflow: drifted,
        ctx,
        authorization,
      }),
    ).toContainEqual(
      expect.objectContaining({
        code: "production_generated_code_attestation_untrusted",
      }),
    );
  });

  it("requires the same promotion authorization for declarative generated agents", () => {
    const declarative = {
      ...workflow(code)[0]!,
      codeExecuted: false,
      typescript_code: undefined,
      code_attestation: undefined,
    };
    const manifest = WorkflowManifestSchema.parse([declarative]);
    expect(
      productionGeneratedCodeImportIssues({
        manifest,
        rawWorkflow: manifest,
        ctx,
      }),
    ).toEqual([
      expect.objectContaining({
        code: "production_generated_agent_promotion_untrusted",
      }),
    ]);
    const authorization = mint(manifest);
    expect(
      productionGeneratedCodeImportIssues({
        manifest,
        rawWorkflow: manifest,
        ctx,
        authorization,
      }),
    ).toEqual([]);
    expect(
      __test.factoryCodeActAuthorizationRows({
        ctx,
        authorization,
        historical: {},
        deploymentId: "dpl-declarative",
        workflowVersionId: "wfv-declarative",
      }),
    ).toEqual([
      expect.objectContaining({
        agentSlug: "generated-agent",
        codeSha256: productionCodeActManifestSha256(manifest[0]),
        agentManifestSha256: productionCodeActManifestSha256(manifest[0]),
      }),
    ]);
  });
});
