import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

const RESULT_FILE = "reasoning-result.json";
const MAX_RESULT_BYTES = 4 * 1024 * 1024;

export interface PersistedReasoningResult {
  schemaVersion: "reasoning-result/v1" | "reasoning-result/v2";
  runId: string;
  output: Record<string, unknown>;
}

function artifactPath(runId: string): string {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(runId)) {
    throw new Error(`Invalid reasoning run id: ${runId}`);
  }
  return path.join(
    process.env.AGENTIC_ARTIFACTS_DIR ?? "./artifacts",
    runId,
    RESULT_FILE,
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      `Reasoning result integrity: ${label} must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(
      `Reasoning result integrity: ${label} must be a string`,
    );
  }
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(
      `Reasoning result integrity: ${label} must be an array`,
    );
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) =>
    text(item, `${label}[${index}]`),
  );
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function promptSha256(input: {
  systemPrompt: string;
  userPrompt: string;
  fullSemanticPathsSha256: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(input.systemPrompt)
    .update("\0")
    .update(input.userPrompt)
    .update("\0")
    .update(input.fullSemanticPathsSha256)
    .digest("hex")}`;
}

function sameStrings(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TypeError(
      `Reasoning result integrity: ${label} must be a non-negative integer`,
    );
  }
  return value;
}

function requireIntegrity(condition: boolean, message: string): void {
  if (!condition) throw new TypeError(`Reasoning result integrity: ${message}`);
}

/**
 * Re-verify persisted v2 receipts before an audit artifact is exposed. The
 * runtime validates the same bindings while producing the result; repeating
 * the checks at the trust boundary detects later truncation or tampering.
 */
