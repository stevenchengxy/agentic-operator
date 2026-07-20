import { afterEach, describe, expect, it, vi } from "vitest";
import { testProviderKey } from "../src/services/provider-test";

describe("custom provider connectivity probe", () => {
  const previousBaseUrl = process.env.CUSTOM_LLM_BASE_URL;

  afterEach(() => {
    vi.unstubAllGlobals();
    if (previousBaseUrl === undefined) delete process.env.CUSTOM_LLM_BASE_URL;
    else process.env.CUSTOM_LLM_BASE_URL = previousBaseUrl;
  });

  it("probes the configured OpenAI-compatible /models endpoint", async () => {
    process.env.CUSTOM_LLM_BASE_URL = "https://gateway.example.test/v1/";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await testProviderKey("custom", "sk-custom-probe-key");

    expect(result).toMatchObject({ ok: true, statusCode: 200, modelCount: 2 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://gateway.example.test/v1/models");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer sk-custom-probe-key",
      Accept: "application/json",
    });
  });

  it("fails clearly when the custom base URL is absent", async () => {
    delete process.env.CUSTOM_LLM_BASE_URL;
    const result = await testProviderKey("custom", "sk-custom-probe-key");
    expect(result).toMatchObject({
      ok: false,
      statusCode: null,
      message: "CUSTOM_LLM_BASE_URL is not configured",
    });
  });
});
