import { promises as fs } from "node:fs";
import path from "node:path";

import {
  assertGeneratedSpecExecutionOwner,
  type GeneratedAgentSpec,
} from "@agentic/agent-factory";
import {
  deployments,
  factoryCodeActAuthorizations,
  getDb,
  workflows,
  workflowVersions,
} from "@agentic/db";
import {
  setProductionGeneratedAgentAuthorizationVerifier,
  productionCodeActManifestSha256,
  type ProductionGeneratedAgentAuthorizationRequest,
  type VerifiedProductionGeneratedAgentAuthorization,
  type ProductionCodeActAuthorizationRequest,
  type VerifiedProductionCodeActAuthorization,
} from "@agentic/runtime";
import { and, eq } from "drizzle-orm";

import { verifyPersistedHumanReviewReceipt } from "./draft-review";
import {
  REGRESSION_ARTIFACT_SCHEMA,
  regressionModuleHash,
  regressionSpecHash,
  regressionSuiteFingerprint,
  type PersistedRegressionArtifact,
} from "./regression-artifact";
import {
  factoryPromotionLedgerDigest,
  factoryPromotionStagedRecordHash,
  readFactoryPromotionRegressionLedger,
  type FactoryPromotionRegressionRecord,
} from "./promotion-regression-ledger";

type JsonRecord = Record<string, unknown>;

const CODEACT_HOST_ERROR_POLICY = [
  {
    when: "meta.codeExecutionError.includes('[terminal]')",
    do: "terminal",
    suppress_emit: true,
  },
  {
    when: "meta.codeExecutionError.includes('[park]')",
    do: "park",
    suppress_emit: true,
  },
  {
    when: "meta.codeExecutionError.includes('[retry]')",
    do: "retry",
    suppress_emit: true,
  },
  { default: "retry", suppress_emit: true },
] as const;

interface PendingActivationGrant {
  promotionId: string;
  deploymentId: string;
  workflowVersionId: string;
}

export interface HistoricalProductionGeneratedAgentAuthorization {
  executionKind: "codeact" | "declarative";
  evidencePromotionId: string;
  tenantId: string;
  tenantSlug: string;
  domainId: string;
  agentSlug: string;
  promotionVersionId: string;
  regressionSuiteFingerprint: string;
  codeSha256: string;
  agentManifestSha256: string;
  evidenceReviewReceiptId: string;
  evidenceReviewSelectionHash: string;
  regressionArtifact: string;
  evidencePromotionRecordHash: string;
}

export type HistoricalProductionCodeActAuthorization =
  HistoricalProductionGeneratedAgentAuthorization;

const pendingActivationGrants = new Map<string, PendingActivationGrant>();

function object(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function deploymentNoteMatchesPromotion(
  note: string | null,
  promotionId: string,
): boolean {
  const marker = `agent-factory-promotion:${promotionId}`;
  return note === marker || note?.startsWith(`${marker};`) === true;
}

function containedFile(base: string, relative: string): string {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
    throw new Error("production CodeAct evidence path is not contained");
  }
  const root = path.resolve(base);
  const target = path.resolve(root, relative);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error("production CodeAct evidence path escapes data root");
  }
  return target;
}

function manifestAgent(
  manifest: unknown,
  slug: string,
): JsonRecord {
  if (!Array.isArray(manifest)) {
    throw new Error("authorized workflow manifest is not an agent array");
  }
  const matches = manifest
    .map(object)
    .filter((agent): agent is JsonRecord => agent?.id === slug);
  if (matches.length !== 1) {
    throw new Error(`authorized workflow must contain exactly one ${slug}`);
  }
  return matches[0]!;
}

