import { describe, expect, it } from "vitest";
import { isPromotionPreviewData } from "./promotion-review";

const preview = {
  versionId: "v-1",
  slugs: ["agent-a"],
  reviewChallenge: "challenge",
  previewHash: "preview-hash",
  liveManifestHash: "live-hash",
  candidateManifestHash: "candidate-hash",
  delta: {
    agents: { added: ["agent-a"], modified: [], unchanged: [], removed: [] },
    events: { added: ["A_DONE"], removed: [] },
    tools: { added: ["records.upsert"], removed: [] },
    config: [],
    contracts: [],
  },
  evidence: {
    regressionPointersPresent: true,
    replayReady: true,
    promotionGateAdmission: true,
    promotionEligible: true,
    promotionEvidenceReady: true,
    promotionBlockers: [],
    evidenceQualification: {
      schema: "agent-factory-regression-evidence-qualification/v1",
      replay: "sandbox_verified",
      promotion: "candidate",
      blockers: [],
    },
    regressionReplayRequiredAtPromotion: true,
    humanCodeAndDesignSignoffRequired: true,
  },
};

describe("promotion review response validation", () => {
  it("accepts a complete server preview", () => {
    expect(isPromotionPreviewData(preview)).toBe(true);
  });

  it("keeps a replay-ready but production-blocked preview displayable", () => {
    expect(isPromotionPreviewData({
      ...preview,
      evidence: {
        ...preview.evidence,
        promotionEligible: false,
        promotionBlockers: ["production live probe missing"],
      },
    })).toBe(true);
  });

  it("fails closed when a review surface or server requirement is missing", () => {
    expect(isPromotionPreviewData({ ...preview, previewHash: "" })).toBe(false);
    expect(isPromotionPreviewData({
      ...preview,
      delta: { ...preview.delta, config: undefined },
    })).toBe(false);
    expect(isPromotionPreviewData({
      ...preview,
      evidence: {
        ...preview.evidence,
        humanCodeAndDesignSignoffRequired: false,
      },
    })).toBe(false);
    expect(isPromotionPreviewData({
      ...preview,
      evidence: { ...preview.evidence, promotionEvidenceReady: undefined },
    })).toBe(false);
  });
});
