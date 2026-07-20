import { describe, expect, it } from "vitest";
import {
  hasVerifiedSemanticLinkReceipt,
  humanizeMatchReason,
  projectPromptReceiptBinding,
  projectSelectionFunnel,
  projectVisibleEvidenceAnalysis,
  publicAuditPayload,
} from "./audit-view";

describe("reasoning audit view model", () => {
  it("projects legacy source facts without claiming they came from hidden reasoning", () => {
    const projected = projectVisibleEvidenceAnalysis(null, null, {
      evidence: {
        candidate: { name: "林澈", nationality: "中国" },
        jobRequisition: {
          client_name: "腾讯",
          client_department_name: "IEG",
          client_studio: "光子工作室",
        },
        resume: {
          employment_history: [
            { company: "荣耀终端有限公司", end_date: "2026-06-20" },
          ],
        },
      },
    });

    expect(projected.source).toBe("legacy_input_projection");
    expect(projected.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "目标客户",
          value: "腾讯",
          purpose: "scope_selection",
        }),
        expect.objectContaining({
          evidencePath: "resume.employment_history[0].end_date",
          value: "2026-06-20",
        }),
      ]),
    );
  });

  it("projects selector funnel counts and human-readable match reasons", () => {
    expect(
      projectSelectionFunnel(
        {
          scannedRuleCount: 262,
          matchedRuleCount: 6,
          selectedRuleCount: 6,
        },
        6,
      ),
    ).toEqual({ scanned: 262, matched: 6, selected: 6 });
    expect(humanizeMatchReason("action-linked")).toBe("Action 语义关联");
    expect(humanizeMatchReason("SCOPED_TO:client:tencent")).toBe("作用域 Link");
    expect(humanizeMatchReason("client-exact")).toBe("目标客户匹配");
  });

  it("only verifies semantic links from an explicit non-fallback execution receipt", () => {
    expect(
      hasVerifiedSemanticLinkReceipt({ linkOnly: true, fallbackUsed: false }),
    ).toBe(true);
    expect(
      hasVerifiedSemanticLinkReceipt({ linkOnly: true, fallbackUsed: true }),
    ).toBe(false);
    expect(hasVerifiedSemanticLinkReceipt({ linkOnly: true })).toBe(false);
    expect(hasVerifiedSemanticLinkReceipt(null)).toBe(false);
  });

  it("verifies that the compiler, RuleBundle, and QualifiedAgent receipts bind", () => {
    const qualifiedRun = {
      role: "qualified" as const,
      executionMode: "isolated-child-run" as const,
      runId: "run-child",
      parentRunId: "run-parent",
      correlationId: "cor-1",
      compilerId: "pc:v3",
      promptSha256: "sha256:prompt",
      ruleBundleId: "sha256:bundle",
      provider: "custom",
      model: "model",
      tokensIn: 10,
      tokensOut: 2,
      durationMs: 12,
      steps: 1,
      assessmentCount: 2,
    };
    expect(
      projectPromptReceiptBinding(
        { compilerId: "pc:v3", promptSha256: "sha256:prompt" },
        qualifiedRun,
        "sha256:bundle",
      ),
    ).toEqual({
      status: "verified",
      compilerIdMatches: true,
      promptHashMatches: true,
      ruleBundleMatches: true,
    });
    expect(
      projectPromptReceiptBinding(
        { compilerId: "pc:v3", promptSha256: "sha256:tampered" },
        qualifiedRun,
        "sha256:bundle",
      ).status,
    ).toBe("mismatch");
  });

  it("does not claim receipt verification before a child exists", () => {
    expect(
      projectPromptReceiptBinding(
        { compilerId: "pc:v3", promptSha256: "sha256:prompt" },
        null,
        "sha256:bundle",
      ).status,
    ).toBe("awaiting_child");
    expect(
      projectPromptReceiptBinding(
        { compilerId: "pc:v2", promptSha256: undefined },
        null,
      ).status,
    ).toBe("legacy_unverified");
  });

  it("redacts provider-private reasoning and credentials from public logs", () => {
    expect(
      publicAuditPayload({
        text: "public result",
        reasoning_content: "private chain",
        headers: { authorization: "Bearer secret" },
        children: [
          {
            steps: [{ output: { thinking: "private child chain" } }],
          },
        ],
      }),
    ).toEqual({
      text: "public result",
      reasoning_content: "[redacted from public audit]",
      headers: { authorization: "[redacted from public audit]" },
      children: [
        {
          steps: [{ output: { thinking: "[redacted from public audit]" } }],
        },
      ],
    });
  });
});