function assertManifestExecutionOwner(agent: JsonRecord): void {
  const tools = Array.isArray(agent.tool_use) ? agent.tool_use : [];
  if (tools.length) {
    throw new Error("production CodeAct cannot own tool_use capabilities");
  }
  const bindings = Array.isArray(agent.factory_input_bindings)
    ? agent.factory_input_bindings
    : [];
  if (bindings.some((binding) => object(binding)?.kind === "step_output")) {
    throw new Error("production CodeAct cannot own step_output durability");
  }
  const walk = (actions: unknown[]): void => {
    for (const raw of actions) {
      const action = object(raw);
      if (!action) continue;
      if (["tool", "invoke", "foreach"].includes(String(action.type))) {
        throw new Error(
          `production CodeAct cannot own ${String(action.type)} capability`,
        );
      }
      if (action.on_error !== undefined || action.onError !== undefined) {
        const hostOwned =
          String(action.type) === "logic" &&
          JSON.stringify(action.on_error) ===
            JSON.stringify(CODEACT_HOST_ERROR_POLICY) &&
          action.onError === undefined;
        if (!hostOwned) {
          throw new Error("production CodeAct cannot own error policy");
        }
      }
      if (Array.isArray(action.foreach_actions)) walk(action.foreach_actions);
      if (Array.isArray(action.body)) walk(action.body);
    }
  };
  walk(Array.isArray(agent.actions) ? agent.actions : []);
}

function assertManifestIdentity(
  agent: JsonRecord,
  request: ProductionGeneratedAgentAuthorizationRequest,
): string | undefined {
  const scope = object(agent.factory_execution_scope);
  const code = typeof agent.typescript_code === "string"
    ? agent.typescript_code
    : "";
  if (
    agent.generated !== true ||
    agent.factory_domain_id !== request.domainId ||
    agent.factory_target_domain_id !== request.domainId ||
    agent.factory_promotion_version_id !== request.promotionVersionId ||
    agent.factory_regression_suite_fingerprint !==
      request.regressionSuiteFingerprint ||
    scope?.kind !== "production" ||
    scope.target_domain_id !== request.domainId
  ) {
    throw new Error("production generated-Agent manifest provenance mismatch");
  }
  if (request.executionKind === "declarative") {
    if (
      agent.codeExecuted === true ||
      request.codeSha256 !== productionCodeActManifestSha256(agent)
    ) {
      throw new Error(
        "production declarative Agent manifest identity mismatch",
      );
    }
    return undefined;
  }
  if (agent.codeExecuted !== true || !code) {
    throw new Error("production CodeAct manifest provenance mismatch");
  }
  if (regressionModuleHash(code) !== request.codeSha256) {
    throw new Error("production CodeAct manifest code hash mismatch");
  }
  assertManifestExecutionOwner(agent);
  return code;
}

function assertLedgerCheckpoint(
  snapshot: Awaited<ReturnType<typeof readFactoryPromotionRegressionLedger>>,
): void {
  const invalid = snapshot.committed.filter(
    (entry) => !entry.record || entry.error,
  );
  if (invalid.length || !snapshot.highWatermark || snapshot.highWatermarkError) {
    throw new Error("committed promotion ledger checkpoint is unavailable");
  }
  const records = snapshot.committed.map((entry) => entry.record!);
  if (
    snapshot.highWatermark.committedCount !== records.length ||
    snapshot.highWatermark.ledgerDigest !== factoryPromotionLedgerDigest(records)
  ) {
    throw new Error("committed promotion ledger checkpoint mismatch");
  }
}

function selectPromotionRecord(
  snapshot: Awaited<ReturnType<typeof readFactoryPromotionRegressionLedger>>,
  promotionId: string,
  allowPending: boolean,
  expectedActivation?: Pick<
    typeof factoryCodeActAuthorizations.$inferSelect,
    "deploymentId" | "workflowVersionId"
  >,
): FactoryPromotionRegressionRecord {
  const committed = snapshot.committed.filter(
    (entry) => entry.record?.promotionId === promotionId,
  );
  if (committed.length === 1 && committed[0]!.record) {
    assertLedgerCheckpoint(snapshot);
    return committed[0]!.record;
  }
  const grant = allowPending
    ? pendingActivationGrants.get(promotionId)
    : undefined;
  const pending = snapshot.pending.filter(
    (entry) => entry.record?.promotionId === promotionId,
  );
  if (
    grant &&
    expectedActivation &&
    grant.deploymentId === expectedActivation.deploymentId &&
    grant.workflowVersionId === expectedActivation.workflowVersionId &&
    pending.length === 1 &&
    pending[0]!.record
  ) {
    return pending[0]!.record;
  }
  throw new Error("committed production promotion record is unavailable");
}

