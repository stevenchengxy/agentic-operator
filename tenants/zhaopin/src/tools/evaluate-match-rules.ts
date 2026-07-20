/**
 * evaluateMatchRules — RAAS-v1 deterministic, fail-closed rule evaluator.
 *
 * The live Allmeta action currently exposes 11 mandatory rules.  A rule may be
 * stamped `pass` only when the input contains the facts needed to prove that it
 * is satisfied (or not applicable).  Missing work history, target-job context,
 * dates, application history, or approval state is `insufficient_info`, which
 * `foldRuleDecision` treats as blocking.  This is deliberately different from
 * treating "no matching token found" as proof that a rule passed.
 */

import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";

interface FetchedRule {
  id?: string;
  rule_id?: string;
  businessLogicRuleName?: string;
  standardizedLogicRule?: string;
  enforcementLevel?: unknown;
  enforcement_level?: unknown;
  mandatory?: unknown;
  [k: string]: unknown;
}

type RuleStatus = "pass" | "fail" | "insufficient_info";

interface Evaluation {
  status: RuleStatus;
  reason: string;
}

interface StructuredList {
  known: boolean;
  values: unknown[];
}

const LIVE_RULE_IDS = new Set([
  "10-25",
  "10-26",
  "10-35",
  "10-49",
  "10-43",
  "10-56",
  "10-51",
  "10-45",
  "10-42",
  "10-34",
  "10-32",
]);

const WORK_HISTORY_KEYS = [
  "work_experience",
  "workExperience",
  "experience",
  "employment_history",
  "employmentHistory",
  "employer_history",
  "work_history",
];

const APPLICATION_HISTORY_KEYS = [
  "application_history",
  "applicationHistory",
  "job_application_history",
  "jobApplicationHistory",
  "recommendation_history",
  "recommendationHistory",
  "match_history",
  "matchHistory",
];

const END_DATE_KEYS = [
  "end_date",
  "endDate",
  "leave_date",
  "leaveDate",
  "departure_date",
  "departureDate",
  "离职日期",
];

const HUAWEI_HONOR_TOKENS = [
  "华为",
  "huawei",
  "海思",
  "hisilicon",
  "荣耀",
  "honor",
];

const OPPO_XIAOMI_TOKENS = [
  "oppo",
  "vivo",
  "realme",
  "iqoo",
  "一加",
  "oneplus",
  "小米",
  "xiaomi",
  "红米",
  "redmi",
];

const TENCENT_TOKENS = ["腾讯", "tencent"];
const BYTE_TOKENS = [
  "字节跳动",
  "字节",
  "bytedance",
  "抖音",
  "douyin",
  "tiktok",
];
const TENGYU_TOKENS = ["深圳市腾娱互动科技有限公司", "腾娱互动"];

const STUDIO_TOKENS: Array<[string, string[]]> = [
  ["天美", ["天美", "timi"]],
  ["光子", ["光子", "lightspeed"]],
  ["魔方", ["魔方", "morefun"]],
  ["北极光", ["北极光", "aurora"]],
];

const CN_NATIONALITY = new Set([
  "中国",
  "中国籍",
  "china",
  "chinese",
  "cn",
  "prc",
  "中华人民共和国",
]);

const OPTIONAL_ENFORCEMENT = new Set([
  "optional",
  "advisory",
  "recommendation",
  "recommended",
  "flag_only",
  "flag-only",
  "false",
]);

const BLOCKED_APPLICATION_STATUSES = [
  "筛选淘汰",
  "面试淘汰",
  "筛选通过未到面",
  "screen_rejected",
  "interview_rejected",
  "screen_passed_no_interview",
];

const PRESENT_DATE_TOKENS = new Set([
  "present",
  "current",
  "now",
  "至今",
  "目前",
  "在职",
]);

const ruleId = (r: FetchedRule): string => String(r.id ?? r.rule_id ?? "");
const ruleName = (r: FetchedRule): string =>
  String(r.businessLogicRuleName ?? r.standardizedLogicRule ?? ruleId(r));
