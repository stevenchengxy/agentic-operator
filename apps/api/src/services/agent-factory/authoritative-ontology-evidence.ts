import {
  canonicalEvidenceJson,
  ontologyContentHash,
  type AuthoritativeOntologyEvidence,
  type DomainOntology,
  type OntologySource,
} from "@agentic/agent-factory";

export const AUTHORITATIVE_ONTOLOGY_EVIDENCE_SCHEMA =
  "agent-factory-authoritative-ontology/v1" as const;

const ONTOLOGY_HASH = /^ontology:v2:[a-f0-9]{64}$/;

export interface AuthoritativeOntologyScope {
  tenantId: string;
  tenantSlug: string;
  domainId: string;
}

export class AuthoritativeOntologyPromotionError extends Error {
  constructor(
    readonly code:
      | "authoritative_ontology_evidence_missing"
      | "authoritative_ontology_unavailable"
      | "authoritative_ontology_drift",
    message: string,
  ) {
    super(message);
    this.name = "AuthoritativeOntologyPromotionError";
  }
}

const restartInstruction =
  "请重新执行“预检 → 新建沙箱测试 → 人工审查”，不要继续使用旧的绿色结果。";

/** Capture the exact normalized source identity after the sandbox's second,
 * drift-free authoritative read. */
export function authoritativeOntologyEvidence(
  scope: AuthoritativeOntologyScope,
  ontology: DomainOntology,
): AuthoritativeOntologyEvidence {
  if (ontology.domainId !== scope.domainId) {
    throw new AuthoritativeOntologyPromotionError(
      "authoritative_ontology_drift",
      `权威 Ontology 返回了另一个 domain（期望 ${scope.domainId}，实际 ${ontology.domainId}）。${restartInstruction}`,
    );
  }
  const evidence: AuthoritativeOntologyEvidence = {
    schema: AUTHORITATIVE_ONTOLOGY_EVIDENCE_SCHEMA,
    tenantId: scope.tenantId,
    tenantSlug: scope.tenantSlug,
    domainId: scope.domainId,
    source: ontology.source,
    contentHash: ontologyContentHash(ontology),
  };
  const issues = authoritativeOntologyEvidenceIssues(evidence, scope);
  if (issues.length) {
    throw new AuthoritativeOntologyPromotionError(
      "authoritative_ontology_evidence_missing",
      `无法记录可验证的权威 Ontology 身份：${issues.join("；")}。${restartInstruction}`,
    );
  }
  return evidence;
}

/** Structural/scope validation used while materializing and replaying the
 * immutable artifact. It intentionally performs no I/O. */
export function authoritativeOntologyEvidenceIssues(
  evidence: AuthoritativeOntologyEvidence | null | undefined,
  scope?: Partial<AuthoritativeOntologyScope>,
): string[] {
  if (!evidence) return ["缺少权威 Ontology 身份和摘要"];
  const issues: string[] = [];
  if (evidence.schema !== AUTHORITATIVE_ONTOLOGY_EVIDENCE_SCHEMA) {
    issues.push("权威 Ontology 证据版本不受支持");
  }
  if (!evidence.tenantId?.trim()) issues.push("缺少 tenantId");
  if (!evidence.tenantSlug?.trim()) issues.push("缺少 tenantSlug");
  if (!evidence.domainId?.trim()) issues.push("缺少 domainId");
  if (evidence.source !== "allmeta" && evidence.source !== "snapshot") {
    issues.push("Ontology source 无效");
  }
  if (!ONTOLOGY_HASH.test(evidence.contentHash ?? "")) {
    issues.push("Ontology contentHash 无效");
  }
  if (scope?.tenantId && evidence.tenantId !== scope.tenantId) {
    issues.push("Ontology tenantId 与当前业务领域不一致");
  }
  if (scope?.tenantSlug && evidence.tenantSlug !== scope.tenantSlug) {
    issues.push("Ontology tenantSlug 与当前业务领域不一致");
  }
  if (scope?.domainId && evidence.domainId !== scope.domainId) {
    issues.push("Ontology domainId 与当前连接不一致");
  }
  return [...new Set(issues)];
}

export function sameAuthoritativeOntologyEvidence(
  left: AuthoritativeOntologyEvidence | null | undefined,
  right: AuthoritativeOntologyEvidence | null | undefined,
): boolean {
  return Boolean(left && right)
    && canonicalEvidenceJson(left) === canonicalEvidenceJson(right);
}

/** Promotion/read-review commit guard. The caller must supply the exact
 * Factory Ontology port selected from the persisted tenant binding; this
 * function never falls back to another source or a local snapshot. */
export async function assertAuthoritativeOntologyCurrent(input: {
  ontology: OntologySource;
  expected: AuthoritativeOntologyEvidence | null | undefined;
  scope: AuthoritativeOntologyScope;
}): Promise<AuthoritativeOntologyEvidence> {
  const evidenceIssues = authoritativeOntologyEvidenceIssues(
    input.expected,
    input.scope,
  );
  if (evidenceIssues.length) {
    throw new AuthoritativeOntologyPromotionError(
      "authoritative_ontology_evidence_missing",
      `这个草稿版本没有可验证的权威 Ontology 证据：${evidenceIssues.join("；")}。${restartInstruction}`,
    );
  }

  let current: DomainOntology;
  try {
    current = await input.ontology.fetchOntology(input.scope.domainId);
  } catch (error) {
    throw new AuthoritativeOntologyPromotionError(
      "authoritative_ontology_unavailable",
      `现在无法读取业务领域「${input.scope.domainId}」的权威 Ontology，已停止预览/晋升。请确认 AllmetaOntology 或当前绑定的上传本体可用后再试。${restartInstruction}`,
    );
  }

  const observed = authoritativeOntologyEvidence(input.scope, current);
  if (!sameAuthoritativeOntologyEvidence(input.expected, observed)) {
    throw new AuthoritativeOntologyPromotionError(
      "authoritative_ontology_drift",
      `业务领域「${input.scope.domainId}」的权威 Ontology 已在沙箱通过后发生变化（来源或内容摘要不同），旧的测试和人工签核不再代表当前业务定义。${restartInstruction}`,
    );
  }
  return observed;
}
