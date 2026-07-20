/**
 * TC-61 — Model fleet CRUD endpoints.
 *
 * Exercises:
 *   GET    /v1/llm/catalog            — full metadata catalog
 *   GET    /v1/llm/fleet              — list tenant fleet
 *   POST   /v1/llm/fleet              — add entry (validation, dedupe)
 *   PATCH  /v1/llm/fleet/:id          — partial update (alias, role, cap)
 *   DELETE /v1/llm/fleet/:id          — remove entry
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { buildTestEnv, type TestEnv } from "./harness";

const FLEET_PATH = path.join(
  process.cwd().endsWith("apps/api") ? "../.." : ".",
  "data",
  "test-model-fleet.json",
);

describe("TC-61: /v1/llm/fleet model-fleet CRUD", () => {
  let env: TestEnv;

  beforeAll(async () => {
    process.env.AGENTIC_MODEL_FLEET_PATH = FLEET_PATH;
    if (existsSync(FLEET_PATH)) rmSync(FLEET_PATH);
    env = await buildTestEnv();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      data: [
        "anthropic/claude-sonnet-4-5",
        "openai/gpt-4.1-mini",
        "openai/gpt-5.4-mini-future",
        "openai/gpt-oss-120b",
        "google/gemini-3-flash-preview",
        "deepseek/deepseek-v4-pro",
        "deepseek/deepseek-v4-flash",
        "minimax/minimax-m2.7",
      ].map((id) => ({ id })),
    }), { status: 200, headers: { "content-type": "application/json" } }));
  });

  afterAll(async () => {
    if (existsSync(FLEET_PATH)) rmSync(FLEET_PATH);
    vi.restoreAllMocks();
    delete process.env.AGENTIC_MODEL_FLEET_PATH;
    await env.cleanup();
  });

  it("GET /catalog returns per-provider model metadata", async () => {
    const res = await env.fetch("/v1/llm/catalog");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Record<string, Array<{ name: string; ctx: number; inP: number; outP: number }>>;
    };
    expect(body.ok).toBe(true);
    expect(body.data.openrouter.length).toBeGreaterThan(0);
    const first = body.data.openrouter[0];
    expect(typeof first.name).toBe("string");
    expect(typeof first.ctx).toBe("number");
  });

  it("GET /fleet initially returns empty array", async () => {
    const res = await env.fetch("/v1/llm/fleet");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: unknown[] };
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  it("POST /fleet adds an entry with defaults", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "anthropic/claude-sonnet-4-5",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: {
        id: string;
        provider: string;
        modelName: string;
        alias: string;
        role: string;
        dailyCapUsd: number;
        maxOutTokens: number;
        temperature: number;
        availability: string;
      };
    };
    expect(body.ok).toBe(true);
    expect(body.data.id).toMatch(/^mdl-/);
    expect(body.data.provider).toBe("openrouter");
    expect(body.data.alias).toBe("anthropic/claude-sonnet-4-5");
    expect(body.data.role).toBe("primary");
    expect(body.data.dailyCapUsd).toBe(30);
    expect(body.data.maxOutTokens).toBe(2048);
    expect(body.data.temperature).toBe(0.2);
    expect(body.data.availability).toBe("provider_confirmed");
  });

  it("POST /fleet honors alias, role, cap, params", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/gpt-4.1-mini",
        alias: "fast-fallback",
        role: "fallback",
        dailyCapUsd: 5,
        maxOutTokens: 4096,
        temperature: 0.5,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { alias: string; role: string; dailyCapUsd: number } };
    expect(body.data.alias).toBe("fast-fallback");
    expect(body.data.role).toBe("fallback");
    expect(body.data.dailyCapUsd).toBe(5);
  });

  it("POST /fleet rejects duplicate provider+modelName", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "anthropic/claude-sonnet-4-5",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/already in/);
  });

  it("POST /fleet rejects unknown provider id", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "bogus", modelName: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("POST /fleet accepts a live-discovered id even when the static catalog is stale", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "openai/gpt-5.4-mini-future",
      }),
    });
    expect(res.status).toBe(200);
    // Clean up so later tests still see only the two seeded entries.
    const body = (await res.json()) as { data: { id: string } };
    await env.fetch(`/v1/llm/fleet/${body.data.id}`, { method: "DELETE" });
  });

  it("POST /fleet rejects a name absent from a discovery-capable provider", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "openrouter",
        modelName: "made-up/not-reported",
      }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      error: { code: "model_not_available" },
    });
  });

  it("persists unsupported-provider entries as explicitly unverified", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "azure",
        modelName: "tenant-deployment-name",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { id: string; availability: string; availabilityCheckedAt: number | null };
    };
    expect(body.data.availability).toBe("unverified");
    expect(body.data.availabilityCheckedAt).toBeNull();
    await env.fetch(`/v1/llm/fleet/${body.data.id}`, { method: "DELETE" });
  });

  it("POST /fleet rejects empty modelName", async () => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", modelName: "  " }),
    });
    expect(res.status).toBe(400);
  });

  it("GET /fleet lists added entries newest first", async () => {
    const res = await env.fetch("/v1/llm/fleet");
    const body = (await res.json()) as { data: Array<{ modelName: string }> };
    expect(body.data.length).toBe(2);
    // Newest first → openai/gpt-4.1-mini was added last
    expect(body.data[0].modelName).toBe("openai/gpt-4.1-mini");
  });

  it("PATCH /fleet/:id updates fields and rejects bad role", async () => {
    const list = (await (await env.fetch("/v1/llm/fleet")).json()) as { data: Array<{ id: string }> };
    const id = list.data[0].id;

    const ok = await env.fetch(`/v1/llm/fleet/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "renamed", dailyCapUsd: 12 }),
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { data: { alias: string; dailyCapUsd: number } };
    expect(okBody.data.alias).toBe("renamed");
    expect(okBody.data.dailyCapUsd).toBe(12);

    const bad = await env.fetch(`/v1/llm/fleet/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "invalid-role" }),
    });
    expect(bad.status).toBe(400);
  });

  it("rejects invalid numeric and no-op fleet mutations instead of auditing fake updates", async () => {
    const list = (await (await env.fetch("/v1/llm/fleet")).json()) as {
      data: Array<{ id: string; dailyCapUsd: number }>;
    };
    const id = list.data[0].id;
    const beforeCap = list.data[0].dailyCapUsd;

    for (const body of [
      { dailyCapUsd: "not-a-number" },
      { maxOutTokens: 0 },
      { temperature: 3 },
      {},
      { ignoredField: true },
    ]) {
      const response = await env.fetch(`/v1/llm/fleet/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      expect(response.status).toBe(400);
    }

    const after = (await (await env.fetch("/v1/llm/fleet")).json()) as {
      data: Array<{ id: string; dailyCapUsd: number }>;
    };
    expect(after.data.find((entry) => entry.id === id)?.dailyCapUsd).toBe(
      beforeCap,
    );
  });

  it("PATCH /fleet/:id 404 on unknown id", async () => {
    const res = await env.fetch("/v1/llm/fleet/mdl-doesnotexist", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /fleet/:id removes the entry", async () => {
    const before = (await (await env.fetch("/v1/llm/fleet")).json()) as { data: Array<{ id: string }> };
    const id = before.data[0].id;

    const res = await env.fetch(`/v1/llm/fleet/${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const after = (await (await env.fetch("/v1/llm/fleet")).json()) as { data: Array<{ id: string }> };
    expect(after.data.find((e) => e.id === id)).toBeUndefined();
    expect(after.data.length).toBe(before.data.length - 1);
  });

  it("DELETE /fleet/:id 404 on unknown id", async () => {
    const res = await env.fetch("/v1/llm/fleet/mdl-nosuch", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  // The catalog was extended with five model IDs that the live OpenRouter
  // /models endpoint returns but the curated list previously rejected — the
  // user saw `bad_request — model … not in openrouter catalog` when trying
  // to add them through the Settings picker. Guard the catalog so the
  // entries don't get pruned by a future cleanup.
  it.each([
    "openai/gpt-oss-120b",
    "google/gemini-3-flash-preview",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "minimax/minimax-m2.7",
  ])("POST /fleet accepts catalog model %s", async (modelName) => {
    const res = await env.fetch("/v1/llm/fleet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "openrouter", modelName }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { modelName: string } };
    expect(body.ok).toBe(true);
    expect(body.data.modelName).toBe(modelName);
  });
});
