import type { Translate } from "@/app/portal/lib/preferences-context";
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

function legacyFacts(input: unknown, t: Translate): VisibleEvidenceFact[] {
  const root = recordValue(input);
  const evidence = recordValue(root.evidence ?? root);
  const candidate = recordValue(evidence.candidate);
  const job = recordValue(evidence.jobRequisition ?? evidence.job_requisition);
  const jd = recordValue(evidence.jd);
  const resume = recordValue(evidence.resume);
  const facts: VisibleEvidenceFact[] = [];
  const replay = t("reasoningAgent.auditView.legacyReplayNote");

  addLegacyFact(facts, candidate.name, {
    category: "candidate",
    purpose: "context",
    label: t("reasoningAgent.auditView.factLabel.candidate"),
    evidencePath: "candidate.name",
    relevance: replay,
  });
  addLegacyFact(facts, candidate.nationality, {
    category: "candidate",
    purpose: "rule_evaluation",
    label: t("reasoningAgent.auditView.factLabel.nationality"),
    evidencePath: "candidate.nationality",
    relevance: replay,
  });
  addLegacyFact(facts, job.client_name ?? jd.client, {
    category: "target_job",
    purpose: "scope_selection",
    label: t("reasoningAgent.auditView.factLabel.targetClient"),
    evidencePath: job.client_name ? "jobRequisition.client_name" : "jd.client",
    relevance: t("reasoningAgent.auditView.relevance.clientScope"),
  });
  addLegacyFact(
    facts,
    job.client_department_name ?? jd.business_group ?? jd.department,
    {
      category: "target_job",
      purpose: "scope_selection",
      label: t("reasoningAgent.auditView.factLabel.targetDepartment"),
      evidencePath: job.client_department_name
        ? "jobRequisition.client_department_name"
        : "jd.business_group",
      relevance: t("reasoningAgent.auditView.relevance.departmentScope"),
    },
  );
  addLegacyFact(facts, job.client_studio ?? jd.studio, {
    category: "target_job",
    purpose: "rule_evaluation",
    label: t("reasoningAgent.auditView.factLabel.targetStudio"),
    evidencePath: job.client_studio
      ? "jobRequisition.client_studio"
      : "jd.studio",
    relevance: replay,
  });
  addLegacyFact(facts, job.client_job_title ?? jd.title, {
    category: "target_job",
    purpose: "context",
    label: t("reasoningAgent.auditView.factLabel.targetRole"),
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
      label: t("reasoningAgent.auditView.factLabel.employmentHistory", {
        index: index + 1,
      }),
      evidencePath: `resume.employment_history[${index}].company`,
      relevance: replay,
    });
    addLegacyFact(facts, entry.end_date, {
      category: "employment_history",
      purpose: "rule_evaluation",
      label: t("reasoningAgent.auditView.factLabel.endDate", {
        index: index + 1,
      }),
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
  t: Translate,
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
  const facts = legacyFacts(input, t);
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

export function humanizeMatchReason(reason: string, t: Translate): string {
  const normalized = reason.trim();
  const lower = normalized.toLowerCase();
  if (lower.includes("scoped_to"))
    return t("reasoningAgent.auditView.matchReason.scopedTo");
  if (lower.includes("governs"))
    return t("reasoningAgent.auditView.matchReason.governs");
  if (lower.includes("applies_to"))
    return t("reasoningAgent.auditView.matchReason.appliesTo");
  if (lower.includes("relevant_to"))
    return t("reasoningAgent.auditView.matchReason.relevantTo");
  if (lower.includes("action") && lower.includes("link"))
    return t("reasoningAgent.auditView.matchReason.actionLink");
  if (lower.includes("csi") && lower.includes("universal"))
    return t("reasoningAgent.auditView.matchReason.csiUniversal");
  if (lower.includes("department"))
    return t("reasoningAgent.auditView.matchReason.departmentMatch");
  if (lower.includes("client"))
    return t("reasoningAgent.auditView.matchReason.clientMatch");
  if (lower.includes("object"))
    return t("reasoningAgent.auditView.matchReason.objectMatch");
  if (lower.includes("keyword"))
    return t("reasoningAgent.auditView.matchReason.keyword", {
      keyword: normalized,
    });
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
export function publicAuditPayload(
  value: unknown,
  t: Translate,
  depth = 0,
): unknown {
  if (depth > 12) return t("reasoningAgent.auditView.depthLimited");
  if (Array.isArray(value)) {
    return value.map((item) => publicAuditPayload(item, t, depth + 1));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      REDACTED_AUDIT_KEYS.has(normalizedKey(key))
        ? t("reasoningAgent.auditView.redactedFromPublicAudit")
        : publicAuditPayload(child, t, depth + 1),
    ]),
  );
}
