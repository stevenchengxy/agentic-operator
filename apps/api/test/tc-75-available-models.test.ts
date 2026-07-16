/**
 * TC-75 — GET /v1/llm/providers/:id/available-models
 *
 * Verifies:
 *   - Unknown provider → 400
 *   - Mock provider returns its single model with source="live"
 *   - Provider with a configured catalog but no key falls back to source=
 *     "unsupported" + the catalog (so the picker still has something to show)
 *   - Provider with a key (env-injected) calls upstream /models; we stub
 *     `fetch` to return a fake response and assert the parsed shape
 *   - inFleet flag is set when a fleet entry matches the modelName
 *   - Empty-catalog provider (custom) returns source="unsupported" + zero
 *     models so the UI shows the free-text input
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildTestEnv, type TestEnv } from "./harness";
import { parseOpenAICompatBody } from "../src/services/model-discovery";

const TMP = mkdtempSync(path.join(tmpdir(), "tc75-"));
const FLEET_PATH = path.join(TMP, "model-fleet.json");
const VAULT_PATH = path.join(TMP, "provider-keys.json");

const ENV_BEFORE = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  AGENTIC_MODEL_FLEET_PATH: process.env.AGENTIC_MODEL_FLEET_PATH,
  AGENTIC_KEY_VAULT_PATH: process.env.AGENTIC_KEY_VAULT_PATH,
  MISTRAL_API_KEY: process.env.MISTRAL_API_KEY,
};

describe("TC-75: /v1/llm/providers/:id/available-models", () => {
  let env: TestEnv;

  beforeAll(async () => {
    // Fresh fleet/vault files so the test owns the state. The harness shares
    // a single Fastify instance across files in the same fork, so set env
    // BEFORE first import so model-fleet.ts / provider-keys.ts pick it up.
    process.env.AGENTIC_MODEL_FLEET_PATH = FLEET_PATH;
    process.env.AGENTIC_KEY_VAULT_PATH = VAULT_PATH;
    // Anthropic test needs a key — env path satisfies provider-keys.ts's
    // fallback even though we'll be stubbing fetch.
    process.env.ANTHROPIC_API_KEY = "test-key-anthropic";
    // Ensure mistral has NO key so we can test the unsupported-without-key
    // path without the test environment leaking a real one.
    delete process.env.MISTRAL_API_KEY;

    env = await buildTestEnv();
  });

  afterAll(async () => {
    process.env.ANTHROPIC_API_KEY = ENV_BEFORE.ANTHROPIC_API_KEY;
    if (ENV_BEFORE.AGENTIC_MODEL_FLEET_PATH === undefined) {
      delete process.env.AGENTIC_MODEL_FLEET_PATH;
    } else {
      process.env.AGENTIC_MODEL_FLEET_PATH = ENV_BEFORE.AGENTIC_MODEL_FLEET_PATH;
    }
    if (ENV_BEFORE.AGENTIC_KEY_VAULT_PATH === undefined) {
      delete process.env.AGENTIC_KEY_VAULT_PATH;
    } else {
      process.env.AGENTIC_KEY_VAULT_PATH = ENV_BEFORE.AGENTIC_KEY_VAULT_PATH;
    }
    if (ENV_BEFORE.MISTRAL_API_KEY === undefined) {
      delete process.env.MISTRAL_API_KEY;
    } else {
      process.env.MISTRAL_API_KEY = ENV_BEFORE.MISTRAL_API_KEY;
    }
    if (existsSync(TMP)) rmSync(TMP, { recursive: true, force: true });
    await env.cleanup();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps OpenRouter live reasoning metadata and ignores dynamic price sentinels", () => {
    const [model] = parseOpenAICompatBody({
      data: [
        {
          id: "openai/gpt-5.6-sol",
          pricing: { prompt: "-1", completion: "0.00003" },
          supported_parameters: ["tools", "reasoning"],
          reasoning: {
            supported_efforts: ["none", "low", "medium", "max", "future"],
            default_effort: "medium",
            mandatory: false,
            default_enabled: true,
          },
        },
      ],
    });

    expect(model).toMatchObject({
      id: "openai/gpt-5.6-sol",
      outputPricePerMTok: 30,
      tools: true,
      reasoning: true,
      reasoningEfforts: ["none", "low", "medium", "max"],
      defaultReasoningEffort: "medium",
      reasoningMandatory: false,
      reasoningDefaultEnabled: true,
    });
    expect(model?.inputPricePerMTok).toBeUndefined();
  });

  it("rejects unknown provider with 400", async () => {
    const res = await env.fetch("/v1/llm/providers/bogus/available-models");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { ok: false; error: { code: string } };
    expect(body.ok).toBe(false);
  });

  it("mock provider returns source=live + mock-model-v1", async () => {
    const res = await env.fetch("/v1/llm/providers/mock/available-models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      data: {
        provider: string;
        source: string;
        models: Array<{ id: string; origin: string; inFleet: boolean }>;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.provider).toBe("mock");
    expect(body.data.source).toBe("live");
    expect(body.data.models.some((m) => m.id === "mock-model-v1")).toBe(true);
    expect(body.data.models.find((m) => m.id === "mock-model-v1")?.origin).toBe("live");
  });

  it("mistral with no key returns source=unsupported but catalog models", async () => {
    const res = await env.fetch("/v1/llm/providers/mistral/available-models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        source: string;
        message: string | null;
        models: Array<{ id: string; origin: string }>;
      };
    };
    expect(body.data.source).toBe("unsupported");
    expect(body.data.message).toMatch(/no api key/i);
    // Catalog fallback ensures the picker still has options
    expect(body.data.models.length).toBeGreaterThan(0);
    expect(body.data.models.every((m) => m.origin === "catalog")).toBe(true);
    expect(body.data.models.some((m) => m.id === "mistral-large-latest")).toBe(true);
  });

  it("custom provider (empty catalog, no live support) returns zero models", async () => {
    const res = await env.fetch("/v1/llm/providers/custom/available-models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { source: string; models: unknown[] };
    };
    expect(body.data.source).toBe("unsupported");
    expect(body.data.models).toEqual([]);
  });

  it("anthropic with key + mocked upstream returns source=live and parsed models", async () => {
    // Stub global.fetch so we don't hit the real Anthropic API. Returning the
    // shape Anthropic's /v1/models actually uses: { data: [{ id, ... }, ...] }.
    const fakeBody = {
      data: [
        { type: "model", id: "claude-3-5-sonnet-20241022", display_name: "Claude 3.5 Sonnet" },
        { type: "model", id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5" },
      ],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(fakeBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const res = await env.fetch("/v1/llm/providers/anthropic/available-models");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        source: string;
        models: Array<{ id: string; origin: string; contextLength: number | null }>;
      };
    };
    expect(body.data.source).toBe("live");
    // Both mocked models present
    expect(body.data.models.some((m) => m.id === "claude-3-5-sonnet-20241022")).toBe(true);
    // Live entry whose id matches catalog inherits the catalog ctx (200_000)
    const haiku = body.data.models.find((m) => m.id === "claude-haiku-4-5");
    expect(haiku?.origin).toBe("live");
    expect(haiku?.contextLength).toBe(200_000);
    // A catalog-only entry whose id wasn't in the mock response is still
    // listed with origin=catalog
    const opus = body.data.models.find((m) => m.id === "claude-opus-4");
    expect(opus?.origin).toBe("catalog");
  });

  it("flags models already in the tenant's fleet with inFleet=true", async () => {
    // Add a fleet entry, then re-query and verify the flag.
    const add = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "mock", modelName: "mock-model-v1" }),
    });
    expect(add.status).toBe(200);

    const res = await env.fetch("/v1/llm/providers/mock/available-models");
    const body = (await res.json()) as {
      data: { models: Array<{ id: string; inFleet: boolean }> };
    };
    const mockEntry = body.data.models.find((m) => m.id === "mock-model-v1");
    expect(mockEntry).toBeDefined();
    expect(mockEntry!.inFleet).toBe(true);
  });
});
