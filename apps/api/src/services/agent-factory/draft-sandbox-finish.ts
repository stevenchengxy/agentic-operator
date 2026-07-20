import { randomUUID } from "node:crypto";

import { findDraftSandboxTestSentinel } from "@agentic/contracts";

import {
  acceptanceGate,
  assessCompleteSuite,
  assertGeneratedSpecToolPoliciesCurrent,
  deriveContractGraph,
  ensureCoverage,
  evaluateExecutionFidelity,
  expectedFieldsByEvent,
  persistedToolAsRealTool,
  sandboxCleanupReceiptIssues,
  sandboxDesignReviewSubjectDigest,
  sandboxEvidenceFingerprint,
  sandboxExecutionReceiptIssues,
  sandboxRegistrationEvidenceIssues,
  generatedFleetModelRequirement,
  sandboxModelUsageEvidenceIssues,
  validateGeneratedSpecIntegrationProfiles,
  verifyGraph,
  compileGraph,
  type AgentDraftRegressionEvidence,
  type BoundaryEvent,
  type DomainOntology,
  type FactoryAuthorizationChallenge,
  type FactoryPorts,
  type GeneratedAgentSpec,
  type IoField,
  type RealTool,
  type SandboxDeployResult,
  type TestCase,
} from "@agentic/agent-factory";

import { specsToActions } from "./sandbox-deployer";
import {
  draftEditorSensitiveCategory,
  FsAgentDraftStore,
  type DraftStoreScope,
} from "./agent-draft-store";
import { authoritativeOntologyEvidence } from "./authoritative-ontology-evidence";

export type SandboxChallengeRef = Pick<
  FactoryAuthorizationChallenge,
  "id" | "kind" | "protocolVersion" | "digest" | "subjectDigest" | "runId" | "conversationId" | "expiresAt"
>;

export interface DraftSandboxReviewRequest {
  scope: DraftStoreScope;
  domain: string;
  versionId: string;
  slug: string;
  testCases: unknown;
  boundaryEvents?: unknown;
  ports: FactoryPorts;
  store?: FsAgentDraftStore;
}

export interface DraftSandboxInputContract {
  schema: "agent-factory-draft-sandbox-input/v1";
  scope: DraftSandboxReview["scope"];
  specsCount: number;
  entryEvents: Array<{
    event: string;
    fields: Array<{
      name: string;
      type: string;
      required?: boolean;
      targetObject?: string;
    }>;
  }>;
  unresolvedBoundaries: Array<{ event: string; producers: string[] }>;
  testKinds: Array<TestCase["kind"]>;
  note: string;
}

export interface DraftSandboxReview {
  schema: "agent-factory-draft-sandbox-review/v1";
  scope: {
    tenantId: string;
    tenantSlug: string;
    domain: string;
    slug: string;
    versionId: string;
  };
  fingerprint: string;
  specsCount: number;
  testCoverage: {
    required: string[];
    covered: string[];
    backfilled: string[];
    uncoveredNeedingData: string[];
  };
  testCases: TestCase[];
  boundaryEvents: BoundaryEvent[];
  challenge: FactoryAuthorizationChallenge;
}

export interface DraftSandboxFinishRequest extends DraftSandboxReviewRequest {
  challengeRef: unknown;
  answer: unknown;
  actor: string;
}

export interface DraftSandboxFinishReceipt {
  schema: "agent-factory-draft-sandbox-finish/v1";
  scope: DraftSandboxReview["scope"] & { baseVersionId: string };
  baseVersionId: string;
  versionId: string;
  regressionReady: true;
  fingerprint: string;
  sandbox: {
    appId: string;
    attemptId: string;
    cleanupVerified: true;
    functionsRegistered: number;
    agentsRan: number;
  };
  regressionReplay: {
    pass: true;
    suiteFingerprint: string;
    results: number;
  };
}

export class DraftSandboxError extends Error {
  constructor(
    readonly code: string,
    readonly publicMessage: string,
    readonly statusCode = 400,
  ) {
    super(publicMessage);
    this.name = "DraftSandboxError";
  }
}

interface ExecutionSnapshot {
  ontology: DomainOntology;
  registryTools: RealTool[];
  declarativeTools: Awaited<ReturnType<NonNullable<FactoryPorts["tools"]>["list"]>>;
  realTools: RealTool[];
  integrationCapabilities: Awaited<ReturnType<NonNullable<FactoryPorts["integrationCapabilities"]>["list"]>>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function requiredText(value: unknown, label: string, max = 240): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > max) {
    throw new DraftSandboxError("invalid_test_suite", `${label}不能为空，且不能超过 ${max} 个字符。`);
  }
  return text;
}

function entryEvents(specs: readonly GeneratedAgentSpec[]): Set<string> {
  const emitted = new Set(specs.filter((spec) => !spec.isSubAgent).flatMap((spec) => spec.emit ?? []));
  return new Set(
    specs
      .filter((spec) => !spec.isSubAgent)
      .flatMap((spec) => spec.trigger ?? [])
      .filter((event) => event && !emitted.has(event)),
  );
}

