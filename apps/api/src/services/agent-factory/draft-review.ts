import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import {
  canonicalEvidenceJson,
  validateGeneratedSpecIntegrationProfiles,
  type AgentDraft,
  type AuthoritativeOntologyEvidence,
  type GeneratedAgentSpec,
} from "@agentic/agent-factory";

import { loadLiveManifest, type TenantCtx } from "../manifest-import";
import { FsAgentDraftStore } from "./agent-draft-store";
import type { RegressionEvidenceQualificationView } from "./agent-draft-store";
import { regressionModuleHash, regressionSpecHash } from "./regression-artifact";
import { buildProductionCodeAttestations, mapToManifest } from "./sandbox-deployer";
import {
  assertAuthoritativeOntologyCurrent,
  sameAuthoritativeOntologyEvidence,
} from "./authoritative-ontology-evidence";
import { makeBoundFactoryOntologySource } from "./bound-ontology-source";
import { currentFactoryExecutionTools } from "./execution-resource-snapshot";
import {
  productionIntegrationProbeIssueMessage,
  verifyProductionIntegrationProbeEvidence,
} from "./production-integration-probe-gate";

export const PROMOTION_PREVIEW_SCHEMA = "agent-factory-promotion-preview/v1" as const;
export const HUMAN_REVIEW_SCHEMA = "agent-factory-human-review/v1" as const;

type JsonRecord = Record<string, unknown>;

export interface PromotionSelectionArtifact {
  slug: string;
  specHash: string;
  /** Exact canonical sandbox evidence identity (code/spec + approved tests,
   * ontology and integration configuration) reviewed for promotion. */
  sandboxEvidenceFingerprint?: string;
  /** Verified-deletion receipt for the one fresh sandbox app that produced the
   * reviewed evidence. This is evidence only and is never a deploy pointer. */
  sandboxCleanupReceiptHash?: string;
  /** Immutable replay suite reviewed alongside this delivery version. */
  regressionSuiteFingerprint?: string;
  /** Exact `GeneratedAgentSpec.generatedCode` bytes destined for manifest.typescript_code. */
  runtimeCodeHash?: string;
  /** Exact immutable rendered delivery module (`versions/<id>/agents/<slug>.ts`). */
  moduleHash: string;
  /** Explicitly shown and HMAC-bound so the reviewer signs the exact
   * authoritative business definition, not only generated code bytes. */
  authoritativeOntology: AuthoritativeOntologyEvidence;
}

export interface PromotionPreview {
  schema: typeof PROMOTION_PREVIEW_SCHEMA;
  tenantId: string;
  domain: string;
  versionId: string;
  slugs: string[];
  selection: PromotionSelectionArtifact[];
  selectionHash: string;
  liveManifestHash: string;
  candidateManifestHash: string;
  previewHash: string;
  reviewChallenge: string;
  delta: {
    agents: { added: string[]; modified: string[]; unchanged: string[]; removed: string[] };
    events: { added: string[]; removed: string[] };
    tools: { added: string[]; removed: string[] };
    config: Array<{ key: string; agentId: string; tool: string; change: "added" | "removed" | "modified"; before?: unknown; after?: unknown }>;
    contracts: Array<{ agentId: string; change: "added" | "modified" | "unchanged"; before?: unknown; after: unknown }>;
  };
  evidence: {
    regressionPointersPresent: boolean;
    replayReady: boolean;
    promotionGateAdmission: boolean;
    promotionEligible: boolean;
    promotionEvidenceReady: boolean;
    promotionBlockers: string[];
    evidenceQualification: RegressionEvidenceQualificationView;
    regressionReplayRequiredAtPromotion: true;
    humanCodeAndDesignSignoffRequired: true;
    authoritativeOntology: AuthoritativeOntologyEvidence;
  };
}

