import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { z } from "zod";

type SearchProvider = "tavily" | "brave" | "serper" | "custom";

interface SearchConfig {
  provider?: SearchProvider;
  api_key_env?: string;
  base_url?: string;
  timeout_ms?: number;
  max_content_chars_per_result?: number;
  max_content_chars_total?: number;
  max_content_bytes_per_result?: number;
  max_content_bytes_total?: number;
}

export interface WebSearchContentLimits {
  perResultCharacters: number;
  totalCharacters: number;
  perResultBytes: number;
  totalBytes: number;
}

export const WEB_SEARCH_CONTENT_LIMITS = {
  defaults: {
    perResultCharacters: 12_000,
    totalCharacters: 48_000,
    perResultBytes: 48_000,
    totalBytes: 192_000,
  },
  maximums: {
    perResultCharacters: 30_000,
    totalCharacters: 100_000,
    perResultBytes: 120_000,
    totalBytes: 400_000,
  },
} as const;

const BUILT_IN_ENDPOINTS: Record<Exclude<SearchProvider, "custom">, string> = {
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
  serper: "https://google.serper.dev/search",
};

function tenantEnvPrefix(tenantSlug: string): string {
  return tenantSlug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

function isTenantCredentialEnv(envName: string, tenantSlug: string): boolean {
  const prefix = tenantEnvPrefix(tenantSlug);
  return (
    envName.startsWith(`TENANT_${prefix}_`) || envName.startsWith(`${prefix}_`)
  );
}

function allowedEndpointHosts(): Set<string> {
  return new Set(
    (process.env.SEARCH_API_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt: string | null;
  score: number | null;
  /** Cleaned source Markdown when the provider returned it. */
  content: string | null;
  contentCharacters: number;
  contentBytes: number;
  contentTruncated: boolean;
}

function config(ctx: ToolContext): SearchConfig {
  return (ctx.config ?? {}) as SearchConfig;
}

function providerApiKey(provider: SearchProvider, cfg: SearchConfig): string {
  const defaultEnv =
    provider === "tavily"
      ? "TAVILY_API_KEY"
      : provider === "brave"
        ? "BRAVE_SEARCH_API_KEY"
        : provider === "serper"
          ? "SERPER_API_KEY"
          : "SEARCH_API_KEY";
  const envName = cfg.api_key_env?.trim() || defaultEnv;
  const value = process.env[envName]?.trim();
  if (!value) {
    throw new Error(
      `search.web: credential missing; configure ${envName} or tool_use[].config.api_key_env`,
    );
  }
  return value;
}

function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.floor(value)))
    : fallback;
}

function strings(value: unknown, max = 20): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .filter(
      (item): item is string =>
        typeof item === "string" && item.trim().length > 0,
    )
    .map((item) => item.trim())
    .slice(0, max);
  return result.length > 0 ? result : undefined;
}

function requiredQuery(args: Record<string, unknown>): string {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) throw new Error("search.web: `query` is required");
  if (query.length > 2_000)
    throw new Error("search.web: query exceeds 2,000 characters");
  return query;
}