function parseTestCases(value: unknown, specs: readonly GeneratedAgentSpec[]): TestCase[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) {
    throw new DraftSandboxError("invalid_test_suite", "请提供 1 到 100 个完整测试用例；不会用空对象替你补流程。", 400);
  }
  const templateSentinelPath = findDraftSandboxTestSentinel(value);
  if (templateSentinelPath) {
    throw new DraftSandboxError(
      "test_template_incomplete",
      `测试用例 ${templateSentinelPath} 还保留着页面模板占位内容。请把场景、预期结果和 payload 都改成你确认过的真实测试值；工厂不会拿占位文字冒充测试证据。`,
    );
  }
  const allowedEntries = entryEvents(specs);
  const declaredEmits = new Set(specs.flatMap((spec) => spec.emit ?? []));
  const ids = new Set<string>();
  const parsed = value.map((raw, index): TestCase => {
    if (!isRecord(raw)) throw new DraftSandboxError("invalid_test_suite", `第 ${index + 1} 个测试用例不是对象。`);
    const id = requiredText(raw.id, `第 ${index + 1} 个用例 ID`, 120);
    if (ids.has(id)) throw new DraftSandboxError("invalid_test_suite", `测试用例 ID 重复：${id}`);
    ids.add(id);
    const kind = raw.kind;
    if (kind !== "pass" && kind !== "reject" && kind !== "edge" && kind !== "fault") {
      throw new DraftSandboxError("invalid_test_suite", `测试用例 ${id} 的 kind 必须是 pass、reject、edge 或 fault。`);
    }
    const entryEvent = requiredText(raw.entryEvent, `测试用例 ${id} 的入口事件`, 240);
    if (!allowedEntries.has(entryEvent)) {
      throw new DraftSandboxError(
        "invalid_test_suite",
        `测试用例 ${id} 的入口事件 ${entryEvent} 不是这版 Agent 的外部入口；可用入口：${[...allowedEntries].join("、") || "无"}。`,
      );
    }
    if (!isRecord(raw.payload)) {
      throw new DraftSandboxError("invalid_test_suite", `测试用例 ${id} 的 payload 必须是 JSON 对象。`);
    }
    const expectedEvent = raw.expectedEvent === undefined
      ? undefined
      : requiredText(raw.expectedEvent, `测试用例 ${id} 的 expectedEvent`, 240);
    if (expectedEvent && !declaredEmits.has(expectedEvent)) {
      throw new DraftSandboxError("invalid_test_suite", `测试用例 ${id} 的 expectedEvent 不是这版 Agent 声明的事件。`);
    }
    if (raw.functionAssertions !== undefined && !isRecord(raw.functionAssertions)) {
      throw new DraftSandboxError("invalid_test_suite", `测试用例 ${id} 的 functionAssertions 必须是 JSON 对象。`);
    }
    return {
      id,
      name: requiredText(raw.name, `测试用例 ${id} 的名称`, 120),
      scenario: requiredText(raw.scenario, `测试用例 ${id} 的场景说明`, 800),
      kind,
      entryEvent,
      payload: JSON.parse(JSON.stringify(raw.payload)) as Record<string, unknown>,
      expectedOutcome: requiredText(raw.expectedOutcome, `测试用例 ${id} 的预期结果`, 800),
      ...(expectedEvent ? { expectedEvent } : {}),
      ...(typeof raw.coverageCell === "string" && raw.coverageCell.trim()
        ? { coverageCell: raw.coverageCell.trim().slice(0, 240) }
        : {}),
      ...(raw.functionAssertions !== undefined
        ? { functionAssertions: JSON.parse(JSON.stringify(raw.functionAssertions)) as TestCase["functionAssertions"] }
        : {}),
    };
  });
  if (draftEditorSensitiveCategory(parsed)) {
    throw new DraftSandboxError(
      "sensitive_test_data",
      "测试用例里不能直接放密钥、认证头、原始文件 bytes 或旧 fixture ID。普通 JSON 业务数据可以直接填写；二进制文件请回到 Agent 工厂会话，用测试数据上传功能绑定后再跑。",
    );
  }
  return parsed;
}

function parseBoundaryEvents(value: unknown, specs: readonly GeneratedAgentSpec[]): BoundaryEvent[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new DraftSandboxError("invalid_boundary_events", "boundaryEvents 必须是数组，且不能超过 100 项。");
  }
  const consumed = new Set(specs.filter((spec) => !spec.isSubAgent).flatMap((spec) => spec.trigger ?? []));
  const dangling = new Set(specs.filter((spec) => !spec.isSubAgent).flatMap((spec) => spec.emit ?? []).filter((event) => !consumed.has(event)));
  const seen = new Set<string>();
  const parsed = value.map((raw, index): BoundaryEvent => {
    if (!isRecord(raw)) throw new DraftSandboxError("invalid_boundary_events", `第 ${index + 1} 个边界事件不是对象。`);
    const event = requiredText(raw.event, `第 ${index + 1} 个边界事件名`, 240);
    if (seen.has(event)) throw new DraftSandboxError("invalid_boundary_events", `边界事件重复：${event}`);
    seen.add(event);
    if (!dangling.has(event)) {
      throw new DraftSandboxError("invalid_boundary_events", `${event} 不是当前版本的悬空产出事件，不能当作外部边界。`);
    }
    if (raw.kind !== "external" && raw.kind !== "terminal" && raw.kind !== "break") {
      throw new DraftSandboxError("invalid_boundary_events", `${event} 的 kind 必须是 external、terminal 或 break。`);
    }
    return {
      event,
      kind: raw.kind,
      ...(typeof raw.consumer === "string" && raw.consumer.trim() ? { consumer: raw.consumer.trim().slice(0, 240) } : {}),
      ...(typeof raw.payloadContract === "string" && raw.payloadContract.trim() ? { payloadContract: raw.payloadContract.trim().slice(0, 1_000) } : {}),
      ...(typeof raw.note === "string" && raw.note.trim() ? { note: raw.note.trim().slice(0, 1_000) } : {}),
    };
  });
  if (draftEditorSensitiveCategory(parsed)) {
    throw new DraftSandboxError("sensitive_boundary_data", "边界说明里不能包含密钥、凭证、fixture bytes 或 fixture ID。");
  }
  return parsed;
}

