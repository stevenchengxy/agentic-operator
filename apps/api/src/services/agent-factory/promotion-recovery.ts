import { canonicalEvidenceJson } from "@agentic/agent-factory";

import {
  abortPendingFactoryPromotionRegression,
  factoryPromotionDeploymentNote,
  finalizePendingFactoryPromotionRegression,
  readFactoryPromotionRegressionLedger,
  type FactoryPromotionRegressionRecord,
} from "./promotion-regression-ledger";
import {
  readFactoryProductionDeploymentRows,
  type FactoryProductionDeploymentRow,
} from "./production-regression-inventory";

export interface FactoryPromotionRecoveryResult {
  pendingSeen: number;
  finalized: number;
  abortedBeforeCommit: number;
  retained: number;
  failures: number;
  errors: string[];
  /** Deployment rows that must remain as immutable CI/audit anchors even
   * after they are rolled back by a later workflow version. */
  protectedDeploymentIds: string[];
}

export interface FactoryPromotionRecoveryOptions {
  dataRoot?: string;
  deployments?: FactoryProductionDeploymentRow[];
  /** Startup owns the process before it accepts traffic, so a valid stage
   * with no matching deployment is provably a pre-commit crash and may be
   * removed. A live multi-process diagnostic call leaves it pending. */
  startupExclusive?: boolean;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function manifestAgents(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(object)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
}

function agentMatchesPromotion(
  agent: Record<string, unknown>,
  pending: FactoryPromotionRegressionRecord,
  slug: string,
): boolean {
  const scope = object(agent.factory_execution_scope);
  return (
    agent.id === slug &&
    agent.generated === true &&
    agent.factory_domain_id === pending.domain &&
    agent.factory_target_domain_id === pending.domain &&
    agent.factory_promotion_version_id === pending.versionId &&
    agent.factory_regression_suite_fingerprint === pending.suiteFingerprint &&
    scope?.kind === "production" &&
    scope.target_domain_id === pending.domain
  );
}

function deploymentMatchesPromotion(
  deployment: FactoryProductionDeploymentRow,
  pending: FactoryPromotionRegressionRecord,
): boolean {
  if (
    deployment.tenantId !== pending.tenantId ||
    deployment.tenantSlug !== pending.tenantSlug ||
    deployment.target !== "workflow" ||
    (deployment.status !== "live" && deployment.status !== "rolled_back")
  ) {
    return false;
  }
  const agents = manifestAgents(deployment.manifest);
  return pending.slugs.every((slug) =>
    agents.some((agent) => agentMatchesPromotion(agent, pending, slug)),
  );
}

function deploymentTime(value: FactoryProductionDeploymentRow): number {
  if (value.deployedAt instanceof Date) return value.deployedAt.getTime();
  if (typeof value.deployedAt === "string") {
    const parsed = Date.parse(value.deployedAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.POSITIVE_INFINITY;
}

function selectOriginalDeployment(
  pending: FactoryPromotionRegressionRecord,
  deployments: FactoryProductionDeploymentRow[],
  committedDeploymentId?: string,
): FactoryProductionDeploymentRow | null {
  if (committedDeploymentId) {
    const exact = deployments.find(
      (deployment) => deployment.deploymentId === committedDeploymentId,
    );
    if (!exact || !deploymentMatchesPromotion(exact, pending)) {
      throw new Error(
        "partially committed promotion is not anchored to its exact production deployment",
      );
    }
    return exact;
  }

  const marker = factoryPromotionDeploymentNote(pending.promotionId);
  const marked = deployments.filter((deployment) => deployment.note === marker);
  if (marked.length > 1) {
    throw new Error("promotion deployment marker is not unique");
  }
  if (marked.length === 1) {
    if (!deploymentMatchesPromotion(marked[0]!, pending)) {
      throw new Error(
        "promotion deployment marker exists but its manifest provenance does not match",
      );
    }
    return marked[0]!;
  }

  // Compatibility for promotions committed before deployment notes were
  // introduced. A later additive deployment may still contain the same
  // origin, so select the earliest matching commit at/after the stage time.
  const stagedAt = Date.parse(pending.stagedAt);
  const candidates = deployments
    .filter((deployment) => deploymentMatchesPromotion(deployment, pending))
    .filter((deployment) => {
      const at = deploymentTime(deployment);
      return !Number.isFinite(at) || !Number.isFinite(stagedAt) || at >= stagedAt - 5_000;
    })
    .sort((left, right) =>
      deploymentTime(left) - deploymentTime(right) ||
      left.deploymentId.localeCompare(right.deploymentId),
    );
  if (!candidates.length) return null;
  const firstTime = deploymentTime(candidates[0]!);
  if (
    candidates.length > 1 &&
    firstTime === deploymentTime(candidates[1]!) &&
    !Number.isFinite(firstTime)
  ) {
    throw new Error(
      "legacy pending promotion matches multiple deployments without timestamps",
    );
  }
  return candidates[0]!;
}

/**
 * Reconcile the only unavoidable distributed-transaction gap in promotion:
 * the target tenant manifest/DB/Inngest activation can commit immediately
 * before the regression catalog checkpoint. No code is regenerated here. We
 * use exact manifest provenance plus the durable promotion marker to either
 * finish the ledger or remove a stage that never crossed the commit boundary.
 */
export async function reconcilePendingFactoryPromotions(
  options: FactoryPromotionRecoveryOptions = {},
): Promise<FactoryPromotionRecoveryResult> {
  const snapshot = await readFactoryPromotionRegressionLedger(options.dataRoot);
  const deployments = options.deployments ?? readFactoryProductionDeploymentRows();
  const committedByPromotion = new Map(
    snapshot.committed.flatMap((entry) =>
      entry.record?.deploymentId
        ? [[entry.record.promotionId, entry.record.deploymentId] as const]
        : [],
    ),
  );
  const result: FactoryPromotionRecoveryResult = {
    pendingSeen: snapshot.pending.length,
    finalized: 0,
    abortedBeforeCommit: 0,
    retained: 0,
    failures: 0,
    errors: [],
    protectedDeploymentIds: snapshot.committed.flatMap((entry) =>
      entry.record?.deploymentId ? [entry.record.deploymentId] : [],
    ),
  };

  for (const entry of snapshot.pending) {
    if (!entry.record || entry.error) {
      result.failures++;
      result.errors.push("pending promotion record is invalid");
      continue;
    }
    const pending = entry.record;
    try {
      const deployment = selectOriginalDeployment(
        pending,
        deployments,
        committedByPromotion.get(pending.promotionId),
      );
      if (!deployment) {
        if (options.startupExclusive === true) {
          await abortPendingFactoryPromotionRegression(
            pending.promotionId,
            options.dataRoot,
          );
          result.abortedBeforeCommit++;
        } else {
          result.retained++;
        }
        continue;
      }
      const committed = await finalizePendingFactoryPromotionRegression(
        pending.promotionId,
        deployment.deploymentId,
        options.dataRoot,
      );
      if (
        committed.tenantId !== pending.tenantId ||
        canonicalEvidenceJson(committed.slugs) !==
          canonicalEvidenceJson(pending.slugs)
      ) {
        throw new Error("recovered promotion identity changed during finalize");
      }
      result.finalized++;
      result.protectedDeploymentIds.push(deployment.deploymentId);
    } catch (error) {
      result.failures++;
      result.errors.push(
        String((error as Error)?.message ?? error).slice(0, 240),
      );
    }
  }

  result.protectedDeploymentIds = [
    ...new Set(result.protectedDeploymentIds),
  ].sort();
  return result;
}

