import { describe, expect, it } from "vitest";
import { translate } from "@/lib/i18n";
import {
  factoryConversationStorageKey,
  parseProductionReworkPreview,
} from "./production-rework";

const zh = (key: string, vars?: Record<string, string | number>) =>
  translate("zh", key, vars);
const en = (key: string, vars?: Record<string, string | number>) =>
  translate("en", key, vars);

const validResponse = () => ({
  started: false,
  seed: {
    version: 1,
    seedId: "rwk-123",
    domain: "Agents-generation",
    createdAt: "2026-07-14T04:00:00.000Z",
    source: {
      kind: "promoted_draft_plus_production_evidence",
      slug: "match-resume",
      draftVersionId: "draft-v7",
      liveManifestMatchedDraft: true,
    },
    productionEvidence: {
      total: 2,
      failed: 1,
      failureRate: 0.5,
      runs: [
        {
          runId: "run-failed",
          status: "failed",
          startedAt: "2026-07-14T03:00:00.000Z",
          durationMs: 900,
          codeRan: true,
          error: "Authorization: Bearer abcdefghijklmnop",
          steps: [
            {
              name: "call matcher",
              status: "failed",
              attempts: 2,
              error: "api_key=secret-value",
            },
          ],
        },
        {
          runId: "run-ok",
          status: "ok",
          startedAt: "2026-07-14T02:00:00.000Z",
          durationMs: 500,
          codeRan: true,
          error: null,
          steps: [],
        },
      ],
    },
  },
  startRequest: {
    domain: "Agents-generation",
    goal: "safe server-authored seed rwk-123",
    started: false,
  },
});

describe("production rework preview", () => {
  it("accepts only a non-started seed containing the selected failed run", () => {
    const parsed = parseProductionReworkPreview(zh, validResponse(), "run-failed");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.preview.startRequest.started).toBe(false);
    expect(parsed.preview.selectedRun.error).not.toContain("abcdefghijklmnop");
    expect(parsed.preview.selectedRun.failedSteps[0]?.error).toBe(
      "api_key=[REDACTED]",
    );
  });

  it("refuses a response that may already have started work", () => {
    expect(
      parseProductionReworkPreview(
        zh,
        { ...validResponse(), started: true },
        "run-failed",
      ),
    ).toMatchObject({ ok: false });
    expect(
      parseProductionReworkPreview(
        zh,
        {
          ...validResponse(),
          startRequest: { ...validResponse().startRequest, started: true },
        },
        "run-failed",
      ),
    ).toMatchObject({ ok: false });
  });

  it("refuses to substitute another production run as evidence", () => {
    const parsed = parseProductionReworkPreview(zh, validResponse(), "run-other");
    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.message).toContain("没有当前运行");
  });

  it("refuses a seed for another domain or agent", () => {
    expect(
      parseProductionReworkPreview(zh, validResponse(), "run-failed", {
        domain: "other-domain",
        slug: "match-resume",
      }),
    ).toMatchObject({ ok: false });
    expect(
      parseProductionReworkPreview(zh, validResponse(), "run-failed", {
        domain: "Agents-generation",
        slug: "other-agent",
      }),
    ).toMatchObject({ ok: false });
  });

  it("uses the same scoped conversation key as the factory cockpit", () => {
    expect(
      factoryConversationStorageKey("tenant-a", "Agents-generation"),
    ).toBe("ao:factory:conv:tenant-a:Agents-generation");
  });

  it("returns validation errors and fallback step names in the active language", () => {
    const invalid = parseProductionReworkPreview(en, {}, "run-failed");
    expect(invalid).toEqual({
      ok: false,
      message:
        "The server did not explicitly confirm started=false; stopped to avoid an accidental start.",
    });

    const response = validResponse();
    response.seed.productionEvidence.runs[0]!.steps[0]!.name = "";
    const parsed = parseProductionReworkPreview(en, response, "run-failed");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.preview.selectedRun.failedSteps[0]?.name).toBe(
        "Unnamed step",
      );
    }
  });
});