export interface HumanReviewReceipt {
  schema: typeof HUMAN_REVIEW_SCHEMA;
  receiptId: string;
  tenantId: string;
  domain: string;
  versionId: string;
  slugs: string[];
  selection: PromotionSelectionArtifact[];
  selectionHash: string;
  liveManifestHash: string;
  candidateManifestHash: string;
  previewHash: string;
  actor: {
    userId: string;
    email: string | null;
    name: string | null;
    via: "cookie" | "dev";
  };
  attestations: { codeReviewed: true; designReviewed: true };
  createdAt: string;
  signature: string;
}

export interface HumanReviewer {
  userId: string | null;
  email: string | null;
  name: string | null;
  via: "token" | "dev" | "cookie";
}

const interactiveVia = (via: unknown): via is "cookie" | "dev" =>
  via === "cookie" || (via === "dev" && process.env.NODE_ENV !== "production");

const sha256 = (value: unknown): string => createHash("sha256").update(canonicalEvidenceJson(value)).digest("hex");
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const asRecord = (value: unknown): JsonRecord => value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};

function signingSecret(): string {
  const secret = process.env.AGENTIC_REVIEW_SIGNING_SECRET?.trim()
    || process.env.AUTH_SESSION_SECRET?.trim()
    || process.env.SESSION_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "test") return "test-only-agent-factory-review-secret";
  throw new Error("AGENTIC_REVIEW_SIGNING_SECRET or session secret is required for human review receipts");
}

function receiptSignature(body: Omit<HumanReviewReceipt, "signature">): string {
  return createHmac("sha256", signingSecret()).update(canonicalEvidenceJson(body)).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function redacted(value: unknown, parentKey = ""): unknown {
  if (Array.isArray(value)) return value.map((entry) => redacted(entry, parentKey));
  if (!value || typeof value !== "object") {
    if (/(authorization|api[-_]?key|password|secret|token|cookie|credential)/i.test(parentKey) && !/_env$/i.test(parentKey)) return "[REDACTED]";
    if (typeof value === "string" && /^(?:Bearer|Basic)\s+/i.test(value)) return "[REDACTED]";
    if (typeof value === "string" && /^https?:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.username) url.username = "REDACTED";
        if (url.password) url.password = "REDACTED";
        for (const key of [...url.searchParams.keys()]) {
          if (/(api[-_]?key|password|secret|token|credential)/i.test(key)) url.searchParams.set(key, "REDACTED");
        }
        return url.toString();
      } catch { /* preserve a non-URL string */ }
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value as JsonRecord).map(([key, entry]) => [key, redacted(entry, key)]));
}

function agentId(value: unknown): string {
  const row = asRecord(value);
  return typeof row.id === "string" ? row.id : "";
}

function collectEvents(manifest: unknown[]): Set<string> {
  const events = new Set<string>();
  const walkAction = (raw: unknown): void => {
    const action = asRecord(raw);
    if (typeof action.emit_event === "string" && action.emit_event) events.add(action.emit_event);
    if (Array.isArray(action.on_error)) for (const rule of action.on_error) walkAction(rule);
    if (Array.isArray(action.body)) for (const child of action.body) walkAction(child);
  };
  for (const raw of manifest) {
    const agent = asRecord(raw);
    for (const name of [...(Array.isArray(agent.trigger) ? agent.trigger : []), ...(Array.isArray(agent.triggered_event) ? agent.triggered_event : [])]) {
      if (typeof name === "string" && name) events.add(name);
    }
    if (typeof agent.compensation_event === "string" && agent.compensation_event) events.add(agent.compensation_event);
    if (Array.isArray(agent.actions)) for (const action of agent.actions) walkAction(action);
  }
  return events;
}