async function verifyArtifactAgent(args: {
  dataRoot: string;
  record: FactoryPromotionRegressionRecord;
  request: ProductionGeneratedAgentAuthorizationRequest;
  exactManifestCode?: string;
}): Promise<{
  specHash: string;
  moduleHash: string;
  runtimeCodeHash?: string;
}> {
  const artifactFile = containedFile(args.dataRoot, args.record.artifact);
  const artifact = JSON.parse(
    await fs.readFile(artifactFile, "utf8"),
  ) as PersistedRegressionArtifact;
  if (
    artifact.schema !== REGRESSION_ARTIFACT_SCHEMA ||
    artifact.domain !== args.request.domainId ||
    artifact.versionId !== args.request.promotionVersionId ||
    artifact.suiteFingerprint !== args.request.regressionSuiteFingerprint ||
    regressionSuiteFingerprint(artifact) !== artifact.suiteFingerprint
  ) {
    throw new Error(
      "production generated-Agent regression artifact identity mismatch",
    );
  }
  const entries = artifact.agents.filter(
    (agent) => agent.slug === args.request.agentSlug,
  );
  if (entries.length !== 1) {
    throw new Error(
      "production generated-Agent regression artifact coverage mismatch",
    );
  }
  const entry = entries[0]!;
  const specDocument = JSON.parse(
    await fs.readFile(containedFile(path.dirname(artifactFile), entry.specFile), "utf8"),
  ) as { spec?: GeneratedAgentSpec };
  const spec = specDocument.spec;
  if (
    !spec ||
    spec.slug !== args.request.agentSlug ||
    spec.domainId !== args.request.domainId ||
    regressionSpecHash(spec) !== entry.specHash
  ) {
    throw new Error("production generated-Agent regression spec mismatch");
  }
  if (args.request.executionKind === "declarative") {
    if (
      spec.codeExecuted === true ||
      entry.execution !== "rendered-module" ||
      entry.runtimeCodeFile !== undefined ||
      entry.runtimeCodeHash !== undefined
    ) {
      throw new Error(
        "production declarative Agent regression execution mismatch",
      );
    }
    const renderedModule = await fs.readFile(
      containedFile(path.dirname(artifactFile), entry.moduleFile),
      "utf8",
    );
    if (regressionModuleHash(renderedModule) !== entry.moduleHash) {
      throw new Error(
        "production declarative Agent reviewed module hash mismatch",
      );
    }
    return {
      specHash: entry.specHash,
      moduleHash: entry.moduleHash,
    };
  }
  if (
    spec.codeExecuted !== true ||
    entry.execution !== "codeact-runtime" ||
    !entry.runtimeCodeFile ||
    entry.runtimeCodeHash !== args.request.codeSha256
  ) {
    throw new Error("production CodeAct regression runtime pointer mismatch");
  }
  assertGeneratedSpecExecutionOwner(spec);
  const runtimeCode = await fs.readFile(
    containedFile(path.dirname(artifactFile), entry.runtimeCodeFile),
    "utf8",
  );
  if (
    regressionModuleHash(runtimeCode) !== entry.runtimeCodeHash ||
    runtimeCode !== spec.generatedCode ||
    runtimeCode !== args.exactManifestCode
  ) {
    throw new Error("production CodeAct reviewed runtime bytes mismatch");
  }
  return {
    specHash: entry.specHash,
    moduleHash: entry.moduleHash,
    runtimeCodeHash: entry.runtimeCodeHash,
  };
}

/** Verify DB commit, live deployment, immutable regression bytes and the
 * signed human receipt for either execution mode. Called at bootstrap for all
 * generated Agents and again before every production generated-Agent run. */
