/** Human-readable sentinels emitted by the Factory draft test template. They
 * are protocol markers, never valid evidence. Browser and API share this
 * detector so an untouched template cannot pass merely because its strings
 * are non-empty. */
export const DRAFT_SANDBOX_TEST_SENTINELS = {
  value: "请填写真实测试值",
  scenario: "请说明这个用例要验证的业务路径",
  expectedOutcome: "请写明预期到达的业务终态",
} as const;

const SENTINELS = Object.values(DRAFT_SANDBOX_TEST_SENTINELS);

export function findDraftSandboxTestSentinel(value: unknown, rootPath = "testCases"): string | undefined {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown, path: string, depth: number): string | undefined => {
    if (depth > 24) return path;
    if (typeof entry === "string") {
      const normalized = entry.normalize("NFKC").trim();
      return SENTINELS.some((sentinel) => normalized.includes(sentinel)) ? path : undefined;
    }
    if (!entry || typeof entry !== "object") return undefined;
    if (seen.has(entry)) return path;
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        const found = visit(entry[index], `${path}[${index}]`, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    for (const [key, nested] of Object.entries(entry as Record<string, unknown>)) {
      const found = visit(nested, `${path}.${key}`, depth + 1);
      if (found) return found;
    }
    return undefined;
  };
  return visit(value, rootPath, 0);
}