const ruleKey = (r: FetchedRule): string => ruleId(r) || ruleName(r);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Collect likely parsed-resume objects, including a JSON-string `resume`. */
function collectFactRoots(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  const roots: Record<string, unknown>[] = [];
  const queue: unknown[] = [data];
  const seen = new Set<object>();
  const nestedKeys = [
    "data",
    "resume",
    "parsed_resume",
    "parsedResume",
    "parsed_resume_json",
    "candidate",
    "candidate_info",
    "result",
  ];

  while (queue.length > 0 && roots.length < 24) {
    let value = queue.shift();
    if (typeof value === "string") value = parseJson(value);
    const record = asRecord(value);
    if (!record || seen.has(record)) continue;
    seen.add(record);
    roots.push(record);
    for (const key of nestedKeys) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return roots;
}

function findValue(roots: Record<string, unknown>[], keys: string[]): unknown {
  for (const root of roots) {
    for (const key of keys) {
      if (root[key] !== undefined && root[key] !== null) return root[key];
    }
  }
  return undefined;
}

function findString(roots: Record<string, unknown>[], keys: string[]): string {
  for (const root of roots) {
    for (const key of keys) {
      const value = root[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return "";
}

function findBoolean(
  roots: Record<string, unknown>[],
  keys: string[],
): boolean | undefined {
  const value = findValue(roots, keys);
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Returns known=true only for an explicitly structured list.  Plain free-form
 * resume text is useful evidence for a hit, but its silence is not proof that a
 * company/history is absent, so it must not produce a pass.
 */
function findStructuredList(
  roots: Record<string, unknown>[],
  keys: string[],
): StructuredList {
  for (const root of roots) {
    for (const key of keys) {
      if (!(key in root)) continue;
      let value = root[key];
      if (typeof value === "string") value = parseJson(value);
      if (Array.isArray(value)) return { known: true, values: value };
      if (asRecord(value)) return { known: true, values: [value] };
    }
  }
  return { known: false, values: [] };
}

function normalizedText(value: unknown): string {
  if (typeof value === "string") return value.trim().toLowerCase();
  return safeJson(value).toLowerCase();
}

function containsAny(text: string, tokens: string[]): boolean {
  return tokens.some((token) => text.includes(token.toLowerCase()));
}

function matchingRecords(records: unknown[], tokens: string[]): unknown[] {
  return records.filter((record) =>
    containsAny(normalizedText(record), tokens),
  );
}

function recordField(record: unknown, keys: string[]): string {
  const root = asRecord(record);
  if (!root) return "";
  for (const key of keys) {
    const value = root[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseDate(value: string): Date | "present" | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (PRESENT_DATE_TOKENS.has(normalized)) return "present";

  // Accept YYYY, YYYY-MM and YYYY-MM-DD (also common Chinese separators).
  const parts = normalized.match(
    /^(\d{4})(?:[-/.年](\d{1,2}))?(?:[-/.月](\d{1,2})日?)?$/,
  );
  if (parts) {
    const year = Number(parts[1]);
    const month = Number(parts[2] ?? "1");
    const day = Number(parts[3] ?? "1");
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const date = new Date(Date.UTC(year, month - 1, day));
      if (!Number.isNaN(date.getTime())) return date;
    }
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function cooldownSatisfied(end: Date, months: number, now: Date): boolean {
  const threshold = new Date(end.getTime());
  threshold.setUTCMonth(threshold.getUTCMonth() + months);
  return now.getTime() >= threshold.getTime();
}

const pass = (reason: string): Evaluation => ({ status: "pass", reason });
const fail = (reason: string): Evaluation => ({ status: "fail", reason });
const insufficient = (reason: string): Evaluation => ({
  status: "insufficient_info",
  reason,
});

function evaluateEmployerCooldown(args: {
  history: StructuredList;
  tokens: string[];
  months: number;
  label: string;
  now: Date;
}): Evaluation {
  if (!args.history.known) {
    return insufficient(
      `${args.label}：缺少结构化工作经历，无法证明未任职于受限公司。`,
    );
  }
  const matches = matchingRecords(args.history.values, args.tokens);
  if (matches.length === 0) {
    return pass(`${args.label}：结构化工作经历中未发现适用的受限公司记录。`);
  }

  for (const record of matches) {
    const rawEnd = recordField(record, END_DATE_KEYS);
    const end = parseDate(rawEnd);
    if (end === "present") {
      return fail(`${args.label}：候选人仍在受限公司任职，冷冻期尚未开始。`);
    }
    if (!end) {
      return insufficient(
        `${args.label}：命中受限公司，但缺少可解析的离职日期，无法计算 ${args.months} 个月冷冻期。`,
      );
    }
    if (!cooldownSatisfied(end, args.months, args.now)) {
      return fail(
        `${args.label}：受限公司离职日期 ${rawEnd} 距今不足 ${args.months} 个月。`,
      );
    }
  }
  return pass(
    `${args.label}：相关任职记录均已满足 ${args.months} 个月冷冻期。`,
  );
}

type EmploymentKind = "fte" | "outsourced" | "unknown";

function employmentKind(record: unknown): EmploymentKind {
  const direct = recordField(record, [
    "employment_type",
    "employmentType",
    "employee_type",
    "employeeType",
    "labor_form",
    "laborForm",
    "用工形式",
  ]).toLowerCase();
  const fteTokens = [
    "正编",
    "正式员工",
    "正式雇员",
    "full-time",
    "full time",
    "fte",
  ];
  const outsourcedTokens = [
    "外包",
    "派驻",
    "供应商",
    "vendor",
    "contractor",
    "outsourc",
    "bpo",
  ];
  // A dedicated type field may legitimately contain only "正式".  Do not use
  // that broad token against the whole job description (where it can occur in
  // unrelated prose).
  const fte = direct
    ? direct === "正式" || containsAny(direct, fteTokens)
    : containsAny(normalizedText(record), fteTokens);
  const outsourced = direct
    ? containsAny(direct, outsourcedTokens)
    : containsAny(normalizedText(record), outsourcedTokens);
  if (fte && !outsourced) return "fte";
  if (outsourced && !fte) return "outsourced";
  return "unknown";
}

interface TargetFacts {
  text: string;
  client: string;
  department: string;
  studio: string;
  jobType: string;
}

function buildTargetFacts(data: Record<string, unknown>): TargetFacts {
  const targetValues = [
    data.job_requisition,
    data.jobRequisition,
    data.job,
    data.position,
    data.jd,
    data.job_description,
  ].filter((value) => value !== undefined && value !== null);
  const targetRoots: Record<string, unknown>[] = [data];
  for (let value of targetValues) {
    if (typeof value === "string") value = parseJson(value) ?? value;
    const root = asRecord(value);
    if (root) targetRoots.push(root);
  }
  const text = targetValues.map(normalizedText).filter(Boolean).join(" ");
  return {
    text,
    client: findString(targetRoots, [
      "client_name",
      "clientName",
      "client",
      "customer_name",
      "customerName",
      "customer",
    ]).toLowerCase(),
    department: findString(targetRoots, [
      "client_department",
      "clientDepartment",
      "department",
      "business_group",
      "businessGroup",
      "bg",
    ]).toLowerCase(),
    studio: findString(targetRoots, [
      "studio",
      "studio_name",
      "studioName",
      "工作室",
    ]).toLowerCase(),
    jobType: findString(targetRoots, [
      "job_type",
      "jobType",
      "position_type",
      "positionType",
      "channel_type",
      "channelType",
      "employment_category",
    ]).toLowerCase(),
  };
}

function targetClient(
  target: TargetFacts,
  tokens: string[],
): boolean | undefined {
  if (target.client) return containsAny(target.client, tokens);
  if (containsAny(target.text, tokens)) return true;
  return undefined;
}

function targetDepartment(
  target: TargetFacts,
  department: string,
): boolean | undefined {
  const token = department.toLowerCase();
  if (target.department) return target.department.includes(token);
  if (target.text.includes(token)) return true;
  return undefined;
}

function studioFromText(text: string): string {
  for (const [studio, tokens] of STUDIO_TOKENS) {
    if (containsAny(text, tokens)) return studio;
  }
  return "";
}

function targetStudio(target: TargetFacts): string {
  return studioFromText(`${target.studio} ${target.text}`);
}

function byteFteRecords(history: StructuredList): {
  records: unknown[];
  ambiguous: boolean;
} {
  const byteRecords = matchingRecords(history.values, BYTE_TOKENS);
  return {
    records: byteRecords.filter((record) => employmentKind(record) === "fte"),
    ambiguous: byteRecords.some(
      (record) => employmentKind(record) === "unknown",
    ),
  };
}

function tencentFteRecords(history: StructuredList): {
  records: unknown[];
  ambiguous: boolean;
} {
  const records = matchingRecords(history.values, TENCENT_TOKENS);
  return {
    records: records.filter((record) => employmentKind(record) === "fte"),
    ambiguous: records.some((record) => employmentKind(record) === "unknown"),
  };
}

function evaluateNationality(
  roots: Record<string, unknown>[],
  data: Record<string, unknown>,
  target: TargetFacts,
): Evaluation {
  const nationality = findString(roots, ["nationality", "country", "国籍"])
    .trim()
    .toLowerCase();

  // This is an explicit part of live rule 10-35, not a generic fail-open
  // fallback: an omitted nationality is treated as Chinese by that rule.
  if (!nationality) {
    return pass("10-35：简历未注明国籍；按 Allmeta 规则明文默认中国籍。 ");
  }
  if (CN_NATIONALITY.has(nationality)) {
    return pass(`10-35：国籍「${nationality}」不受外籍通道限制。`);
  }

  const isTencent = targetClient(target, TENCENT_TOKENS);
  if (isTencent === false) {
    return pass("10-35：目标岗位明确不是腾讯岗位，外籍通道规则不适用。");
  }
  if (isTencent === undefined) {
    return insufficient(
      `10-35：候选人为外籍（${nationality}），但缺少目标客户信息，无法判断规则是否适用。`,
    );
  }

  // Only top-level, operator/server-owned booleans are trusted as verification;
  // a value embedded inside candidate-supplied resume JSON cannot self-clear.
  const serverVerified =
    data.channel_verified === true || data.nationality_channel === true;
  const jobTypeText = `${target.jobType} ${target.text}`;
  const allowedType = jobTypeText.includes("外籍人国内工作");
  if (serverVerified || allowedType) {
    return pass("10-35：腾讯岗位已明确为外籍人国内工作通道。");
  }
  if (target.jobType) {
    return fail(`10-35：外籍候选人不可匹配腾讯岗位类型「${target.jobType}」。`);
  }
  return insufficient(
    "10-35：外籍候选人匹配腾讯岗位，但缺少可验证的岗位类型/通道状态。",
  );
}

function evaluateByteCredential(
  history: StructuredList,
  platformData: Record<string, unknown>,
): Evaluation {
  if (!history.known) {
    return insufficient("10-49：缺少结构化工作经历，无法排除字节正编经历。");
  }
  const fte = byteFteRecords(history);
  if (fte.records.length === 0 && !fte.ambiguous) {
    return pass("10-49：结构化履历中无字节正式雇员经历。");
  }
  if (fte.records.length === 0) {
    return insufficient(
      "10-49：履历提及字节，但未明确正编/外包身份，无法完成凭证规则判定。",
    );
  }
  const credential = findBoolean(
    [platformData],
    [
      "compliance_credential_verified",
      "complianceCredentialVerified",
      "compliance_document_verified",
      "complianceDocumentVerified",
      "credential_verified",
    ],
  );
  if (credential === true) {
    return pass("10-49：字节正编经历已命中，且合规凭证已验证。");
  }
  return insufficient(
    "10-49：命中字节正编经历，尚无已验证合规凭证；从严挂起。",
  );
}

function evaluateByteBpApproval(
  history: StructuredList,
  platformData: Record<string, unknown>,
): Evaluation {
  if (!history.known) {
    return insufficient(
      "10-51：缺少结构化工作经历，无法确定是否需要客户 BP 放行。",
    );
  }
  const fte = byteFteRecords(history);
  if (fte.records.length === 0 && !fte.ambiguous) {
    return pass("10-51：无字节正编经历，客户 BP 回流确认规则不适用。");
  }
  if (fte.records.length === 0) {
    return insufficient(
      "10-51：履历提及字节但用工身份不明，无法确定 BP 放行规则是否适用。",
    );
  }

  const credential = findBoolean(
    [platformData],
    [
      "compliance_credential_verified",
      "complianceCredentialVerified",
      "compliance_document_verified",
      "credential_verified",
    ],
  );
  if (credential !== true) {
    return insufficient(
      "10-51：字节正编回流的合规凭证尚未验证，未进入 BP 放行阶段。",
    );
  }
  const decision = findString(
    [platformData],
    [
      "client_bp_decision",
      "clientBpDecision",
      "bp_decision",
      "bpDecision",
      "reflux_approval",
    ],
  ).toLowerCase();
  if (
    containsAny(decision, ["无异常且可回流", "可回流", "approved", "allow"])
  ) {
    return pass("10-51：客户 BP 已确认无异常且可回流。");
  }
  if (
    containsAny(decision, [
      "不可回流",
      "拒绝",
      "denied",
      "rejected",
      "timeout",
      "超时",
    ])
  ) {
    return fail(`10-51：客户 BP 回流结论为「${decision}」。`);
  }
  return insufficient("10-51：字节正编回流缺少客户 BP 的明确放行结论。");
}

function evaluateIegStudio(
  history: StructuredList,
  target: TargetFacts,
  now: Date,
): Evaluation {
  if (!history.known) {
    return insufficient("10-43：缺少结构化工作经历，无法排除 IEG 工作室回流。");
  }
  const studioRecords = history.values.filter((record) =>
    Boolean(studioFromText(normalizedText(record))),
  );
  if (studioRecords.length === 0) {
    return pass("10-43：结构化履历中无四大 IEG 工作室经历。");
  }
  if (targetClient(target, TENCENT_TOKENS) === false) {
    return pass("10-43：目标客户明确不是腾讯，IEG 跨工作室规则不适用。");
  }
  if (targetDepartment(target, "ieg") === false) {
    return pass("10-43：目标部门明确不是 IEG，跨工作室规则不适用。");
  }
  const destination = targetStudio(target);
  if (!destination) {
    return insufficient("10-43：命中 IEG 工作室经历，但缺少目标工作室信息。");
  }

  for (const record of studioRecords) {
    const source = studioFromText(normalizedText(record));
    if (source === destination) continue;
    const rawEnd = recordField(record, END_DATE_KEYS);
    const end = parseDate(rawEnd);
    if (end === "present") {
      return fail(
        `10-43：仍在「${source}」任职，不允许跨室推荐至「${destination}」。`,
      );
    }
    if (!end) {
      return insufficient("10-43：跨工作室回流记录缺少可解析离职日期。");
    }
    if (!cooldownSatisfied(end, 6, now)) {
      return fail(
        `10-43：从「${source}」离职不足 6 个月，不允许跨室推荐至「${destination}」。`,
      );
    }
  }
  return pass("10-43：同室推荐或跨室记录均已满足 6 个月冷冻期。");
}

function evaluateTengyu(
  history: StructuredList,
  target: TargetFacts,
  now: Date,
): Evaluation {
  if (!history.known) {
    return insufficient("10-56：缺少结构化工作经历，无法排除腾娱互动回流。");
  }
  const records = matchingRecords(history.values, TENGYU_TOKENS);
  if (records.length === 0) {
    return pass("10-56：结构化履历中无腾娱互动任职记录。");
  }
  const isTencent = targetClient(target, TENCENT_TOKENS);
  if (isTencent === false)
    return pass("10-56：目标客户明确不是腾讯，该规则不适用。");
  if (isTencent === undefined) {
    return insufficient("10-56：命中腾娱互动经历，但缺少目标客户信息。");
  }
  return evaluateEmployerCooldown({
    history: { known: true, values: records },
    tokens: TENGYU_TOKENS,
    months: 6,
    label: "10-56",
    now,
  });
}

function evaluateTencentMarker(history: StructuredList): Evaluation {
  if (!history.known) {
    return insufficient(
      "10-45：缺少结构化工作经历，无法判定腾讯正编转外包标记。",
    );
  }
  const fte = tencentFteRecords(history);
  if (fte.records.length === 0 && !fte.ambiguous) {
    return pass("10-45：无腾讯正式岗位经历，无需备案标记。");
  }
  if (fte.records.length === 0) {
    return insufficient("10-45：履历提及腾讯但用工身份不明，无法可靠打标。");
  }
  // Live rule 10-45 explicitly says the marker does not block matching.
  return pass(
    "10-45：已识别腾讯正编经历；按规则标记需客户备案，但不阻断匹配。",
  );
}

function evaluateCdgCooldown(
  history: StructuredList,
  target: TargetFacts,
  now: Date,
): Evaluation {
  if (!history.known) {
    return insufficient(
      "10-42：缺少结构化工作经历，无法排除腾讯/腾讯外包回流。",
    );
  }
  const records = matchingRecords(history.values, TENCENT_TOKENS);
  if (records.length === 0) {
    return pass("10-42：结构化履历中无腾讯或腾讯外包经历。");
  }
  if (targetClient(target, TENCENT_TOKENS) === false) {
    return pass("10-42：目标客户明确不是腾讯，CDG 回流规则不适用。");
  }
  const cdg = targetDepartment(target, "cdg");
  if (cdg === false) return pass("10-42：目标部门明确不是 CDG，该规则不适用。");
  if (cdg === undefined) {
    return insufficient("10-42：命中腾讯历史经历，但缺少目标事业群信息。");
  }

  for (const record of records) {
    const rawEnd = recordField(record, END_DATE_KEYS);
    const end = parseDate(rawEnd);
    if (end === "present")
      return fail("10-42：候选人仍在腾讯相关岗位任职，未满足冷冻期。");
    if (!end) return insufficient("10-42：腾讯相关经历缺少可解析离职日期。");
    if (!cooldownSatisfied(end, 6, now)) {
      return fail(`10-42：腾讯相关经历离职日期 ${rawEnd} 距今不足 6 个月。`);
    }
  }
  return pass("10-42：腾讯相关经历均已满足 CDG 6 个月冷冻期。");
}

function evaluateByteVendorCooldown(
  history: StructuredList,
  target: TargetFacts,
  now: Date,
): Evaluation {
  if (!history.known) {
    return insufficient(
      "10-34：缺少结构化工作经历，无法排除友商派驻字节经历。",
    );
  }
  const byteRecords = matchingRecords(history.values, BYTE_TOKENS);
  if (byteRecords.length === 0) {
    return pass("10-34：结构化履历中无字节相关任职记录。");
  }
  const vendorRecords = byteRecords.filter(
    (record) => employmentKind(record) === "outsourced",
  );
  const ambiguous = byteRecords.some(
    (record) => employmentKind(record) === "unknown",
  );
  if (vendorRecords.length === 0 && ambiguous) {
    return insufficient(
      "10-34：字节经历未明确正编/友商派驻身份，无法判断规则适用性。",
    );
  }
  if (vendorRecords.length === 0) {
    return pass("10-34：字节经历明确不是友商派驻，该规则不适用。");
  }

  const isByteTarget = targetClient(target, BYTE_TOKENS);
  if (isByteTarget === false)
    return pass("10-34：目标客户明确不是字节，该规则不适用。");
  if (isByteTarget === undefined) {
    return insufficient("10-34：命中友商派驻字节经历，但缺少目标客户信息。");
  }

  for (const record of vendorRecords) {
    const text = normalizedText(record);
    const nonBpo = containsAny(text, ["非bpo", "non-bpo", "non bpo"]);
    const bpo = !nonBpo && text.includes("bpo");
    if (bpo) continue;
    if (!nonBpo) {
      return insufficient("10-34：友商派驻字节经历缺少 BPO/非 BPO 业务类型。");
    }
    const rawEnd = recordField(record, END_DATE_KEYS);
    const end = parseDate(rawEnd);
    if (end === "present")
      return fail("10-34：仍在非 BPO 友商派驻岗位，未满足冷冻期。");
    if (!end) return insufficient("10-34：非 BPO 派驻经历缺少可解析离职日期。");
    if (!cooldownSatisfied(end, 6, now)) {
      return fail(`10-34：非 BPO 友商派驻离职日期 ${rawEnd} 距今不足 6 个月。`);
    }
  }
  return pass("10-34：BPO 经历不受限，或非 BPO 经历已满足 6 个月冷冻期。");
}

function applicationDate(record: unknown): string {
  return recordField(record, [
    "occurred_at",
    "occurredAt",
    "status_at",
    "statusAt",
    "updated_at",
    "updatedAt",
    "created_at",
    "createdAt",
    "date",
  ]);
}

function evaluatePositionCooldown(
  history: StructuredList,
  roots: Record<string, unknown>[],
  now: Date,
): Evaluation {
  if (!history.known) {
    return insufficient(
      "10-32：缺少结构化岗位投递/推荐历史，无法检查近 3 个月记录。",
    );
  }
  if (history.values.length === 0) {
    return pass("10-32：已提供完整岗位历史，当前无历史记录。");
  }
  const currentJob = findString(roots, [
    "job_requisition_id",
    "jobRequisitionId",
    "job_id",
    "jobId",
  ]);
  if (!currentJob) {
    return insufficient(
      "10-32：有岗位历史记录，但缺少当前 job_requisition_id。",
    );
  }

  for (const record of history.values) {
    const recordJob = recordField(record, [
      "job_requisition_id",
      "jobRequisitionId",
      "job_id",
      "jobId",
    ]);
    if (!recordJob) {
      return insufficient(
        "10-32：岗位历史记录缺少 job_requisition_id，无法确认是否为同岗。",
      );
    }
    if (recordJob !== currentJob) continue;
    const status = recordField(record, [
      "status",
      "result",
      "stage_result",
      "stageResult",
    ])
      .trim()
      .toLowerCase();
    if (!containsAny(status, BLOCKED_APPLICATION_STATUSES)) continue;
    const rawDate = applicationDate(record);
    const date = parseDate(rawDate);
    if (!date || date === "present") {
      return insufficient("10-32：同岗淘汰/未到面记录缺少可解析发生日期。");
    }
    if (!cooldownSatisfied(date, 3, now)) {
      return fail(`10-32：同岗存在近 3 个月的「${status}」记录。`);
    }
  }
  return pass("10-32：无同岗近 3 个月淘汰或筛选通过未到面记录。");
}

function isExplicitlyOptional(r: FetchedRule): boolean {
  const enforcement = String(
    r.enforcementLevel ?? r.enforcement_level ?? r.mandatory ?? "",
  )
    .trim()
    .toLowerCase();
  return OPTIONAL_ENFORCEMENT.has(enforcement);
}

function evaluateKnownRule(args: {
  id: string;
  history: StructuredList;
  applicationHistory: StructuredList;
  roots: Record<string, unknown>[];
  data: Record<string, unknown>;
  target: TargetFacts;
  now: Date;
}): Evaluation {
  switch (args.id) {
    case "10-25":
      return evaluateEmployerCooldown({
        history: args.history,
        tokens: HUAWEI_HONOR_TOKENS,
        months: 3,
        label: "10-25",
        now: args.now,
      });
    case "10-26":
      return evaluateEmployerCooldown({
        history: args.history,
        tokens: OPPO_XIAOMI_TOKENS,
        months: 6,
        label: "10-26",
        now: args.now,
      });
    case "10-35":
      return evaluateNationality(args.roots, args.data, args.target);
    case "10-49":
      return evaluateByteCredential(args.history, args.data);
    case "10-43":
      return evaluateIegStudio(args.history, args.target, args.now);
    case "10-56":
      return evaluateTengyu(args.history, args.target, args.now);
    case "10-51":
      return evaluateByteBpApproval(args.history, args.data);
    case "10-45":
      return evaluateTencentMarker(args.history);
    case "10-42":
      return evaluateCdgCooldown(args.history, args.target, args.now);
    case "10-34":
      return evaluateByteVendorCooldown(args.history, args.target, args.now);
    case "10-32":
      return evaluatePositionCooldown(
        args.applicationHistory,
        args.roots,
        args.now,
      );
    default:
      return insufficient(`规则 ${args.id} 没有确定性评估器。`);
  }
}

export const evaluateMatchRules = defineTool({
  name: "evaluateMatchRules",
  description:
    "Evaluate the live RAAS-v1 match rules from Allmeta using structured " +
    "resume, target-role and history facts. Missing facts fail closed as " +
    "insufficient_info; unknown mandatory rules never pass.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    const fetched = (ctx.lastResult ?? {}) as {
      rules?: FetchedRule[];
      mandatory?: FetchedRule[];
      source?: string;
    };

    if (
      !fetched ||
      fetched.source !== "allmeta" ||
      !Array.isArray(fetched.rules) ||
      fetched.rules.length === 0
    ) {
      return {
        data: {
          rule_results: [
            {
              rule_id: "rule_fetch",
              status: "error",
              reason: `规则拉取失败/为空或未配置 Allmeta（source=${String(fetched?.source ?? "none")}, count=${Array.isArray(fetched?.rules) ? fetched.rules.length : 0}）——从严判定不通过。`,
              flag_only: false,
            },
          ],
          evaluated: 0,
          source: fetched?.source ?? "unconfigured",
          infra_degraded: true,
        },
      };
    }

    // `loadRaasRuleContext` and `ontology.fetchActionRules` are preceding
    // steps. The runtime accumulates their object outputs in ctx.lastResult;
    // merge those trusted platform facts over the original event so the
    // evaluator can use PG-backed application history / target metadata.
    // (Candidate-authored application_history nested inside resume remains
    // ignored below because rule 10-32 reads only this top-level object.)
    const data = {
      ...((ctx.event?.data ?? {}) as Record<string, unknown>),
      ...(fetched as Record<string, unknown>),
    };
    const roots = collectFactRoots(data);
    const history = findStructuredList(roots, WORK_HISTORY_KEYS);
    // Application/approval history is a platform fact, never candidate-authored
    // resume content.  Restrict it to the top-level RAAS event payload so a
    // crafted resume cannot self-clear rule 10-32 with `application_history:[]`.
    const applicationHistory = findStructuredList(
      [data],
      APPLICATION_HISTORY_KEYS,
    );
    const target = buildTargetFacts(data);
    const now = new Date();
    const mandatoryKeys = new Set(
      Array.isArray(fetched.mandatory) ? fetched.mandatory.map(ruleKey) : [],
    );

    const rule_results = fetched.rules.map((rule) => {
      const id = ruleId(rule);
      const name = ruleName(rule);
      const isMandatory =
        mandatoryKeys.has(ruleKey(rule)) || !isExplicitlyOptional(rule);

      let evaluation: Evaluation;
      if (LIVE_RULE_IDS.has(id)) {
        evaluation = evaluateKnownRule({
          id,
          history,
          applicationHistory,
          roots,
          data,
          target,
          now,
        });
      } else {
        evaluation = insufficient(
          isMandatory
            ? `Allmeta 新增/未识别必选规则「${name}」尚无确定性评估器，需人工复核；从严阻断。`
            : `Allmeta 新增/未识别可选规则「${name}」尚无确定性评估器，已标记复核，不自动判定通过。`,
        );
      }

      return {
        rule_id: id || name,
        status: evaluation.status,
        reason: evaluation.reason,
        flag_only: !LIVE_RULE_IDS.has(id) && !isMandatory,
      };
    });

    return {
      data: {
        rule_results,
        evaluated: rule_results.length,
        source: fetched.source,
        infra_degraded: false,
        failed: rule_results
          .filter((result) => result.status === "fail")
          .map((result) => result.rule_id),
        unresolved: rule_results
          .filter((result) => result.status === "insufficient_info")
          .map((result) => result.rule_id),
      },
    };
  },
});