async function readExactSpecs(
  request: Pick<DraftSandboxReviewRequest, "domain" | "versionId" | "slug" | "scope" | "store">,
): Promise<{ store: FsAgentDraftStore; specs: GeneratedAgentSpec[] }> {
  const store = request.store ?? new FsAgentDraftStore(request.scope);
  const drafts = await store.getVersion(request.domain, request.versionId);
  if (!drafts.length || drafts.some((draft) => draft.versionId !== request.versionId)) {
    throw new DraftSandboxError("draft_version_not_found", "这个草稿版本已经变化或不存在，请刷新列表后重试。", 404);
  }
  if (!drafts.some((draft) => draft.slug === request.slug)) {
    throw new DraftSandboxError("draft_not_found", "这个 Agent 不在所选不可变版本里，请刷新列表后重试。", 404);
  }
  return {
    store,
    specs: drafts.map((draft) => JSON.parse(JSON.stringify(draft.spec)) as GeneratedAgentSpec),
  };
}

async function executionSnapshot(ports: FactoryPorts, domain: string): Promise<ExecutionSnapshot> {
  if (!ports.toolRegistry || !ports.tools || !ports.integrationCapabilities) {
    throw new DraftSandboxError(
      "execution_registry_unavailable",
      "当前 Agent 工厂没有接齐工具库、租户工具和运行时能力快照，不能创建可晋升的沙箱证据。",
      503,
    );
  }
  let ontology: DomainOntology;
  let registryTools: RealTool[];
  let declarativeTools: ExecutionSnapshot["declarativeTools"];
  let integrationCapabilities: ExecutionSnapshot["integrationCapabilities"];
  try {
    [ontology, registryTools, declarativeTools, integrationCapabilities] = await Promise.all([
      ports.ontology.fetchOntology(domain),
      ports.toolRegistry.list(),
      ports.tools.list(domain),
      ports.integrationCapabilities.list(),
    ]);
  } catch {
    throw new DraftSandboxError(
      "execution_snapshot_failed",
      "无法从 AllmetaOntology 和当前工具库重建执行快照；没有创建沙箱 App。请确认服务可用后重试。",
      503,
    );
  }
  const globalNames = new Set(registryTools.flatMap((tool) => [tool.name, ...(tool.aliases ?? [])]));
  const realTools = [
    ...registryTools,
    ...declarativeTools.filter((tool) => !globalNames.has(tool.name)).map(persistedToolAsRealTool),
  ];
  return { ontology, registryTools, declarativeTools, integrationCapabilities, realTools };
}

function validateCurrentBindings(
  specs: GeneratedAgentSpec[],
  snapshot: ExecutionSnapshot,
  scope: DraftStoreScope,
  domain: string,
): void {
  try {
    assertGeneratedSpecToolPoliciesCurrent(specs, snapshot.realTools);
  } catch (error) {
    throw new DraftSandboxError(
      "tool_policy_drift",
      `工具库在草稿生成后发生了变化：${String((error as Error).message ?? error).slice(0, 600)}。请重新选择/确认工具后再测试。`,
    );
  }
  const profileValidation = validateGeneratedSpecIntegrationProfiles({
    specs,
    tools: snapshot.realTools,
    scope: {
      tenantId: scope.tenantId,
      tenantSlug: scope.tenantSlug,
      domainId: domain,
    },
  });
  if (!profileValidation.ok) {
    throw new DraftSandboxError(
      "integration_profile_drift",
      `sandbox/production 集成配置缺失或已经变化：${profileValidation.issues.slice(0, 6).map((issue) => issue.message).join("；")}。请先补齐两套 profile 和 probe。`,
    );
  }
  const providers = new Map(snapshot.integrationCapabilities.map((provider) => [provider.id, provider]));
  const unavailable = specs.flatMap((spec) => (spec.integrationBindings ?? [])
    .filter((binding) => binding.status === "resolved" && binding.bindingKind === "runtime")
    .filter((binding) => !binding.bindingId || providers.get(binding.bindingId)?.status !== "available")
    .map((binding) => `${spec.short}:${binding.bindingId || binding.requirement.id}`));
  if (unavailable.length) {
    throw new DraftSandboxError(
      "runtime_capability_unavailable",
      `这些运行时能力当前不可用：${unavailable.slice(0, 8).join("、")}。请先完成配置，不会用模拟能力补过去。`,
    );
  }
}

