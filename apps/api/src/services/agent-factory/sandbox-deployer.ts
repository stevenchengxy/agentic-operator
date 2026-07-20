// SandboxDeployer port impls.
//
// ManifestSandboxDeployer: the REAL deploy — maps the
// generated specs to the runtime WorkflowManifest, commits them to an ISOLATED sandbox
// tenant via the manifest-import service (writes models/<sb>/workflow.json + DB +
// reregisters Inngest functions), fires the entry event, polls the runs table, then
// tears the sandbox back down. Needs the Inngest stack (pnpm dev) for execution to be
// observed; the deploy itself (functions registered) is verifiable from the commit.

import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import type { SandboxDeployer, SandboxDeployResult, SandboxCleanupReceipt, SandboxBrokerRegistrationProof, GeneratedAgentSpec, OntologyAction, AgentRunIO, FunctionTesterEntry, TestCase } from "@agentic/agent-factory";
import { SANDBOX_CLEANUP_RECEIPT_SCHEMA, SANDBOX_BROKER_REGISTRATION_SCHEMA, SandboxLifecycleBlockedError, sandboxCleanupReceiptHash, catalogToolDefinitionHash, declarativeToolDefinitionHash } from "@agentic/agent-factory";
import { compileGraph, verifyGraph, projectInputBinding, projectPlanToActions, verificationPolicy, synthesizeMockExternalAgents, externalInputEvents, caseOutcomeFromRuns, chainVerdictByKind } from "@agentic/agent-factory";
import { loadApprovedFunctionTestCassette, testGeneratedFunction } from "./function-tester-run";
import { getDb, tenants, runs, agents, steps, events, factoryTools, eq, and, desc, asc } from "@agentic/db";
import { gt } from "drizzle-orm";
import { makeId } from "@agentic/shared";
import type { CanonicalCassetteDocument } from "@agentic/shared/cassette";
import { listGlobalTools } from "@agentic/tools";
import type { TenantRegistry } from "@agentic/agent-kit";
import {
  getTenantInngest,
  appIdForTenant,
  deleteFactorySandboxApp,
  disposeTenantInngestClient,
  isFactorySandboxTenant,
  sandboxInngestIsolationStatus,
  tenantInngestConfigStatus,
  initializeFactorySandboxReplayAttempt,
  stageFactorySandboxReplayCassette,
  readFactorySandboxDispatchEvidence,
  removeFactorySandboxReplayAttempt,
  type FactorySandboxExecutionScope,
  type FactorySandboxReplayRef,
  type TargetInngestIsolationIdentity,
} from "@agentic/runtime";
import { validate as miValidate, commit as miCommit, removeTenantModelDirs } from "../manifest-import";
import {
  beginInngestAppDeletion,
  finishInngestAppDeletion,
  forgetInngestSyncEvidence,
  syncTenantApp,
  probeApp,
  verifyTenantAppRegistration,
} from "../inngest-sync";
import { unregisterApp } from "../inngest-registry";
import { getLLMGateway } from "../llm";
import {
  cloneSandboxDeclarativeTools,
  assertSandboxAttemptFence,
  claimSandboxAttemptForCleanup,
  createSandboxAttemptWithTenant,
  deleteSandboxToolClones,
  heartbeatSandboxAttempt,
  listOutstandingSandboxAttempts,
  listReapableSandboxAttempts,
  markSandboxActive,
  markSandboxCleanupFailed,
  markSandboxCleanupPending,
  markSandboxCleanupVerified,
  markSandboxRegistering,
  sandboxAttemptContext,
  sandboxAttemptError,
  sandboxAttemptHeartbeatMs,
  sandboxLeaseFence,
  verifySandboxToolSnapshot,
  type SandboxAttemptStatus,
  type SandboxLeaseFence,
} from "./sandbox-lifecycle-store";
import { drainSandboxRuns } from "./sandbox-run-drain";
import {
  findVerifiedToolProbeReceipt,
  listGlobalToolProbeReceipts,
} from "./tool-probe-store";
import { cassetteConfigHash } from "./cassette-evidence-attestation";
import { FsFactoryFixtureAssetStore } from "./fixture-asset-store";
import {
  containsFactoryFixtureAssetReference,
  materializeFactoryFixturePayload,
} from "./fixture-materializer";
import {
  installFactorySandboxTenantRegistryAlias,
  removeFactorySandboxTenantRegistryAlias,
} from "./sandbox-tenant-registry-alias";

const FAILISH = /FAIL|REJECT|ERROR|CONFLICT|DENIED|FAILED/i;
// A run-row STATUS that means the agent finished (runtime sets `ok`) vs
// failed/aborted. NB: this is the runtime RUN status, NOT the business event (an agent can finish
// `ok` while emitting a fail-BRANCH event — that's a successful execution reaching a fail terminal).
const RUN_DONE = /^ok$|complet/i;
const RUN_FAILED = /fail|cancel|abort|error/i;
type SandboxCase = Pick<TestCase, "entryEvent" | "payload" | "kind" | "expectedEvent"> & { id?: string };

interface SandboxAttemptContext {
  tenantId: string;
  tenantSlug: string;
  appId: string;
  attemptId: string;
  candidateFingerprint: string;
  targetDomainId: string;
  lease: SandboxLeaseFence;
}

interface FunctionTestToolEvidence {
  toolCassettes: Record<string, CanonicalCassetteDocument>;
  blockedToolReasons: Record<string, string>;
  replayRefs: Record<string, FactorySandboxReplayRef>;
}

export interface BundledFunctionTestToolEvidence {
  definitionHash: string;
  schemaHash?: string;
  document?: CanonicalCassetteDocument;
  blockedReason?: string;
}

export interface ManifestSandboxDeployerOptions {
  /** Control-plane-issued nonce from the signed remote job. Local callers
   * omit it and receive a fresh UUID in this process. */
  sandboxAttemptId?: string;
  /** Exact registry version observed by the control plane while constructing
   * the signed bundle.  The runner refuses a different loaded tenant adapter. */
  targetRegistryVersion?: string;
  /** Tool-only, replay-only registry reconstructed from a signed remote
   * bundle when the selected tenant-code artifact is not packaged in the
   * workload image. No untrusted adapter module is loaded. */
  targetReplayRegistry?: TenantRegistry;
  /** Self-contained evidence copied into a signed remote bundle. Presence of
   * this map disables all fallback reads from the runner's local probe store. */
  preloadedEvidenceBySpec?: Record<
    string,
    Record<string, BundledFunctionTestToolEvidence>
  >;
  /** Only the separately authenticated runner sets `promotable`. */
  executionQualification?: "development_only" | "promotable";
  /** Non-secret target identity carried by the signed remote bundle. */
  targetInngestIsolation?: TargetInngestIsolationIdentity;
  /** Control-plane retention fence, always later than the signed bundle and
   * the longest candidate/cleanup window. */
  sandboxTombstoneExpiresAt?: string;
}

type SandboxReplayRefsBySpec = Record<string, Record<string, FactorySandboxReplayRef>>;

/**
 * A tool-free function is not inherently degraded. Deterministic transforms,
 * routing, validation, and event-only orchestration can all be complete without
 * an external tool. Only a spec that generation explicitly marked as a
 * last-resort shell is degraded here; unresolved capabilities, integration
 * readiness, replay evidence, and execution failures have their own gates.
 */
export function explicitlyDegradedAgents(specs: GeneratedAgentSpec[]): string[] {
  return specs
    .filter((spec) => spec.degraded === true)
    .map((spec) => spec.short || spec.nameZh || spec.actionName);
}

function sandboxExecutionScope(ctx: SandboxAttemptContext): FactorySandboxExecutionScope {
  return {
    kind: "sandbox",
    target_domain_id: ctx.targetDomainId,
    candidate_fingerprint: ctx.candidateFingerprint,
    attempt_id: ctx.attemptId,
  };
}

/** Every operation which can mutate or observe remote sandbox state is
 * bracketed by the exact durable lease fence.  A reaper that takes over an
 * expired attempt changes both token and generation, so the old process can
 * neither start another side effect nor treat an in-flight one as successful. */
async function fencedSandboxEffect<T>(
  ctx: SandboxAttemptContext,
  expectedStatuses: SandboxAttemptStatus[],
  effect: () => Promise<T>,
): Promise<T> {
  assertSandboxAttemptFence(ctx.lease, expectedStatuses);
  try {
    return await effect();
  } finally {
    assertSandboxAttemptFence(ctx.lease, expectedStatuses);
  }
}

function functionTestToolNames(spec: GeneratedAgentSpec): string[] {
  const names = new Set<string>();
  for (const name of spec.tools ?? []) if (name.trim()) names.add(name.trim());
  const visit = (plan: GeneratedAgentSpec["plan"]): void => {
    for (const step of plan ?? []) {
      if (step.kind === "tool" && step.tool?.trim()) names.add(step.tool.trim());
      if (step.body?.length) visit(step.body);
    }
  };
  visit(spec.plan);
  return [...names].sort();
}

const LIVE_SANDBOX_ATTEMPTS = new Set<string>();

// ── Real deploy (runtime default) ─────────────────────────────────────────────
export function specsToActions(specs: GeneratedAgentSpec[]): OntologyAction[] {
  // Sub-agents are invoke-only helpers with a SYNTHETIC trigger (`${slug}.invoked`, never event-fired)
  // — exclude them from the event GRAPH so their trigger isn't treated as an entry event (which would
  // pollute entryEvents/fireList/mock-synthesis). They still DEPLOY via mapToManifest (separate path).
  return specs.filter((s) => !(s as { isSubAgent?: boolean }).isSubAgent).map((s) => ({ id: s.slug, name: s.actionName, actor: s.hitl ? ["Human"] : ["Agent"], trigger: s.trigger ?? [], triggered_event: s.emit ?? [], target_objects: s.objects ?? [], tool_use: s.tools ?? [], system_prompt: s.systemPrompt, user_prompt: s.userPrompt }));
}

type Boundary = Array<{ event: string; kind: string }>;
/** #D — boundary-aware chain verdict (redefines 跑通). Threads the user's boundary classification
 *  into the closure check so an external-HANDOFF emit (consumed by an external platform) counts as
 *  a legitimate terminal — NOT a broken chain — and an agent that's only triggered by an externally
 *  sourced event (waiting for an external platform) is exempt from the "must run" count. Only a real
 *  break (kind:"break") or a degraded agent fails the chain. */
export function chainVerdict(specs: GeneratedAgentSpec[], graph: ReturnType<typeof compileGraph>, boundaryEvents?: Boundary, firedEntries?: string[]) {
  const nonBreak = (boundaryEvents ?? []).filter((b) => b.kind !== "break").map((b) => b.event);
  const external = new Set((boundaryEvents ?? []).filter((b) => b.kind === "external").map((b) => b.event));
  const v = verifyGraph(graph, { boundaryEvents: nonBreak });
  const reachable = new Set(v.reachable);
  const internallyProduced = new Set(specs.flatMap((s) => s.emit ?? []));
  // An agent is "externally entered" if EVERY one of its trigger events is sourced from OUTSIDE: not
  // produced by any internal agent AND not in the entry events we actually FIRE in the sandbox — i.e.
  // it waits for an external platform to send its trigger. A legitimate non-run, exempt from the
  // "must run" count. (Falls back to the graph's entry events when no fired set is given.)
  const fired = new Set(firedEntries && firedEntries.length ? firedEntries : graph.entryEvents);
  const externallyEntered = new Set(
    specs
      .filter((s) => (s.trigger ?? []).length > 0 && (s.trigger ?? []).every((t) => !internallyProduced.has(t) && !fired.has(t)))
      .map((s) => s.actionName),
  );
  // Sub-agents are invoke-only helpers (synthetic trigger, never event-fired) — they don't run as
  // event-chain nodes, so exclude them from expectedToRun (else fullChainRan waits forever for a node
  // that only fires via step.invoke inside its parent).
  const expectedToRun = specs.filter((s) => !externallyEntered.has(s.actionName) && !(s as { isSubAgent?: boolean }).isSubAgent);
  const successTerminals = [...new Set([...graph.terminalEvents, ...external])].filter((e) => !FAILISH.test(e));
  const externalTerminals = specs.filter((s) => (s.emit ?? []).some((e) => external.has(e) && !FAILISH.test(e))).length;
  return { v, reachable, externallyEntered, expectedToRun, successTerminals, externalTerminals };
}

