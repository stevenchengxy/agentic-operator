const DEFAULT_TIMEOUT_MS = 8_000;

export interface ReasoningActionSummary {
  id: string;
  name: string;
  description: string | null;
  actor: string[];
}

export interface ReasoningAllmetaConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

function positiveTimeout(value: string | undefined): number {
  const configured = value?.trim();
  if (!configured) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(configured);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("ALLMETA_TIMEOUT_MS must be a positive integer");
  }
  return parsed;
}

export function reasoningAllmetaConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): ReasoningAllmetaConfig {
  const baseUrl = (env.ALLMETA_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (env.ALLMETA_API_KEY ?? "").trim();
  if (!baseUrl) throw new Error("ALLMETA_BASE_URL is not configured");
  if (!apiKey) {
    throw new Error(
      "ALLMETA_API_KEY is required by the Reasoning Allmeta endpoints",
    );
  }
  return {
    baseUrl,
    apiKey,
    timeoutMs: positiveTimeout(env.ALLMETA_TIMEOUT_MS),
  };
}

export async function reasoningAllmetaJson(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {},
  options: {
    config?: ReasoningAllmetaConfig;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<unknown> {
  const config = options.config ?? reasoningAllmetaConfigFromEnv();
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${config.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 240);
    throw new Error(
      `Allmeta request failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return response.json();
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  let decoded = value;
  if (typeof value === "string" && value.trim()) {
    try {
      decoded = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(decoded)) return [];
  return decoded.map(nonEmptyString).filter(Boolean);
}

export async function listReasoningActions(
  domainId: string,
  options: {
    config?: ReasoningAllmetaConfig;
    fetchImpl?: typeof fetch;
  } = {},
): Promise<ReasoningActionSummary[]> {
  const canonicalDomain = domainId.trim();
  if (!canonicalDomain) throw new Error("Reasoning ontology domainId is required");
  const body = (await reasoningAllmetaJson(
    `/api/v1/ontology/actions?domain=${encodeURIComponent(canonicalDomain)}&limit=1000`,
    {},
    options,
  )) as { items?: unknown };
  if (!Array.isArray(body?.items)) {
    throw new Error("Allmeta actions payload is missing items[]");
  }
  const seen = new Set<string>();
  const actions: ReasoningActionSummary[] = [];
  for (const raw of body.items) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const name = nonEmptyString(item.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    actions.push({
      id: nonEmptyString(item.id) || nonEmptyString(item.uid) || name,
      name,
      description: nonEmptyString(item.description) || null,
      actor: stringArray(item.actor_json ?? item.actor),
    });
  }
  return actions.sort((left, right) => left.name.localeCompare(right.name));
}
