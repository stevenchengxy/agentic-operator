import {
  DRAFT_SANDBOX_TEST_SENTINELS,
  findDraftSandboxTestSentinel,
} from "@agentic/contracts";

import { draftEditContainsSensitiveData } from "./draft-editor";

export interface DraftSandboxScope {
  tenantId: string;
  tenantSlug: string;
  domain: string;
  slug: string;
  versionId: string;
}

export interface DraftSandboxInputContract {
  schema: "agent-factory-draft-sandbox-input/v1";
  scope: DraftSandboxScope;
  specsCount: number;
  entryEvents: Array<{
    event: string;
    fields: Array<{ name: string; type: string; required?: boolean; targetObject?: string }>;
  }>;
  unresolvedBoundaries: Array<{ event: string; producers: string[] }>;
  testKinds: Array<"pass" | "reject" | "edge" | "fault">;
  note: string;
}

export interface DraftSandboxChallenge {
  id: string;
  kind: "sandbox_design_review";
  protocolVersion: number;
  digest: string;
  subjectDigest: string;
  token: string;
  question: string;
  context: string;
  options: Array<{ label: string; value: string; recommended: boolean }>;
  runId: string;
  conversationId: string;
  expiresAt: string;
}

export interface DraftSandboxReview {
  schema: "agent-factory-draft-sandbox-review/v1";
  scope: DraftSandboxScope;
  fingerprint: string;
  specsCount: number;
  testCoverage: {
    required: string[];
    covered: string[];
    backfilled: string[];
    uncoveredNeedingData: string[];
  };
  testCases: Array<Record<string, unknown>>;
  boundaryEvents: Array<Record<string, unknown>>;
  challenge: DraftSandboxChallenge;
}