function validateOntologyAlignment(
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology,
  domain: string,
  boundaries: BoundaryEvent[],
): void {
  const actions = new Map(ontology.actions.map((action) => [action.name, action]));
  const missing = specs.filter((spec) => !spec.isSubAgent && !actions.has(spec.actionName));
  if (missing.length) {
    throw new DraftSandboxError("ontology_drift", `这些 Agent 的 Action 已不在当前 Ontology：${missing.map((spec) => spec.actionName).join("、")}。请重新生成或修正引用。`);
  }
  const known = compileGraph(ontology.actions, { domainId: domain });
  const proposed = compileGraph(specsToActions(specs), { domainId: domain });
  const graph = verifyGraph(proposed, {
    knownEntries: known.entryEvents,
    knownTerminals: known.terminalEvents,
    boundaryEvents: boundaries.filter((boundary) => boundary.kind !== "break").map((boundary) => boundary.event),
  });
  if (!graph.ok) {
    const details = graph.issues.slice(0, 6).map((issue) => {
      if (issue.kind === "missing_producer") return `${issue.action} 消费的 ${issue.event} 没有上游`;
      if (issue.kind === "orphan_emit") return `${issue.action} 产出的 ${issue.event} 没有下游或边界确认`;
      if (issue.kind === "unreachable_node") return `${issue.action} 从入口不可达`;
      if (issue.kind === "dead_end") return `${issue.action} 到不了终态`;
      if (issue.kind === "cycle") return `存在无界循环 ${issue.actions.join("→")}`;
      return issue.kind === "no_entry" ? "没有入口事件" : "没有终态事件";
    });
    throw new DraftSandboxError("agent_graph_invalid", `这版 Agent 的事件图还没闭合：${details.join("；")}。请先修改字段或边界分类。`);
  }
}

function effectiveSuite(
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology,
  domain: string,
  testCases: unknown,
  boundaryEvents: unknown,
): { testCases: TestCase[]; boundaryEvents: BoundaryEvent[]; coverage: DraftSandboxReview["testCoverage"] } {
  const parsedBoundaries = parseBoundaryEvents(boundaryEvents, specs);
  validateOntologyAlignment(specs, ontology, domain, parsedBoundaries);
  const parsedCases = parseTestCases(testCases, specs);
  const coverage = ensureCoverage(
    { specs, ontology, domain } as Parameters<typeof ensureCoverage>[0],
    parsedCases,
  );
  if (coverage.coverage.uncoveredNeedingData.length) {
    throw new DraftSandboxError(
      "test_coverage_incomplete",
      `测试还缺这些必须由人提供真实数据的覆盖项：${coverage.coverage.uncoveredNeedingData.join("、")}。请补用例后再申请沙箱审查。`,
    );
  }
  if (draftEditorSensitiveCategory(coverage.cases)) {
    throw new DraftSandboxError(
      "binary_fixture_requires_factory_run",
      "覆盖矩阵需要文件或敏感测试数据，字段编辑器不能把原始 bytes 带进浏览器。请在 Agent 工厂会话里上传测试文件并完成 sandbox_run。",
    );
  }
  return { testCases: coverage.cases, boundaryEvents: parsedBoundaries, coverage: coverage.coverage };
}

function evidenceIdentity(
  domain: string,
  specs: GeneratedAgentSpec[],
  suite: ReturnType<typeof effectiveSuite>,
  snapshot: ExecutionSnapshot,
): string {
  return sandboxEvidenceFingerprint({
    domain,
    specs,
    ontology: snapshot.ontology,
    testCases: suite.testCases,
    boundaryEvents: suite.boundaryEvents,
    realTools: snapshot.realTools,
    declarativeTools: snapshot.declarativeTools,
    integrationCapabilities: snapshot.integrationCapabilities,
  });
}

function selectedCassetteRefs(
  specs: GeneratedAgentSpec[],
  snapshot: ExecutionSnapshot,
): NonNullable<AgentDraftRegressionEvidence["cassetteRefs"]> {
  const selected = new Set<string>();
  const visit = (steps: GeneratedAgentSpec["plan"]): void => {
    for (const step of steps ?? []) {
      if (step.kind === "tool" && step.tool) selected.add(step.tool);
      if (step.body?.length) visit(step.body);
    }
  };
  for (const spec of specs) {
    for (const tool of spec.tools ?? []) selected.add(tool);
    visit(spec.plan);
  }
  return snapshot.declarativeTools.flatMap((tool) => {
    if (!selected.has(tool.name)) return [];
    const path = typeof tool.probeEvidence?.cassettePath === "string" ? tool.probeEvidence.cassettePath.trim() : "";
    if (!path) return [];
    return [{
      tool: tool.name,
      path,
      ...(tool.definitionHash ? { definitionHash: tool.definitionHash } : {}),
      ...(typeof tool.probeEvidence?.schemaHash === "string" ? { schemaHash: tool.probeEvidence.schemaHash } : {}),
    }];
  });
}

