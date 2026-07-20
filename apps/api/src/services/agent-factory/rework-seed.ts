import { createHash } from "node:crypto";
import {
  agentVersions,
  agents,
  and,
  desc,
  eq,
  getDb,
  runSummaries,
  runs,
  steps,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { redactCassetteValue, stableJson } from "@agentic/shared";
import type { AgentDraft, GeneratedAgentSpec } from "@agentic/agent-factory";
import { FsAgentDraftStore } from "./agent-draft-store";
import { buildProductionCodeAttestations, mapToManifest } from "./sandbox-deployer";
import { redactHumanMemorySecrets } from "./human-memory-store";

export type ReworkSeedErrorCode =
  | "draft_not_found"
  | "agent_not_live"
  | "live_draft_mismatch"
  | "production_evidence_not_found";

export class ReworkSeedError extends Error {
  constructor(readonly code: ReworkSeedErrorCode, message: string) {
    super(message);
  }
}

export interface ReworkRunEvidence {
  runId: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  codeRan: boolean | null;
  error: string | null;
  summary: unknown | null;
  steps: Array<{
    ord: number;
    name: string;
    type: string;
    status: string;
    attempts: number;
    durationMs: number | null;
    error: string | null;
  }>;
}

export interface FactoryReworkSeed {
  version: 1;
  seedId: string;
  domain: string;
  createdAt: string;
  source: {
    kind: "promoted_draft_plus_production_evidence";
    draftVersionId: string;
    draftCreatedAt: string;
    slug: string;
    liveAgentVersionId: string;
    liveWorkflowVersion: string;
    liveManifestMatchedDraft: true;
  };
  draft: {
    spec: Omit<GeneratedAgentSpec, "generatedCode">;
    generatedCodeSha256?: string;
  };
  productionEvidence: {
    runs: ReworkRunEvidence[];
    total: number;
    failed: number;
    failureRate: number;
  };
  constraints: string[];
}

const asIso = (value: Date | string | number | null): string | null =>
  value == null ? null : value instanceof Date ? value.toISOString() : new Date(value).toISOString();

function redactReworkValue(value: unknown): unknown {
  const structurallyRedacted = redactCassetteValue(value);
  if (typeof structurallyRedacted === "string") return redactHumanMemorySecrets(structurallyRedacted);
  if (Array.isArray(structurallyRedacted)) return structurallyRedacted.map(redactReworkValue);
  if (!structurallyRedacted || typeof structurallyRedacted !== "object") return structurallyRedacted;
  return Object.fromEntries(Object.entries(structurallyRedacted as Record<string, unknown>).map(([key, item]) => [key, redactReworkValue(item)]));
}

/** Redact credentials recursively and omit generated source from the seed.  A
 * code hash is sufficient to bind provenance; the new conversation can inspect
 * the authenticated draft through the normal draft surface if code is needed. */
function safeDraftSpec(spec: GeneratedAgentSpec): FactoryReworkSeed["draft"] {
  const { generatedCode, ...withoutCode } = spec;
  const redacted = redactReworkValue(withoutCode) as Omit<GeneratedAgentSpec, "generatedCode">;
  return {
    spec: redacted,
    ...(generatedCode
      ? { generatedCodeSha256: createHash("sha256").update(generatedCode, "utf8").digest("hex") }
      : {}),
  };
}

const MANIFEST_PROVENANCE_FIELDS = [
  "id",
  "name",
  "title",
  "description",
  "trigger",
  "triggered_event",
  "retries",
  "ontology_instructions",
  "generated",
  "factory_domain_id",
  "factory_target_domain_id",
  "factory_execution_scope",
  "codeExecuted",
  "tool_use",
  "actions",
  "compensation_event",
] as const;

function manifestContract(value: unknown): Record<string, unknown> {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const contract = Object.fromEntries(
    MANIFEST_PROVENANCE_FIELDS
      .filter((field) => row[field] !== undefined)
      .map((field) => [field, row[field]]),
  );
  if (typeof row.typescript_code === "string") {
    contract.typescript_code_sha256 = createHash("sha256").update(row.typescript_code, "utf8").digest("hex");
  }
  return contract;
}

/** Pure construction step; it does not create a conversation or execute an
 * agent.  Keeping this function pure makes the evidence bundle reviewable and
 * independently testable before a human elects to start the returned request. */
export function buildFactoryReworkSeed(input: {
  domain: string;
  draft: AgentDraft;
  liveAgentVersionId: string;
  liveWorkflowVersion: string;
  evidence: ReworkRunEvidence[];
  createdAt?: string;
}): FactoryReworkSeed {
  if (!input.draft.versionId) throw new ReworkSeedError("draft_not_found", "draft has no immutable version identity");
  if (!input.evidence.length) {
    throw new ReworkSeedError("production_evidence_not_found", "该 agent 尚无非测试生产运行证据，不能构造生产返工 seed。");
  }
  const failed = input.evidence.filter((run) => run.status === "failed" || run.status === "cancelled").length;
  const seedWithoutId = {
    version: 1 as const,
    domain: input.domain,
    createdAt: input.createdAt ?? new Date().toISOString(),
    source: {
      kind: "promoted_draft_plus_production_evidence" as const,
      draftVersionId: input.draft.versionId,
      draftCreatedAt: input.draft.createdAt,
      slug: input.draft.slug,
      liveAgentVersionId: input.liveAgentVersionId,
      liveWorkflowVersion: input.liveWorkflowVersion,
      liveManifestMatchedDraft: true as const,
    },
    draft: safeDraftSpec(input.draft.spec),
    productionEvidence: {
      runs: input.evidence,
      total: input.evidence.length,
      failed,
      failureRate: Number((failed / input.evidence.length).toFixed(4)),
    },
    constraints: [
      "仅针对这个已晋升 agent 做定点返工，不得把 seed 当作重新全量生成整个 domain 的授权。",
      "先根据生产 evidence 定位根因，再修改 draft；任何修改都必须重新经过测试、人工签核与显式晋升。",
      "seed 只包含非测试生产运行的元数据、错误与摘要，不包含事件/步骤输入输出载荷或凭证。",
    ],
  };
  return {
    ...seedWithoutId,
    seedId: `rwk-${createHash("sha256").update(stableJson(seedWithoutId), "utf8").digest("hex").slice(0, 24)}`,
  };
}

export function reworkStartRequest(seed: FactoryReworkSeed): { domain: string; goal: string; started: false } {
  const goal = [
    `[生产返工种子 ${seed.seedId}]`,
    `请基于以下【已晋升 draft + 非测试生产运行证据】对 agent「${seed.source.slug}」做定点返工。`,
    `第一步必须调用 ask_user 询问：「你对 agent『${seed.source.slug}』这次生产问题的人工诊断、复现条件或修复约束是什么？」；拿到人类回答前不得修改 draft。该回答会作为本体域人工记忆立即保存。`,
    "先解释证据指向的根因；只在证据支持时修改；重新验证后停在可审阅 draft，不得自动晋升。",
    JSON.stringify(seed),
  ].join("\n\n");
  return { domain: seed.domain, goal, started: false };
}

export async function createFactoryReworkSeed(opts: {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  slug: string;
  limit?: number;
}): Promise<{ seed: FactoryReworkSeed; startRequest: { domain: string; goal: string; started: false } }> {
  const draftStore = new FsAgentDraftStore({
    tenantId: opts.tenantId,
    tenantSlug: opts.tenantSlug,
    ontologyDomainId: opts.domain,
  });
  const draft = (await draftStore.list(opts.domain)).find((entry) => entry.slug === opts.slug);
  if (!draft) throw new ReworkSeedError("draft_not_found", `找不到当前租户、本体域下的 draft「${opts.slug}」。`);

  const db = getDb();
  const live = db
    .select({
      agentId: agents.id,
      agentVersionId: agentVersions.id,
      manifest: agentVersions.manifestJson,
      workflowVersion: workflowVersions.version,
    })
    .from(agents)
    .innerJoin(workflows, eq(workflows.id, agents.workflowId))
    .innerJoin(agentVersions, eq(agentVersions.agentId, agents.id))
    .innerJoin(workflowVersions, eq(workflowVersions.id, agentVersions.workflowVersionId))
    .where(and(
      eq(workflows.tenantId, opts.tenantId),
      eq(agents.kebabId, opts.slug),
      eq(agents.enabled, true),
    ))
    .orderBy(desc(workflowVersions.createdAt))
    .all()[0];
  if (!live) throw new ReworkSeedError("agent_not_live", `draft「${opts.slug}」当前不是这个租户的 live agent。`);

  if (!draft.versionId || !draft.regression?.suiteFingerprint) {
    throw new ReworkSeedError("live_draft_mismatch", `draft「${opts.slug}」缺少可对账的晋升版本/回归来源。`);
  }
  const expected = mapToManifest([draft.spec], {
    target: "production",
    targetDomainId: opts.domain,
    productionCodeAttestations: buildProductionCodeAttestations([draft.spec]),
    productionProvenance: {
      versionId: draft.versionId,
      suiteFingerprint: draft.regression.suiteFingerprint,
    },
  })[0];
  if (stableJson(manifestContract(live.manifest)) !== stableJson(manifestContract(expected))) {
    throw new ReworkSeedError(
      "live_draft_mismatch",
      `live agent「${opts.slug}」与当前 immutable draft 不一致；无法把该 draft 伪称为当前生产来源，请先选择真实晋升版本。`,
    );
  }

  const limit = Math.min(50, Math.max(1, Math.trunc(opts.limit ?? 20)));
  const runRows = db
    .select({
      id: runs.id,
      status: runs.status,
      startedAt: runs.startedAt,
      endedAt: runs.endedAt,
      durationMs: runs.durationMs,
      codeRan: runs.codeRan,
      errorMessage: runs.errorMessage,
      summary: runSummaries.summaryJson,
    })
    .from(runs)
    .leftJoin(runSummaries, and(eq(runSummaries.runId, runs.id), eq(runSummaries.tenantId, opts.tenantId)))
    .where(and(
      eq(runs.tenantId, opts.tenantId),
      eq(runs.agentId, live.agentId),
      eq(runs.isTest, false),
    ))
    .orderBy(desc(runs.startedAt))
    .limit(limit)
    .all();

  const evidence: ReworkRunEvidence[] = runRows.map((run) => ({
    runId: run.id,
    status: String(run.status),
    startedAt: asIso(run.startedAt),
    endedAt: asIso(run.endedAt),
    durationMs: run.durationMs ?? null,
    codeRan: run.codeRan ?? null,
    error: run.errorMessage ? redactHumanMemorySecrets(run.errorMessage).slice(0, 2_000) : null,
    summary: run.summary == null ? null : redactReworkValue(run.summary),
    steps: db.select({
      ord: steps.ord,
      name: steps.name,
      type: steps.type,
      status: steps.status,
      attempts: steps.attempts,
      durationMs: steps.durationMs,
      error: steps.error,
    }).from(steps).where(eq(steps.runId, run.id)).orderBy(steps.ord).limit(50).all().map((step) => ({
      ...step,
      error: step.error ? redactHumanMemorySecrets(step.error).slice(0, 2_000) : null,
      durationMs: step.durationMs ?? null,
    })),
  }));

  const seed = buildFactoryReworkSeed({
    domain: opts.domain,
    draft,
    liveAgentVersionId: live.agentVersionId,
    liveWorkflowVersion: live.workflowVersion,
    evidence,
  });
  return { seed, startRequest: reworkStartRequest(seed) };
}