export interface DraftSandboxFinishReceipt {
  schema: "agent-factory-draft-sandbox-finish/v1";
  scope: DraftSandboxScope & { baseVersionId: string };
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

export type DraftSandboxValidation<T> =
  | { ok: true; data: T }
  | { ok: false; message: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function exactScope(value: unknown, expected: Omit<DraftSandboxScope, "tenantId">): value is DraftSandboxScope {
  return isRecord(value)
    && typeof value.tenantId === "string" && Boolean(value.tenantId)
    && value.tenantSlug === expected.tenantSlug
    && value.domain === expected.domain
    && value.slug === expected.slug
    && value.versionId === expected.versionId;
}

export function readDraftSandboxInputContract(
  value: unknown,
  expected: Omit<DraftSandboxScope, "tenantId">,
): DraftSandboxValidation<DraftSandboxInputContract> {
  if (!isRecord(value) || value.schema !== "agent-factory-draft-sandbox-input/v1" || !exactScope(value.scope, expected)) {
    return { ok: false, message: "服务端返回的测试输入契约不属于当前草稿版本。" };
  }
  if (!Number.isInteger(value.specsCount) || Number(value.specsCount) < 1 || !Array.isArray(value.entryEvents) || !Array.isArray(value.unresolvedBoundaries)) {
    return { ok: false, message: "测试输入契约不完整，请刷新后重试。" };
  }
  const entries = value.entryEvents.map((entry) => {
    if (!isRecord(entry) || typeof entry.event !== "string" || !entry.event || !Array.isArray(entry.fields)) return null;
    const fields = entry.fields.map((field) => {
      if (!isRecord(field) || typeof field.name !== "string" || !field.name || typeof field.type !== "string") return null;
      return {
        name: field.name,
        type: field.type,
        ...(typeof field.required === "boolean" ? { required: field.required } : {}),
        ...(typeof field.targetObject === "string" ? { targetObject: field.targetObject } : {}),
      };
    });
    return fields.some((field) => !field) ? null : { event: entry.event, fields: fields as DraftSandboxInputContract["entryEvents"][number]["fields"] };
  });
  const boundaries = value.unresolvedBoundaries.map((boundary) =>
    isRecord(boundary) && typeof boundary.event === "string" && boundary.event && isStringArray(boundary.producers)
      ? { event: boundary.event, producers: [...boundary.producers] }
      : null);
  if (entries.some((entry) => !entry) || boundaries.some((boundary) => !boundary)) {
    return { ok: false, message: "测试输入契约包含无法识别的事件字段。" };
  }
  const kinds = value.testKinds;
  if (!Array.isArray(kinds) || !["pass", "reject", "edge", "fault"].every((kind) => kinds.includes(kind))) {
    return { ok: false, message: "测试用例类型契约不完整。" };
  }
  return {
    ok: true,
    data: {
      schema: "agent-factory-draft-sandbox-input/v1",
      scope: value.scope as unknown as DraftSandboxScope,
      specsCount: Number(value.specsCount),
      entryEvents: entries as DraftSandboxInputContract["entryEvents"],
      unresolvedBoundaries: boundaries as DraftSandboxInputContract["unresolvedBoundaries"],
      testKinds: ["pass", "reject", "edge", "fault"],
      note: typeof value.note === "string" ? value.note : "请填写人工确认过的测试值。",
    },
  };
}

function placeholder(type: string): unknown {
  return `${DRAFT_SANDBOX_TEST_SENTINELS.value}（${type || "unknown"}）`;
}

export function draftSandboxTestTemplate(contract: DraftSandboxInputContract): string {
  return JSON.stringify(contract.entryEvents.map((entry, index) => ({
    id: `manual_${index + 1}`,
    name: `${entry.event} 人工测试`,
    scenario: DRAFT_SANDBOX_TEST_SENTINELS.scenario,
    kind: "pass",
    entryEvent: entry.event,
    payload: Object.fromEntries(entry.fields.map((field) => [field.name, placeholder(field.type)])),
    expectedOutcome: DRAFT_SANDBOX_TEST_SENTINELS.expectedOutcome,
  })), null, 2);
}

export function parseDraftSandboxSubmission(
  testCasesText: string,
  boundaryEventsText: string,
): DraftSandboxValidation<{ testCases: unknown[]; boundaryEvents: unknown[] }> {
  let testCases: unknown;
  let boundaryEvents: unknown;
  try {
    testCases = JSON.parse(testCasesText);
  } catch {
    return { ok: false, message: "测试用例不是有效的 JSON。" };
  }
  try {
    boundaryEvents = JSON.parse(boundaryEventsText || "[]");
  } catch {
    return { ok: false, message: "边界事件不是有效的 JSON。" };
  }
  if (!Array.isArray(testCases) || testCases.length === 0) {
    return { ok: false, message: "至少需要一个测试用例；不会用空 payload 自动补链。" };
  }
  if (!Array.isArray(boundaryEvents)) {
    return { ok: false, message: "边界事件必须是 JSON 数组。" };
  }
  const sentinelPath = findDraftSandboxTestSentinel(testCases);
  if (sentinelPath) {
    return { ok: false, message: `测试用例 ${sentinelPath} 还是模板占位内容。请把场景、预期结果和 payload 全部换成你确认过的测试值。` };
  }
  if (draftEditContainsSensitiveData(testCases) || draftEditContainsSensitiveData(boundaryEvents)) {
    return { ok: false, message: "测试 JSON 里不能直接放密钥、认证头、文件 bytes 或旧 fixture ID。二进制文件请回 Agent 工厂会话上传。" };
  }
  return { ok: true, data: { testCases, boundaryEvents } };
}

function validChallenge(value: unknown): value is DraftSandboxChallenge {
  if (!isRecord(value) || value.kind !== "sandbox_design_review" || !Number.isInteger(value.protocolVersion)) return false;
  if (
    typeof value.id !== "string" || !value.id
    || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/i.test(value.digest)
    || typeof value.subjectDigest !== "string" || !/^[a-f0-9]{64}$/i.test(value.subjectDigest)
    || typeof value.token !== "string" || !value.token
    || typeof value.question !== "string" || !value.question
    || typeof value.context !== "string" || !value.context
    || typeof value.runId !== "string" || !value.runId
    || value.conversationId !== value.runId
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt))
    || !Array.isArray(value.options) || value.options.length !== 2
  ) return false;
  const options = value.options as unknown[];
  if (!options.every((option) => isRecord(option) && typeof option.label === "string" && typeof option.value === "string" && typeof option.recommended === "boolean")) return false;
  const typedOptions = options as DraftSandboxChallenge["options"];
  const confirm = typedOptions.filter((option) => option.value === value.token);
  const decline = typedOptions.filter((option) => option.value !== value.token);
  return confirm.length === 1
    && confirm[0]!.recommended === false
    && decline.length === 1
    && decline[0]!.recommended === true
    && new Set(typedOptions.map((option) => option.value)).size === 2;
}

