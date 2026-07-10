import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { fetchModelCatalog, cachedModelIds, __resetModelCatalog } from "./model-catalog";
import { modelChain } from "./model-router";

// #7 — live model-catalog introspection + catalog-aware tier chains.
const ENV = { CUSTOM_LLM_BASE_URL: "http://gw.local/v1", CUSTOM_LLM_API_KEY: "sk-test", FACTORY_AI_MODEL: "google/gemini-3-flash-preview" };
const CATALOG = [
  "google/gemini-3-flash-preview",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-haiku-4.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-nano",
  "google/gemini-3.1-pro-preview-customtools",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "google/gemini-3-pro-image-preview", // non-chat: must be excluded from derivation
];

function mockModelsFetch(ids: string[]) {
  return vi.fn(async () => ({ ok: true, json: async () => ({ data: ids.map((id) => ({ id })) }) })) as unknown as typeof fetch;
}

describe("model-catalog (#7)", () => {
  beforeEach(() => { __resetModelCatalog(); });
  afterEach(() => { vi.restoreAllMocks(); __resetModelCatalog(); });

  it("returns null before warming, then the served ids after a fetch", async () => {
    expect(cachedModelIds(ENV)).toBeNull();
    vi.stubGlobal("fetch", mockModelsFetch(CATALOG));
    const ids = await fetchModelCatalog(ENV, { force: true });
    expect(ids).toEqual(CATALOG);
    expect(cachedModelIds(ENV)).toEqual(CATALOG);
  });

  it("hits the gateway's /models endpoint with the bearer key", async () => {
    const f = mockModelsFetch(CATALOG);
    vi.stubGlobal("fetch", f);
    await fetchModelCatalog(ENV, { force: true });
    expect(f).toHaveBeenCalledWith("http://gw.local/v1/models", expect.objectContaining({
      headers: expect.objectContaining({ Authorization: "Bearer sk-test" }),
    }));
  });

  it("returns null (never throws) when the gateway is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
    await expect(fetchModelCatalog(ENV, { force: true })).resolves.toBeNull();
  });

  it("does not fetch when no api key is configured", async () => {
    const f = mockModelsFetch(CATALOG);
    vi.stubGlobal("fetch", f);
    await fetchModelCatalog({ CUSTOM_LLM_BASE_URL: "http://gw.local/v1" }, { force: true });
    expect(f).not.toHaveBeenCalled();
  });
});

describe("modelChain catalog validation/derivation (#7)", () => {
  beforeEach(() => { __resetModelCatalog(); });
  afterEach(() => { vi.restoreAllMocks(); __resetModelCatalog(); });

  it("drops a configured id the gateway does not serve, keeping the served ones + base", async () => {
    vi.stubGlobal("fetch", mockModelsFetch(CATALOG));
    await fetchModelCatalog(ENV, { force: true });
    const env = { ...ENV, FACTORY_MODEL_HARD: "anthropic/claude-sonnet-4.6,openai/gpt-9-imaginary,deepseek/deepseek-v4-pro" };
    expect(modelChain("hard", env)).toEqual(["anthropic/claude-sonnet-4.6", "deepseek/deepseek-v4-pro", "google/gemini-3-flash-preview"]);
  });

  it("derives a tier chain from the live catalog when the env chain is unset", async () => {
    vi.stubGlobal("fetch", mockModelsFetch(CATALOG));
    await fetchModelCatalog(ENV, { force: true });
    // hard prefers sonnet/gpt-5/deepseek-pro; image model must NOT appear.
    const hard = modelChain("hard", ENV);
    expect(hard).toContain("anthropic/claude-sonnet-4.6");
    expect(hard.some((m) => /image/.test(m))).toBe(false);
    // fast prefers flash/haiku — cheap models first.
    const fast = modelChain("fast", ENV);
    expect(fast[0]).toMatch(/flash|haiku/);
  });

  it("keeps the configured chain intact when the catalog is unknown (null-safe)", () => {
    // no fetch → cache null → no filtering/derivation
    const env = { ...ENV, FACTORY_MODEL_HARD: "a/x,b/y" };
    expect(modelChain("hard", env)).toEqual(["a/x", "b/y", "google/gemini-3-flash-preview"]);
  });
});