export async function verifyDurableProductionGeneratedAgentAuthorization(
  request: ProductionGeneratedAgentAuthorizationRequest,
  purpose: "bootstrap" | "execution" = "execution",
): Promise<VerifiedProductionGeneratedAgentAuthorization> {
  const db = getDb();
  const liveDeployments = db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.tenantId, request.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
      ),
    )
    .all();
  const deployment = liveDeployments[0];
  if (
    liveDeployments.length !== 1 ||
    !deployment ||
    deployment.tenantId !== request.tenantId ||
    deployment.target !== "workflow" ||
    deployment.status !== "live"
  ) {
    throw new Error(
      "production generated-Agent authorization deployment is not live",
    );
  }
  const rows = db
    .select()
    .from(factoryCodeActAuthorizations)
    .where(
      and(
        eq(factoryCodeActAuthorizations.tenantId, request.tenantId),
        eq(factoryCodeActAuthorizations.tenantSlug, request.tenantSlug),
        eq(factoryCodeActAuthorizations.agentSlug, request.agentSlug),
        eq(factoryCodeActAuthorizations.deploymentId, deployment.id),
        eq(factoryCodeActAuthorizations.status, "committed"),
      ),
    )
    .all();
  if (rows.length !== 1) {
    throw new Error(
      "exact durable production generated-Agent authorization is missing",
    );
  }
  const row = rows[0]!;
  if (
    row.domainId !== request.domainId ||
    row.promotionVersionId !== request.promotionVersionId ||
    row.regressionSuiteFingerprint !== request.regressionSuiteFingerprint ||
    row.codeSha256 !== request.codeSha256 ||
    row.agentManifestSha256 !== request.agentManifestSha256 ||
    row.workflowManifestSha256 !== request.workflowManifestSha256 ||
    deployment.versionId !== row.workflowVersionId ||
    !deploymentNoteMatchesPromotion(
      deployment.note,
      row.activationPromotionId,
    )
  ) {
    throw new Error(
      "production generated-Agent authorization deployment is not live",
    );
  }
  const workflowVersion = db
    .select()
    .from(workflowVersions)
    .where(eq(workflowVersions.id, row.workflowVersionId))
    .all()[0];
  if (!workflowVersion) {
    throw new Error(
      "production generated-Agent authorized workflow version is missing",
    );
  }
  const workflow = db
    .select()
    .from(workflows)
    .where(eq(workflows.id, workflowVersion.workflowId))
    .all()[0];
  if (!workflow || workflow.tenantId !== request.tenantId) {
    throw new Error(
      "production generated-Agent workflow tenant binding mismatch",
    );
  }
  const authorizedManifestAgent = manifestAgent(
    workflowVersion.manifestJson,
    request.agentSlug,
  );
  const agentManifestSha256 = productionCodeActManifestSha256(
    authorizedManifestAgent,
  );
  const workflowManifestSha256 = productionCodeActManifestSha256(
    workflowVersion.manifestJson,
  );
  if (
    agentManifestSha256 !== request.agentManifestSha256 ||
    agentManifestSha256 !== row.agentManifestSha256 ||
    workflowManifestSha256 !== request.workflowManifestSha256 ||
    workflowManifestSha256 !== row.workflowManifestSha256
  ) {
    throw new Error(
      "production generated-Agent complete manifest hash mismatch",
    );
  }
  const exactManifestCode = assertManifestIdentity(
    authorizedManifestAgent,
    request,
  );

  const snapshot = await readFactoryPromotionRegressionLedger();
  const evidenceRecord = selectPromotionRecord(
    snapshot,
    row.promotionId,
    purpose === "bootstrap",
    row,
  );
  const activationRecord = selectPromotionRecord(
    snapshot,
    row.activationPromotionId,
    purpose === "bootstrap",
    row,
  );
  if (
    factoryPromotionStagedRecordHash(evidenceRecord) !==
      row.promotionRecordHash ||
    evidenceRecord.tenantId !== row.tenantId ||
    evidenceRecord.tenantSlug !== row.tenantSlug ||
    evidenceRecord.domain !== row.domainId ||
    evidenceRecord.versionId !== row.promotionVersionId ||
    evidenceRecord.suiteFingerprint !== row.regressionSuiteFingerprint ||
    evidenceRecord.reviewReceiptId !== row.reviewReceiptId ||
    evidenceRecord.artifact !== row.regressionArtifact ||
    !evidenceRecord.slugs.includes(row.agentSlug)
  ) {
    throw new Error(
      "production generated-Agent promotion ledger binding mismatch",
    );
  }
  if (
    factoryPromotionStagedRecordHash(activationRecord) !==
      row.activationPromotionRecordHash ||
    activationRecord.tenantId !== row.tenantId ||
    activationRecord.tenantSlug !== row.tenantSlug ||
    activationRecord.domain !== row.activationDomainId ||
    activationRecord.versionId !== row.activationVersionId ||
    activationRecord.reviewReceiptId !== row.activationReviewReceiptId ||
    (activationRecord.deploymentId !== undefined &&
      activationRecord.deploymentId !== row.deploymentId)
  ) {
    throw new Error(
      "production generated-Agent activation ledger binding mismatch",
    );
  }
  const artifactAgent = await verifyArtifactAgent({
    dataRoot: snapshot.dataRoot,
    record: evidenceRecord,
    request,
    exactManifestCode,
  });
  const receipt = await verifyPersistedHumanReviewReceipt({
    domain: row.domainId,
    versionId: row.promotionVersionId,
    receiptId: row.reviewReceiptId,
    selectionHash: row.reviewSelectionHash,
    slugs: evidenceRecord.slugs,
    ctx: { tenantId: row.tenantId, tenantSlug: row.tenantSlug },
  });
  const selected = receipt.selection.filter(
    (entry) => entry.slug === row.agentSlug,
  );
  if (
    selected.length !== 1 ||
    selected[0]!.specHash !== artifactAgent.specHash ||
    selected[0]!.moduleHash !== artifactAgent.moduleHash ||
    (request.executionKind === "codeact"
      ? selected[0]!.runtimeCodeHash !== row.codeSha256 ||
        selected[0]!.runtimeCodeHash !== artifactAgent.runtimeCodeHash
      : selected[0]!.runtimeCodeHash !== undefined) ||
    selected[0]!.regressionSuiteFingerprint !==
      row.regressionSuiteFingerprint
  ) {
    throw new Error(
      "production generated-Agent human review selection mismatch",
    );
  }
  const activationReceipt = await verifyPersistedHumanReviewReceipt({
    domain: row.activationDomainId,
    versionId: row.activationVersionId,
    receiptId: row.activationReviewReceiptId,
    selectionHash: row.activationReviewSelectionHash,
    slugs: activationRecord.slugs,
    ctx: { tenantId: row.tenantId, tenantSlug: row.tenantSlug },
  });
  if (
    activationReceipt.candidateManifestHash !==
    `manifest:v1:${workflowManifestSha256}`
  ) {
    throw new Error(
      "production generated-Agent activation review manifest hash mismatch",
    );
  }
  return {
    executionKind: request.executionKind,
    tenantId: row.tenantId,
    tenantSlug: row.tenantSlug,
    domainId: row.domainId,
    agentSlug: row.agentSlug,
    promotionVersionId: row.promotionVersionId,
    regressionSuiteFingerprint: row.regressionSuiteFingerprint,
    codeSha256: row.codeSha256,
    agentManifestSha256,
    workflowManifestSha256,
    authorizationId: row.id,
    promotionId: row.promotionId,
    activationPromotionId: row.activationPromotionId,
    deploymentId: row.deploymentId,
    workflowVersionId: row.workflowVersionId,
    reviewReceiptId: row.reviewReceiptId,
    activationReviewReceiptId: row.activationReviewReceiptId,
  };
}