/** External platform inputs are coverage requirements, never payloads the harness may invent. The
 * caller must provide an approved test case for every returned event (with any real values already
 * applied by supply_test_data) before a production sandbox can dispatch. */
export function externalInputCoverageGaps(
  specs: GeneratedAgentSpec[],
  explicitEntryEvents: readonly string[],
): string[] {
  const eventDrivenSpecs = specs.filter(
    (spec) => !(spec as { isSubAgent?: boolean }).isSubAgent,
  );
  return externalInputEvents(eventDrivenSpecs, {
    domainId: specs[0]?.domainId ?? "sandbox",
    firedEntries: [...explicitEntryEvents],
  });
}

export interface SandboxTenantScope { tenantId: string; tenantSlug: string }

/**
 * A fresh, content-labelled identity for one test attempt. `nonce` is injectable
 * only for deterministic unit tests; production callers always use randomUUID.
 * Re-running unchanged code still gets a new app, and modifying code can never
 * reuse the prior app by construction.
 */
export function sandboxTenantSlug(
  domain: string,
  scope: SandboxTenantScope,
  candidateFingerprint: string,
  nonce: string = randomUUID(),
): string {
  const owner = scope?.tenantId ?? `unscoped:${scope?.tenantSlug ?? "local"}`;
  const ownerDigest = createHash("sha256").update(owner).update("\0").update(domain).digest("hex").slice(0, 8);
  const candidateDigest = createHash("sha256").update(candidateFingerprint).digest("hex").slice(0, 8);
  const attemptDigest = createHash("sha256").update(nonce).digest("hex").slice(0, 12);
  return `af-sbx-${ownerDigest}-${candidateDigest}-${attemptDigest}-sb`;
}

export type GeneratedManifestTarget = {
  /**
   * Sandbox execution needs no production receipt. Production CodeAct is emitted
   * only when the caller supplies an exact per-agent code attestation; callers
   * that omit it cannot silently turn a requested code-backed agent declarative.
   */
  target: "production";
  targetDomainId: string;
  /** Durable origin used to reconcile the current live manifest against the
   * committed promotion regression ledger. */
  productionProvenance: {
    versionId: string;
    suiteFingerprint: string;
  };
  productionCodeAttestations?: Readonly<Record<string, {
    allowProduction: true;
    expectedCodeSha256: string;
  }>>;
} | {
  target: "sandbox";
  targetDomainId: string;
  candidateFingerprint: string;
  sandboxAttemptId: string;
  sandboxReplayRefs?: Readonly<SandboxReplayRefsBySpec>;
};

export type ProductionCodeAttestations = NonNullable<
  Extract<GeneratedManifestTarget, { target: "production" }>["productionCodeAttestations"]
>;

/** Derive the runtime attestation from the exact handler bytes that will be
 * serialized into `typescript_code`. This is an identity helper, not a proof
 * issuer: promotion must still verify HMAC review + regression evidence before
 * handing the result to the production mapper/import authorization path. */
export function buildProductionCodeAttestations(specs: GeneratedAgentSpec[]): ProductionCodeAttestations {
  const attestations: Record<string, { allowProduction: true; expectedCodeSha256: string }> = {};
  for (const spec of specs) {
    if (spec.codeExecuted !== true) continue;
    if (!spec.generatedCode?.trim()) {
      throw new Error(`production CodeAct requested without generated handler bytes: ${spec.slug}`);
    }
    attestations[spec.slug] = {
      allowProduction: true,
      expectedCodeSha256: createHash("sha256").update(spec.generatedCode, "utf8").digest("hex"),
    };
  }
  return attestations;
}

/** Map a GeneratedAgentSpec[] to the runtime WorkflowManifest agent array (the deploy
 *  shape manifest-import validates). Unresolved tools are dropped (they'd fail dispatch).
 *  The target is required so a promotion caller cannot accidentally copy the sandbox-only
 *  CodeAct claim into a real tenant. */
export function mapToManifest(specs: GeneratedAgentSpec[], opts: GeneratedManifestTarget): unknown[] {
  const targetDomainId = opts.targetDomainId?.trim();
  if (!targetDomainId) throw new Error("generated manifest targetDomainId is required");
  const wrongDomain = specs.filter((spec) => spec.domainId !== targetDomainId);
  if (wrongDomain.length) {
    throw new Error(
      `generated manifest target domain mismatch: expected ${targetDomainId}, got ${wrongDomain.map((spec) => `${spec.slug}:${spec.domainId}`).join(", ")}`,
    );
  }
  if (opts.target === "sandbox") {
    if (!opts.candidateFingerprint.trim() || !opts.sandboxAttemptId.trim()) {
      throw new Error("sandbox manifest requires candidateFingerprint and sandboxAttemptId");
    }
  } else if (
    !opts.productionProvenance.versionId.trim() ||
    !opts.productionProvenance.suiteFingerprint.startsWith("regression-suite:v1:")
  ) {
    throw new Error("production manifest requires immutable Factory version and regression suite provenance");
  }
  return specs.map((s) => {
    const tools = (s.tools ?? []).filter((t) => !(s.unresolvedTools ?? []).includes(t));
    // `codeExecuted` is the result of compile + security + load + sandbox-run gates. `codeSource`
    // alone is only authorship provenance and must never opt unprobed code into execution.
    const sandboxCodeExecuted = opts.target === "sandbox" && s.codeExecuted === true;
    const productionCodeRequested = opts.target === "production" && s.codeExecuted === true;
    const productionAttestation = productionCodeRequested
      ? opts.productionCodeAttestations?.[s.slug]
      : undefined;
    if (productionCodeRequested) {
      if (!s.generatedCode?.trim()) {
        throw new Error(`production CodeAct requested without generated handler bytes: ${s.slug}`);
      }
      const actual = createHash("sha256").update(s.generatedCode, "utf8").digest("hex");
      if (
        productionAttestation?.allowProduction !== true
        || productionAttestation.expectedCodeSha256 !== actual
      ) {
        throw new Error(`production CodeAct attestation missing or stale for ${s.slug}`);
      }
    }
    const codeExecuted = sandboxCodeExecuted || productionCodeRequested;
    return {
      id: s.slug,
      name: s.short || s.nameZh,
      title: s.nameZh,
      description: (s.designReasoning ?? "").slice(0, 200),
      actor: s.hitl ? ["Human"] : ["Agent"],
      trigger: s.trigger ?? [],
      triggered_event: s.emit ?? [],
      // Agent-level retry budget: the spec's `retries` flows onto the runtime manifest so
      // register.ts stamps it on createFunction (AgentSchema allows 0–10; clamp so an
      // out-of-range brain value can't fail manifest-import validation).
      ...(typeof s.retries === "number" && Number.isFinite(s.retries)
        ? { retries: Math.min(Math.max(Math.trunc(s.retries), 0), 10) }
        : {}),
      ontology_instructions: s.systemPrompt,
      // Generated agent: runtime supplies the default prompt + advertises GLOBAL tools, so it runs
      // without a hand-written tenant prompt package. THIS is what makes generated functions
      // actually execute on Inngest (not just register).
      generated: true,
      // Immutable provenance for additive promotion. A tenant's live manifest
      // may contain agents promoted from several ontology domains after a
      // rebind; runtime tool resolution must use this marker rather than the
      // tenant's current Factory binding.
      factory_domain_id: s.domainId,
      factory_target_domain_id: targetDomainId,
      factory_execution_scope: opts.target === "sandbox"
        ? {
            kind: "sandbox",
            target_domain_id: targetDomainId,
            candidate_fingerprint: opts.candidateFingerprint,
            attempt_id: opts.sandboxAttemptId,
          }
        : { kind: "production", target_domain_id: targetDomainId },
      factory_action_name: s.actionName,
      ...(opts.target === "production" ? {
        factory_promotion_version_id: opts.productionProvenance.versionId,
        factory_regression_suite_fingerprint: opts.productionProvenance.suiteFingerprint,
      } : {}),
      // Reviewable ontology/data contracts travel with the live manifest. They
      // are runtime-pass-through metadata, but promotion preview needs them to
      // show an exact old→new contract delta instead of reducing review to a
      // prompt/code diff.
      ...(s.inputSchema ? { factory_input_schema: s.inputSchema } : {}),
      ...(s.inputBindings?.length ? { factory_input_bindings: s.inputBindings.map(projectInputBinding) } : {}),
      ...((opts.target === "sandbox" ? s.sandboxToolProfileRefs : s.toolProfileRefs)
        && Object.keys((opts.target === "sandbox" ? s.sandboxToolProfileRefs : s.toolProfileRefs)!).length
        ? { factory_tool_profile_refs: opts.target === "sandbox" ? s.sandboxToolProfileRefs : s.toolProfileRefs }
        : {}),
      ...(opts.target === "sandbox" && opts.sandboxReplayRefs?.[s.slug]
        ? { factory_tool_replay_refs: opts.sandboxReplayRefs[s.slug] }
        : {}),
      ...(s.outputSchema ? { factory_output_schema: s.outputSchema } : {}),
      ...(s.objects?.length ? { factory_objects: s.objects } : {}),
      ...(s.stateBindings?.length ? { factory_state_bindings: s.stateBindings } : {}),
      ...(s.ruleRefs?.length ? { factory_rule_refs: s.ruleRefs } : {}),
      ...(s.decisionTables?.length ? { factory_decision_tables: s.decisionTables } : {}),
      ...(s.integrationBindings?.length ? { factory_integration_bindings: s.integrationBindings } : {}),
      // #G — production true is emitted only by an explicit exact-byte attestation supplied after
      // the promotion evidence gates. There is no true→false downgrade for a requested CodeAct spec.
      codeExecuted,
      ...(productionCodeRequested ? {
        code_attestation: {
          allow_production: true,
          expected_sha256: productionAttestation!.expectedCodeSha256,
        },
      } : {}),
      tool_use: tools.map((t) => {
        const authored = (opts.target === "sandbox" ? s.sandboxToolConfigs : s.toolConfigs)?.[t] ?? {};
        const sideEffect = s.toolSideEffects?.[t];
        if (sideEffect !== "read" && sideEffect !== "write" && sideEffect !== "dual" && sideEffect !== "call") {
          throw new Error(`generated tool ${t} is missing reviewed side-effect metadata; ask the user to configure the tool registry/profile instead of guessing from its name`);
        }
        const policy = s.toolPolicies?.[t];
        if (
          !policy ||
          !["read", "compute", "write", "read_write"].includes(policy.operation) ||
          !["none", "sandbox_local", "external"].includes(policy.effectScope) ||
          !["pure", "sandbox_local", "live_external", "requires_attempt_grant"].includes(policy.sandboxPolicy)
        ) {
          throw new Error(`generated tool ${t} is missing reviewed execution-policy metadata; ask the user to select/configure a registry tool or integration profile instead of inferring authorization`);
        }
        const executionPolicy = {
          operation: policy.operation,
          effect_scope: policy.effectScope,
          sandbox_policy: policy.sandboxPolicy,
        };
        return Object.keys(authored).length
          ? { name: t, side_effect: sideEffect, execution_policy: executionPolicy, config: authored }
          : { name: t, side_effect: sideEffect, execution_policy: executionPolicy };
      }),
      typescript_code: s.generatedCode,
      // #SAGA（§6.6）— 补偿事件透传：硬失败时 runtime（register.ts）幂等 emit 它，撤销外部副作用。
      ...(s.compensationEvent ? { compensation_event: s.compensationEvent } : {}),
      // Phase 1 — project the spec's STRUCTURED plan[] into ordered manifest actions (one durable
      // step.run each: tool / condition / invoke / logic), giving the generated agent the per-step
      // durability + branching + soft-fail of a hand-written production agent. When the spec has no
      // plan, this falls back to the legacy single-logic action (a HITL agent still gets its
      // `manual` approval gate first so the runtime's human-approval path actually parks). The
      // descriptive prose `steps[]` remain on the spec for the UI.
      actions: projectPlanToActions(s),
    };
  });
}