function toolEntries(manifest: unknown[]): Map<string, { agentId: string; tool: string; config?: unknown }> {
  const entries = new Map<string, { agentId: string; tool: string; config?: unknown }>();
  for (const raw of manifest) {
    const agent = asRecord(raw);
    const id = agentId(agent);
    for (const rawTool of Array.isArray(agent.tool_use) ? agent.tool_use : []) {
      const tool = typeof rawTool === "string" ? rawTool : asRecord(rawTool).name;
      if (typeof tool !== "string" || !tool) continue;
      const config = typeof rawTool === "object" && rawTool ? asRecord(rawTool).config : undefined;
      entries.set(`${id}\0${tool}`, { agentId: id, tool, ...(config && Object.keys(asRecord(config)).length ? { config: redacted(config) } : {}) });
    }
  }
  return entries;
}

function contractOf(agent: unknown): unknown {
  const row = asRecord(agent);
  return redacted({
    trigger: Array.isArray(row.trigger) ? row.trigger : [],
    emit: Array.isArray(row.triggered_event) ? row.triggered_event : [],
    compensationEvent: row.compensation_event,
    inputSchema: row.factory_input_schema,
    outputSchema: row.factory_output_schema,
    objects: row.factory_objects,
    stateBindings: row.factory_state_bindings,
    ruleRefs: row.factory_rule_refs,
    decisionTables: row.factory_decision_tables,
    integrationBindings: row.factory_integration_bindings,
  });
}

export interface DraftPromotionReadiness {
  promotionEligible: boolean;
  blockers: string[];
}

/** Read-only readiness projection for UI/preview. It re-reads the current
 * tenant tool catalog, expanded production profile and HMAC-backed live-probe
 * evidence. The commit path repeats the same checks; this projection is never
 * itself authorization. */
export async function assessDraftPromotionReadiness(input: {
  domain: string;
  drafts: readonly AgentDraft[];
  ctx: TenantCtx;
  promotionGateAdmission: boolean;
}): Promise<DraftPromotionReadiness> {
  if (!input.promotionGateAdmission) {
    return {
      promotionEligible: false,
      blockers: ["不可变沙箱回放尚未取得进入 production commit gate 的服务端资格。"],
    };
  }
  try {
    const specs = input.drafts.map((draft) => draft.spec as GeneratedAgentSpec);
    const tools = await currentFactoryExecutionTools({
      tenantId: input.ctx.tenantId,
      tenantSlug: input.ctx.tenantSlug,
      domainId: input.domain,
    });
    const profile = validateGeneratedSpecIntegrationProfiles({
      specs,
      tools,
      scope: {
        tenantId: input.ctx.tenantId,
        tenantSlug: input.ctx.tenantSlug,
        domainId: input.domain,
      },
      environments: ["production"],
    });
    const blockers = profile.issues.map((issue) => issue.message);
    if (profile.ok) {
      blockers.push(...(await verifyProductionIntegrationProbeEvidence({
        tenantId: input.ctx.tenantId,
        tenantSlug: input.ctx.tenantSlug,
        domainId: input.domain,
        specs,
        tools,
      })).map(productionIntegrationProbeIssueMessage));
    }
    return { promotionEligible: blockers.length === 0, blockers: blockers.slice(0, 12) };
  } catch {
    return {
      promotionEligible: false,
      blockers: ["暂时无法读取或验签当前 production profile/live probe；不会把未知状态当成可上线。"],
    };
  }
}

function configDelta(beforeManifest: unknown[], afterManifest: unknown[]): PromotionPreview["delta"]["config"] {
  const before = toolEntries(beforeManifest);
  const after = toolEntries(afterManifest);
  const changes: PromotionPreview["delta"]["config"] = [];
  for (const key of sorted([...before.keys(), ...after.keys()])) {
    const prior = before.get(key);
    const next = after.get(key);
    if (!prior && next) changes.push({ key, agentId: next.agentId, tool: next.tool, change: "added", after: next.config ?? {} });
    else if (prior && !next) changes.push({ key, agentId: prior.agentId, tool: prior.tool, change: "removed", before: prior.config ?? {} });
    else if (prior && next && sha256(prior.config ?? {}) !== sha256(next.config ?? {})) {
      changes.push({ key, agentId: next.agentId, tool: next.tool, change: "modified", before: prior.config ?? {}, after: next.config ?? {} });
    }
  }
  return changes;
}