export async function verifyDurableProductionCodeActAuthorization(
  request: ProductionCodeActAuthorizationRequest,
  purpose: "bootstrap" | "execution" = "execution",
): Promise<VerifiedProductionCodeActAuthorization> {
  if (request.executionKind !== "codeact") {
    throw new Error(
      "verifyDurableProductionCodeActAuthorization requires executionKind=codeact",
    );
  }
  return verifyDurableProductionGeneratedAgentAuthorization(request, purpose);
}

/** Allow the just-committed DB deployment to bootstrap while its portable
 * filesystem ledger record is still pending final broker activation. This is
 * process-local, exact, non-nestable, and removed immediately after hot-swap. */
export async function withPendingProductionGeneratedAgentActivation<T>(
  grant: PendingActivationGrant | null,
  work: () => Promise<T>,
): Promise<T> {
  if (!grant) return work();
  if (pendingActivationGrants.has(grant.promotionId)) {
    throw new Error(
      "production generated-Agent activation grant is already active",
    );
  }
  pendingActivationGrants.set(grant.promotionId, Object.freeze({ ...grant }));
  try {
    return await work();
  } finally {
    pendingActivationGrants.delete(grant.promotionId);
  }
}

export const withPendingProductionCodeActActivation =
  withPendingProductionGeneratedAgentActivation;

/** Install once during API composition, before any production tenant manifest
 * is bootstrapped or hot-swapped. */
