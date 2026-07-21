import { redactDomainKnowledge } from "../../factory/domain-knowledge";
import type { Translate } from "../../../../lib/preferences-context";

export interface ProductionReworkPreview {
  seedId: string;
  domain: string;
  slug: string;
  createdAt: string;
  draftVersionId: string;
  evidenceTotal: number;
  evidenceFailed: number;
  failureRate: number;
  selectedRun: {
    runId: string;
    status: "failed";
    startedAt: string | null;
    durationMs: number | null;
    codeRan: boolean | null;
    error: string | null;
    failedSteps: Array<{
      name: string;
      attempts: number;
      error: string | null;
    }>;
  };
  startRequest: {
    domain: string;
    goal: string;
    started: false;
  };
}

export type ProductionReworkPreviewResult =
  | { ok: true; preview: ProductionReworkPreview }
  | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" ? redactDomainKnowledge(value) : null;

/** Fail closed: a preview is actionable only when the server explicitly says
 * no run was started and its evidence bundle contains this exact failed run. */
export function parseProductionReworkPreview(
  t: Translate,
  value: unknown,
  selectedRunId: string,
  expected?: { domain: string; slug: string },
): ProductionReworkPreviewResult {
  if (!isRecord(value) || value.started !== false) {
    return {
      ok: false,
      message: t("runDetail.rework.errNotStartedUnconfirmed"),
    };
  }
  const seed = isRecord(value.seed) ? value.seed : null;
  const source = seed && isRecord(seed.source) ? seed.source : null;
  const evidence = seed && isRecord(seed.productionEvidence)
    ? seed.productionEvidence
    : null;
  const startRequest = isRecord(value.startRequest) ? value.startRequest : null;
  if (
    !seed ||
    seed.version !== 1 ||
    typeof seed.seedId !== "string" ||
    typeof seed.domain !== "string" ||
    typeof seed.createdAt !== "string" ||
    !source ||
    typeof source.slug !== "string" ||
    typeof source.draftVersionId !== "string" ||
    source.kind !== "promoted_draft_plus_production_evidence" ||
    source.liveManifestMatchedDraft !== true ||
    !evidence ||
    !Array.isArray(evidence.runs) ||
    typeof evidence.total !== "number" ||
    typeof evidence.failed !== "number" ||
    typeof evidence.failureRate !== "number" ||
    !startRequest ||
    startRequest.started !== false ||
    startRequest.domain !== seed.domain ||
    typeof startRequest.goal !== "string" ||
    !startRequest.goal.trim() ||
    !startRequest.goal.includes(seed.seedId)
  ) {
    return {
      ok: false,
      message: t("runDetail.rework.errInvalidStructure"),
    };
  }

  const evidenceRows = evidence.runs.filter(isRecord);
  const computedFailed = evidenceRows.filter(
    (run) => run.status === "failed" || run.status === "cancelled",
  ).length;
  if (
    evidenceRows.length !== evidence.runs.length ||
    evidence.total !== evidenceRows.length ||
    evidence.failed !== computedFailed ||
    Math.abs(
      evidence.failureRate -
        (evidenceRows.length ? computedFailed / evidenceRows.length : 0),
    ) > 0.0001
  ) {
    return {
      ok: false,
      message: t("runDetail.rework.errEvidenceMismatch"),
    };
  }

  const selectedRows = evidenceRows.filter(
    (run) => run.runId === selectedRunId,
  );
  if (selectedRows.length !== 1) {
    return {
      ok: false,
      message: t("runDetail.rework.errRunNotInEvidence"),
    };
  }
  const selected = selectedRows[0]!;
  if (selected.status !== "failed") {
    return {
      ok: false,
      message: t("runDetail.rework.errRunNotFailed"),
    };
  }
  if (
    expected &&
    (seed.domain !== expected.domain || source.slug !== expected.slug)
  ) {
    return {
      ok: false,
      message: t("runDetail.rework.errSeedDomainMismatch"),
    };
  }

  const failedSteps = Array.isArray(selected.steps)
    ? selected.steps
        .filter(
          (step): step is Record<string, unknown> =>
            isRecord(step) &&
            (step.status === "failed" || typeof step.error === "string"),
        )
        .map((step) => ({
          name:
            typeof step.name === "string" && step.name.trim()
              ? redactDomainKnowledge(step.name)
              : t("runDetail.rework.unnamedStep"),
          attempts:
            typeof step.attempts === "number" && Number.isFinite(step.attempts)
              ? Math.max(0, Math.trunc(step.attempts))
              : 0,
          error: stringOrNull(step.error),
        }))
    : [];

  return {
    ok: true,
    preview: {
      seedId: seed.seedId,
      domain: seed.domain,
      slug: source.slug,
      createdAt: seed.createdAt,
      draftVersionId: source.draftVersionId,
      evidenceTotal: evidence.total,
      evidenceFailed: evidence.failed,
      failureRate: evidence.failureRate,
      selectedRun: {
        runId: selectedRunId,
        status: "failed",
        startedAt:
          typeof selected.startedAt === "string" ? selected.startedAt : null,
        durationMs:
          typeof selected.durationMs === "number" ? selected.durationMs : null,
        codeRan:
          typeof selected.codeRan === "boolean" ? selected.codeRan : null,
        error: stringOrNull(selected.error),
        failedSteps,
      },
      startRequest: {
        domain: startRequest.domain,
        goal: startRequest.goal,
        started: false,
      },
    },
  };
}

export function factoryConversationStorageKey(
  tenant: string,
  domain: string,
): string {
  return `ao:factory:conv:${tenant}:${domain}`;
}
