/**
 * TC-1 — Provider listing reflects env state.
 *
 * Boots the API, ensures GET /v1/llm/providers returns every adapter that is
 * actually registered in this process (bedrock/vertex are catalog presets with
 * no adapter and must not be reported), and that hasKey accurately reflects
 * which env vars are set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildTestEnv, type TestEnv } from "./harness";
import { PROVIDER_IDS } from "@agentic/contracts";

const ENV_BEFORE = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};

describe("TC-1: /v1/llm/providers", () => {
  let env: TestEnv;

  beforeAll(async () => {
    // Force a known key state for assertions:
    process.env.ANTHROPIC_API_KEY = "test-key-anthropic";
    // Note: the LLMGateway singleton is constructed once on first request;
    // setting env before buildTestEnv() ensures the singleton sees this value.
    env = await buildTestEnv();
  });

  afterAll(async () => {
    process.env.ANTHROPIC_API_KEY = ENV_BEFORE.ANTHROPIC_API_KEY;
    await env.cleanup();
  });

  it("returns exactly the adapters registered in this process", async () => {
    const res = await env.fetch("/v1/llm/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Array<{ id: string; name: string; hasKey: boolean; models: string[] }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toBeInstanceOf(Array);
    // registerAllProviders() wires 13 real adapters; the deterministic mock is
    // added only in the test process. bedrock/vertex are catalog presets with
    // no adapter in this build and must not be reported as runnable, so this
    // is intentionally NOT PROVIDER_IDS.length.
    const expectedIds = [
      "anthropic",
      "azure",
      "custom",
      "deepseek",
      "gemini",
      "groq",
      "mistral",
      "mock",
      "moonshot",
      "openai",
      "openrouter",
      "qwen",
      "together",
      "zai",
    ];
    expect(body.data.map((provider) => provider.id).sort()).toEqual(expectedIds);
    expect(body.data.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["moonshot", "zai"]),
    );
    expect(PROVIDER_IDS).toEqual(expect.arrayContaining(expectedIds.filter((id) => id !== "mock")));
  });

  it("includes the openrouter entry", async () => {
    const res = await env.fetch("/v1/llm/providers");
    const body = (await res.json()) as {
      data: Array<{ id: string; name: string; hasKey: boolean }>;
    };
    const openrouter = body.data.find((p) => p.id === "openrouter");
    expect(openrouter).toBeDefined();
    expect(openrouter!.name).toMatch(/openrouter/i);
  });

  it("mock provider always reports hasKey=true", async () => {
    const res = await env.fetch("/v1/llm/providers");
    const body = (await res.json()) as {
      data: Array<{ id: string; hasKey: boolean }>;
    };
    const mock = body.data.find((p) => p.id === "mock");
    expect(mock).toBeDefined();
    expect(mock!.hasKey).toBe(true);
  });

  it("anthropic reports hasKey=true (env was set)", async () => {
    const res = await env.fetch("/v1/llm/providers");
    const body = (await res.json()) as {
      data: Array<{ id: string; hasKey: boolean }>;
    };
    const anthropic = body.data.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.hasKey).toBe(true);
  });

  it("each provider entry carries a models array", async () => {
    const res = await env.fetch("/v1/llm/providers");
    const body = (await res.json()) as {
      data: Array<{ id: string; models: string[] }>;
    };
    for (const p of body.data) {
      expect(Array.isArray(p.models)).toBe(true);
    }
  });
});