async function selectVersion(
  store: FsAgentDraftStore,
  domain: string,
  versionId: string,
  slugs?: string[],
): Promise<{
  drafts: AgentDraft[];
  artifacts: PromotionSelectionArtifact[];
  authoritativeOntology: AuthoritativeOntologyEvidence;
}> {
  const version = await store.getVersion(domain, versionId);
  if (!version.length) throw new Error(`draft version not found: ${versionId}`);
  const authoritativeOntology = version[0]?.regression?.authoritativeOntology;
  if (
    !authoritativeOntology
    || version.some((draft) =>
      !sameAuthoritativeOntologyEvidence(
        draft.regression?.authoritativeOntology,
        authoritativeOntology,
      ))
  ) {
    throw new Error(
      "这个草稿版本缺少一致、可验证的权威 Ontology 证据。请重新执行“预检 → 新建沙箱测试 → 人工审查”。",
    );
  }
  const requested = slugs?.length ? sorted(slugs) : version.map((draft) => draft.slug).sort();
  const drafts = requested.map((slug) => version.find((draft) => draft.slug === slug)).filter((draft): draft is AgentDraft => Boolean(draft));
  const missing = requested.filter((slug) => !drafts.some((draft) => draft.slug === slug));
  if (missing.length) throw new Error(`drafts not found in ${versionId}: ${missing.join(", ")}`);
  if (!drafts.length) throw new Error("promotion selection is empty");
  const artifacts: PromotionSelectionArtifact[] = [];
  for (const draft of drafts) {
    const module = await store.getCode(domain, draft.slug, versionId);
    if (module == null) throw new Error(`draft module not found: ${versionId}/${draft.slug}`);
    const codeBacked = draft.spec.codeExecuted === true;
    if (codeBacked && !draft.spec.generatedCode?.trim()) {
      throw new Error(`production CodeAct requested without generated handler bytes: ${draft.slug}`);
    }
    artifacts.push({
      slug: draft.slug,
      specHash: regressionSpecHash(draft.spec),
      ...(draft.regression?.evidenceFingerprint ? { sandboxEvidenceFingerprint: draft.regression.evidenceFingerprint } : {}),
      ...(draft.regression?.cleanupReceiptHash ? { sandboxCleanupReceiptHash: draft.regression.cleanupReceiptHash } : {}),
      ...(draft.regression?.suiteFingerprint ? { regressionSuiteFingerprint: draft.regression.suiteFingerprint } : {}),
      ...(codeBacked ? { runtimeCodeHash: regressionModuleHash(draft.spec.generatedCode!) } : {}),
      moduleHash: regressionModuleHash(module),
      authoritativeOntology,
    });
  }
  return { drafts, artifacts, authoritativeOntology };
}

/** Purely read-only promotion diff. It does not call manifest-import.validate
 * because validate creates a pending deployment row; preview must have zero
 * deployment side effects. */
