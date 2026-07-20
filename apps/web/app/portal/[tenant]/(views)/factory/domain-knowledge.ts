export type HumanMemoryKind =
  | "clarify"
  | "boundary"
  | "test_approval"
  | "directive";

export interface HumanDomainMemory {
  id: string;
  domain: string;
  questionKey: string;
  kind: HumanMemoryKind;
  question: string;
  answer: string;
  context?: string;
  source: "human";
  conversationId?: string;
  confirmed: true;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

const SECRET_ASSIGNMENT =
  /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|authorization|cookie|credential)\s*[:=：]\s*)([^\s,;\n]+)/gi;

/**
 * Defense in depth for the operator UI. The API already redacts memory writes,
 * but old/imported rows must not become a credential reveal surface.
 */
export function redactDomainKnowledge(value: string): string {
  return value
    .replace(
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=:-]{8,}/gi, "$1 [REDACTED]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{12,})\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED JWT]")
    .replace(
      /\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s:/@]+:)([^\s/@]+)(@)/gi,
      "$1[REDACTED]$3",
    )
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

/** Secret-bearing edits are rejected instead of silently storing a redacted
 * approximation that could look like a usable integration configuration. */
export function containsDomainKnowledgeSecret(value: string): boolean {
  return redactDomainKnowledge(value) !== value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === "object" && !Array.isArray(value);

const isIsoDate = (value: unknown): value is string =>
  typeof value === "string" && Number.isFinite(Date.parse(value));

const MEMORY_KINDS = new Set<HumanMemoryKind>([
  "clarify",
  "boundary",
  "test_approval",
  "directive",
]);

function parseMemory(value: unknown): HumanDomainMemory | null {
  if (!isRecord(value)) return null;
  if (
    value.source !== "human" ||
    value.confirmed !== true ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    typeof value.domain !== "string" ||
    typeof value.questionKey !== "string" ||
    typeof value.kind !== "string" ||
    !MEMORY_KINDS.has(value.kind as HumanMemoryKind) ||
    typeof value.question !== "string" ||
    typeof value.answer !== "string" ||
    typeof value.pinned !== "boolean" ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.updatedAt)
  ) {
    return null;
  }

  const context =
    typeof value.context === "string"
      ? redactDomainKnowledge(value.context)
      : undefined;
  const conversationId =
    typeof value.conversationId === "string" && value.conversationId.trim()
      ? value.conversationId
      : undefined;
  return {
    id: value.id,
    domain: value.domain,
    questionKey: value.questionKey,
    kind: value.kind as HumanMemoryKind,
    question: redactDomainKnowledge(value.question),
    answer: redactDomainKnowledge(value.answer),
    ...(context ? { context } : {}),
    source: "human",
    ...(conversationId ? { conversationId } : {}),
    confirmed: true,
    pinned: value.pinned,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

/** Parse the API payload as untrusted input and deliberately discard AI
 * reflections or malformed/non-human rows from the human ground-truth panel. */
export function parseHumanDomainMemories(
  value: unknown,
  expectedDomain?: string,
): HumanDomainMemory[] {
  if (!isRecord(value) || !Array.isArray(value.memories)) return [];
  return value.memories
    .map(parseMemory)
    .filter((memory): memory is HumanDomainMemory => memory !== null)
    .filter((memory) => !expectedDomain || memory.domain === expectedDomain)
    .sort(
      (left, right) =>
        Number(right.pinned) - Number(left.pinned) ||
        Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
}
