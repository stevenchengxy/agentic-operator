import type {
  CompiledPrompt,
  EvidenceAnalysis,
  QualificationCompilerReceipt,
  QualifiedAgentRunReceipt,
  ReasoningOutput,
  RuleSelectionToolData,
} from "./contracts";

export interface VisibleEvidenceFact {
  category: EvidenceAnalysis["facts"][number]["category"];
  purpose: EvidenceAnalysis["facts"][number]["purpose"];
  label: string;
  value: string | null;
  evidencePath: string;
  relevance: string;
  verified: boolean;
}

export interface VisibleEvidenceAnalysis {
  source: "llm_path_verified" | "legacy_input_projection";
  facts: VisibleEvidenceFact[];
  temporalFacts: EvidenceAnalysis["temporalFacts"];
  ruleEvidencePlan: EvidenceAnalysis["ruleEvidencePlan"];
  verifiedCount: number;
  unverifiedCount: number;
}

export interface PromptReceiptBinding {
  status: "verified" | "awaiting_child" | "legacy_unverified" | "mismatch";
  compilerIdMatches: boolean | null;
  promptHashMatches: boolean | null;
  ruleBundleMatches: boolean | null;
}

/** Public receipt binding only; it never claims to expose model reasoning. */
export function projectPromptReceiptBinding(
  compiler:
    | Pick<CompiledPrompt, "compilerId" | "promptSha256">
    | QualificationCompilerReceipt
    | null,
  qualifiedRun: QualifiedAgentRunReceipt | null,
  expectedRuleBundleId?: string | null,
): PromptReceiptBinding {
  if (!compiler?.promptSha256) {
    return {
      status: "legacy_unverified",
      compilerIdMatches: null,
      promptHashMatches: null,
      ruleBundleMatches: null,
    };
  }
  if (!qualifiedRun) {
    return {
      status: "awaiting_child",
      compilerIdMatches: null,
      promptHashMatches: null,
      ruleBundleMatches: null,
    };
  }
  const compilerIdMatches = compiler.compilerId === qualifiedRun.compilerId;
  const promptHashMatches = compiler.promptSha256 === qualifiedRun.promptSha256;
  const ruleBundleMatches = expectedRuleBundleId
    ? expectedRuleBundleId === qualifiedRun.ruleBundleId
    : null;
  return {
    status:
      compilerIdMatches && promptHashMatches && ruleBundleMatches !== false
        ? "verified"
        : "mismatch",
    compilerIdMatches,
    promptHashMatches,
    ruleBundleMatches,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function primitive(value: unknown): string | null {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  return null;
}

function addLegacyFact(
  facts: VisibleEvidenceFact[],
  value: unknown,
  fact: Omit<VisibleEvidenceFact, "value" | "verified">,
): void {
  const visible = primitive(value);
  if (
    visible == null ||
    facts.some((item) => item.evidencePath === fact.evidencePath)
  ) {
    return;
  }
  facts.push({ ...fact, value: visible, verified: true });
}

function legacyFacts(input: unknown): VisibleEvidenceFact[] {
  const root = recordValue(input);
  const evidence = recordValue(root.evidence ?? root);
  const candidate = recordValue(evidence.candidate);
  const job = recordValue(evidence.jobRequisition ?? evidence.job_requisition);
  const jd = recordValue(evidence.jd);
  const resume = recordValue(evidence.resume);
  const facts: VisibleEvidenceFact[] = [];
  const replay = "旧运行没有首轮 LLM 事实回执；此项由原始输入确定性回放。";

  addLegacyFact(facts, candidate.name, {
    category: "candidate",
    purpose: "context",
    label: "候选人",
    evidencePath: "candidate.name",
    relevance: replay,
  });
  addLegacyFact(facts, candidate.nationality, {
    category: "candidate",
    purpose: "rule_evaluation",
    label: "国籍",
    evidencePath: "candidate.nationality",
    relevance: replay,
  });
  addLegacyFact(facts, job.client_name ?? jd.client, {
    category: "target_job",
    purpose: "scope_selection",
    label: "目标客户",
    evidencePath: job.client_name ? "jobRequisition.client_name" : "jd.client",
    relevance: "决定客户通用规则作用域。",
  });
  addLegacyFact(
    facts,
    job.client_department_name ?? jd.business_group ?? jd.department,
    {
      category: "target_job",
      purpose: "scope_selection",
      label: "目标部门",
      evidencePath: job.client_department_name
        ? "jobRequisition.client_department_name"
        : "jd.business_group",
      relevance: "决定客户部门规则作用域。",
    },
  );
  addLegacyFact(facts, job.client_studio ?? jd.studio, {
    category: "target_job",
    purpose: "rule_evaluation",
    label: "目标工作室",
    evidencePath: job.client_studio
      ? "jobRequisition.client_studio"
      : "jd.studio",
    relevance: replay,
  });
  addLegacyFact(facts, job.client_job_title ?? jd.title, {
    category: "target_job",
    purpose: "context",
    label: "目标岗位",
    evidencePath: job.client_job_title
      ? "jobRequisition.client_job_title"
      : "jd.title",
    relevance: replay,
  });

  const history = Array.isArray(resume.employment_history)
    ? resume.employment_history.slice(0, 4)
    : [];
  history.forEach((rawEntry, index) => {
    const entry = recordValue(rawEntry);
    addLegacyFact(facts, entry.company, {
      category: "employment_history",
      purpose: "rule_evaluation",
      label: `历史任职 ${index + 1}`,
      evidencePath: `resume.employment_history[${index}].company`,
      relevance: replay,
    });
    addLegacyFact(facts, entry.end_date, {
      category: "employment_history",
      purpose: "rule_evaluation",
      label: `离职日期 ${index + 1}`,
      evidencePath: `resume.employment_history[${index}].end_date`,
      relevance: replay,
    });
  });
  return facts;
}

export function projectVisibleEvidenceAnalysis(
  output: ReasoningOutput | null,
  selection: RuleSelectionToolData | null,
  input: unknown,
  compiledPrompt?: CompiledPrompt | null,
): VisibleEvidenceAnalysis {
  const structured =
    output?.audit.evidenceAnalysis ?? selection?.evidenceAnalysis;
  if (structured && structured.facts.length > 0) {
    return {
      source: "llm_path_verified",
      facts: structured.facts,
      temporalFacts: structured.temporalFacts,
      ruleEvidencePlan:
        output?.audit.compiledPrompt.evidencePlan ??
        compiledPrompt?.evidencePlan ??
        structured.ruleEvidencePlan ??
        [],
      verifiedCount: structured.verifiedCount,
      unverifiedCount: structured.unverifiedCount,
    };
  }
  const facts = legacyFacts(input);
  return {
    source: "legacy_input_projection",
    facts,
    temporalFacts: structured?.temporalFacts ?? [],
    ruleEvidencePlan:
      output?.audit.compiledPrompt.evidencePlan ??
      compiledPrompt?.evidencePlan ??
      [],
    verifiedCount: facts.length,
    unverifiedCount: structured?.unverifiedCount ?? 0,
  };
}

export function projectSelectionFunnel(
  diagnostics: Record<string, unknown> | null | undefined,
  selectedCount: number,
): { scanned: number | null; matched: number | null; selected: number } {
  const scanned = diagnostics?.scannedRuleCount;
  const matched = diagnostics?.matchedRuleCount;
  const selected = diagnostics?.selectedRuleCount;
  return {
    scanned: typeof scanned === "number" ? scanned : null,
    matched: typeof matched === "number" ? matched : null,
    selected: typeof selected === "number" ? selected : selectedCount,
  };
}

export function humanizeMatchReason(reason: string): string {
  const normalized = reason.trim();
  const lower = normalized.toLowerCase();
  if (lower.includes("scoped_to")) return "作用域 Link";
  if (lower.includes("governs")) return "显式流程 Link";
  if (lower.includes("applies_to")) return "对象 Link";
  if (lower.includes("relevant_to")) return "已审核语义 Link";
  if (lower.includes("action") && lower.includes("link"))
    return "Action 语义关联";
  if (lower.includes("csi") && lower.includes("universal"))
    return "CSI 通用作用域";
  if (lower.includes("department")) return "目标部门匹配";
  if (lower.includes("client")) return "目标客户匹配";
  if (lower.includes("object")) return "业务对象匹配";
  if (lower.includes("keyword")) return `语义关键词 · ${normalized}`;
  return normalized;
}

/** A semantic-link badge is evidence-backed only by the executed receipt. */
export function hasVerifiedSemanticLinkReceipt(value: unknown): boolean {
  const receipt = recordValue(value);
  return receipt.linkOnly === true && receipt.fallbackUsed === false;
}

const REDACTED_AUDIT_KEYS = new Set([
  "analysis",
  "chainofthought",
  "internalreasoning",
  "reasoning",
  "reasoningcontent",
  "reasoningdetails",
  "thinking",
  "thoughts",
  "authorization",
  "cookie",
  "setcookie",
  "apikey",
  "accesstoken",
  "refreshtoken",
]);

function normalizedKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Public log projection: preserves tool I/O while removing secrets and any
 * provider-private reasoning payload that must not be rendered as chain of thought. */
export function publicAuditPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return "[depth limited]";
  if (Array.isArray(value)) {
    return value.map((item) => publicAuditPayload(item, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      REDACTED_AUDIT_KEYS.has(normalizedKey(key))
        ? "[redacted from public audit]"
        : publicAuditPayload(child, depth + 1),
    ]),
  );
}
