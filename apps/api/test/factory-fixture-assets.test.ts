import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { FACTORY_TEST_FIXTURE_ASSET_SCHEMA } from "@agentic/agent-factory";

import { registerEnvelope } from "../src/plugins/error";
import { registerFactoryFixtureAssetRoutes } from "../src/routes/v1/agent-factory-fixture-assets";
import {
  FACTORY_FIXTURE_ASSET_MAX_BYTES,
  FactoryFixtureAssetError,
  FsFactoryFixtureAssetStore,
  type FactoryFixtureAssetScope,
} from "../src/services/agent-factory/fixture-asset-store";
import {
  containsFactoryFixtureAssetReference,
  materializeFactoryFixturePayload,
} from "../src/services/agent-factory/fixture-materializer";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "factory-fixtures-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

const scope = (
  tenantId = "ten-a",
  domain = "Agents-generation",
  conversationId = "run-a",
): FactoryFixtureAssetScope => ({ tenantId, domain, conversationId });

async function walk(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      found.push(target);
      if (entry.isDirectory()) await visit(target);
    }
  };
  await visit(root);
  return found;
}

describe("FsFactoryFixtureAssetStore", () => {
  it("persists 0600 content under 0700 scope directories and only resolves the exact scope", async () => {
    const root = await temporaryRoot();
    const store = new FsFactoryFixtureAssetStore({ root, ttlSeconds: 60 });
    const original = Buffer.from("private resume fixture", "utf8");
    const base64 = original.toString("base64");
    const uploaded = await store.put(scope(), {
      caseId: "resume-pdf",
      path: "/resume/file",
      base64,
      mimeType: "application/pdf",
      filename: "candidate.pdf",
    });

    expect(uploaded).toEqual({
      assetId: expect.stringMatching(/^ffa-[0-9a-f]{32}$/),
      sha256: createHash("sha256").update(original).digest("hex"),
      bytes: original.length,
      mimeType: "application/pdf",
      filename: "candidate.pdf",
      expiresAt: expect.any(String),
    });
    expect(await store.read(scope(), uploaded.assetId)).toMatchObject({
      ...uploaded,
      caseId: "resume-pdf",
      path: "/resume/file",
      base64,
    });

    await expect(
      store.inspect(scope("ten-b"), uploaded.assetId),
    ).resolves.toBeNull();
    await expect(
      store.inspect(scope("ten-a", "Other-domain"), uploaded.assetId),
    ).resolves.toBeNull();
    await expect(
      store.inspect(
        scope("ten-a", "Agents-generation", "run-other"),
        uploaded.assetId,
      ),
    ).resolves.toBeNull();
    await expect(store.delete(scope("ten-b"), uploaded.assetId)).resolves.toBe(
      false,
    );
    await expect(store.inspect(scope(), uploaded.assetId)).resolves.toEqual(
      uploaded,
    );

    const files = await walk(root);
    const contentFile = files.find((file) => file.endsWith(".bin"));
    const metadataFile = files.find((file) => file.endsWith(".json"));
    expect(contentFile).toBeTruthy();
    expect(metadataFile).toBeTruthy();
    expect((await fs.stat(contentFile!)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(metadataFile!)).mode & 0o777).toBe(0o600);
    for (const directory of [
      root,
      ...files.filter((file) => !/\.(?:bin|json)$/.test(file)),
    ]) {
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(await fs.readFile(metadataFile!, "utf8")).not.toContain(base64);
  });

  it("fails closed on non-canonical base64, hash drift, oversized data, and path traversal", async () => {
    const root = await temporaryRoot();
    const store = new FsFactoryFixtureAssetStore({
      root,
    });
    const input = {
      caseId: "case-1",
      path: "/resume/file",
      base64: Buffer.from("fixture").toString("base64"),
    };

    await expect(
      store.put(scope(), { ...input, base64: " Zml4dHVyZQ==" }),
    ).rejects.toMatchObject({ code: "invalid_fixture_base64" });
    await expect(
      store.put(scope(), { ...input, base64: "" }),
    ).rejects.toMatchObject({ code: "invalid_fixture_base64" });
    await expect(
      store.put(scope(), { ...input, sha256: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "fixture_hash_mismatch" });
    await expect(
      store.put(scope(), {
        ...input,
        base64: Buffer.alloc(FACTORY_FIXTURE_ASSET_MAX_BYTES + 1).toString(
          "base64",
        ),
      }),
    ).rejects.toMatchObject({ code: "fixture_too_large" });
    await expect(
      store.put(scope(), { ...input, filename: "../candidate.pdf" }),
    ).rejects.toMatchObject({ code: "invalid_fixture_filename" });
    await expect(
      store.put(scope(), { ...input, path: "/__proto__/polluted" }),
    ).rejects.toMatchObject({ code: "invalid_fixture_path" });
    await expect(store.inspect(scope(), "../../secret")).rejects.toBeInstanceOf(
      FactoryFixtureAssetError,
    );
    expect(await walk(root)).toEqual([]);
  });

  it("expires and deletes both metadata and content", async () => {
    const root = await temporaryRoot();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new FsFactoryFixtureAssetStore({
      root,
      ttlSeconds: 2,
      now: () => now,
    });
    const uploaded = await store.put(scope(), {
      caseId: "case-1",
      path: "/file",
      base64: Buffer.from("expires").toString("base64"),
    });
    expect(await store.inspect(scope(), uploaded.assetId)).toEqual(uploaded);
    now = new Date("2026-01-01T00:00:02.000Z");
    expect(await store.inspect(scope(), uploaded.assetId)).toBeNull();
    expect(
      (await walk(root)).filter((file) => /\.(?:bin|json)$/.test(file)),
    ).toEqual([]);
  });

  it("checks export evidence without mutating expired production assets", async () => {
    const root = await temporaryRoot();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new FsFactoryFixtureAssetStore({
      root,
      ttlSeconds: 2,
      now: () => now,
    });
    const uploaded = await store.put(scope(), {
      caseId: "case-export",
      path: "/file",
      base64: Buffer.from("export-only").toString("base64"),
    });
    const evidenceFiles = () =>
      walk(root).then((files) =>
        files.filter((file) => /\.(?:bin|json)$/.test(file)),
      );
    expect(await evidenceFiles()).toHaveLength(2);

    now = new Date("2026-01-01T00:00:02.000Z");
    expect(
      await store.readForEvidenceExport(scope(), uploaded.assetId),
    ).toBeNull();
    expect(await evidenceFiles()).toHaveLength(2);
  });

  it("materializes approved descriptors only for the exact tenant/domain/conversation/case/path/hash", async () => {
    const root = await temporaryRoot();
    const store = new FsFactoryFixtureAssetStore({ root, ttlSeconds: 60 });
    const binary = Buffer.from("server-memory-only", "utf8");
    const base64 = binary.toString("base64");
    const putAt = (jsonPointer: string, filename: string) =>
      store.put(scope(), {
        caseId: "case-asset",
        path: jsonPointer,
        base64,
        mimeType: "application/pdf",
        filename,
      });
    const [raw, dataUrl, object] = await Promise.all([
      putAt("/raw", "raw.pdf"),
      putAt("/nested/data_url", "url.pdf"),
      putAt("/items/0", "object.pdf"),
    ]);
    const binding = (
      metadata: typeof raw,
      as: "base64_string" | "data_url" | "object",
    ) => ({
      schema: FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
      conversationId: "run-a",
      as,
      ...metadata,
    });
    const payload = {
      raw: binding(raw, "base64_string"),
      nested: { data_url: binding(dataUrl, "data_url") },
      items: [binding(object, "object")],
    };
    expect(containsFactoryFixtureAssetReference(payload)).toBe(true);
    await expect(
      materializeFactoryFixturePayload({
        tenantId: "ten-a",
        domain: "Agents-generation",
        conversationId: "run-a",
        caseId: "case-asset",
        payload,
        store,
      }),
    ).resolves.toEqual({
      raw: base64,
      nested: { data_url: `data:application/pdf;base64,${base64}` },
      items: [
        {
          encoding: "base64",
          data: base64,
          sha256: object.sha256,
          bytes: binary.length,
          mime_type: "application/pdf",
          filename: "object.pdf",
        },
      ],
    });

    const exact = {
      tenantId: "ten-a",
      domain: "Agents-generation",
      conversationId: "run-a",
      caseId: "case-asset",
      payload: { raw: binding(raw, "base64_string") },
      store,
    };
    await expect(
      materializeFactoryFixturePayload({ ...exact, tenantId: "ten-b" }),
    ).rejects.toThrow(/tenant\/domain\/conversation scope/);
    await expect(
      materializeFactoryFixturePayload({ ...exact, domain: "Other-domain" }),
    ).rejects.toThrow(/tenant\/domain\/conversation scope/);
    await expect(
      materializeFactoryFixturePayload({
        ...exact,
        conversationId: "run-other",
      }),
    ).rejects.toThrow(/approved conversation/);
    await expect(
      materializeFactoryFixturePayload({ ...exact, caseId: "case-other" }),
    ).rejects.toThrow(/test case and JSON path/);
    await expect(
      materializeFactoryFixturePayload({
        ...exact,
        payload: { moved: binding(raw, "base64_string") },
      }),
    ).rejects.toThrow(/test case and JSON path/);
    await expect(
      materializeFactoryFixturePayload({
        ...exact,
        payload: {
          raw: { ...binding(raw, "base64_string"), sha256: "0".repeat(64) },
        },
      }),
    ).rejects.toThrow(/identity changed/);
    await expect(
      materializeFactoryFixturePayload({
        ...exact,
        payload: {
          raw: {
            ...binding(raw, "base64_string"),
            schema: "agent-factory-test-fixture-asset/v2",
          },
        },
      }),
    ).rejects.toThrow(/unsupported descriptor schema/);
  });

  it("refuses to materialize an expired descriptor", async () => {
    const root = await temporaryRoot();
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = new FsFactoryFixtureAssetStore({
      root,
      ttlSeconds: 1,
      now: () => now,
    });
    const metadata = await store.put(scope(), {
      caseId: "case-expired",
      path: "/file",
      base64: Buffer.from("expired-server-fixture", "utf8").toString("base64"),
    });
    now = new Date("2026-01-01T00:00:01.000Z");
    await expect(
      materializeFactoryFixturePayload({
        tenantId: "ten-a",
        domain: "Agents-generation",
        conversationId: "run-a",
        caseId: "case-expired",
        payload: {
          file: {
            schema: FACTORY_TEST_FIXTURE_ASSET_SCHEMA,
            conversationId: "run-a",
            as: "base64_string",
            ...metadata,
          },
        },
        store,
      }),
    ).rejects.toThrow(/missing, expired, deleted/);
  });
});

describe("Agent Factory fixture asset routes", () => {
  it("derives tenant/domain/conversation scope, never echoes content, and deletes exactly once", async () => {
    const root = await temporaryRoot();
    const store = new FsFactoryFixtureAssetStore({ root });
    const app = Fastify({ logger: false });
    await registerEnvelope(app);
    const auth = {
      userId: "usr-a",
      email: "fixture@example.test",
      name: "Fixture Human",
      platformRole: "superadmin" as const,
      tenantId: "ten-a",
      tenantSlug: "tenant-a",
      role: "admin" as const,
      via: "cookie" as const,
    };
    app.addHook("onRequest", async (req) => {
      req.auth = { ...auth };
    });
    const conversations = new Map([
      [
        "ten-a:run-a",
        { id: "run-a", domain: "Agents-generation", deletedAt: null },
      ],
      [
        "ten-a:run-b",
        { id: "run-b", domain: "Agents-generation", deletedAt: null },
      ],
      [
        "ten-b:run-b",
        { id: "run-b", domain: "Agents-generation", deletedAt: null },
      ],
    ]);
    const guardedDomains: string[] = [];
    await app.register(
      async (v1) => {
        await registerFactoryFixtureAssetRoutes(v1, {
          store,
          loadConversation: (id, tenantId) =>
            conversations.get(`${tenantId}:${id}`) ?? null,
          requireBoundDomain: async (_requestAuth, domain) => {
            guardedDomains.push(domain);
          },
        });
      },
      { prefix: "/v1" },
    );
    await app.ready();

    try {
      const raw = Buffer.from("do-not-echo-this-fixture", "utf8");
      const base64 = raw.toString("base64");
      const uploaded = await app.inject({
        method: "POST",
        url: "/v1/agent-factory/runs/run-a/fixtures",
        payload: {
          caseId: "resume-file",
          path: "/resume/file",
          base64,
          mimeType: "application/pdf",
          filename: "resume.pdf",
          sha256: createHash("sha256").update(raw).digest("hex"),
        },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      expect(uploaded.body).not.toContain(base64);
      expect(uploaded.body).not.toContain("do-not-echo-this-fixture");
      expect(uploaded.json().data).toEqual({
        assetId: expect.stringMatching(/^ffa-/),
        sha256: createHash("sha256").update(raw).digest("hex"),
        bytes: raw.length,
        mimeType: "application/pdf",
        filename: "resume.pdf",
        expiresAt: expect.any(String),
      });
      const assetId = uploaded.json().data.assetId as string;
      expect(guardedDomains).toEqual(["Agents-generation"]);

      const metadata = await app.inject({
        method: "GET",
        url: `/v1/agent-factory/runs/run-a/fixtures/${assetId}`,
      });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.body).not.toContain(base64);
      expect(metadata.json().data).toEqual(uploaded.json().data);

      const otherConversation = await app.inject({
        method: "GET",
        url: `/v1/agent-factory/runs/run-b/fixtures/${assetId}`,
      });
      expect(otherConversation.statusCode).toBe(404);

      auth.tenantId = "ten-b";
      auth.tenantSlug = "tenant-b";
      const otherTenant = await app.inject({
        method: "GET",
        url: `/v1/agent-factory/runs/run-b/fixtures/${assetId}`,
      });
      expect(otherTenant.statusCode).toBe(404);
      auth.tenantId = "ten-a";
      auth.tenantSlug = "tenant-a";

      const deleted = await app.inject({
        method: "DELETE",
        url: `/v1/agent-factory/runs/run-a/fixtures/${assetId}`,
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().data).toEqual({ deleted: true });
      const deletedAgain = await app.inject({
        method: "DELETE",
        url: `/v1/agent-factory/runs/run-a/fixtures/${assetId}`,
      });
      expect(deletedAgain.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("returns bounded hash/size failures without reflecting uploaded base64", async () => {
    const root = await temporaryRoot();
    const app = Fastify({ logger: false });
    await registerEnvelope(app);
    app.addHook("onRequest", async (req) => {
      req.auth = {
        userId: "usr-a",
        email: "fixture@example.test",
        name: "Fixture Human",
        platformRole: "superadmin",
        tenantId: "ten-a",
        tenantSlug: "tenant-a",
        role: "admin",
        via: "cookie",
      };
    });
    await registerFactoryFixtureAssetRoutes(app, {
      store: new FsFactoryFixtureAssetStore({ root }),
      loadConversation: () => ({
        id: "run-a",
        domain: "Agents-generation",
        deletedAt: null,
      }),
      requireBoundDomain: async () => undefined,
    });
    await app.ready();
    try {
      const smallBase64 = Buffer.from("sensitive-small").toString("base64");
      const mismatch = await app.inject({
        method: "POST",
        url: "/agent-factory/runs/run-a/fixtures",
        payload: {
          caseId: "case-1",
          path: "/file",
          base64: smallBase64,
          sha256: "0".repeat(64),
        },
      });
      expect(mismatch.statusCode).toBe(422);
      expect(mismatch.json().error.code).toBe("fixture_hash_mismatch");
      expect(mismatch.body).not.toContain(smallBase64);

      const oversizedBase64 = Buffer.alloc(
        FACTORY_FIXTURE_ASSET_MAX_BYTES + 1,
      ).toString("base64");
      const oversized = await app.inject({
        method: "POST",
        url: "/agent-factory/runs/run-a/fixtures",
        payload: {
          caseId: "case-1",
          path: "/file",
          base64: oversizedBase64,
        },
      });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json().error.code).toBe("fixture_too_large");
      expect(oversized.body.length).toBeLessThan(1_000);
    } finally {
      await app.close();
    }
  });
});
