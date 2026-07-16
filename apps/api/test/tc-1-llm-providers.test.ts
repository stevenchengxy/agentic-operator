/**
 * TC-1 — Provider listing reflects env state.
 *
 * Boots the API, ensures GET /v1/llm/providers returns every provider,
 * and that hasKey accurately reflects which env vars are set.
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

  it("returns every configured provider", async () => {
    const res = await env.fetch("/v1/llm/providers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Array<{ id: string; name: string; hasKey: boolean; models: string[] }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toBeInstanceOf(Array);
    expect(body.data).toHaveLength(PROVIDER_IDS.length);
    expect(body.data.map((provider) => provider.id)).toEqual(
      expect.arrayContaining(["moonshot", "zai"]),
    );
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