function sandboxQuestion(domain: string, specs: GeneratedAgentSpec[], suite: ReturnType<typeof effectiveSuite>, fingerprint: string): string {
  const flows = specs.map((spec) => `${spec.actionName}：${spec.trigger.join("/") || "无入口"} → ${spec.emit.join("/") || "无产出"}（${spec.tools.join("/") || "无工具"}）`);
  const cases = suite.testCases.map((testCase) => `${testCase.id}:${testCase.kind}:${testCase.entryEvent}`);
  return [
    `是否批准 ${domain} 的这一个不可变版本进入一次全新的隔离 Inngest 沙箱？`,
    `版本指纹：${fingerprint}`,
    `整版共 ${specs.length} 个 Agent；测试用例 ${cases.join("、")}。`,
    "请先核对页面里的代码、事件、工具、边界分类和测试 payload。如果这些函数需要语义推理，你批准的测试数据会经内部代理发送给目标 tenant 当前配置的真实模型提供商；代理会记模型、token 和预算，但不会保存 provider raw 或密钥。externalLiveCalls=0 只表示外部工具没有直连，不表示模型调用为 0。批准只允许这一次临时沙箱；不代表允许晋升或真实外部写操作。沙箱无论成功失败都会删除并验证 App 已不存在。",
    `链路：${flows.join("；")}`,
  ].join("\n").slice(0, 1_900);
}

export async function getDraftSandboxInputContract(
  request: Omit<DraftSandboxReviewRequest, "testCases" | "boundaryEvents">,
): Promise<DraftSandboxInputContract> {
  const { specs } = await readExactSpecs(request);
  let ontology: DomainOntology;
  try {
    ontology = await request.ports.ontology.fetchOntology(request.domain);
  } catch {
    throw new DraftSandboxError(
      "ontology_unavailable",
      "暂时无法从 AllmetaOntology 读取测试输入契约，请确认服务可用后重试。",
      503,
    );
  }
  const entries = entryEvents(specs);
  const events = new Map(ontology.events.map((event) => [event.name, event]));
  const consumed = new Set(specs.filter((spec) => !spec.isSubAgent).flatMap((spec) => spec.trigger ?? []));
  const ontologyGraph = compileGraph(ontology.actions, { domainId: request.domain });
  const knownTerminals = new Set(ontologyGraph.terminalEvents);
  const producedBy = new Map<string, string[]>();
  for (const spec of specs.filter((candidate) => !candidate.isSubAgent)) {
    for (const event of spec.emit ?? []) {
      const producers = producedBy.get(event) ?? [];
      producers.push(spec.actionName);
      producedBy.set(event, producers);
    }
  }
  return {
    schema: "agent-factory-draft-sandbox-input/v1",
    scope: {
      tenantId: request.scope.tenantId,
      tenantSlug: request.scope.tenantSlug,
      domain: request.domain,
      slug: request.slug,
      versionId: request.versionId,
    },
    specsCount: specs.length,
    entryEvents: [...entries].sort().map((event) => ({
      event,
      fields: (events.get(event)?.payload?.event_data ?? []).map((field) => ({
        name: field.name,
        type: field.type || "unknown",
        ...(typeof field.required === "boolean" ? { required: field.required } : {}),
        ...(field.target_object ? { targetObject: field.target_object } : {}),
      })),
    })),
    unresolvedBoundaries: [...producedBy.entries()]
      .filter(([event]) => !consumed.has(event) && !knownTerminals.has(event))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([event, producers]) => ({ event, producers: [...new Set(producers)].sort() })),
    testKinds: ["pass", "reject", "edge", "fault"],
    note: "这里只提供 Ontology 契约，不会猜业务测试值。请为每个外部入口填写你确认过的 JSON payload；规则拒绝和多分支场景也需要单独用例。",
  };
}

function challengeRef(value: unknown): SandboxChallengeRef {
  if (!isRecord(value)) throw new DraftSandboxError("sandbox_review_missing", "缺少这版沙箱审查回执，请重新点击“准备沙箱审查”。");
  const ref: SandboxChallengeRef = {
    id: requiredText(value.id, "challenge id", 200),
    kind: value.kind as SandboxChallengeRef["kind"],
    protocolVersion: Number(value.protocolVersion),
    digest: requiredText(value.digest, "challenge digest", 128),
    subjectDigest: requiredText(value.subjectDigest, "challenge subject", 128),
    runId: requiredText(value.runId, "challenge run", 200),
    conversationId: requiredText(value.conversationId, "challenge conversation", 200),
    expiresAt: requiredText(value.expiresAt, "challenge expiry", 100),
  };
  if (ref.kind !== "sandbox_design_review" || !Number.isInteger(ref.protocolVersion)) {
    throw new DraftSandboxError("sandbox_review_invalid", "沙箱审查回执类型不正确，请重新申请。", 409);
  }
  return ref;
}

function canonicalFields(ontology: DomainOntology): Map<string, IoField[]> {
  return new Map(ontology.events.map((event) => [event.name, (event.payload?.event_data ?? []).map((field) => ({
    field: field.name,
    type: field.type || "unknown",
    source: field.target_object ?? undefined,
    ...(typeof field.required === "boolean" ? { required: field.required } : {}),
  }))]));
}