export async function previewDraftPromotion(
  domain: string,
  request: { versionId: string; slugs?: string[] },
  ctx: TenantCtx,
): Promise<PromotionPreview> {
  const store = new FsAgentDraftStore({ tenantId: ctx.tenantId, tenantSlug: ctx.tenantSlug, ontologyDomainId: domain });
  const { drafts, artifacts, authoritativeOntology } = await selectVersion(
    store,
    domain,
    request.versionId,
    request.slugs,
  );
  // Re-derive both gates from the immutable bytes on the server. List/API
  // booleans are explanatory projections only and can never authorize review.
  const replay = await store.replayRegression(
    domain,
    artifacts.map((artifact) => artifact.slug),
    request.versionId,
  );
  const replayReady = replay.pass === true;
  const promotionGateAdmission = replayReady && replay.promotionEvidenceReady === true;
  const readiness = await assessDraftPromotionReadiness({
    domain,
    drafts,
    ctx,
    promotionGateAdmission,
  });
  const evidenceQualification: RegressionEvidenceQualificationView = {
    schema: "agent-factory-regression-evidence-qualification/v1",
    replay: replayReady ? "sandbox_verified" : "blocked",
    promotion: promotionGateAdmission ? "candidate" : "blocked",
    blockers: promotionGateAdmission ? [] : [{
      code: replayReady ? "tool_evidence_invalid" : "replay_not_ready",
      detail: replayReady
        ? "不可变沙箱证据尚不能进入独立 production commit gate。"
        : "不可变回归套件尚未完整重放通过。",
    }],
  };
  await assertAuthoritativeOntologyCurrent({
    ontology: makeBoundFactoryOntologySource(ctx.tenantSlug, ctx.tenantId),
    expected: authoritativeOntology,
    scope: {
      tenantId: ctx.tenantId,
      tenantSlug: ctx.tenantSlug,
      domainId: domain,
    },
  });
  const specs = drafts.map((draft) => draft.spec as GeneratedAgentSpec);
  const suiteFingerprints = [...new Set(drafts.map((draft) => draft.regression?.suiteFingerprint).filter((value): value is string => Boolean(value)))];
  if (suiteFingerprints.length !== 1 || drafts.some((draft) => !draft.regression?.suiteFingerprint)) {
    throw new Error("promotion preview requires one immutable regression suite shared by every selected draft");
  }
  const promoted = mapToManifest(specs, {
    target: "production",
    targetDomainId: domain,
    productionCodeAttestations: buildProductionCodeAttestations(specs),
    productionProvenance: {
      versionId: request.versionId,
      suiteFingerprint: suiteFingerprints[0]!,
    },
  });
  const promotedIds = new Set(promoted.map(agentId).filter(Boolean));
  const live = loadLiveManifest(ctx);
  const candidate = [...live.filter((agent) => !promotedIds.has(agentId(agent))), ...promoted];
  const beforeById = new Map(live.map((agent) => [agentId(agent), agent]));
  const afterById = new Map(candidate.map((agent) => [agentId(agent), agent]));

  const added: string[] = [];
  const modified: string[] = [];
  const unchanged: string[] = [];
  const contracts: PromotionPreview["delta"]["contracts"] = [];
  for (const id of sorted(promotedIds)) {
    const before = beforeById.get(id);
    const after = afterById.get(id)!;
    if (!before) added.push(id);
    else if (sha256(before) === sha256(after)) unchanged.push(id);
    else modified.push(id);
    const beforeContract = before ? contractOf(before) : undefined;
    const afterContract = contractOf(after);
    contracts.push({
      agentId: id,
      change: !before ? "added" : sha256(beforeContract) === sha256(afterContract) ? "unchanged" : "modified",
      ...(beforeContract === undefined ? {} : { before: beforeContract }),
      after: afterContract,
    });
  }

  const beforeEvents = collectEvents(live);
  const afterEvents = collectEvents(candidate);
  const beforeTools = new Set([...toolEntries(live).values()].map((entry) => entry.tool));
  const afterTools = new Set([...toolEntries(candidate).values()].map((entry) => entry.tool));
  const addedEvents = sorted([...afterEvents].filter((name) => !beforeEvents.has(name)));
  const removedEvents = sorted([...beforeEvents].filter((name) => !afterEvents.has(name)));
  const addedTools = sorted([...afterTools].filter((name) => !beforeTools.has(name)));
  const removedTools = sorted([...beforeTools].filter((name) => !afterTools.has(name)));
  const config = configDelta(live, candidate);
  if (
    added.length === 0 &&
    modified.length === 0 &&
    addedEvents.length === 0 &&
    removedEvents.length === 0 &&
    addedTools.length === 0 &&
    removedTools.length === 0 &&
    config.length === 0
  ) {
    throw new Error("promotion preview has no changes: this exact draft version is already live");
  }
  const selectionHash = `promotion-selection:v1:${sha256({ tenantId: ctx.tenantId, domain, versionId: request.versionId, artifacts })}`;
  const base = {
    schema: PROMOTION_PREVIEW_SCHEMA,
    tenantId: ctx.tenantId,
    domain,
    versionId: request.versionId,
    slugs: artifacts.map((artifact) => artifact.slug),
    selection: artifacts,
    selectionHash,
    liveManifestHash: `manifest:v1:${sha256(live)}`,
    candidateManifestHash: `manifest:v1:${sha256(candidate)}`,
    delta: {
      agents: { added, modified, unchanged, removed: [] },
      events: { added: addedEvents, removed: removedEvents },
      tools: { added: addedTools, removed: removedTools },
      config,
      contracts,
    },
    evidence: {
      regressionPointersPresent: drafts.every((draft) => draft.versionId === request.versionId && Boolean(draft.regression)),
      replayReady,
      promotionGateAdmission,
      promotionEligible: readiness.promotionEligible,
      promotionEvidenceReady: promotionGateAdmission,
      promotionBlockers: readiness.blockers,
      evidenceQualification,
      regressionReplayRequiredAtPromotion: true as const,
      humanCodeAndDesignSignoffRequired: true as const,
      authoritativeOntology,
    },
  };
  const previewHash = `promotion-preview:v1:${sha256(base)}`;
  return {
    ...base,
    previewHash,
    reviewChallenge: `review-challenge:v1:${sha256({ selectionHash, liveManifestHash: base.liveManifestHash, candidateManifestHash: base.candidateManifestHash, previewHash })}`,
  };
}

