import { describe, expect, it } from "vitest";

import type { DraftRow } from "./model";
import { draftPromotionIneligibleReason } from "./left-rail";

const readyDraft = (over: Partial<DraftRow> = {}): DraftRow => ({
  slug: "resume-agent",
  createdAt: new Date(0).toISOString(),
  versionId: "v-ready",
  replayReady: true,
  regressionReady: true,
  regressionStatus: "ready",
  promotionEligible: true,
  promotionGateAdmission: true,
  promotionEvidenceReady: true,
  promotionBlockers: [],
  evidenceQualification: {
    schema: "agent-factory-regression-evidence-qualification/v1",
    replay: "sandbox_verified",
    promotion: "candidate",
    blockers: [],
  },
  regression: {
    artifact: "versions/v-ready/regression.json",
    evidenceFingerprint: "sandbox-evidence:v6:ready",
    suiteFingerprint: "regression-suite:v3:ready",
  },
  spec: { short: "ResumeAgent" },
  ...over,
});

describe("draft promotion evidence labels", () => {
  it("allows a server-qualified replay + production candidate", () => {
    expect(draftPromotionIneligibleReason(readyDraft())).toBeNull();
  });

  it("explains that a signed-fixture replay is sandbox-only", () => {
    const reason = draftPromotionIneligibleReason(readyDraft({
      promotionEligible: false,
      promotionEvidenceReady: false,
      evidenceQualification: {
        schema: "agent-factory-regression-evidence-qualification/v1",
        replay: "sandbox_verified",
        promotion: "blocked",
        blockers: [{
          code: "live_probe_required",
          detail: "production live probe required",
        }],
      },
    }));
    expect(reason).toContain("沙箱编排已验证，当前不能上线");
    expect(reason).toContain("signed fixture");
  });

  it("does not treat replay readiness alone as promotion authority", () => {
    expect(draftPromotionIneligibleReason(readyDraft({
      promotionEligible: true,
      promotionEvidenceReady: false,
    }))).not.toBeNull();
  });
});