export function readDraftSandboxReview(
  value: unknown,
  expected: Omit<DraftSandboxScope, "tenantId">,
): DraftSandboxValidation<DraftSandboxReview> {
  if (!isRecord(value) || value.schema !== "agent-factory-draft-sandbox-review/v1" || !exactScope(value.scope, expected)) {
    return { ok: false, message: "沙箱审查回执不属于当前草稿版本。" };
  }
  if (
    typeof value.fingerprint !== "string" || !/^sandbox-evidence:v\d+:[a-f0-9]{64}$/i.test(value.fingerprint)
    || !Number.isInteger(value.specsCount) || Number(value.specsCount) < 1
    || !Array.isArray(value.testCases) || value.testCases.length === 0
    || !Array.isArray(value.boundaryEvents)
    || !isRecord(value.testCoverage)
    || !isStringArray(value.testCoverage.required)
    || !isStringArray(value.testCoverage.covered)
    || !isStringArray(value.testCoverage.backfilled)
    || !isStringArray(value.testCoverage.uncoveredNeedingData)
    || value.testCoverage.uncoveredNeedingData.length > 0
    || !validChallenge(value.challenge)
  ) {
    return { ok: false, message: "服务端没有返回完整、可确认的沙箱审查。" };
  }
  if (value.challenge.subjectDigest === "" || draftEditContainsSensitiveData(value.testCases) || draftEditContainsSensitiveData(value.boundaryEvents)) {
    return { ok: false, message: "沙箱审查包含不应进入浏览器的敏感测试数据。" };
  }
  return { ok: true, data: value as unknown as DraftSandboxReview };
}

export function sandboxChallengeRef(challenge: DraftSandboxChallenge): Omit<DraftSandboxChallenge, "token" | "question" | "context" | "options"> {
  const { token: _token, question: _question, context: _context, options: _options, ...ref } = challenge;
  return ref;
}

export function readDraftSandboxFinishReceipt(
  value: unknown,
  expected: Omit<DraftSandboxScope, "tenantId" | "versionId"> & { baseVersionId: string },
): DraftSandboxValidation<DraftSandboxFinishReceipt> {
  if (!isRecord(value) || value.schema !== "agent-factory-draft-sandbox-finish/v1" || !isRecord(value.scope)) {
    return { ok: false, message: "服务端没有返回完整的沙箱完成回执。" };
  }
  const scope = value.scope;
  if (
    typeof scope.tenantId !== "string" || !scope.tenantId
    || scope.tenantSlug !== expected.tenantSlug
    || scope.domain !== expected.domain
    || scope.slug !== expected.slug
    || scope.baseVersionId !== expected.baseVersionId
    || value.baseVersionId !== expected.baseVersionId
    || typeof value.versionId !== "string" || !value.versionId || value.versionId === expected.baseVersionId
    || scope.versionId !== value.versionId
    || value.regressionReady !== true
    || typeof value.fingerprint !== "string" || !/^sandbox-evidence:v\d+:[a-f0-9]{64}$/i.test(value.fingerprint)
    || !isRecord(value.sandbox) || value.sandbox.cleanupVerified !== true
    || typeof value.sandbox.appId !== "string" || !value.sandbox.appId
    || typeof value.sandbox.attemptId !== "string" || !value.sandbox.attemptId
    || !Number.isInteger(value.sandbox.functionsRegistered) || Number(value.sandbox.functionsRegistered) < 1
    || !Number.isInteger(value.sandbox.agentsRan) || Number(value.sandbox.agentsRan) < 1
    || !isRecord(value.regressionReplay) || value.regressionReplay.pass !== true
    || typeof value.regressionReplay.suiteFingerprint !== "string" || !value.regressionReplay.suiteFingerprint
    || !Number.isInteger(value.regressionReplay.results) || Number(value.regressionReplay.results) < 1
  ) {
    return { ok: false, message: "沙箱完成回执与当前版本不一致，或缺少清理/回归证据。" };
  }
  return { ok: true, data: value as unknown as DraftSandboxFinishReceipt };
}