export async function createHumanReviewReceipt(args: {
  domain: string;
  versionId: string;
  slugs?: string[];
  reviewChallenge: string;
  decision: "approve_code_and_design";
  codeReviewed: boolean;
  designReviewed: boolean;
  reviewer: HumanReviewer;
  ctx: TenantCtx;
}): Promise<HumanReviewReceipt> {
  if (!args.reviewer.userId || !interactiveVia(args.reviewer.via)) {
    throw new Error("interactive human identity required; API tokens and model assertions cannot sign off");
  }
  if (args.decision !== "approve_code_and_design" || args.codeReviewed !== true || args.designReviewed !== true) {
    throw new Error("both code and design must be explicitly reviewed");
  }
  const preview = await previewDraftPromotion(args.domain, { versionId: args.versionId, slugs: args.slugs }, args.ctx);
  if (args.reviewChallenge !== preview.reviewChallenge) throw new Error("promotion preview changed; fetch and review a fresh preview");
  if (
    !preview.evidence.replayReady
    || !preview.evidence.promotionGateAdmission
    || !preview.evidence.promotionEligible
  ) {
    const state = preview.evidence.replayReady
      ? "沙箱编排已验证，当前不能上线；生产证据还不够，人工签核已禁用。"
      : "这个版本的回归套件还没有完整重放通过，不能进入人工上线审查。";
    throw new Error(
      `${state}${preview.evidence.promotionBlockers.slice(0, 4).join("；") || "请补齐 production profile 与 live probe 后重试。"}`,
    );
  }
  const body: Omit<HumanReviewReceipt, "signature"> = {
    schema: HUMAN_REVIEW_SCHEMA,
    receiptId: `review-${randomUUID()}`,
    tenantId: args.ctx.tenantId,
    domain: args.domain,
    versionId: args.versionId,
    slugs: preview.slugs,
    selection: preview.selection,
    selectionHash: preview.selectionHash,
    liveManifestHash: preview.liveManifestHash,
    candidateManifestHash: preview.candidateManifestHash,
    previewHash: preview.previewHash,
    actor: {
      userId: args.reviewer.userId,
      email: args.reviewer.email,
      name: args.reviewer.name,
      via: args.reviewer.via,
    },
    attestations: { codeReviewed: true, designReviewed: true },
    createdAt: new Date().toISOString(),
  };
  const receipt = { ...body, signature: receiptSignature(body) };
  const store = new FsAgentDraftStore({ tenantId: args.ctx.tenantId, tenantSlug: args.ctx.tenantSlug, ontologyDomainId: args.domain });
  await store.writeReviewReceipt(args.domain, receipt.receiptId, receipt);
  return receipt;
}