export function assertReasoningResultV2Integrity(
  outputValue: unknown,
  parentRunId: string,
): void {
  const output = record(outputValue, "output");
  const audit = record(output.audit, "output.audit");
  const compiled = record(audit.compiledPrompt, "output.audit.compiledPrompt");
  const selection = record(audit.ruleSelection, "output.audit.ruleSelection");
  const quality = record(audit.qualityCheck, "output.audit.qualityCheck");
  const qualifiedRun = record(quality.run, "output.audit.qualityCheck.run");
  const topCompiler = record(output.promptCompiler, "output.promptCompiler");

  const compilerId = text(compiled.compilerId, "compiledPrompt.compilerId");
  const compilerVersion = text(
    compiled.compilerVersion,
    "compiledPrompt.compilerVersion",
  );
  const strictV3 =
    compilerVersion === "v3" || compilerVersion === "qualified-rule-check/v3";
  const promptReceipt = text(
    compiled.promptSha256,
    "compiledPrompt.promptSha256",
  );
  const systemPrompt = text(
    compiled.systemPrompt,
    "compiledPrompt.systemPrompt",
  );
  const userPrompt = text(compiled.userPrompt, "compiledPrompt.userPrompt");
  const ruleIds = stringArray(compiled.ruleIds, "compiledPrompt.ruleIds");
  const evidenceKeys = stringArray(
    compiled.evidenceKeys,
    "compiledPrompt.evidenceKeys",
  );
  const selectedRules = array(selection.selectedRules, "selectedRules");
  const selectedRuleIds = selectedRules.map((rule, index) =>
    text(
      record(rule, `selectedRules[${index}]`).id,
      `selectedRules[${index}].id`,
    ),
  );
  const semanticPaths = selectedRules.map((rule, index) => {
    const selectedRule = record(rule, `selectedRules[${index}]`);
    return {
      ruleId: text(selectedRule.id, `selectedRules[${index}].id`),
      linkPaths: array(
        selectedRule.linkPaths,
        `selectedRules[${index}].linkPaths`,
      ),
    };
  });
  const semanticPathCount = semanticPaths.reduce(
    (count, entry) => count + entry.linkPaths.length,
    0,
  );
  const fullSemanticPathsSha256 =
    typeof compiled.fullSemanticPathsSha256 === "string" &&
    compiled.fullSemanticPathsSha256.trim()
      ? compiled.fullSemanticPathsSha256
      : null;

  requireIntegrity(
    !strictV3 || fullSemanticPathsSha256 !== null,
    "v3 compiledPrompt.fullSemanticPathsSha256 is missing",
  );
  if (fullSemanticPathsSha256) {
    requireIntegrity(
      fullSemanticPathsSha256 === sha256(JSON.stringify(semanticPaths)),
      "full Semantic Link paths hash mismatch",
    );
  }
  if (strictV3 && fullSemanticPathsSha256) {
    requireIntegrity(
      promptReceipt ===
        promptSha256({ systemPrompt, userPrompt, fullSemanticPathsSha256 }),
      "compiled Prompt content hash mismatch",
    );
  }
  requireIntegrity(
    sameStrings(ruleIds, selectedRuleIds),
    "compiled ruleIds do not match selected RuleBundle order",
  );
  if (strictV3 || compiled.semanticLinkCount !== undefined) {
    requireIntegrity(
      integer(
        compiled.semanticLinkCount,
        "compiledPrompt.semanticLinkCount",
      ) === semanticPathCount,
      "semanticLinkCount does not match selected RuleBundle paths",
    );
  }

  if (strictV3) {
    const canonicalCompilerInput = JSON.stringify({
      compilerVersion,
      domainId: text(output.domainId, "output.domainId"),
      action: text(output.action, "output.action"),
      scenario: text(output.scenario, "output.scenario"),
      queryIr: record(output.queryIr, "output.queryIr"),
      ruleIds,
      evidenceKeys,
      harnessPlan: record(compiled.harnessPlan, "compiledPrompt.harnessPlan"),
      semanticPaths,
      evidencePlan: array(compiled.evidencePlan, "compiledPrompt.evidencePlan"),
    });
    requireIntegrity(
      compilerId ===
        `pc:${createHash("sha256").update(canonicalCompilerInput).digest("hex")}`,
      "compilerId does not match the compiled inputs",
    );
  }
  requireIntegrity(
    topCompiler.compilerId === compilerId &&
      topCompiler.compilerVersion === compilerVersion &&
      sameStrings(
        stringArray(topCompiler.evidenceKeys, "promptCompiler.evidenceKeys"),
        evidenceKeys,
      ),
    "top-level Prompt Compiler receipt mismatch",
  );

  const ruleBundleId = text(output.ruleBundleId, "output.ruleBundleId");
  requireIntegrity(
    qualifiedRun.role === "qualified" &&
      qualifiedRun.executionMode === "isolated-child-run" &&
      qualifiedRun.parentRunId === parentRunId &&
      qualifiedRun.compilerId === compilerId &&
      qualifiedRun.promptSha256 === promptReceipt &&
      qualifiedRun.ruleBundleId === ruleBundleId,
    "QualifiedAgent child receipt mismatch",
  );

  const assessments = array(output.assessments, "output.assessments");
  const assessmentRuleIds = assessments.map((assessment, index) =>
    text(
      record(assessment, `assessments[${index}]`).ruleId,
      `assessments[${index}].ruleId`,
    ),
  );
  const ruleCount = integer(output.ruleCount, "output.ruleCount");
  const assessmentCount = integer(
    quality.assessmentCount,
    "qualityCheck.assessmentCount",
  );
  requireIntegrity(
    ruleCount === selectedRules.length &&
      ruleCount === ruleIds.length &&
      ruleCount === assessments.length &&
      assessmentCount === assessments.length &&
      integer(qualifiedRun.assessmentCount, "qualifiedRun.assessmentCount") ===
        assessments.length &&
      sameStrings(assessmentRuleIds, ruleIds),
    "RuleBundle and assessment counts/order do not match",
  );

  const enforcementCounts = selectedRules.reduce<{
    mandatory: number;
    optional: number;
  }>(
    (counts, rule, index) => {
      const level = text(
        record(rule, `selectedRules[${index}]`).enforcementLevel,
        `selectedRules[${index}].enforcementLevel`,
      );
      if (level === "mandatory") counts.mandatory += 1;
      else if (level === "optional") counts.optional += 1;
      else requireIntegrity(false, `unknown enforcementLevel ${level}`);
      return counts;
    },
    { mandatory: 0, optional: 0 },
  );
  requireIntegrity(
    integer(selection.mandatoryCount, "ruleSelection.mandatoryCount") ===
      enforcementCounts.mandatory &&
      integer(selection.optionalCount, "ruleSelection.optionalCount") ===
        enforcementCounts.optional,
    "mandatory/optional counts do not match selected rules",
  );

  const statuses = [
    "satisfied",
    "violated",
    "optional_unmet",
    "not_applicable",
    "insufficient_evidence",
  ] as const;
  const computedStatusCounts = Object.fromEntries(
    statuses.map((status) => [status, 0]),
  ) as Record<(typeof statuses)[number], number>;
  for (const [index, assessment] of assessments.entries()) {
    const status = text(
      record(assessment, `assessments[${index}]`).status,
      `assessments[${index}].status`,
    );
    requireIntegrity(
      statuses.includes(status as (typeof statuses)[number]),
      `unknown assessment status ${status}`,
    );
    computedStatusCounts[status as (typeof statuses)[number]] += 1;
  }
  const persistedStatusCounts = record(
    quality.statusCounts,
    "qualityCheck.statusCounts",
  );
  requireIntegrity(
    statuses.every(
      (status) =>
        integer(
          persistedStatusCounts[status],
          `qualityCheck.statusCounts.${status}`,
        ) === computedStatusCounts[status],
    ),
    "persisted statusCounts do not match assessments",
  );

  const queryExecution = record(
    selection.queryExecution,
    "ruleSelection.queryExecution",
  );
  const queryExecutions = array(
    selection.queryExecutions,
    "ruleSelection.queryExecutions",
  ).map((execution, index) =>
    record(execution, `ruleSelection.queryExecutions[${index}]`),
  );
  requireIntegrity(
    queryExecutions.length === 2 &&
      queryExecutions[0]?.purpose === "semantic-rule-selection" &&
      queryExecutions[1]?.purpose === "mandatory-link-coverage" &&
      queryExecutions[1]?.rowCount === 0 &&
      queryExecution.fingerprint === queryExecutions[0]?.fingerprint &&
      selection.queryFingerprint === queryExecution.fingerprint,
    "Link-only Cypher receipts do not match",
  );
  requireIntegrity(
    queryExecutions.every(
      (execution) =>
        execution.language === "cypher" &&
        execution.readOnly === true &&
        execution.domainLocked === true &&
        execution.linkOnly === true &&
        execution.fallbackUsed === false &&
        typeof execution.query === "string" &&
        !execution.query.toLowerCase().includes("stage"),
    ),
    "Cypher receipt is not read-only/domain-locked/link-only/stage-free",
  );
  requireIntegrity(
    audit.hiddenChainOfThoughtExposed === false,
    "hiddenChainOfThoughtExposed must remain false",
  );
}

/** Read the final, post-fold Reasoning output written by ReasoningAgent. */
export async function readReasoningRunResult(
  runId: string,
): Promise<PersistedReasoningResult | null> {
  const filePath = artifactPath(runId);
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (size > MAX_RESULT_BYTES) {
    throw new Error(
      `Reasoning result ${runId} exceeds ${MAX_RESULT_BYTES} bytes`,
    );
  }
  const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Reasoning result artifact must be a JSON object");
  }
  const envelope = parsed as Partial<PersistedReasoningResult>;
  if (
    !["reasoning-result/v1", "reasoning-result/v2"].includes(
      String(envelope.schemaVersion),
    ) ||
    envelope.runId !== runId ||
    !envelope.output ||
    typeof envelope.output !== "object" ||
    Array.isArray(envelope.output)
  ) {
    throw new TypeError("Reasoning result artifact has an invalid envelope");
  }
  if (envelope.schemaVersion === "reasoning-result/v2") {
    assertReasoningResultV2Integrity(envelope.output, runId);
  }
  return envelope as PersistedReasoningResult;
}