function validateSandboxResult(
  result: SandboxDeployResult,
  fingerprint: string,
  domain: string,
  specs: GeneratedAgentSpec[],
  ontology: DomainOntology,
  realTools: RealTool[],
  expectedCaseIds: string[],
): void {
  const cleanupIssues = sandboxCleanupReceiptIssues(result.cleanupReceipt, {
    candidateFingerprint: fingerprint,
    targetDomainId: domain,
  });
  const executionIssues = sandboxExecutionReceiptIssues(result.executionReceipt, {
    candidateFingerprint: fingerprint,
    targetDomainId: domain,
    sandboxAttemptId: result.sandboxAttemptId,
    modelUsageHash: result.modelUsage?.evidenceHash,
  });
  const modelRequirement = generatedFleetModelRequirement(specs);
  const modelUsageIssues = [
    ...modelRequirement.issues,
    ...sandboxModelUsageEvidenceIssues(result.modelUsage, {
    sandboxAttemptId: result.sandboxAttemptId,
    modelRequired: modelRequirement.requiredAgentRefs.length > 0,
    requiredAgentRefs: modelRequirement.requiredAgentRefs,
  })];
  const fires = result.fires ?? [];
  const failedFires = fires.filter((fire) => !fire.ok);
  const testerFailures = (result.functionTester ?? []).filter((entry) => !entry.pass || !entry.ran);
  const nonPromotableTester = (result.functionTester ?? []).filter(
    (entry) => entry.qualification !== "promotable",
  );
  const completeSuite = assessCompleteSuite({
    fullChainRan: result.fullChainRan,
    degradedAgents: result.degradedAgents,
    caseVerdicts: result.caseVerdicts,
    expectedCaseIds,
  });
  const registrationIssues = sandboxRegistrationEvidenceIssues(
    {
      appId: result.appId,
      committedManifestFunctionIds: result.committedManifestFunctionIds,
      brokerRegistration: result.brokerRegistration,
    },
    specs.map((spec) => spec.slug),
  );
  if (
    result.simulated === true
    || result.candidateFingerprint !== fingerprint
    || result.targetDomainId !== domain
    || result.cleanupVerified !== true
    || cleanupIssues.length
    || executionIssues.length
    || modelUsageIssues.length
    || registrationIssues.length
    || result.cleanupReceipt?.appId !== result.appId
    || result.cleanupReceipt?.sandboxAttemptId !== result.sandboxAttemptId
    || result.cleanupReceipt?.sandboxTenantSlug !== result.sandboxTenantSlug
    || result.functionsRegistered !== specs.length
    || result.appReady === false
    || fires.length === 0
    || failedFires.length > 0
    || (result.uncoveredExternalInputs?.length ?? 0) > 0
    || !completeSuite.complete
    || result.degradedAgents.length > 0
    || !result.functionTester
    || result.functionTester.length < specs.length
    || testerFailures.length > 0
    || nonPromotableTester.length > 0
    || result.toolMode !== "evidence_replay"
    || result.externalLiveCalls !== 0
    || result.sandboxReplayEvidenceComplete !== true
  ) {
    const reasons = [
      ...(cleanupIssues.length ? [`清理回执：${cleanupIssues.join("、")}`] : []),
      ...(executionIssues.length ? [`外部执行回执：${executionIssues.join("、")}`] : []),
      ...(modelUsageIssues.length ? [`真实模型账本：${modelUsageIssues.join("、")}`] : []),
      ...(registrationIssues.length ? [`Inngest 精确注册：${registrationIssues.join("、")}`] : []),
      ...(result.simulated ? ["只返回了模拟结果"] : []),
      ...(result.candidateFingerprint !== fingerprint || result.targetDomainId !== domain ? ["候选指纹或目标 domain 不匹配"] : []),
      ...(result.functionsRegistered !== specs.length ? [`manifest commit 数量不是精确的 ${specs.length}（实际 ${result.functionsRegistered}）`] : []),
      ...(result.appReady === false ? ["Inngest 没有确认 App 已注册"] : []),
      ...(fires.length === 0 ? ["没有入口事件被投递"] : []),
      ...(failedFires.length ? [`${failedFires.length} 个入口事件投递失败`] : []),
      ...((result.uncoveredExternalInputs?.length ?? 0) ? [`外部入口没有已批准数据：${result.uncoveredExternalInputs!.join("、")}`] : []),
      ...(!completeSuite.complete ? [`完整测试套件未通过：${completeSuite.detail}`] : []),
      ...(result.degradedAgents.length ? [`发生降级：${result.degradedAgents.join("、")}`] : []),
      ...(!result.functionTester ? ["缺少交付模块隔离测试"] : []),
      ...(testerFailures.length ? [`模块测试失败：${testerFailures.map((entry) => entry.short).join("、")}`] : []),
      ...(nonPromotableTester.length ? [`模块测试不在可晋升执行面：${nonPromotableTester.map((entry) => entry.short).join("、")}`] : []),
      ...(result.toolMode !== "evidence_replay" || result.externalLiveCalls !== 0 || result.sandboxReplayEvidenceComplete !== true
        ? ["不是 externalLiveCalls=0 的完整 evidence replay"]
        : []),
    ];
    throw new DraftSandboxError(
      "sandbox_not_green",
      `这次临时沙箱没有形成可晋升证据：${reasons.slice(0, 8).join("；") || "运行证据不完整"}。App 已进入强制清理流程；修正后请重新创建一次新沙箱。`,
      422,
    );
  }

  const fields = canonicalFields(ontology);
  const fidelity = Array.isArray(result.agentRuns)
    ? evaluateExecutionFidelity(result.agentRuns, expectedFieldsByEvent(deriveContractGraph(specs, domain, fields), fields))
    : undefined;
  const gate = acceptanceGate(specs, ontology, {
    appId: result.appId,
    committedManifestFunctionIds: result.committedManifestFunctionIds,
    brokerRegistration: result.brokerRegistration,
    registeredIds: result.registeredIds,
    functionsRegistered: result.functionsRegistered,
    ran: result.ran,
    fullChainRan: result.fullChainRan,
    reachedSuccessTerminal: result.reachedSuccessTerminal,
    caseVerdicts: result.caseVerdicts,
    expectedCaseIds,
    codeRanAgents: result.codeRanAgents,
    degradedAgents: result.degradedAgents,
    fidelityFailures: fidelity?.failingShorts,
    functionTester: result.functionTester,
    toolMode: result.toolMode,
    externalLiveCalls: result.externalLiveCalls,
    replayReceipts: result.replayReceipts,
    sandboxReplayEvidenceComplete: result.sandboxReplayEvidenceComplete,
    modelUsage: result.modelUsage,
    candidateFingerprint: fingerprint,
    targetDomainId: domain,
    sandboxAttemptId: result.sandboxAttemptId,
    executionReceipt: result.executionReceipt,
    simulated: result.simulated ?? false,
  }, { registeredTools: realTools });
  if (!gate.pass) {
    throw new DraftSandboxError(
      "sandbox_acceptance_failed",
      `沙箱运行完成，但交付验收仍未通过：${gate.failing.slice(0, 8).map((criterion) => `${criterion.label}（${criterion.detail}）`).join("；")}。请先修正，不会生成可晋升版本。`,
      422,
    );
  }
}

