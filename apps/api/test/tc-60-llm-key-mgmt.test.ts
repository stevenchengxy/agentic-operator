/**
 * TC-60 — Provider key management endpoints.
 *
 * Exercises:
 *   GET  /v1/llm/providers/keys          — list masked metadata
 *   GET  /v1/llm/providers/:id/key       — single provider meta
 *   POST /v1/llm/providers/:id/key       — save + rotate (vault round-trip)
 *   POST /v1/llm/providers/:id/test      — connectivity probe (mock provider)
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { buildTestEnv, type TestEnv } from "./harness";
import { PROVIDER_IDS } from "@agentic/contracts";

const VAULT_PATH = path.join(
  process.cwd().endsWith("apps/api") ? "../.." : ".",
  "data",
  "test-provider-keys.json",
);

describe("TC-60: /v1/llm/providers key management", () => {
  let env: TestEnv;

  beforeAll(async () => {
    process.env.AGENTIC_KEY_VAULT_PATH = VAULT_PATH;
    process.env.AGENTIC_KEY_VAULT_SECRET = "test-vault-secret";
    if (existsSync(VAULT_PATH)) rmSync(VAULT_PATH);
    env = await buildTestEnv();
  });

  afterAll(async () => {
    if (existsSync(VAULT_PATH)) rmSync(VAULT_PATH);
    delete process.env.AGENTIC_KEY_VAULT_PATH;
    delete process.env.AGENTIC_KEY_VAULT_SECRET;
    await env.cleanup();
  });

  it("lists key metadata for every provider", async () => {
    const res = await env.fetch("/v1/llm/providers/keys");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: Array<{ provider: string; hasKey: boolean; source: string }>;
    };
    expect(body.ok).toBe(true);
    expect(body.data).toHaveLength(PROVIDER_IDS.length);
    const openrouter = body.data.find((m) => m.provider === "openrouter");
    expect(openrouter).toBeDefined();
  });

  it("POST /key persists, returns masked, and a follow-up GET reflects it", async () => {
    const res = await env.fetch("/v1/llm/providers/openrouter/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: "sk-or-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        scope: "workspace",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { provider: string; keyMasked: string; source: string; setAt: number };
    };
    expect(body.ok).toBe(true);
    expect(body.data.provider).toBe("openrouter");
    expect(body.data.source).toBe("vault");
    expect(body.data.keyMasked).toMatch(/^sk-or-/);
    expect(body.data.setAt).toBeGreaterThan(0);

    const meta = await env.fetch("/v1/llm/providers/openrouter/key");
    const metaBody = (await meta.json()) as {
      data: { source: string; hasKey: boolean; keyMasked: string };
    };
    expect(metaBody.data.hasKey).toBe(true);
    expect(metaBody.data.source).toBe("vault");
    expect(metaBody.data.keyMasked).toBe(body.data.keyMasked);
  });

  it("rejects too-short keys", async () => {
    const res = await env.fetch("/v1/llm/providers/openrouter/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "short", scope: "workspace" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects unknown provider ids", async () => {
    const res = await env.fetch("/v1/llm/providers/not-a-provider/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "aaaaaaaaaaaaaa", scope: "workspace" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects bad scope", async () => {
    const res = await env.fetch("/v1/llm/providers/openrouter/key", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "aaaaaaaaaaaaaaaaaaaa", scope: "global" }),
    });
    expect(res.status).toBe(400);
  });

  it("mock provider test connection succeeds without network", async () => {
    const res = await env.fetch("/v1/llm/providers/mock/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "mock-key-anything-long-enough" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      data: { ok: boolean; statusCode: number | null; message: string };
    };
    expect(body.ok).toBe(true);
    expect(body.data.ok).toBe(true);
    expect(body.data.statusCode).toBe(200);
  });

  it("test endpoint returns ok=false for empty key without network roundtrip", async () => {
    const res = await env.fetch("/v1/llm/providers/anthropic/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "x" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { ok: boolean; message: string };
    };
    expect(body.data.ok).toBe(false);
    expect(body.data.message).toMatch(/too short|empty/i);
  });
});
