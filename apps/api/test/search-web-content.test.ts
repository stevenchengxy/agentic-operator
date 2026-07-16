import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeWebSearchResponse, webSearch } from "@agentic/tools/search";

const originalFetch = globalThis.fetch;
const originalTavilyApiKey = process.env.TAVILY_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTavilyApiKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavilyApiKey;
  vi.restoreAllMocks();
});

describe("search.web source content", () => {
  it("enforces per-result and aggregate character budgets", () => {
    const results = normalizeWebSearchResponse(
      "tavily",
      {
        results: [
          {
            title: "First",
            url: "https://first.example",
            content: "First snippet",
            raw_content: "abcdefghij",
          },
          {
            title: "Second",
            url: "https://second.example",
            content: "Second snippet",
            raw_content: "klmnopqrst",
          },
        ],
      },
      5,
      {
        perResultCharacters: 6,
        totalCharacters: 8,
        perResultBytes: 100,
        totalBytes: 100,
      },
    );

    expect(results).toMatchObject([
      {
        content: "abcdef",
        contentCharacters: 6,
        contentBytes: 6,
        contentTruncated: true,
      },
      {
        content: "kl",
        contentCharacters: 2,
        contentBytes: 2,
        contentTruncated: true,
      },
    ]);
  });

  it("caps UTF-8 bytes without splitting a multi-byte character", () => {
    const [result] = normalizeWebSearchResponse(
      "tavily",
      {
        results: [
          {
            title: "Unicode",
            url: "https://unicode.example",
            raw_content: "😀😀x",
          },
        ],
      },
      1,
      {
        perResultCharacters: 10,
        totalCharacters: 10,
        perResultBytes: 5,
        totalBytes: 5,
      },
    );

    expect(result).toMatchObject({
      content: "😀",
      contentCharacters: 1,
      contentBytes: 4,
      contentTruncated: true,
    });
  });

  it("requests cleaned Markdown by default for advanced Tavily search", async () => {
    process.env.TAVILY_API_KEY = "test-key";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_url, init) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          results: [
            {
              title: "Primary source",
              url: "https://primary.example",
              content: "Result snippet",
              raw_content: "# Primary source\n\nFull evidence.",
              score: 0.95,
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await webSearch.handler({
      agentName: "deepSearch",
      actionName: "gatherEvidence",
      correlationId: "cor-search-content",
      tenantSlug: "tenant-test",
      event: {
        name: "tool:search.web",
        data: {
          query: "primary evidence",
          search_depth: "advanced",
        },
      },
    });

    expect(JSON.parse(String(capturedInit?.body))).toMatchObject({
      search_depth: "advanced",
      include_raw_content: "markdown",
      include_answer: false,
    });
    expect(result.data).toMatchObject({
      contentRequested: true,
      contentCharacters: 32,
      contentBytes: 32,
      contentTruncated: false,
      results: [
        {
          content: "# Primary source\n\nFull evidence.",
          contentTruncated: false,
        },
      ],
    });
  });
});