export class ManifestSandboxDeployer implements SandboxDeployer {
  private readonly activeAttempts = new Map<string, SandboxAttemptContext>();

  constructor(
    private readonly tenantScope?: SandboxTenantScope,
    private readonly fixtureAssetStore = new FsFactoryFixtureAssetStore(),
    private readonly options: ManifestSandboxDeployerOptions = {},
  ) {
    // manifest-import requires AGENTIC_MODELS_DIR; default it to the repo models dir.
    if (!process.env.AGENTIC_MODELS_DIR) {
      // #AUDIT-FIX(M11) — 旧循环 try/catch 包的是永不抛错的 env 赋值（永远取第一个候选，回退
      // 列表形同虚设）。真判据是目录存在与否；都不存在则明确告警而不是静默乱指。
      const candidates = [path.resolve(process.cwd(), "models"), path.resolve(process.cwd(), "../../models")];
      const hit = candidates.find((c) => { try { return existsSync(c); } catch { return false; } });
      if (hit) process.env.AGENTIC_MODELS_DIR = hit;
      else {
        process.env.AGENTIC_MODELS_DIR = candidates[0]!;
        try { console.warn(`[sandbox] AGENTIC_MODELS_DIR 未配置且候选目录都不存在（${candidates.join(" / ")}）——manifest 导入将失败，请设置 AGENTIC_MODELS_DIR`); } catch { /* best-effort */ }
      }
    }
  }

  private async materializeApprovedTestCases(
    domain: string,
    testCases: SandboxCase[] | undefined,
    conversationId: string | undefined,
  ): Promise<SandboxCase[] | undefined> {
    if (!testCases?.length) return testCases;
    const containsBinding = testCases.some((testCase) => containsFactoryFixtureAssetReference(testCase.payload));
    if (!containsBinding) return testCases;
    if (!this.tenantScope || !conversationId?.trim()) {
      throw new Error("binary fixture scope is missing");
    }
    return Promise.all(testCases.map(async (testCase) => ({
      ...testCase,
      payload: await materializeFactoryFixturePayload({
        payload: testCase.payload,
        caseId: testCase.id ?? "",
        domain,
        conversationId,
        tenantId: this.tenantScope!.tenantId,
        store: this.fixtureAssetStore,
      }),
    })));
  }

  /** Resolve only persisted, definition-bound replay evidence. This method
   * never calls a tool handler or an external URL. Missing evidence is carried
   * into the harness and blocks only if the generated code actually invokes
   * that tool, so a genuinely tool-free branch can still be structurally run. */
  private async functionTestEvidence(
    spec: GeneratedAgentSpec,
    ctx: SandboxAttemptContext,
  ): Promise<FunctionTestToolEvidence> {
    const toolCassettes: Record<string, CanonicalCassetteDocument> = {};
    const blockedToolReasons: Record<string, string> = {};
    const replayRefs: Record<string, FactorySandboxReplayRef> = {};
    const names = functionTestToolNames(spec);
    if (names.length === 0) return { toolCassettes, blockedToolReasons, replayRefs };
    if (this.options.preloadedEvidenceBySpec !== undefined) {
      const supplied = this.options.preloadedEvidenceBySpec[spec.slug] ?? {};
      for (const name of names) {
        const evidence = supplied[name];
        if (!evidence) {
          blockedToolReasons[name] = `签名测试包没有工具「${name}」的定义绑定回放证据；远端 runner 不会读取其它 tenant 的本地 probe 数据补齐。`;
          continue;
        }
        if (evidence.blockedReason || !evidence.document) {
          blockedToolReasons[name] = evidence.blockedReason?.trim()
            || `工具「${name}」没有可用的定义绑定回放证据。`;
          continue;
        }
        const document = evidence.document;
        if (
          document.version !== 1
          || document.tool?.name !== name
          || document.tool?.definitionHash !== evidence.definitionHash
          || (evidence.schemaHash !== undefined
            && document.tool?.schemaHash !== evidence.schemaHash)
          || !document.evidence?.recordedAt
          || !["live-probe", "signed-fixture", "runtime-record"].includes(
            document.evidence.mode ?? "",
          )
          || !document.entries?.some((entry) =>
            entry?.request?.kind === "tool"
            && entry.request.toolName === name
            && typeof entry.request.argsHash === "string"
            && Boolean(entry.response)
            && Object.prototype.hasOwnProperty.call(entry.response, "body"))
        ) {
          blockedToolReasons[name] = `工具「${name}」的签名 cassette 与 bundle 中的定义身份不一致，已阻断执行。`;
          continue;
        }
        toolCassettes[name] = document;
        if (spec.toolPolicies?.[name]?.effectScope !== "external") continue;
        replayRefs[name] = await stageFactorySandboxReplayCassette({
          scope: sandboxExecutionScope(ctx),
          tenantSlug: ctx.tenantSlug,
          toolName: name,
          definitionHash: evidence.definitionHash,
          document,
        });
      }
      return { toolCassettes, blockedToolReasons, replayRefs };
    }
    const clonedRows = getDb()
      .select()
      .from(factoryTools)
      .where(eq(factoryTools.scopeKey, ctx.tenantId))
      .all();
    const cloneByName = new Map(clonedRows.map((row) => [row.name, row]));
    const globalByName = new Map(listGlobalTools().map((tool) => [tool.name, tool]));
    const globalReceipts = this.tenantScope
      ? listGlobalToolProbeReceipts(this.tenantScope.tenantId, ctx.targetDomainId)
      : [];
    const acceptLoaded = async (
      name: string,
      definitionHash: string,
      loaded: ReturnType<typeof loadApprovedFunctionTestCassette>,
    ): Promise<void> => {
      if (!loaded.document) {
        blockedToolReasons[name] = loaded.blockedReason;
        return;
      }
      toolCassettes[name] = loaded.document;
      if (spec.toolPolicies?.[name]?.effectScope !== "external") return;
      replayRefs[name] = await stageFactorySandboxReplayCassette({
        scope: sandboxExecutionScope(ctx),
        tenantSlug: ctx.tenantSlug,
        toolName: name,
        definitionHash,
        document: loaded.document,
      });
    };

    for (const name of names) {
      const clone = cloneByName.get(name);
      if (clone) {
        const definition = {
          name: clone.name,
          method: clone.method,
          urlTemplate: clone.urlTemplate,
          headers: clone.headers ?? undefined,
          bodyTemplate: clone.bodyTemplate ?? undefined,
          requestSpec: clone.requestSpec ?? undefined,
          responseSpec: clone.responseSpec ?? undefined,
          examples: clone.examples ?? undefined,
          sideEffect: clone.sideEffect,
          operation: clone.operation,
          effectScope: clone.effectScope,
          sandboxPolicy: clone.sandboxPolicy,
          paramsSchema: clone.paramsSchema ?? undefined,
          returnsSchema: clone.returnsSchema ?? undefined,
          capabilities: clone.capabilities ?? undefined,
        } as Parameters<typeof declarativeToolDefinitionHash>[0];
        const expectedDefinitionHash = declarativeToolDefinitionHash(
          definition,
          spec.sandboxToolConfigs?.[name] ?? {},
        );
        const receipt = findVerifiedToolProbeReceipt(globalReceipts, {
          toolName: name,
          definitionHash: expectedDefinitionHash,
        });
        if (!receipt) {
          blockedToolReasons[name] = `工具「${name}」没有与这次 sandbox profile/定义一致且未过期的已签名 cassette，本次函数测试已阻断；请用当前 profile 重新 probe。`;
          continue;
        }
        const evidence = receipt.evidence && typeof receipt.evidence === "object"
          ? receipt.evidence
          : {};
        const loaded = loadApprovedFunctionTestCassette({
          toolName: name,
          cassettePath: typeof evidence.cassettePath === "string" ? evidence.cassettePath : "",
          definitionHash: expectedDefinitionHash,
          ...(receipt.schemaHash ? { schemaHash: receipt.schemaHash } : {}),
          ...(this.tenantScope ? {
            trustBinding: {
              tenantId: this.tenantScope.tenantId,
              tenantSlug: this.tenantScope.tenantSlug,
              domainId: ctx.targetDomainId,
              toolName: name,
              definitionHash: expectedDefinitionHash,
              configHash: cassetteConfigHash(spec.sandboxToolConfigs?.[name] ?? {}),
              allowedModes: ["live-probe", "signed-fixture", "runtime-record"],
            },
          } : {}),
        });
        await acceptLoaded(name, expectedDefinitionHash, loaded);
        continue;
      }

      const catalog = globalByName.get(name);
      if (!catalog) {
        blockedToolReasons[name] = `工具「${name}」在这次隔离快照和全局工具目录里都不存在，本次函数测试已阻断。`;
        continue;
      }
      const expectedDefinitionHash = catalogToolDefinitionHash(
        catalog as Parameters<typeof catalogToolDefinitionHash>[0],
        spec.sandboxToolConfigs?.[name] ?? {},
      );
      const receipt = findVerifiedToolProbeReceipt(globalReceipts, {
        toolName: name,
        definitionHash: expectedDefinitionHash,
      });
      if (!receipt) {
        blockedToolReasons[name] = `工具「${name}」没有与这次 sandbox profile/定义一致的已验证 cassette，本次函数测试已阻断；不会调用真实外部系统补测。`;
        continue;
      }
      const evidence = receipt.evidence && typeof receipt.evidence === "object"
        ? receipt.evidence
        : {};
      const loaded = loadApprovedFunctionTestCassette({
        toolName: name,
        cassettePath: typeof evidence.cassettePath === "string" ? evidence.cassettePath : "",
        definitionHash: expectedDefinitionHash,
        ...(receipt.schemaHash ? { schemaHash: receipt.schemaHash } : {}),
        ...(this.tenantScope ? {
          trustBinding: {
            tenantId: this.tenantScope.tenantId,
            tenantSlug: this.tenantScope.tenantSlug,
            domainId: ctx.targetDomainId,
            toolName: name,
            definitionHash: expectedDefinitionHash,
            configHash: cassetteConfigHash(spec.sandboxToolConfigs?.[name] ?? {}),
            allowedModes: ["live-probe", "signed-fixture", "runtime-record"],
          },
        } : {}),
      });
      await acceptLoaded(name, expectedDefinitionHash, loaded);
    }
    return { toolCassettes, blockedToolReasons, replayRefs };
  }