function endpoint(
  provider: SearchProvider,
  cfg: SearchConfig,
  tenantSlug: string,
): URL {
  const configuredRaw = cfg.base_url?.trim();
  const raw =
    configuredRaw ||
    (provider === "custom" ? "" : BUILT_IN_ENDPOINTS[provider]);
  if (!raw)
    throw new Error("search.web: custom provider requires config.base_url");
  const url = new URL(raw);
  if (
    url.protocol !== "https:" &&
    url.hostname !== "localhost" &&
    url.hostname !== "127.0.0.1"
  ) {
    throw new Error("search.web: search endpoint must use HTTPS");
  }
  if (configuredRaw) {
    const builtIn =
      provider === "custom" ? null : new URL(BUILT_IN_ENDPOINTS[provider]);
    if (url.href !== builtIn?.href && !allowedEndpointHosts().has(url.host)) {
      throw new Error(
        "search.web: configured endpoint is not provider-owned or in SEARCH_API_ALLOWED_HOSTS",
      );
    }
    const apiKeyEnv = cfg.api_key_env?.trim();
    if (!apiKeyEnv || !isTenantCredentialEnv(apiKeyEnv, tenantSlug)) {
      throw new Error(
        "search.web: a configured endpoint requires an explicit tenant-scoped api_key_env binding",
      );
    }
  }
  return url;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveContentLimits(cfg: SearchConfig): WebSearchContentLimits {
  const defaults = WEB_SEARCH_CONTENT_LIMITS.defaults;
  const maximums = WEB_SEARCH_CONTENT_LIMITS.maximums;
  return {
    perResultCharacters: boundedInteger(
      cfg.max_content_chars_per_result,
      defaults.perResultCharacters,
      256,
      maximums.perResultCharacters,
    ),
    totalCharacters: boundedInteger(
      cfg.max_content_chars_total,
      defaults.totalCharacters,
      256,
      maximums.totalCharacters,
    ),
    perResultBytes: boundedInteger(
      cfg.max_content_bytes_per_result,
      defaults.perResultBytes,
      1_024,
      maximums.perResultBytes,
    ),
    totalBytes: boundedInteger(
      cfg.max_content_bytes_total,
      defaults.totalBytes,
      1_024,
      maximums.totalBytes,
    ),
  };
}

function utf8Bytes(symbol: string): number {
  const codePoint = symbol.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function boundedSourceContent(
  value: string,
  characterLimit: number,
  byteLimit: number,
): {
  content: string | null;
  characters: number;
  bytes: number;
  truncated: boolean;
} {
  if (!value || characterLimit <= 0 || byteLimit <= 0) {
    return {
      content: null,
      characters: 0,
      bytes: 0,
      truncated: value.length > 0,
    };
  }

  const pieces: string[] = [];
  let characters = 0;
  let bytes = 0;
  let codeUnits = 0;
  for (const symbol of value) {
    const symbolBytes = utf8Bytes(symbol);
    if (characters + 1 > characterLimit || bytes + symbolBytes > byteLimit) {
      break;
    }
    pieces.push(symbol);
    characters += 1;
    bytes += symbolBytes;
    codeUnits += symbol.length;
  }

  return {
    content: pieces.length > 0 ? pieces.join("") : null,
    characters,
    bytes,
    truncated: codeUnits < value.length,
  };
}

/** Normalize the common Tavily, Brave, Serper, and custom result envelopes. */
export function normalizeWebSearchResponse(
  _provider: SearchProvider,
  body: unknown,
  limit: number,
  contentLimits: WebSearchContentLimits = WEB_SEARCH_CONTENT_LIMITS.defaults,
): WebSearchResult[] {
  const root = object(body) ?? {};
  const web = object(root.web);
  const raw =
    (Array.isArray(root.results) ? root.results : undefined) ??
    (Array.isArray(root.organic) ? root.organic : undefined) ??
    (Array.isArray(web?.results) ? web?.results : undefined) ??
    [];
  const results: WebSearchResult[] = [];
  let remainingCharacters = Math.max(0, contentLimits.totalCharacters);
  let remainingBytes = Math.max(0, contentLimits.totalBytes);

  for (const item of raw) {
    if (results.length >= limit) break;
    const record = object(item);
    if (!record) continue;
    const url = text(record.url) || text(record.link);
    if (!url) continue;

    const sourceContent =
      text(record.raw_content) ||
      text(record.rawContent) ||
      text(record.markdown);
    const bounded = boundedSourceContent(
      sourceContent,
      Math.min(contentLimits.perResultCharacters, remainingCharacters),
      Math.min(contentLimits.perResultBytes, remainingBytes),
    );
    remainingCharacters -= bounded.characters;
    remainingBytes -= bounded.bytes;

    results.push({
      title: text(record.title) || text(record.name),
      url,
      snippet:
        text(record.content) ||
        text(record.snippet) ||
        text(record.description),
      publishedAt:
        text(record.published_date) ||
        text(record.publishedAt) ||
        text(record.page_age) ||
        null,
      score: numeric(record.score),
      content: bounded.content,
      contentCharacters: bounded.characters,
      contentBytes: bounded.bytes,
      contentTruncated: bounded.truncated,
    });
  }
  return results;
}

export const webSearch = defineTool({
  name: "search.web",
  description:
    "Read-only public web search for Deep Search. Supports Tavily, Brave Search, Serper, or a compatible custom endpoint. Advanced Tavily searches can return bounded cleaned source Markdown so agents can inspect evidence rather than rely on snippets. Call it repeatedly with varied queries and cite retrieved URLs.",
  output: z.object({
    query: z.string(),
    provider: z.enum(["tavily", "brave", "serper", "custom"]),
    contentRequested: z.boolean(),
    contentCharacters: z.number().int().nonnegative(),
    contentBytes: z.number().int().nonnegative(),
    contentTruncated: z.boolean(),
    results: z.array(
      z.object({
        title: z.string(),
        url: z.string(),
        snippet: z.string(),
        publishedAt: z.string().nullable(),
        score: z.number().nullable(),
        content: z.string().nullable(),
        contentCharacters: z.number().int().nonnegative(),
        contentBytes: z.number().int().nonnegative(),
        contentTruncated: z.boolean(),
      }),
    ),
  }),
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const cfg = config(ctx);
    const provider = cfg.provider ?? "tavily";
    const query = requiredQuery(args);
    const limit = boundedInteger(args.max_results, 8, 1, 20);
    const url = endpoint(provider, cfg, ctx.tenantSlug);
    const apiKey = providerApiKey(provider, cfg);
    const includeDomains = strings(args.include_domains);
    const excludeDomains = strings(args.exclude_domains);
    const depth = args.search_depth === "advanced" ? "advanced" : "basic";
    const includeRawContent =
      provider === "tavily" &&
      (args.include_raw_content === true ||
        (args.include_raw_content !== false && depth === "advanced"));
    const timeRange =
      typeof args.time_range === "string" ? args.time_range : undefined;

    let init: RequestInit;
    if (provider === "brave") {
      url.searchParams.set("q", query);
      url.searchParams.set("count", String(limit));
      if (timeRange) url.searchParams.set("freshness", timeRange);
      init = {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
      };
    } else {
      const headers: Record<string, string> = {
        Accept: "application/json",
        "Content-Type": "application/json",
      };
      if (provider === "serper") headers["X-API-KEY"] = apiKey;
      else headers.Authorization = `Bearer ${apiKey}`;
      const body =
        provider === "serper"
          ? { q: query, num: limit, ...(timeRange ? { tbs: timeRange } : {}) }
          : {
              query,
              max_results: limit,
              search_depth: depth,
              include_answer: false,
              include_raw_content: includeRawContent ? "markdown" : false,
              ...(includeDomains ? { include_domains: includeDomains } : {}),
              ...(excludeDomains ? { exclude_domains: excludeDomains } : {}),
              ...(timeRange ? { time_range: timeRange } : {}),
            };
      init = { method: "POST", headers, body: JSON.stringify(body) };
    }

    const timeoutMs = boundedInteger(cfg.timeout_ms, 30_000, 1_000, 120_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      const responseText = await response.text();
      let body: unknown = responseText;
      try {
        body = responseText ? JSON.parse(responseText) : {};
      } catch {
        // Keep the upstream text for the error message below.
      }
      if (!response.ok) {
        throw new Error(
          `search.web: ${provider} returned ${response.status}: ${responseText.slice(0, 500)}`,
        );
      }
      const results = normalizeWebSearchResponse(
        provider,
        body,
        limit,
        resolveContentLimits(cfg),
      );
      const contentCharacters = results.reduce(
        (total, result) => total + result.contentCharacters,
        0,
      );
      const contentBytes = results.reduce(
        (total, result) => total + result.contentBytes,
        0,
      );
      return {
        data: {
          query,
          provider,
          contentRequested: includeRawContent,
          contentCharacters,
          contentBytes,
          contentTruncated: results.some((result) => result.contentTruncated),
          results,
        },
        meta: { tool: "search.web", readOnly: true, status: response.status },
      };
    } finally {
      clearTimeout(timer);
    }
  },
});