export async function prepareDraftSandboxReview(request: DraftSandboxReviewRequest): Promise<DraftSandboxReview> {
  const { specs } = await readExactSpecs(request);
  const snapshot = await executionSnapshot(request.ports, request.domain);
  validateCurrentBindings(specs, snapshot, request.scope, request.domain);
  const suite = effectiveSuite(specs, snapshot.ontology, request.domain, request.testCases, request.boundaryEvents);
  const fingerprint = evidenceIdentity(request.domain, specs, suite, snapshot);
  const subjectDigest = sandboxDesignReviewSubjectDigest({ domain: request.domain, fingerprint });
  if (!request.ports.authorizationChallenges) {
    throw new DraftSandboxError("sandbox_review_store_missing", "一次性人工审查存储没有接入，不能创建 Inngest 沙箱 App。", 503);
  }
  const executionId = `draft-sandbox-${randomUUID()}`;
  const challenge = await request.ports.authorizationChallenges.issue(request.domain, {
    kind: "sandbox_design_review",
    subjectDigest,
    runId: executionId,
    conversationId: executionId,
    question: sandboxQuestion(request.domain, specs, suite, fingerprint),
    declineLabel: "需要修改，先别创建沙箱",
    confirmLabel: "我已核对，批准这版进入一次沙箱",
  });
  return {
    schema: "agent-factory-draft-sandbox-review/v1",
    scope: {
      tenantId: request.scope.tenantId,
      tenantSlug: request.scope.tenantSlug,
      domain: request.domain,
      slug: request.slug,
      versionId: request.versionId,
    },
    fingerprint,
    specsCount: specs.length,
    testCoverage: suite.coverage,
    testCases: suite.testCases,
    boundaryEvents: suite.boundaryEvents,
    challenge,
  };
}