export function installProductionGeneratedAgentAuthorizationVerifier(): void {
  setProductionGeneratedAgentAuthorizationVerifier(
    verifyDurableProductionGeneratedAgentAuthorization,
  );
}

export const installProductionCodeActAuthorizationVerifier =
  installProductionGeneratedAgentAuthorizationVerifier;

/** Focused import gate: prove an unchanged historical generated Agent is still
 * backed by its own live durable authorization. An unrelated promotion cannot
 * mint or carry this authority forward. */
export async function assertHistoricalProductionGeneratedAgentAuthorized(args: {
  tenantId: string;
  tenantSlug: string;
  agent: JsonRecord;
}): Promise<HistoricalProductionGeneratedAgentAuthorization> {
  const db = getDb();
  const live = db
    .select({
      deploymentId: deployments.id,
      workflowVersionId: workflowVersions.id,
      manifestJson: workflowVersions.manifestJson,
    })
    .from(deployments)
    .innerJoin(
      workflowVersions,
      eq(workflowVersions.id, deployments.versionId),
    )
    .where(
      and(
        eq(deployments.tenantId, args.tenantId),
        eq(deployments.target, "workflow"),
        eq(deployments.status, "live"),
      ),
    )
    .all();
  if (live.length !== 1) {
    throw new Error(
      "historical production generated-Agent live deployment is ambiguous",
    );
  }
  const code = typeof args.agent.typescript_code === "string"
    ? args.agent.typescript_code
    : "";
  const agentManifestSha256 = productionCodeActManifestSha256(args.agent);
  const executionKind = args.agent.codeExecuted === true
    ? "codeact" as const
    : "declarative" as const;
  const claims = await verifyDurableProductionGeneratedAgentAuthorization({
    executionKind,
    tenantId: args.tenantId,
    tenantSlug: args.tenantSlug,
    domainId: String(args.agent.factory_domain_id ?? ""),
    agentSlug: String(args.agent.id ?? ""),
    promotionVersionId: String(
      args.agent.factory_promotion_version_id ?? "",
    ),
    regressionSuiteFingerprint: String(
      args.agent.factory_regression_suite_fingerprint ?? "",
    ),
    codeSha256: executionKind === "codeact"
      ? regressionModuleHash(code)
      : agentManifestSha256,
    agentManifestSha256,
    workflowManifestSha256: productionCodeActManifestSha256(
      live[0]!.manifestJson,
    ),
  });
  const row = db
    .select()
    .from(factoryCodeActAuthorizations)
    .where(eq(factoryCodeActAuthorizations.id, claims.authorizationId))
    .all()[0];
  if (
    !row ||
    row.deploymentId !== live[0]!.deploymentId ||
    row.workflowVersionId !== live[0]!.workflowVersionId ||
    row.agentManifestSha256 !== agentManifestSha256
  ) {
    throw new Error(
      "historical production generated-Agent authority changed during import",
    );
  }
  return Object.freeze({
    executionKind,
    evidencePromotionId: row.promotionId,
    tenantId: row.tenantId,
    tenantSlug: row.tenantSlug,
    domainId: row.domainId,
    agentSlug: row.agentSlug,
    promotionVersionId: row.promotionVersionId,
    regressionSuiteFingerprint: row.regressionSuiteFingerprint,
    codeSha256: row.codeSha256,
    agentManifestSha256,
    evidenceReviewReceiptId: row.reviewReceiptId,
    evidenceReviewSelectionHash: row.reviewSelectionHash,
    regressionArtifact: row.regressionArtifact,
    evidencePromotionRecordHash: row.promotionRecordHash,
  });
}

export async function assertHistoricalProductionCodeActAuthorized(args: {
  tenantId: string;
  tenantSlug: string;
  agent: JsonRecord;
}): Promise<HistoricalProductionCodeActAuthorization> {
  if (args.agent.codeExecuted !== true) {
    throw new Error(
      "assertHistoricalProductionCodeActAuthorized requires a CodeAct agent",
    );
  }
  return assertHistoricalProductionGeneratedAgentAuthorized(args);
}

export const __test = {
  pendingActivationGrants,
  assertManifestExecutionOwner,
  assertManifestIdentity,
  deploymentNoteMatchesPromotion,
  verifyArtifactAgent,
};
