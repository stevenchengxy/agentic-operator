export interface WorkflowResearchResult {
  query: string;
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
}

export interface WorkflowResearchReport {
  configured: boolean;
  provider: "tavily" | "brave" | "serper" | null;
  results: WorkflowResearchResult[];
  warnings: string[];
}

type FetchLike = typeof fetch;
let researchFetch: FetchLike = globalThis.fetch.bind(globalThis);

/** Test seam; passing null restores the platform fetch implementation. */
export function _setWorkflowResearchFetchForTests(
  replacement: FetchLike | null,
): void {
  researchFetch = replacement ?? globalThis.fetch.bind(globalThis);
}

function tenantPrefix(tenantSlug: string): string {
  // This is also the operator-facing convention documented in the workflow
  // authoring guide: uppercase the slug and replace each non-alphanumeric
  // character with an underscore.
  return tenantSlug.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function credential(
  tenantSlug: string,
  provider: "tavily" | "brave" | "serper",
): string | null {
  const upper = provider.toUpperCase();
  const tenant = tenantPrefix(tenantSlug);
  return (
    process.env[`AGENTIC_TENANT_${tenant}_${upper}_API_KEY`] ??
    process.env[`${upper}_API_KEY`] ??
    null
  );
}

function resolveProvider(tenantSlug: string): {
  provider: "tavily" | "brave" | "serper";
  key: string;
} | null {
  const configured =
    process.env.AGENTIC_WORKFLOW_RESEARCH_PROVIDER?.toLowerCase();
  const candidates: Array<"tavily" | "brave" | "serper"> =
    configured === "tavily" || configured === "brave" || configured === "serper"
      ? [configured]
      : ["tavily", "brave", "serper"];
  for (const provider of candidates) {
    const key = credential(tenantSlug, provider);
    if (key) return { provider, key };
  }
  return null;
}

function boundedQueries(input: {
  purpose: string;
  constraints: string[];
  expectedOutputs: string[];
}): string[] {
  const queries = [input.purpose.trim().slice(0, 500)];
  if (input.constraints.length > 0) {
    queries.push(
      `${input.purpose.slice(0, 300)} requirements controls ${input.constraints.slice(0, 4).join(" ")}`.slice(
        0,
        500,
      ),
    );
  }
  if (input.expectedOutputs.length > 0) {
    queries.push(
      `${input.purpose.slice(0, 300)} best practices outputs ${input.expectedOutputs.slice(0, 4).join(" ")}`.slice(
        0,
        500,
      ),
    );
  }
  return Array.from(new Set(queries)).slice(0, 3);
}

function safeUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await researchFetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`research provider returned HTTP ${response.status}`);
  }
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > 2 * 1024 * 1024) {
    throw new Error("research response exceeded 2 MiB");
  }
  const maxBytes = 2 * 1024 * 1024;
  if (!response.body)
    throw new Error("research provider returned an empty body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel("research response exceeded 2 MiB");
        throw new Error("research response exceeded 2 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const text = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
  ).toString("utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("research provider returned a non-object response");
  }
  return parsed as Record<string, unknown>;
}

async function tavilySearch(
  key: string,
  query: string,
): Promise<WorkflowResearchResult[]> {
  const data = await fetchJson("https://api.tavily.com/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      query,
      search_depth: "basic",
      max_results: 5,
      include_raw_content: false,
      include_answer: false,
    }),
  });
  const results = Array.isArray(data.results) ? data.results : [];
  return results.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const url = safeUrl(item.url);
    if (!url) return [];
    return [
      {
        query,
        title: stringValue(item.title, 500) || url,
        url,
        snippet: stringValue(item.content, 2_000),
        publishedAt: stringValue(item.published_date, 100) || null,
      },
    ];
  });
}

async function braveSearch(
  key: string,
  query: string,
): Promise<WorkflowResearchResult[]> {
  const endpoint = new URL("https://api.search.brave.com/res/v1/web/search");
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("count", "5");
  const data = await fetchJson(endpoint.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": key,
    },
  });
  const web =
    data.web && typeof data.web === "object" && !Array.isArray(data.web)
      ? (data.web as Record<string, unknown>)
      : {};
  const results = Array.isArray(web.results) ? web.results : [];
  return results.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const url = safeUrl(item.url);
    if (!url) return [];
    return [
      {
        query,
        title: stringValue(item.title, 500) || url,
        url,
        snippet: stringValue(item.description, 2_000),
        publishedAt:
          stringValue(item.page_age, 100) || stringValue(item.age, 100) || null,
      },
    ];
  });
}

async function serperSearch(
  key: string,
  query: string,
): Promise<WorkflowResearchResult[]> {
  const data = await fetchJson("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-API-KEY": key,
    },
    body: JSON.stringify({ q: query, num: 5 }),
  });
  const results = Array.isArray(data.organic) ? data.organic : [];
  return results.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const item = raw as Record<string, unknown>;
    const url = safeUrl(item.link);
    if (!url) return [];
    return [
      {
        query,
        title: stringValue(item.title, 500) || url,
        url,
        snippet: stringValue(item.snippet, 2_000),
        publishedAt: stringValue(item.date, 100) || null,
      },
    ];
  });
}

export async function researchWorkflowPurpose(
  input: {
    purpose: string;
    constraints: string[];
    expectedOutputs: string[];
  },
  tenantSlug: string,
): Promise<WorkflowResearchReport> {
  const selected = resolveProvider(tenantSlug);
  if (!selected) {
    return {
      configured: false,
      provider: null,
      results: [],
      warnings: [
        "Web research was requested but no Tavily, Brave, or Serper credential is configured for this tenant.",
      ],
    };
  }
  const warnings: string[] = [];
  const all: WorkflowResearchResult[] = [];
  for (const query of boundedQueries(input)) {
    try {
      const found =
        selected.provider === "tavily"
          ? await tavilySearch(selected.key, query)
          : selected.provider === "brave"
            ? await braveSearch(selected.key, query)
            : await serperSearch(selected.key, query);
      all.push(...found);
    } catch (error) {
      warnings.push(
        `Research query failed (${query.slice(0, 80)}): ${error instanceof Error ? error.message : String(error)}.`,
      );
    }
  }
  const byUrl = new Map<string, WorkflowResearchResult>();
  for (const result of all) {
    if (!byUrl.has(result.url)) byUrl.set(result.url, result);
    if (byUrl.size >= 10) break;
  }
  if (byUrl.size === 0 && warnings.length === 0) {
    warnings.push(
      "The configured research provider returned no citeable HTTPS results.",
    );
  }
  return {
    configured: true,
    provider: selected.provider,
    results: Array.from(byUrl.values()),
    warnings,
  };
}