  /** Create (never reuse) the isolated DB tenant for this one attempt. */
  private createTenant(args: {
    domain: string;
    candidateFingerprint: string;
    attemptId: string;
  }): SandboxAttemptContext {
    if (!this.tenantScope) {
      throw new SandboxLifecycleBlockedError({
        code: "target_scope_missing",
        next: "ask_user",
        question: "我还不知道这些 Agent 最终要部署到哪个业务空间，所以不能创建测试 App。请先明确目标 tenant；我不会根据域名、旧部署或示例替你猜。",
        missing: ["target tenant id", "target tenant slug"],
      });
    }
    const slug = sandboxTenantSlug(
      args.domain,
      this.tenantScope,
      args.candidateFingerprint,
      args.attemptId,
    );
    if (!isFactorySandboxTenant(slug)) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_isolation_invalid",
        next: "ask_user",
        question: "沙箱身份没有通过隔离校验，我已停止部署。请检查 Agent Factory 的沙箱身份配置后再试。",
        missing: ["valid ephemeral sandbox identity"],
      });
    }
    const status = tenantInngestConfigStatus(slug);
    if (status.readiness === "blocked" || status.source !== "sandbox_env_refs") {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_config_missing",
        next: "ask_user",
        question: `Inngest 测试环境还没配完整，我不会借用生产的 URL 或密钥。请配置 ${status.missing.join("、") || "独立的 sandbox event/signing key、serve origin 和 broker 配置"} 后再试；密钥只放环境变量，不要发到对话里。`,
        missing: status.missing.length ? status.missing : ["INNGEST_SANDBOX_CONFIG_REFS"],
      });
    }
    if (status.cleanupMode !== "custom_delete_control" || status.deleteControlConfigured !== true) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_unregister_unavailable",
        next: "ask_user",
        question: "当前 Inngest 测试环境没有可调用、可验证的 App 删除控制面。0 个 functions 不等于 App 已删除。请为专用测试 broker 配置 custom_delete_control 的 URL 模板和令牌环境变量；我不会猜 Inngest Cloud/UI 的未公开接口，也不会拿生产凭证尝试。",
        missing: ["sandbox custom delete control URL/token capability"],
      });
    }
    const isolation = sandboxInngestIsolationStatus(
      slug,
      this.tenantScope.tenantSlug,
      this.options.targetInngestIsolation,
    );
    if (!isolation.isolated) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_isolation_invalid",
        next: "ask_user",
        question: `我还不能证明测试 Inngest 与目标 tenant「${this.tenantScope.tenantSlug}」完全隔离，所以没有创建 App。请补齐并确认：${isolation.missing.join("、")}。我不会用生产 broker、密钥或命名空间试跑。`,
        missing: isolation.missing,
      });
    }
    const id = makeId("ten");
    const appId = appIdForTenant(slug);
    let attempt: ReturnType<typeof createSandboxAttemptWithTenant>;
    try {
      attempt = createSandboxAttemptWithTenant({
        attemptId: args.attemptId,
        ownerTenantId: this.tenantScope.tenantId,
        ownerTenantSlug: this.tenantScope.tenantSlug,
        targetDomainId: args.domain,
        candidateFingerprint: args.candidateFingerprint,
        sandboxTenantId: id,
        sandboxTenantSlug: slug,
        appId,
      });
    } catch (error) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_isolation_invalid",
        next: "ask_user",
        question: "临时 App 的持久化生命周期账本没有成功落盘，所以我在远端注册前停下了。请检查数据库迁移 0047 和 SQLite 写入状态；账本恢复前我不会继续创建测试 App。",
        missing: [`durable sandbox attempt ledger: ${sandboxAttemptError(error)}`],
      });
    }
    return {
      tenantId: id,
      tenantSlug: slug,
      appId,
      attemptId: args.attemptId,
      candidateFingerprint: args.candidateFingerprint,
      targetDomainId: args.domain,
      lease: sandboxLeaseFence(attempt),
    };
  }

  private async clearPreviousOrphans(domain: string): Promise<void> {
    if (!this.tenantScope) return;
    let report: SandboxReaperReport;
    let remaining: ReturnType<typeof listOutstandingSandboxAttempts>;
    try {
      report = await reapFactorySandboxOrphans({
        ownerTenantId: this.tenantScope.tenantId,
        targetDomainId: domain,
      });
      remaining = listOutstandingSandboxAttempts({
        ownerTenantId: this.tenantScope.tenantId,
        targetDomainId: domain,
        excludeAttemptIds: LIVE_SANDBOX_ATTEMPTS,
      });
    } catch (error) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        question: "我无法读取或执行旧沙箱的持久化清理账本，因此没有创建新的测试 App。请先修复数据库迁移或沙箱回收器；我不会绕过旧 orphan 继续部署。",
        missing: [`sandbox orphan ledger/reaper: ${sandboxAttemptError(error)}`],
      });
    }
    if (report.failed > 0 || remaining.length > 0) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        question: `还有 ${Math.max(report.failed, remaining.length)} 个旧的临时 Inngest App 没有被验证为已清除，所以我没有创建新 App。请检查专用测试 broker 的删除控制面和缺席回读，然后重试。`,
        missing: [...new Set([
          ...report.failures.map((failure) => failure.error),
          ...remaining.map((row) => `uncleared sandbox attempt ${row.id}`),
        ])].slice(0, 8),
      });
    }
  }

  async deployAndObserve(
    domain: string,
    specs: GeneratedAgentSpec[],
    opts?: {
      testCases?: SandboxCase[];
      boundaryEvents?: Boundary;
      candidateFingerprint?: string;
      fixtureConversationId?: string;
      signal?: AbortSignal;
    },
  ): Promise<SandboxDeployResult> {
    const candidateFingerprint = opts?.candidateFingerprint?.trim();
    if (!candidateFingerprint) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_isolation_invalid",
        next: "ask_user",
        question: "这次候选代码还没有生成不可变指纹，不能部署测试 App。请先重新运行生成/预检，让工厂为当前代码和测试数据生成指纹。",
        missing: ["candidate code/spec fingerprint"],
      });
    }
    let heartbeatMs: number;
    try {
      // Validate lease/heartbeat before creating the tenant or durable row. An
      // invalid interval must not manufacture an orphan outside the finally.
      heartbeatMs = sandboxAttemptHeartbeatMs();
    } catch (error) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_isolation_invalid",
        next: "ask_user",
        question: "沙箱 lease/heartbeat 配置不安全，所以我没有创建测试 App。请把 heartbeat 设为小于 lease 的正整数毫秒值后重试。",
        missing: [sandboxAttemptError(error)],
      });
    }
    let approvedTestCases: SandboxCase[] | undefined;
    try {
      approvedTestCases = await this.materializeApprovedTestCases(domain, opts?.testCases, opts?.fixtureConversationId);
    } catch (error) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_fixture_invalid",
        next: "ask_user",
        question: "已批准测试用例引用的文件不可用、已过期或摘要不一致，所以我没有创建 Inngest 测试 App。请在当前任务重新上传脱敏测试文件并重新批准用例；不要把 base64 粘贴到聊天里。",
        missing: [`valid current-run binary fixture: ${sandboxAttemptError(error)}`],
      });
    }
    await this.clearPreviousOrphans(domain);
    const attemptId = this.options.sandboxAttemptId?.trim() || randomUUID();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(attemptId)) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_isolation_invalid",
        next: "ask_user",
        question: "签名测试任务的 attempt 身份无效，因此 runner 没有创建临时 App。请重新提交这次候选测试；不要复用或手工修改旧任务标识。",
        missing: ["valid signed sandbox attempt id"],
      });
    }
    const ctx = this.createTenant({ domain, candidateFingerprint, attemptId });
    this.activeAttempts.set(ctx.tenantSlug, ctx);
    LIVE_SANDBOX_ATTEMPTS.add(ctx.attemptId);
    let heartbeatFailure: unknown;
    const lifecycleAbort = new AbortController();
    const executionSignal = opts?.signal
      ? AbortSignal.any([opts.signal, lifecycleAbort.signal])
      : lifecycleAbort.signal;
    const heartbeat = setInterval(() => {
      try {
        heartbeatSandboxAttempt(ctx.lease);
      } catch (error) {
        heartbeatFailure = error;
        lifecycleAbort.abort(error);
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    let result: SandboxDeployResult;
    let cleanupReceipt: SandboxCleanupReceipt;
    try {
      try {
        await initializeFactorySandboxReplayAttempt(
          sandboxExecutionScope(ctx),
          ctx.tenantSlug,
        );
      } catch (error) {
        throw new SandboxLifecycleBlockedError({
          code: "sandbox_isolation_invalid",
          next: "ask_user",
          question: "这次临时 App 的证据回放空间没有成功创建，所以我在注册 Inngest 前停下了。请检查本地 data 目录的写入权限和旧 attempt 残留；我不会让完整运行退回真实外部调用。",
          missing: [`attempt-bound replay namespace: ${sandboxAttemptError(error)}`],
        });
      }
      if (this.options.targetRegistryVersion || this.options.targetReplayRegistry) {
        installFactorySandboxTenantRegistryAlias({
          sandboxTenantSlug: ctx.tenantSlug,
          targetTenantSlug: this.tenantScope!.tenantSlug,
          expectedRegistryVersion: this.options.targetRegistryVersion,
          replayRegistry: this.options.targetReplayRegistry,
        });
      }
      try {
        cloneSandboxDeclarativeTools({
          attemptId: ctx.attemptId,
          lease: ctx.lease,
          ownerTenantId: this.tenantScope!.tenantId,
          targetDomainId: domain,
          candidateFingerprint,
          sandboxTenantId: ctx.tenantId,
          specs,
        });
        verifySandboxToolSnapshot(ctx.attemptId);
      } catch (error) {
        throw new SandboxLifecycleBlockedError({
          code: "sandbox_isolation_invalid",
          next: "ask_user",
          question: "目标 tenant 的私有 declarative tools 没有生成完整、可校验的临时快照，所以我在注册 Inngest App 前停下了。请检查 factory_tools 数据和数据库迁移；我不会让沙箱直接读取生产或 shared 源行。",
          missing: [`content-addressed sandbox tool snapshot: ${sandboxAttemptError(error)}`],
        });
      }
      // Run the rendered functions against approved local evidence before the
      // first remote App registration or event dispatch. Missing/mismatched
      // cassette evidence therefore cannot be "repaired" by accidentally
      // calling a live external system during the full Inngest run.
      executionSignal.throwIfAborted();
      const tested = await this.testFunctionModules(specs, approvedTestCases, ctx);
      const functionTester = tested.entries;
      const testerFailures = functionTester.filter((entry) => !entry.pass);
      result = testerFailures.length
        ? {
            appId: ctx.appId,
            functionsRegistered: 0,
            ran: 0,
            deployed: 0,
            reachedSuccessTerminal: false,
            fullChainRan: false,
            degradedAgents: testerFailures.map((entry) => `${entry.short}: ${entry.reasons.join("；") || "函数测试未通过"}`),
            runs: [],
            fingerprint: "",
            simulated: false,
            functionTester,
            toolMode: verificationPolicy().toolMode,
          }
        : await this.deployAttempt(
            domain,
            specs,
            { ...opts, testCases: approvedTestCases, signal: executionSignal },
            ctx,
            functionTester,
            tested.replayRefs,
          );
      try {
        const dispatchEvidence = await readFactorySandboxDispatchEvidence(
          sandboxExecutionScope(ctx),
          ctx.tenantSlug,
        );
        const replayGate = dispatchEvidence.complete && dispatchEvidence.externalLiveCalls === 0;
        result = {
          ...result,
          fullChainRan: result.fullChainRan && replayGate,
          reachedSuccessTerminal: result.reachedSuccessTerminal && replayGate,
          degradedAgents: replayGate
            ? result.degradedAgents
            : [...result.degradedAgents, "沙箱工具调用证据不完整：存在 replay miss 或外部 live call"],
          toolMode: "evidence_replay",
          replayReceipts: dispatchEvidence.replayReceipts,
          sandboxDispatches: dispatchEvidence.dispatches,
          externalLiveCalls: dispatchEvidence.externalLiveCalls,
          sandboxReplayEvidenceComplete: replayGate,
        };
      } catch (error) {
        result = {
          ...result,
          fullChainRan: false,
          reachedSuccessTerminal: false,
          degradedAgents: [
            ...result.degradedAgents,
            `沙箱工具调用证据无法读取：${sandboxAttemptError(error)}`,
          ],
          toolMode: "evidence_replay",
          replayReceipts: [],
          sandboxDispatches: [],
          externalLiveCalls: null,
          sandboxReplayEvidenceComplete: false,
        };
      }
      if (heartbeatFailure) throw heartbeatFailure;
    } finally {
      try {
        // Cleanup can include a bounded run drain and two broker readbacks.
        // Keep renewing the same fenced lease until that entire sequence has
        // either produced a durable receipt or failed closed.
        cleanupReceipt = await this.cleanupAttempt(ctx);
      } finally {
        clearInterval(heartbeat);
      }
    }
    return {
      ...result,
      appId: ctx.appId,
      candidateFingerprint,
      targetDomainId: domain,
      sandboxAttemptId: attemptId,
      sandboxTenantSlug: ctx.tenantSlug,
      cleanupVerified: true,
      cleanupReceipt,
    };
  }

  private async deployAttempt(
    domain: string,
    specs: GeneratedAgentSpec[],
    opts: { testCases?: SandboxCase[]; boundaryEvents?: Boundary; candidateFingerprint?: string; signal?: AbortSignal } | undefined,
    ctx: SandboxAttemptContext,
    functionTester: FunctionTesterEntry[],
    sandboxReplayRefs: SandboxReplayRefsBySpec,
  ): Promise<SandboxDeployResult> {
    const appId = ctx.appId;
    opts?.signal?.throwIfAborted();
    // Surface the verification posture. Non-test runs always use a real model;
    // reads execute live and external writes remain explicitly gated unless the
    // operator opts into live side effects with real test data.
    const vpolicy = verificationPolicy();
    const exactCodeOnly = this.options.executionQualification === "promotable"
      && specs.length > 0
      && specs.every((spec) =>
        spec.codeExecuted === true && Boolean(spec.generatedCode?.trim()));
    console.info(`[sandbox] verification policy — model=${vpolicy.realModel ? "real" : "mock"} tools=${vpolicy.toolMode} budgetTokens=${vpolicy.budgetTokens || "∞(mock)"} judgeBlocking=${vpolicy.judgeIsBlocking}`);
    // #NOMOCK — "real means real": when the policy intends a REAL model but the CONSTRUCTED gateway is
    // the mock (echo) provider (for example from config drift), REFUSE the
    // run — never grade "跑通" against mock completions, which would fabricate a green verdict. Fail
    // closed with a clear reason. NODE_ENV=test legitimately uses the mock model (realModel=false there).
    if (vpolicy.realModel && process.env.NODE_ENV !== "test") {
      let prov = "";
      try { prov = getLLMGateway().defaultProvider; } catch { /* singleton unbuilt — leave empty */ }
      // A remote, no-public-egress runner can still prove an exact CodeAct
      // candidate without a model call: every function below executes the
      // reviewed generated handler bytes and codeRan is checked later. This is
      // not a mock-model pass. Declarative/LLM-backed candidates continue to
      // require a real, separately allowlisted model gateway.
      if (prov === "mock" && !exactCodeOnly) {
        console.warn("[sandbox] ⚠️  拒绝在 MOCK 网关上判定「跑通」——realModel=true 但网关为 mock。");
        return {
          appId, functionsRegistered: 0, ran: 0, deployed: 0,
          reachedSuccessTerminal: false, fullChainRan: false,
          degradedAgents: ["沙箱拒绝：LLM 网关当前为 MOCK（回声、非真实模型），不能据此判定「跑通」。请配置真实 provider，并通过 /health 确认 llmGateway.mock=false 后重试。"],
          runs: [], fingerprint: "", simulated: false,
        };
      }
    }
    // T2 — compute the event graph + the entries we'll fire, then AUTO-SYNTHESIZE mock external-
    // platform agents to close any external handoff (orphan trigger), so the chain runs end-to-end
    // in the isolated sandbox. Mock slugs contain "-mock-" (excluded from the real-deliverable count).
    const graph = compileGraph(specsToActions(specs), { domainId: domain });
    const plannedEntries = (opts?.testCases?.length ? opts.testCases.map((c) => c.entryEvent) : graph.entryEvents).filter(Boolean);
    // #REDESIGN P1b — ZERO mock by default: don't synthesize fake external-platform PRODUCER agents.
    // Instead the external-INPUT events are FIRED as real entries below (real events close the chain).
    // Legacy mock stubs exist only inside the test process. A configuration
    // flag can no longer make fabricated external agents production-reachable.
    const mockExternalEnabled = process.env.NODE_ENV === "test";
    const mockAgents = mockExternalEnabled ? synthesizeMockExternalAgents(specs, { domainId: domain, firedEntries: plannedEntries, terminals: graph.terminalEvents }) : [];
    if (mockAgents.length) console.info(`[sandbox] synthesized ${mockAgents.length} mock external-platform agent(s): ${mockAgents.map((m) => m.slug).join(", ")}`);
    const allSpecs = [...specs, ...mockAgents];
    const manifest = mapToManifest(allSpecs, {
      target: "sandbox",
      targetDomainId: domain,
      candidateFingerprint: ctx.candidateFingerprint,
      sandboxAttemptId: ctx.attemptId,
      sandboxReplayRefs,
    });
    const degradedAgents = explicitlyDegradedAgents(specs);

    // 1) validate → 2) commit (real registration). Block on hard issues.
    const manifestCtx = exactCodeOnly
      ? { ...ctx, manifestValidationMode: "sandbox_exact_code" as const }
      : ctx;
    const preview = await miValidate({ mode: "validate", workflow: manifest, target: "staging", confirm_overwrite: true, conflict_resolutions: [] }, manifestCtx);
    opts?.signal?.throwIfAborted();
    const blocking = preview.issues.filter((i) => i.severity === "error");
    if (blocking.length) {
      return { appId, functionsRegistered: 0, ran: 0, deployed: 0, reachedSuccessTerminal: false, fullChainRan: false, degradedAgents: [...degradedAgents, ...blocking.map((i) => i.message ?? "lint error")], runs: [], fingerprint: "", simulated: false };
    }
    // The durable row already exists. Mark remote_may_exist BEFORE commit so a
    // crash at any point in registration is conservatively reaped on restart.
    verifySandboxToolSnapshot(ctx.attemptId);
    markSandboxRegistering(ctx.lease);
    const committed = await fencedSandboxEffect(
      ctx,
      ["registering"],
      () => miCommit({ mode: "commit", workflow: manifest, target: "staging", confirm_overwrite: true, conflict_resolutions: [], deployment_id: preview.deployment_id }, manifestCtx),
    );
    markSandboxActive(ctx.lease);
    opts?.signal?.throwIfAborted();
    // #INNGEST-FIX(B2) — clamp to ≥0. A failed reregister returns inngest_fns_registered = -1; `?? 0`
    // let -1 slip past the `=== 0` deploy-failed guard (Math.max(0,…) makes it 0 → guard fires →
    // honest "deploy failed" instead of a masked non-zero-but-ran:0.
    const functionsRegistered = Math.max(0, committed.inngest_fns_registered ?? 0);
    const committedManifestFunctionIds = allSpecs.map((spec) => spec.slug);
    if (functionsRegistered !== committedManifestFunctionIds.length) {
      return {
        appId,
        functionsRegistered,
        ran: 0,
        deployed: specs.length,
        reachedSuccessTerminal: false,
        fullChainRan: false,
        degradedAgents,
        runs: [],
        fingerprint: committed.deployment_id ?? "",
        simulated: false,
        appReady: false,
        syncError: `manifest commit reported ${functionsRegistered}/${committedManifestFunctionIds.length} functions`,
        committedManifestFunctionIds,
      };
    }

    // #1 FIX: register the sandbox app with the Inngest dev server. miCommit rebuilds the
    // in-process handler, but the dev server never DISCOVERS the sandbox app unless we PUT its
    // serve URL — without this, fired events route to an app Inngest never saw (silent ran:0).
    // Registration is a hard transport precondition. Continuing after a rejected PUT can execute a
    // stale app version that happens to remain in the broker, which makes a later green verdict lie.
    // #AUDIT-FIX(H2) — 注册失败的诊断曾被三重丢弃（sync 结果丢、readiness 布尔无人消费、
    // 结果类型无字段）→ 大脑只看到 ran:0 并按「事件名没对齐」错误归因死循环。现在全程保留。
    let syncError: string | undefined;
    const syncRes = await fencedSandboxEffect(
      ctx,
      ["active"],
      () => syncTenantApp(ctx.tenantSlug),
    ).catch((e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }));
    if (syncRes && typeof syncRes === "object" && "ok" in syncRes && !(syncRes as { ok: boolean }).ok) {
      syncError = String((syncRes as { error?: unknown }).error ?? "sync failed").slice(0, 240);
      try { console.warn(`[sandbox] Inngest app 注册失败：${syncError}`); } catch { /* best-effort */ }
      return {
        appId,
        functionsRegistered,
        ran: 0,
        deployed: specs.length,
        reachedSuccessTerminal: false,
        fullChainRan: false,
        degradedAgents,
        runs: [],
        fingerprint: committed.deployment_id ?? "",
        simulated: false,
        appReady: false,
        syncError,
        fires: [],
        committedManifestFunctionIds,
        mockExternalAgents: mockAgents.map((m) => m.slug),
        toolMode: vpolicy.toolMode,
      };
    }
    // Readiness poll (replaces a blind fixed sleep): wait until the Inngest dev server has actually
    // introspected the sandbox app and registered its functions, so the events we fire next route
    // to live triggers instead of an app Inngest hasn't finished discovering (the silent ran:0).
    const brokerRegistration = await fencedSandboxEffect(
      ctx,
      ["active"],
      () => this.readExactBrokerRegistration(
        ctx.tenantSlug,
        committedManifestFunctionIds.length,
        8_000,
        opts?.signal,
      ),
    );
    const appReady = brokerRegistration.verified === true
      && brokerRegistration.connected === true
      && brokerRegistration.observedFunctionCount === committedManifestFunctionIds.length
      && (
        brokerRegistration.evidence === "dev_graphql"
        || (
          process.env.NODE_ENV === "test"
          && process.env.FACTORY_SANDBOX_TEST_REGISTRATION_BYPASS === "1"
          && brokerRegistration.evidence === "test_only_bypass"
        )
      );
    if (!appReady) {
      syncError = brokerRegistration.error
        ?? (brokerRegistration.evidence === "test_only_bypass"
          ? "test-only sync bypass is not an independent Inngest broker registry readback"
          : `Inngest broker did not prove the exact App registry (${brokerRegistration.observedFunctionCount ?? "unknown"}/${committedManifestFunctionIds.length})`);
      return {
        appId,
        functionsRegistered,
        ran: 0,
        deployed: specs.length,
        reachedSuccessTerminal: false,
        fullChainRan: false,
        degradedAgents,
        runs: [],
        fingerprint: committed.deployment_id ?? "",
        simulated: false,
        appReady: false,
        syncError,
        fires: [],
        committedManifestFunctionIds,
        brokerRegistration,
        mockExternalAgents: mockAgents.map((m) => m.slug),
        toolMode: vpolicy.toolMode,
      };
    }

    // 3) fire the entry event(s) — the events consumed but produced by no agent.
    //    Registered functions trigger on `${tenantSlug}/${eventName}` (register.ts:139),
    //    so the fired event name MUST be namespaced to match (the bare name silently
    //    matches nothing → ran:0). Include the canonical envelope (subject + ids).
    const since = new Date();
    // T1 — fire each test case on a DISTINCT subject so its chain is independently attributable
    // (same-event cases used to share `sandbox-${ev}` → collided, no per-case verdict). Carry the
    // case KIND so the outcome is judged per-kind (reject reaching FAIL = pass). Namespaced
    // `${slug}/${ev}` to match the registered triggers.
    const sbSubject = (ev: string) => ev.replace(/[^A-Za-z0-9]/g, "-").slice(0, 24);
    const fireList: Array<{ id?: string; ev: string; payload: Record<string, unknown>; kind?: "pass" | "reject" | "edge" | "fault"; expectedEvent?: string; subject: string }> =
      opts?.testCases && opts.testCases.length
        ? opts.testCases.map((c, i) => ({ ...(c.id ? { id: c.id } : {}), ev: c.entryEvent, payload: c.payload, kind: c.kind, expectedEvent: c.expectedEvent, subject: `sb-${i}-${sbSubject(c.entryEvent)}` }))
        : graph.entryEvents.slice(0, 3).map((ev, i) => ({ ev, payload: {} as Record<string, unknown>, kind: undefined, subject: `sb-${i}-${sbSubject(ev)}` }));
    // Production must never fabricate an external platform callback. Every unproduced trigger needs
    // an explicit approved case (whose payload already contains supply_test_data overrides). Missing
    // coverage is a hard stop, not an empty `{}` event dressed up as a "real" entry.
    if (!mockExternalEnabled) {
      const firedNow = fireList.map((f) => f.ev);
      const uncoveredExternalInputs = externalInputCoverageGaps(specs, firedNow);
      if (uncoveredExternalInputs.length) {
        return {
          appId,
          functionsRegistered,
          ran: 0,
          deployed: specs.length,
          reachedSuccessTerminal: false,
          fullChainRan: false,
          degradedAgents,
          runs: [],
          fingerprint: committed.deployment_id ?? "",
          simulated: false,
          appReady: true,
          fires: [],
          committedManifestFunctionIds,
          brokerRegistration,
          mockExternalAgents: [],
          uncoveredExternalInputs,
          toolMode: vpolicy.toolMode,
        };
      }
    }
    // R2: capture each fire result instead of swallowing it, so a failed send is visible.
    const fires: Array<{ event: string; ok: boolean; error?: string }> = [];
    try {
      const ig = getTenantInngest(ctx.tenantSlug);
      for (const f of fireList) {
        opts?.signal?.throwIfAborted();
        try {
          const eventId = makeId("evt");
          await fencedSandboxEffect(
            ctx,
            ["active"],
            () => ig.send({ id: eventId, name: `${ctx.tenantSlug}/${f.ev}`, data: { ...f.payload, _sandbox: true, _factory: true, subject: f.subject } }),
          );
          fires.push({ event: f.ev, ok: true });
        } catch (e) {
          fires.push({ event: f.ev, ok: false, error: (e as Error).message?.slice(0, 140) });
        }
      }
    } catch {
      for (const f of fireList) fires.push({ event: f.ev, ok: false, error: "Inngest client unavailable" });
    }
    // A partial/ambiguous dispatch is never eligible for chain acceptance. In particular, do not
    // poll and accidentally attribute rows from an older/stale app to this deployment attempt.
    if (fireList.length === 0 || fires.length !== fireList.length || fires.some((fire) => !fire.ok)) {
      return {
        appId,
        functionsRegistered,
        ran: 0,
        deployed: specs.length,
        reachedSuccessTerminal: false,
        fullChainRan: false,
        degradedAgents,
        runs: [],
        fingerprint: committed.deployment_id ?? "",
        simulated: false,
        appReady: true,
        fires,
        committedManifestFunctionIds,
        brokerRegistration,
        mockExternalAgents: mockAgents.map((m) => m.slug),
        toolMode: vpolicy.toolMode,
      };
    }

    // #D + review fixes: boundary-aware verdict. Externally-entered agents are exempt; the gate
    // keys on DISTINCT completed agents (not raw run-row count); externally-entered tool-less agents
    // are NOT counted as degraded; external-handoff emits count as success terminals.
    const cv = chainVerdict(specs, graph, opts?.boundaryEvents, fireList.map((f) => f.ev));
    // 4) poll the runs table for this sandbox tenant (bounded; best-effort).
    const observed = await this.pollRuns(ctx.tenantId, since, cv.expectedToRun.length, undefined, opts?.signal);
    // T1 — per-case attribution: group each fired case's runs by its DISTINCT subject + the event
    // each run emitted (runs⋈events), then judge per kind via chainVerdictByKind. A reject case
    // reaching a FAIL terminal is a PASS — it no longer drags a success-only gate to false.
    const perSubject = await this.pollRunsBySubject(ctx.tenantId, since, fireList.map((f) => f.subject));
    const kinded = fireList.filter((f) => f.kind);
    const rawCaseVerdicts = kinded.length
      ? chainVerdictByKind(kinded.map((f) => caseOutcomeFromRuns(f.kind!, perSubject.get(f.subject) ?? [], { successTerminals: cv.successTerminals, expectedEvent: f.expectedEvent })))
      : undefined;
    const caseVerdicts = rawCaseVerdicts
      ? {
          ...rawCaseVerdicts,
          results: rawCaseVerdicts.results.map((verdict, index) => ({
            ...verdict,
            ...(kinded[index]?.id ? { caseId: kinded[index]!.id } : {}),
          })),
        }
      : undefined;
    const everyCaseObserved = kinded.every((entry) => (perSubject.get(entry.subject)?.length ?? 0) > 0);
    const ranAgent = (s: GeneratedAgentSpec) => observed.completedAgents.has(s.short || s.nameZh); // manifest name = short||nameZh
    const distinctRan = cv.expectedToRun.filter(ranAgent).length;
    const verdictDegraded = explicitlyDegradedAgents(cv.expectedToRun);
    // A run must have ACTUALLY EMITTED a success-terminal event — not merely "the graph defines some
    // success terminal AND any agent ran" (which would be true even for a chain that only emitted FAIL
    // events). This makes reachedSuccessTerminal a trustworthy signal, so the finish gate's
    // "reachedSuccessTerminal && zero-degraded" timing-fallback can't accept a genuinely-broken chain.
    const successTermSet = new Set(cv.successTerminals);
    const emittedSuccess = [...perSubject.values()].flat().some((r) => r.emittedEvent != null && successTermSet.has(r.emittedEvent));
    const reachedSuccessTerminal = emittedSuccess && observed.completedAgents.size > 0;
    // A green suite needs both dimensions: every approved case has an
    // attributable passing verdict, and every statically expected function
    // actually completed somewhere in the suite. A single short branch must
    // never hide an unexecuted sibling/cascade.
    const aggregateChainRan = functionsRegistered > 0 && cv.expectedToRun.every(ranAgent) && observed.failed === 0 && verdictDegraded.length === 0;
    const fullChainRan = aggregateChainRan && (
      caseVerdicts
        ? everyCaseObserved && caseVerdicts.allPass && caseVerdicts.results.length === kinded.length
        : true
    );
    // 5) reconstruct per-agent REAL I/O from the runs (+ agent) rows.
    const agentRuns = this.collectAgentRuns(ctx.tenantId, since, specs, ctx.tenantSlug);
    // #REDESIGN P1 — which agents' GENERATED CODE actually EXECUTED (runs.code_ran=true), not fell
    // back to declarative. The finish gate requires every codeExecuted spec to appear here.
    const codeRanAgents = this.collectCodeRanAgents(ctx.tenantId, since, specs);
    return {
      appId,
      functionsRegistered,
      ran: observed.ran,
      deployed: specs.length,
      reachedSuccessTerminal,
      fullChainRan,
      codeRanAgents,
      degradedAgents: verdictDegraded,
      runs: observed.rows,
      agentRuns,
      fingerprint: committed.deployment_id ?? "",
      simulated: false, // real Inngest registration + run
      appReady, // #AUDIT-FIX(H2)
      ...(syncError ? { syncError } : {}),
      fires,
      committedManifestFunctionIds,
      brokerRegistration,
      internalChains: distinctRan,
      externalTerminals: cv.externalTerminals,
      caseVerdicts,
      mockExternalAgents: mockAgents.map((m) => m.slug),
      functionTester,
      toolMode: vpolicy.toolMode,
    };
  }

  /** #TESTER-WIRE — run the P2.5 function tester over every real deliverable spec: render its
   *  ts_function_module, execute it in isolation (worker/process/container per FACTORY_EXEC_TIER)
   *  against a matching approved test case (or a bare trigger event), grade ran+declared-emit.
   *  Never throws — a tester crash is recorded as a failing entry, not a swallowed pass. */
  private async testFunctionModules(
    specs: GeneratedAgentSpec[],
    testCases: SandboxCase[] | undefined,
    ctx: SandboxAttemptContext,
  ): Promise<{ entries: FunctionTesterEntry[]; replayRefs: SandboxReplayRefsBySpec }> {
    const out: FunctionTesterEntry[] = [];
    const replayRefs: SandboxReplayRefsBySpec = {};
    for (const s of specs) {
      try {
        const evidence = await this.functionTestEvidence(s, ctx);
        replayRefs[s.slug] = evidence.replayRefs;
        const matchingCases = (testCases ?? []).filter((candidate) =>
          (s.trigger ?? []).includes(candidate.entryEvent));
        // Every approved case that can invoke this function must prove its own
        // actual argsHash. Choosing only the first pass case would let a later
        // reject/fault dispatch reach a live tool without replay evidence.
        const cases: Array<SandboxCase | undefined> = matchingCases.length
          ? matchingCases
          : [undefined];
        const caseRuns = [] as Awaited<ReturnType<typeof testGeneratedFunction>>[];
        for (const kase of cases) {
          const testEvent = { name: kase?.entryEvent ?? s.trigger?.[0] ?? "", data: kase?.payload ?? {} };
          const rejectLike = kase?.kind === "reject" || kase?.kind === "fault";
          const expectedEvent = kase?.expectedEvent ?? (rejectLike ? s.emit?.[s.emit.length - 1] : s.emit?.[0]);
          // The approved case may deterministically select a decision branch, but it can never
          // manufacture an external tool response. Tool calls below replay only definition-bound
          // probe/record cassettes and still have to match the actual argsHash inside the harness.
          const reasonResult = { ok: !rejectLike, pass: !rejectLike, ...(expectedEvent ? { emit: expectedEvent } : {}) };
          caseRuns.push(await testGeneratedFunction(s, {
            testEvent,
            expectEmits: expectedEvent ? [expectedEvent] : undefined,
            tenantSlug: ctx.tenantSlug,
            fixture: {
              toolCassettes: evidence.toolCassettes,
              blockedToolReasons: evidence.blockedToolReasons,
              reasonResult,
              ...(kase?.kind === "fault" ? { allowEvidenceFailures: true } : {}),
            },
          }));
        }
        const fixtureMode = caseRuns.some((run) => run.fixtureMode === "evidence")
          ? "evidence"
          : caseRuns.some((run) => run.fixtureMode === "scripted")
            ? "scripted"
            : "missing";
        out.push({
          short: s.short,
          pass: caseRuns.every((run) => run.verdict.pass),
          ran: caseRuns.every((run) => run.verdict.ran),
          emitNames: caseRuns.flatMap((run) => run.verdict.emitNames),
          reasons: caseRuns.flatMap((run, index) =>
            run.verdict.reasons.map((reason) => `${cases[index]?.kind ?? "structural"}/${cases[index]?.entryEvent ?? s.trigger?.[0] ?? "trigger"}: ${reason}`)),
          tier: caseRuns[0]?.tier ?? "worker",
          qualification: this.options.executionQualification ?? "development_only",
          fixtureMode,
        });
      } catch (e) {
        out.push({
          short: s.short,
          pass: false,
          ran: false,
          emitNames: [],
          reasons: [`tester 异常：${String((e as Error)?.message ?? e).slice(0, 160)}`],
          tier: "worker",
          qualification: this.options.executionQualification ?? "development_only",
        });
      }
    }
    return { entries: out, replayRefs };
  }

  /** T1 — group runs by their (distinct per-case) subject + the event each emitted (runs⋈events),
   *  so deployAndObserve can compute a per-case, per-kind verdict. */
  private async pollRunsBySubject(tenantId: string, since: Date, subjects: string[]): Promise<Map<string, Array<{ status: string; emittedEvent: string | null }>>> {
    const out = new Map<string, Array<{ status: string; emittedEvent: string | null }>>();
    for (const s of subjects) out.set(s, []);
    if (!subjects.length) return out;
    const rows = getDb()
      .select({ subject: runs.subject, status: runs.status, emittedEvent: events.name })
      .from(runs)
      .leftJoin(events, eq(events.id, runs.emittedEventId))
      .where(and(eq(runs.tenantId, tenantId), gt(runs.startedAt, since)))
      .orderBy(desc(runs.startedAt))
      .limit(100)
      .all();
    for (const r of rows) {
      const subj = r.subject ?? "";
      if (!out.has(subj)) continue;
      out.get(subj)!.push({ status: String(r.status), emittedEvent: r.emittedEvent ?? null });
    }
    return out;
  }

  /** Reconstruct per-agent real I/O from the sandbox tenant's runs (joined to the
   *  agent for its name). Payload bodies live behind step artifact refs (not resolved
   *  here); status + trigger subject + real runId are the concrete evidence. */
  /** #REDESIGN P1 — the spec shorts whose GENERATED CODE actually EXECUTED (runs.code_ran=true) in
   *  this window. The finish gate requires every codeExecuted spec to appear here (else the code
   *  fell back to the declarative path and "跑通" is a lie for a code-delivered agent). */
  private collectCodeRanAgents(tenantId: string, since: Date, specs: GeneratedAgentSpec[]): string[] {
    const rows = getDb()
      .select({ agentName: agents.name })
      .from(runs)
      .leftJoin(agents, eq(agents.id, runs.agentId))
      .where(and(eq(runs.tenantId, tenantId), gt(runs.startedAt, since), eq(runs.codeRan, true)))
      .all();
    const ranNames = new Set(rows.map((r) => r.agentName).filter(Boolean) as string[]);
    return specs.filter((s) => ranNames.has(s.short) || ranNames.has(s.nameZh)).map((s) => s.short);
  }

  private collectAgentRuns(tenantId: string, since: Date, specs: GeneratedAgentSpec[], tenantSlug: string): AgentRunIO[] {
    const rows = getDb()
        // review fix (#R3): join the ACTUAL emitted event — outputEvent/outputPayload must be the
        // real emit (which branch fired + the assembled envelope payload), not spec.emit[0] + the
        // last step's raw return value. execution_fidelity grades THIS artifact.
        .select({ runId: runs.id, status: runs.status, subject: runs.subject, agentName: agents.name, emittedEvent: events.name, emittedPayloadRef: events.payloadRef })
        .from(runs)
        .leftJoin(agents, eq(agents.id, runs.agentId))
        .leftJoin(events, eq(events.id, runs.emittedEventId))
        .where(and(eq(runs.tenantId, tenantId), gt(runs.startedAt, since)))
        .orderBy(desc(runs.startedAt))
        .limit(50)
        .all();
    // P4: link to OUR run-record page, NOT the Inngest dashboard. Inngest's /run?runID expects a
    // ULID and chokes on our `run-<hex>` ids ("ulid: bad data size"). The portal run page is
    // tenant-scoped via the URL slug (tenant-header.ts derives x-agentic-tenant), so the sandbox
    // fresh factory-issued sandbox run resolves correctly.
    // Resolve the REAL per-agent I/O from step artifacts (steps.input_ref / output_ref are absolute
    // JSON sidecar paths written by the runtime) — so the sandbox panel shows each agent's actual
    // input + output, not nulls. Best-effort + sync (better-sqlite3 + readFileSync); a missing file
    // just leaves it null. First step's input ≈ the trigger payload; last step's output ≈ the result.
    const readJson = (p: string | null): Record<string, unknown> | null => {
      if (!p) return null;
      return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;
    };
    // The emitted event's payload lives in the NDJSON ledger behind `<path>#<byteOffset>`
    // (appendToLedger). Read the record at that offset and return its `data` — the REAL
    // assembled envelope payload that went onto the wire.
    const readLedgerPayload = (ref: string | null): Record<string, unknown> | null => {
      if (!ref) return null;
      const hash = ref.lastIndexOf("#");
      if (hash <= 0) throw new Error(`invalid emitted payload reference: ${ref}`);
      const file = ref.slice(0, hash);
      const offset = Number(ref.slice(hash + 1));
      if (!Number.isFinite(offset) || offset < 0) throw new Error(`invalid emitted payload offset: ${ref}`);
      const raw = readFileSync(file, "utf8");
      if (offset >= raw.length) throw new Error(`emitted payload offset is outside ledger: ${ref}`);
      const nl = raw.indexOf("\n", offset);
      const line = raw.slice(offset, nl === -1 ? undefined : nl);
      const rec = JSON.parse(line) as { data?: unknown };
      if (!(rec && typeof rec.data === "object" && rec.data !== null && !Array.isArray(rec.data))) {
        throw new Error(`emitted payload record has no object data: ${ref}`);
      }
        // #AUDIT-FIX(M9) — 载荷里被 blob 卸载的字段（{__ref:"blob",...}）会被保真评估当成
        // object≠string 的契约违约（>8KB 合法字符串字段全部假阳性）。按 contentType 还原为
        // 字符串占位（类型正确即可，内容用 preview 表示——保真查的是类型/存在性，不是全文）。
        const data = { ...(rec.data as Record<string, unknown>) };
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && !Array.isArray(v) && (v as { __ref?: unknown }).__ref === "blob") {
            const ref = v as { preview?: unknown; bytes?: unknown };
            data[k] = `${String(ref.preview ?? "")}…[blob ${String(ref.bytes ?? "?")}B 已卸载]`;
          }
        }
      return data;
    };
    const runIO = (runId: string): { input: Record<string, unknown> | null; output: Record<string, unknown> | null } => {
      const ss = getDb().select({ inputRef: steps.inputRef, outputRef: steps.outputRef }).from(steps).where(eq(steps.runId, runId)).orderBy(asc(steps.ord)).all();
      const input = ss.find((s) => s.inputRef)?.inputRef ?? null;
      const output = [...ss].reverse().find((s) => s.outputRef)?.outputRef ?? null;
      return { input: readJson(input), output: readJson(output) };
    };
    return rows.map((r) => {
      const spec = specs.find((s) => s.short === r.agentName || s.slug === r.agentName);
      const io = runIO(r.runId);
      // review fix: prefer the REAL emit (actual branch + assembled envelope payload from the
      // ledger); only a genuinely absent emit may use the last step output.
      const emittedPayload = readLedgerPayload(r.emittedPayloadRef);
      return {
        agentSlug: spec?.slug ?? r.agentName ?? r.runId,
        agentShort: spec?.nameZh ?? r.agentName ?? "agent",
        status: r.status,
        degraded: false,
        triggerEvent: r.subject,
        inputPayload: io.input,
        tools: spec?.tools ?? [],
        // No recorded emit ⇒ outputEvent null (honest: nothing went on the wire; fidelity skips it,
        // the failure itself is chain_ran/status territory). Never guess spec.emit[0] — that graded
        // reject-branch runs against the success branch's contract.
        outputEvent: r.emittedEvent ?? null,
        reasoning: "",
        outputPayload: emittedPayload ?? io.output,
        runId: r.runId,
        url: `/portal/${encodeURIComponent(tenantSlug)}/runs/${encodeURIComponent(r.runId)}`,
      };
    });
  }

  /** Read the broker's independent registry until it proves the exact function
   * count. A larger/stale app is just as unsafe as a partial registration. */
  private async readExactBrokerRegistration(
    tenantSlug: string,
    expected: number,
    maxMs = 8_000,
    signal?: AbortSignal,
  ): Promise<SandboxBrokerRegistrationProof> {
    const readyMs = Math.max(1_500, Number(process.env.FACTORY_SANDBOX_READY_MS) || maxMs);
    const delayMs = 600;
    const attempts = Math.max(1, Math.ceil(readyMs / delayMs));
    const observed = await verifyTenantAppRegistration(tenantSlug, expected, {
      attempts,
      delayMs,
      signal,
    });
    return {
      schema: SANDBOX_BROKER_REGISTRATION_SCHEMA,
      appId: observed.appId,
      expectedFunctionCount: observed.expectedFunctionCount,
      observedFunctionCount: observed.observedFunctionCount,
      connected: observed.connected,
      verified: observed.verified,
      evidence: observed.evidence,
      checkedAt: observed.checkedAt,
      ...(observed.error ? { error: observed.error } : {}),
    };
  }

  private async pollRuns(tenantId: string, since: Date, expected: number, maxMs?: number, signal?: AbortSignal): Promise<{ ran: number; failed: number; rows: Array<{ id: string; status: string }>; completedAgents: Set<string> }> {
    // WAIT for the whole fired chain to settle before sampling. The agents run async on Inngest and
    // a rule-gate cascade (each ontology.fetchActionRules is slow) appears gradually; a too-short
    // window samples while runs are still `running` → ran=0/partial → fullChainRan=false → finish
    // loops forever (the brain re-runs the sandbox endlessly). Scale by chain length; env-overridable.
    // In tests (no real Inngest execution → runs never settle) keep the OLD short window so the suite
    // doesn't block on the full wait; in production wait long + adaptive for the real async cascade.
    const isTest = process.env.NODE_ENV === "test";
    const base = maxMs ?? (isTest ? 12_000 : (Number(process.env.FACTORY_SANDBOX_POLL_MS) || 45_000));
    const deadline = Date.now() + (isTest ? base : Math.min(120_000, Math.max(base, expected * 7_000)));
    let rows: Array<{ id: string; status: string; agentName: string | null }> = [];
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      // Join the agent so we can count DISTINCT completed agents (not raw run rows) — multiple
      // fired test cases / fan-out produce several rows per agent, which would inflate the verdict.
      const r = getDb().select({ id: runs.id, status: runs.status, agentName: agents.name }).from(runs).leftJoin(agents, eq(agents.id, runs.agentId)).where(and(eq(runs.tenantId, tenantId), gt(runs.startedAt, since))).orderBy(desc(runs.startedAt)).limit(50).all();
      rows = r.map((x) => ({ id: x.id, status: String(x.status), agentName: x.agentName ?? null }));
      // The runtime marks a finished run `ok` (register.ts), the DryRun sim uses "Completed".
      const settled = rows.filter((x) => RUN_DONE.test(x.status) || RUN_FAILED.test(x.status)).length;
      if (rows.length >= expected && settled >= rows.length) break;
      await new Promise((res) => setTimeout(res, 1500));
    }
    const failed = rows.filter((x) => RUN_FAILED.test(x.status)).length;
    // TRUE completed count — `ok`/`Completed` (NOT a `|| rows.length` fallback that reads stuck rows as success).
    const ran = rows.filter((x) => RUN_DONE.test(x.status)).length;
    const completedAgents = new Set(rows.filter((x) => RUN_DONE.test(x.status) && x.agentName).map((x) => x.agentName as string));
    return { ran, failed, rows: rows.map((x) => ({ id: x.id, status: x.status })), completedAgents };
  }

  async cleanupAttempt(ctx: SandboxAttemptContext): Promise<SandboxCleanupReceipt> {
    if (!isFactorySandboxTenant(ctx.tenantSlug)) {
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        question: "清理被安全门阻止：目标不是 Agent Factory 创建的临时沙箱。我没有删除任何生产 App，请人工检查这个身份。",
        missing: ["verified ephemeral sandbox identity"],
      });
    }
    try {
      const failures: string[] = [];
      const fail = (phase: string, error: unknown): void => {
        failures.push(`${phase}: ${String((error as Error)?.message ?? error).slice(0, 240)}`);
      };
      let tombstoneHeld = false;
      let firstAbsenceVerified = false;
      let secondAbsenceVerified = false;
      let runDrain: SandboxCleanupReceipt["runDrain"] | undefined;

      // Close the durable dispatch gate before observing or cancelling runs.
      // Losing this CAS means another owner has taken over; the stale process
      // must not perform even a best-effort remote mutation.
      markSandboxCleanupPending(ctx.lease);

      // Tombstone first, then await every earlier PUT. The reconciler and
      // manual sync paths refuse this slug while cleanup is in progress.
      try {
        await fencedSandboxEffect(
          ctx,
          ["cleanup_pending"],
          () => beginInngestAppDeletion(ctx.tenantSlug, ctx.appId),
        );
        tombstoneHeld = true;
      } catch (error) {
        fail("install app-deletion tombstone", error);
      }

      // Broker acceptance of run.cancel is not terminal proof. The drain
      // helper targets each persisted subject and waits for the runtime to
      // independently persist ok/failed/cancelled for every tenant run.
      try {
        runDrain = await fencedSandboxEffect(
          ctx,
          ["cleanup_pending"],
          () => drainSandboxRuns({
            tenantId: ctx.tenantId,
            tenantSlug: ctx.tenantSlug,
            appId: ctx.appId,
            attemptId: ctx.attemptId,
            lease: ctx.lease,
          }),
        );
      } catch (error) {
        fail("drain sandbox runs", error);
      }

      // Deletion remains best-effort even when run drain or ledger mutation
      // failed. No cleanup receipt can be signed from this path unless every
      // required phase below succeeds.
      try {
        await fencedSandboxEffect(
          ctx,
          ["cleanup_pending"],
          () => deleteFactorySandboxApp(
            ctx.tenantSlug,
            ctx.appId,
            fetch,
            { tombstoneExpiresAt: this.options.sandboxTombstoneExpiresAt },
          ),
        );
      } catch (error) {
        fail("delete remote sandbox app", error);
      }
      try {
        await fencedSandboxEffect(
          ctx,
          ["cleanup_pending"],
          () => this.waitForAppAbsent(ctx.appId, ctx.tenantSlug),
        );
        firstAbsenceVerified = true;
      } catch (error) {
        fail("first strict app-absence readback", error);
      }

      if (firstAbsenceVerified) {
        try {
          await removeTenantModelDirs(ctx.tenantSlug);
        } catch (error) {
          fail("remove sandbox model artifacts", error);
        }
        try {
          unregisterApp(ctx.appId);
        } catch (error) {
          fail("unregister local sandbox app", error);
        }
        try {
          removeFactorySandboxTenantRegistryAlias(ctx.tenantSlug);
        } catch (error) {
          fail("remove sandbox tenant registry alias", error);
        }
        try {
          disposeTenantInngestClient(ctx.tenantSlug);
        } catch (error) {
          fail("dispose sandbox Inngest client", error);
        }
        try {
          forgetInngestSyncEvidence(ctx.tenantSlug);
        } catch (error) {
          fail("remove sandbox sync evidence", error);
        }

        // Re-read after local unregister while the tombstone is still held.
        // This closes the DELETE/probe/unregister TOCTOU window.
        try {
          await fencedSandboxEffect(
            ctx,
            ["cleanup_pending"],
            () => this.waitForAppAbsent(ctx.appId, ctx.tenantSlug),
          );
          secondAbsenceVerified = true;
        } catch (error) {
          fail("second strict app-absence readback", error);
        }

        if (secondAbsenceVerified) {
          try {
            deleteSandboxToolClones(ctx.lease, ctx.tenantId);
          } catch (error) {
            fail("delete sandbox tool clones", error);
          }
          try {
            await removeFactorySandboxReplayAttempt(
              sandboxExecutionScope(ctx),
              ctx.tenantSlug,
            );
          } catch (error) {
            fail("delete attempt-bound replay evidence", error);
          }
          try {
            const now = new Date();
            const archived = getDb()
              .update(tenants)
              .set({ archivedAt: now, updatedAt: now })
              .where(eq(tenants.id, ctx.tenantId))
              .run() as { changes?: number };
            if ((archived.changes ?? 0) !== 1) {
              throw new Error(`sandbox tenant ${ctx.tenantSlug} could not be archived`);
            }
          } catch (error) {
            fail("archive sandbox tenant", error);
          }
        }
      }

      if (!runDrain) fail("run-drain evidence", "verified receipt missing");
      if (!firstAbsenceVerified || !secondAbsenceVerified) {
        fail("app-absence evidence", "both strict readbacks are required");
      }
      if (!tombstoneHeld) fail("app-deletion tombstone", "tombstone was not acquired");
      if (failures.length > 0) throw new Error(failures.join("; "));
      if (!runDrain) throw new Error("verified run-drain receipt missing");

      // Keep the anti-resurrection tombstone until the tenant is archived and
      // every local executable artifact/clone has been physically removed.
      finishInngestAppDeletion(ctx.tenantSlug, ctx.appId);
      const receiptBody: Omit<SandboxCleanupReceipt, "absenceProbeHash"> = {
        schema: SANDBOX_CLEANUP_RECEIPT_SCHEMA,
        appId: ctx.appId,
        sandboxTenantSlug: ctx.tenantSlug,
        sandboxAttemptId: ctx.attemptId,
        candidateFingerprint: ctx.candidateFingerprint,
        targetDomainId: ctx.targetDomainId,
        runDrain,
        deletedAt: new Date().toISOString(),
        absence: {
          connected: false,
          functionCount: null,
          registryState: "not_registered",
        },
      };
      const receipt: SandboxCleanupReceipt = {
        ...receiptBody,
        absenceProbeHash: sandboxCleanupReceiptHash(receiptBody),
      };
      markSandboxCleanupVerified(ctx.lease, receipt);
      this.activeAttempts.delete(ctx.tenantSlug);
      LIVE_SANDBOX_ATTEMPTS.delete(ctx.attemptId);
      return receipt;
    } catch (error) {
      LIVE_SANDBOX_ATTEMPTS.delete(ctx.attemptId);
      try {
        markSandboxCleanupFailed(ctx.lease, error);
      } catch {
        // The original cleanup failure is the useful operator-facing cause.
      }
      throw new SandboxLifecycleBlockedError({
        code: "sandbox_cleanup_failed",
        next: "ask_user",
        question: `临时 Inngest App「${ctx.appId}」的运行终止或删除证明不完整，我已阻止继续 promotion。请检查专用测试 Inngest 的取消投递、运行终态回写和 App 缺席回读后再试；即使取消事件已被接收、functions 已变成 0，也不会冒充清理成功，更不会改动生产 App。`,
        missing: [String((error as Error)?.message ?? error).slice(0, 200)],
      });
    }
  }

  /** A network error is never absence. Only a successful broker registry read
   * whose app list does not contain this exact id can complete cleanup. */
  private async waitForAppAbsent(appId: string, tenantSlug: string): Promise<void> {
    const configured = Number(process.env.FACTORY_SANDBOX_DELETE_VERIFY_MS);
    const maxMs = process.env.NODE_ENV === "test"
      ? 100
      : Number.isFinite(configured) && configured > 0
        ? Math.max(1_000, configured)
        : 8_000;
    const deadline = Date.now() + maxMs;
    let last = await probeApp(appId, tenantSlug);
    while (!(
      last.connected === false &&
      last.functionCount === null &&
      last.error === "App not registered in Inngest"
    )) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `broker did not prove app absence (connected=${String(last.connected)}, functions=${String(last.functionCount)}, error=${String(last.error ?? "none")})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, remaining)));
      last = await probeApp(appId, tenantSlug);
    }
  }

  async teardown(domain: string): Promise<void> {
    const attempts = [...this.activeAttempts.values()].filter(
      (attempt) => attempt.targetDomainId === domain,
    );
    const failures: unknown[] = [];
    for (const attempt of attempts) {
      try {
        let cleanupContext = attempt;
        const durable = listOutstandingSandboxAttempts()
          .find((row) => row.id === attempt.attemptId);
        if (
          durable &&
          (durable.status === "cleanup_failed" || durable.leaseExpiresAt.getTime() <= Date.now())
        ) {
          const lease = claimSandboxAttemptForCleanup(durable.id);
          if (!lease) {
            throw new Error(`sandbox cleanup lease could not be reclaimed: ${durable.id}`);
          }
          cleanupContext = { ...attempt, lease };
          this.activeAttempts.set(cleanupContext.tenantSlug, cleanupContext);
        }
        await this.cleanupAttempt(cleanupContext);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      throw new AggregateError(failures, `failed to clean ${failures.length} sandbox attempt(s)`);
    }
  }
}

export interface SandboxReaperReport {
  scanned: number;
  cleaned: number;
  failed: number;
  failures: Array<{ attemptId: string; appId: string; error: string }>;
}

/** Startup/periodic/preflight orphan recovery. A lease that belongs to a live
 * attempt in this process is excluded; cleanup_failed rows are immediately
 * retryable. External calls remain the same strict delete + absence-readback
 * path as normal teardown. */
export async function reapFactorySandboxOrphans(args: {
  ownerTenantId?: string;
  targetDomainId?: string;
  now?: Date;
} = {}): Promise<SandboxReaperReport> {
  const rows = listReapableSandboxAttempts({
    now: args.now,
    ownerTenantId: args.ownerTenantId,
    targetDomainId: args.targetDomainId,
    excludeAttemptIds: LIVE_SANDBOX_ATTEMPTS,
  });
  const report: SandboxReaperReport = {
    scanned: rows.length,
    cleaned: 0,
    failed: 0,
    failures: [],
  };
  if (!rows.length) return report;
  const cleaner = new ManifestSandboxDeployer();
  for (const row of rows) {
    const cleanupLease = claimSandboxAttemptForCleanup(row.id, args.now ?? new Date());
    if (!cleanupLease) continue;
    try {
      await cleaner.cleanupAttempt(sandboxAttemptContext(row, cleanupLease));
      report.cleaned += 1;
    } catch (error) {
      report.failed += 1;
      report.failures.push({
        attemptId: row.id,
        appId: row.appId,
        error: sandboxAttemptError(error),
      });
    }
  }
  return report;
}

// ── Probing wrapper (the DEFAULT) ───────────────────────────────────────────────
/** Uses the REAL deployer only. Runtime code never falls back to graph-closure
 * simulation; dedicated sandbox config/sync/readiness checks fail closed. */
export class ProbingSandboxDeployer implements SandboxDeployer {
  private readonly real: ManifestSandboxDeployer;
  private chosen: SandboxDeployer | null = null;
  constructor(scope?: SandboxTenantScope) {
    this.real = new ManifestSandboxDeployer(scope);
  }
  async deployAndObserve(domain: string, specs: GeneratedAgentSpec[], opts?: { dryRun?: boolean; testCases?: SandboxCase[]; boundaryEvents?: Boundary; candidateFingerprint?: string; fixtureConversationId?: string; signal?: AbortSignal }): Promise<SandboxDeployResult> {
    this.chosen = this.real;
    return this.chosen.deployAndObserve(domain, specs, opts);
  }
  async teardown(domain: string): Promise<void> {
    if (!this.chosen) return;
    return this.chosen.teardown(domain);
  }
}
