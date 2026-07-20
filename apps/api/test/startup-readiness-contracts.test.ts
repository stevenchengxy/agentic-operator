import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readApiBuildStatus, summarizeMcp } from "../src/routes/health";
import {
  __recordInngestSyncEvidenceForTests,
  __resetInngestSyncEvidenceForTests,
  inngestRegistrationStatus,
} from "../src/services/inngest-sync";
import { probeDefaultLLMProvider, resetLLMGateway } from "../src/services/llm";
import { configuredMemoryEmbedderHealth } from "../src/services/memory-pgvector";
import { McpManager } from "@agentic/mcp";
import { openaiEmbedder } from "@agentic/runtime";

const TRACKED_ENV = [
  "NODE_ENV",
  "INNGEST_SYNC_DISABLED",
  "LLM_DEFAULT_PROVIDER",
  "LLM_DEFAULT_MODEL",
  "CUSTOM_LLM_BASE_URL",
  "CUSTOM_LLM_API_KEY",
] as const;
const originalEnv = Object.fromEntries(
  TRACKED_ENV.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of TRACKED_ENV) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetLLMGateway();
  __resetInngestSyncEvidenceForTests();
  vi.unstubAllGlobals();
});

describe("production startup readiness contracts", () => {
  it("keeps identically named MCP servers isolated by tenant scope", () => {
    const manager = new McpManager();
    manager.register(
      {
        name: "catalog",
        transport: "http",
        url: "https://tenant-a.invalid/mcp",
        optional: true,
      },
      "tenant-a",
    );
    manager.register(
      {
        name: "catalog",
        transport: "http",
        url: "https://tenant-b.invalid/mcp",
        optional: false,
      },
      "tenant-b",
    );

    expect(manager.describe()).toHaveLength(2);
    expect(manager.describe("tenant-a")).toEqual([
      expect.objectContaining({
        name: "catalog",
        scope: "tenant-a",
        optional: true,
      }),
    ]);
    expect(manager.describe("tenant-b")).toEqual([
      expect.objectContaining({
        name: "catalog",
        scope: "tenant-b",
        optional: false,
      }),
    ]);
  });

  it("removes stale MCP declarations from an authoritative tenant rebuild", async () => {
    const manager = new McpManager();
    manager.register(
      {
        name: "removed-server",
        transport: "http",
        url: "https://removed.invalid/mcp",
        optional: true,
      },
      "acme",
    );
    expect(manager.describe("acme")).toHaveLength(1);
    await manager.connectAll([], "acme");
    expect(manager.describe("acme")).toEqual([]);
    expect(manager.toolMap({ scope: "acme" })).toEqual({});
  });

  it("fails health for a required MCP and marks optional outages as degradation", () => {
    const required = summarizeMcp(
      [
        {
          name: "critical",
          scope: "acme",
          transport: "http",
          optional: false,
          connected: false,
          toolCount: 0,
        },
        {
          name: "nice-to-have",
          scope: "acme",
          transport: "http",
          optional: true,
          connected: false,
          toolCount: 0,
        },
      ],
      123,
    );
    expect(required).toMatchObject({
      ok: false,
      degraded: true,
      requiredUnavailable: ["acme:critical"],
      optionalUnavailable: ["acme:nice-to-have"],
    });

    const optionalOnly = summarizeMcp(
      [
        {
          name: "nice-to-have",
          scope: "acme",
          transport: "http",
          optional: true,
          connected: false,
          toolCount: 0,
        },
      ],
      124,
    );
    expect(optionalOnly).toMatchObject({ ok: true, degraded: true });
  });

  it("never synthesizes 0.0.0 when package metadata is missing or invalid", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "agentic-build-health-"),
    );
    try {
      const valid = path.join(root, "valid.json");
      const invalid = path.join(root, "invalid.json");
      await fs.writeFile(valid, JSON.stringify({ version: "9.8.7" }));
      await fs.writeFile(
        invalid,
        JSON.stringify({ name: "api-without-version" }),
      );

      await expect(readApiBuildStatus(valid)).resolves.toEqual({
        ok: true,
        version: "9.8.7",
      });
      await expect(readApiBuildStatus(invalid)).resolves.toEqual({
        ok: false,
        note: "api package metadata is missing or invalid",
      });
      const missing = await readApiBuildStatus(path.join(root, "missing.json"));
      expect(missing.ok).toBe(false);
      expect(JSON.stringify(missing)).not.toContain("0.0.0");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates Inngest acceptance evidence when the served function set changes", () => {
    process.env.NODE_ENV = "development";
    delete process.env.INNGEST_SYNC_DISABLED;
    const expected = [
      {
        slug: "acme",
        appId: "agentic-operator-acme",
        servePath: "/inngest/acme",
        fnCount: 3,
      },
    ];

    expect(inngestRegistrationStatus(expected)).toMatchObject({
      ok: false,
      expectedApps: 1,
      syncedApps: 0,
      unsynced: ["acme"],
    });
    __recordInngestSyncEvidenceForTests({
      slug: "acme",
      appId: "agentic-operator-acme",
      fnCount: 3,
      ok: true,
    });
    expect(inngestRegistrationStatus(expected)).toMatchObject({
      ok: true,
      syncedApps: 1,
    });
    expect(
      inngestRegistrationStatus([{ ...expected[0]!, fnCount: 4 }]),
    ).toMatchObject({
      ok: false,
      syncedApps: 0,
      unsynced: ["acme"],
    });
  });

  it("uses a token-free upstream probe and exposes no provider credential", async () => {
    process.env.NODE_ENV = "development";
    process.env.LLM_DEFAULT_PROVIDER = "custom";
    process.env.LLM_DEFAULT_MODEL = "real-model";
    process.env.CUSTOM_LLM_BASE_URL = "http://provider.invalid/v1";
    process.env.CUSTOM_LLM_API_KEY = "fixture-provider-key";
    resetLLMGateway();
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ id: "real-model" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const readiness = await probeDefaultLLMProvider({
      force: true,
      maxAgeMs: 0,
    });
    expect(readiness).toMatchObject({
      ok: true,
      provider: "custom",
      model: "real-model",
      reachable: true,
      statusCode: 200,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://provider.invalid/v1/models",
    );
    expect(JSON.stringify(readiness)).not.toContain("fixture-provider-key");
  });

  it("marks a rejected provider credential unhealthy without returning upstream text", async () => {
    process.env.NODE_ENV = "development";
    process.env.LLM_DEFAULT_PROVIDER = "custom";
    process.env.LLM_DEFAULT_MODEL = "real-model";
    process.env.CUSTOM_LLM_BASE_URL = "http://provider.invalid/v1";
    process.env.CUSTOM_LLM_API_KEY = "fixture-provider-key";
    resetLLMGateway();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "credential body must stay private" },
            }),
            { status: 401, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    const readiness = await probeDefaultLLMProvider({
      force: true,
      maxAgeMs: 0,
    });
    expect(readiness).toMatchObject({
      ok: false,
      provider: "custom",
      reachable: true,
      statusCode: 401,
      note: "auth_rejected",
    });
    expect(JSON.stringify(readiness)).not.toContain("credential body");
    expect(JSON.stringify(readiness)).not.toContain("fixture-provider-key");
  });

  it("treats a configured remote embedding endpoint as a real health dependency", async () => {
    const healthy = await configuredMemoryEmbedderHealth({
      force: true,
      maxAgeMs: 0,
      env: { MEMORY_EMBED_MODEL: "embed-real" },
      embedder: async () => [0.5, 0.5, 0.5],
    });
    expect(healthy).toMatchObject({
      configured: true,
      ok: true,
      dimensions: 3,
    });

    const failed = await configuredMemoryEmbedderHealth({
      force: true,
      maxAgeMs: 0,
      env: { MEMORY_EMBED_MODEL: "embed-real" },
      embedder: async () => {
        throw new Error("private upstream response");
      },
    });
    expect(failed).toMatchObject({ configured: true, ok: false });
    expect(JSON.stringify(failed)).not.toContain("private upstream response");
  });

  it("bounds remote embedding probes and sends the configured vector dimensions", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: [{ embedding: [3, 4] }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const embed = openaiEmbedder({
      MEMORY_EMBED_MODEL: "embed-real",
      MEMORY_EMBED_BASE_URL: "https://embedding.invalid/v1/",
      MEMORY_EMBED_API_KEY: "private-embedding-key",
      MEMORY_EMBED_DIMENSIONS: "256",
      MEMORY_EMBED_TIMEOUT_MS: "1200",
    });
    await expect(embed?.("readiness")).resolves.toEqual(
      Float32Array.from([0.6, 0.8]),
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "embed-real",
      dimensions: 256,
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(() =>
      openaiEmbedder({
        MEMORY_EMBED_MODEL: "embed-real",
        MEMORY_EMBED_BASE_URL: "https://embedding.invalid/v1",
        MEMORY_EMBED_TIMEOUT_MS: "never",
      }),
    ).toThrow(/MEMORY_EMBED_TIMEOUT_MS/);
  });
});