export async function verifyHumanReviewReceipt(args: {
  domain: string;
  versionId: string;
  slugs?: string[];
  receiptId: string;
  ctx: TenantCtx;
}): Promise<{ receipt: HumanReviewReceipt; preview: PromotionPreview }> {
  const receipt = await verifyPersistedHumanReviewReceipt({
    domain: args.domain,
    versionId: args.versionId,
    receiptId: args.receiptId,
    ctx: args.ctx,
  });
  const preview = await previewDraftPromotion(args.domain, { versionId: args.versionId, slugs: args.slugs }, args.ctx);
  if (
    receipt.selectionHash !== preview.selectionHash
    || receipt.liveManifestHash !== preview.liveManifestHash
    || receipt.candidateManifestHash !== preview.candidateManifestHash
    || receipt.previewHash !== preview.previewHash
    || canonicalEvidenceJson(receipt.selection) !== canonicalEvidenceJson(preview.selection)
  ) {
    throw new Error("human review receipt is stale for the selected draft or current live manifest");
  }
  return { receipt, preview };
}

/** Verify an immutable historical review receipt without recomputing a
 * preview against today's live manifest. Runtime authorization uses this at
 * bootstrap: the HMAC, actor, signed selection and exact scope remain
 * authoritative, while current-live deltas are intentionally irrelevant. */
export async function verifyPersistedHumanReviewReceipt(args: {
  domain: string;
  versionId: string;
  receiptId: string;
  selectionHash?: string;
  slugs?: string[];
  ctx: TenantCtx;
}): Promise<HumanReviewReceipt> {
  const store = new FsAgentDraftStore({
    tenantId: args.ctx.tenantId,
    tenantSlug: args.ctx.tenantSlug,
    ontologyDomainId: args.domain,
  });
  const receipt = await store.readReviewReceipt<HumanReviewReceipt>(
    args.domain,
    args.receiptId,
  );
  if (!receipt || receipt.schema !== HUMAN_REVIEW_SCHEMA) {
    throw new Error("human code/design sign-off receipt not found");
  }
  const { signature, ...body } = receipt;
  if (!safeEqual(signature, receiptSignature(body))) {
    throw new Error("human review receipt signature mismatch");
  }
  if (
    receipt.tenantId !== args.ctx.tenantId ||
    receipt.domain !== args.domain ||
    receipt.versionId !== args.versionId ||
    receipt.receiptId !== args.receiptId
  ) {
    throw new Error("human review receipt scope mismatch");
  }
  const actor = asRecord(receipt.actor);
  const attestations = asRecord(receipt.attestations);
  if (
    !actor.userId ||
    !interactiveVia(actor.via) ||
    attestations.codeReviewed !== true ||
    attestations.designReviewed !== true
  ) {
    throw new Error(
      "human review receipt lacks interactive code/design sign-off",
    );
  }
  if (args.selectionHash && receipt.selectionHash !== args.selectionHash) {
    throw new Error("human review receipt selection hash mismatch");
  }
  if (args.slugs) {
    const expected = sorted(args.slugs);
    if (
      canonicalEvidenceJson(sorted(receipt.slugs)) !==
      canonicalEvidenceJson(expected)
    ) {
      throw new Error("human review receipt selected agents mismatch");
    }
  }
  return receipt;
}