export async function finishDraftSandbox(request: DraftSandboxFinishRequest): Promise<DraftSandboxFinishReceipt> {
  const { store, specs } = await readExactSpecs(request);
  const before = await executionSnapshot(request.ports, request.domain);
  validateCurrentBindings(specs, before, request.scope, request.domain);
  const suite = effectiveSuite(specs, before.ontology, request.domain, request.testCases, request.boundaryEvents);
  const fingerprint = evidenceIdentity(request.domain, specs, suite, before);
  const subjectDigest = sandboxDesignReviewSubjectDigest({ domain: request.domain, fingerprint });
  if (!request.ports.authorizationChallenges) {
    throw new DraftSandboxError("sandbox_review_store_missing", "一次性人工审查存储没有接入，不能创建 Inngest 沙箱 App。", 503);
  }
  const ref = challengeRef(request.challengeRef);
  if (ref.subjectDigest !== subjectDigest) {
    throw new DraftSandboxError("sandbox_review_stale", "代码、Ontology、工具、边界或测试数据在审查后发生了变化，请重新准备沙箱审查。", 409);
  }
  const challenge = await request.ports.authorizationChallenges.restore(request.domain, ref);
  if (!challenge || challenge.subjectDigest !== subjectDigest) {
    throw new DraftSandboxError("sandbox_review_stale", "这次沙箱批准已过期、已使用或不属于当前版本，请重新申请。", 409);
  }
  const answer = typeof request.answer === "string" ? request.answer : "";
  if (answer !== challenge.token) {
    throw new DraftSandboxError("sandbox_review_declined", "你没有批准创建沙箱 App；本次没有部署。", 409);
  }
  if (!request.actor.trim()) {
    throw new DraftSandboxError("interactive_human_required", "必须由当前交互式登录用户批准这次沙箱测试。", 403);
  }
  const receipt = await request.ports.authorizationChallenges.consume(request.domain, {
    challenge,
    answer,
    actor: request.actor,
    question: challenge.question,
    context: challenge.context,
    options: challenge.options,
  });

  let result: SandboxDeployResult;
  try {
    result = await request.ports.sandbox.deployAndObserve(request.domain, specs, {
      candidateFingerprint: fingerprint,
      fixtureConversationId: challenge.conversationId,
      testCases: suite.testCases.map((testCase) => ({
        id: testCase.id,
        entryEvent: testCase.entryEvent,
        payload: testCase.payload,
        kind: testCase.kind,
        ...(testCase.expectedEvent ? { expectedEvent: testCase.expectedEvent } : {}),
      })),
      boundaryEvents: suite.boundaryEvents.map((boundary) => ({ event: boundary.event, kind: boundary.kind })),
    });
  } catch (error) {
    const block = (error as { block?: { question?: unknown } })?.block;
    if (block && typeof block.question === "string") {
      throw new DraftSandboxError("sandbox_lifecycle_blocked", block.question, 409);
    }
    throw new DraftSandboxError(
      "sandbox_execution_failed",
      "临时 Inngest 沙箱执行失败；清理流程已经触发。请检查测试 App 配置和运行日志，修正后重新创建一个新 App 测试。",
      503,
    );
  }
  validateSandboxResult(result, fingerprint, request.domain, specs, before.ontology, before.realTools, suite.testCases.map((testCase) => testCase.id));

  // Re-read every execution-bearing surface after the disposable app has been
  // deleted. A tool/profile/Ontology change during the run invalidates this
  // attempt instead of racing into persistence.
  const after = await executionSnapshot(request.ports, request.domain);
  validateCurrentBindings(specs, after, request.scope, request.domain);
  const afterSuite = effectiveSuite(specs, after.ontology, request.domain, suite.testCases, suite.boundaryEvents);
  const afterFingerprint = evidenceIdentity(request.domain, specs, afterSuite, after);
  if (afterFingerprint !== fingerprint) {
    throw new DraftSandboxError(
      "sandbox_evidence_drift",
      "沙箱运行期间 Ontology、工具、配置或测试输入发生了变化；这次 App 已清理，但结果不会保存。请重新审查并新建一次沙箱。",
      409,
    );
  }

  const evidence: AgentDraftRegressionEvidence = {
    evidenceFingerprint: fingerprint,
    authoritativeOntology: authoritativeOntologyEvidence(
      {
        tenantId: request.scope.tenantId,
        tenantSlug: request.scope.tenantSlug,
        domainId: request.domain,
      },
      after.ontology,
    ),
    cleanupReceipt: result.cleanupReceipt,
    sandboxAppId: result.appId,
    committedManifestFunctionIds: result.committedManifestFunctionIds,
    brokerRegistration: result.brokerRegistration,
    executionReceipt: result.executionReceipt,
    modelUsage: result.modelUsage,
    approvedTestCases: suite.testCases,
    testCoverage: suite.coverage,
    boundaryEvents: suite.boundaryEvents,
    functionTester: result.functionTester,
    toolMode: result.toolMode,
    externalLiveCalls: result.externalLiveCalls,
    replayReceipts: result.replayReceipts,
    sandboxReplayEvidenceComplete: result.sandboxReplayEvidenceComplete,
    sandboxDesignReview: {
      fingerprint,
      subjectDigest,
      receipt,
    },
    cassetteRefs: result.cassetteRefs ?? selectedCassetteRefs(specs, after),
  };
  const persisted = await store.createSandboxedVersion(request.domain, request.versionId, evidence);
  const replay = await store.validateSandboxedRegression(
    request.domain,
    persisted.drafts.map((draft) => draft.slug),
    persisted.versionId,
  );
  if (!replay.pass || !replay.suiteFingerprint) {
    throw new DraftSandboxError(
      "regression_materialization_failed",
      "沙箱本身通过了，但新的不可变回归工件没有完整回放通过；这个版本不会被当作可晋升证据。请检查回放错误后重新测试。",
      503,
    );
  }
  await store.publishValidatedVersion(
    request.domain,
    persisted.versionId,
    request.versionId,
  );
  return {
    schema: "agent-factory-draft-sandbox-finish/v1",
    scope: {
      tenantId: request.scope.tenantId,
      tenantSlug: request.scope.tenantSlug,
      domain: request.domain,
      slug: request.slug,
      versionId: persisted.versionId,
      baseVersionId: request.versionId,
    },
    baseVersionId: request.versionId,
    versionId: persisted.versionId,
    regressionReady: true,
    fingerprint,
    sandbox: {
      appId: result.appId,
      attemptId: result.sandboxAttemptId!,
      cleanupVerified: true,
      functionsRegistered: result.functionsRegistered,
      agentsRan: result.ran,
    },
    regressionReplay: {
      pass: true,
      suiteFingerprint: replay.suiteFingerprint,
      results: replay.results.length,
    },
  };
}
