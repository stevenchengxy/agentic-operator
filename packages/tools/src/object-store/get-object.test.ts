import { describe, expect, it, vi } from "vitest";
import {
  getObjectFromStore,
  signObjectStoreGet,
  validateObjectStoreBucket,
  validateObjectStoreKey,
} from "./get-object";

const env = {
  STORE_ACCESS: "access-123",
  STORE_SECRET: "super-secret-value",
};

const config = {
  endpoint: "https://objects.example.test",
  access_key_env: "STORE_ACCESS",
  secret_key_env: "STORE_SECRET",
  region: "eu-west-1",
  max_bytes: 1024,
};

describe("objectStore.getObject", () => {
  it("signs and returns bounded object bytes with hash and mime", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response("hello", {
          status: 200,
          headers: {
            "content-type": "text/plain; charset=utf-8",
            etag: '"abc"',
            "last-modified": "Mon, 13 Jul 2026 08:00:00 GMT",
          },
        }),
    );
    const result = await getObjectFromStore(
      { bucket: "documents", object_key: "incoming/hello world.txt" },
      config,
      {
        env,
        fetchImpl,
        now: () => new Date("2026-07-13T08:00:00.000Z"),
      },
    );

    expect(result).toEqual({
      bucket: "documents",
      object_key: "incoming/hello world.txt",
      filename: "hello world.txt",
      mime: "text/plain",
      base64: "aGVsbG8=",
      sha256:
        "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
      bytes: 5,
      etag: '"abc"',
      last_modified: "Mon, 13 Jul 2026 08:00:00 GMT",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchImpl.mock.calls[0]!;
    expect(String(requestUrl)).toBe(
      "https://objects.example.test/documents/incoming/hello%20world.txt",
    );
    expect(init?.redirect).toBe("manual");
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=access-123\//,
    );
    expect(headers.authorization).not.toContain(env.STORE_SECRET);
  });

  it("never accepts endpoint or credentials from the tool-call payload", async () => {
    const fetchImpl = vi.fn();
    await expect(
      getObjectFromStore(
        {
          bucket: "documents",
          object_key: "a.txt",
          endpoint: "https://attacker.example",
        },
        config,
        { env, fetchImpl },
      ),
    ).rejects.toThrow(/does not accept 'endpoint'/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("enforces bucket/key validation and configured bucket boundaries", async () => {
    expect(() => validateObjectStoreBucket("../bad")).toThrow(/bucket/);
    expect(() => validateObjectStoreKey("safe/../secret")).toThrow(/traversal/);
    await expect(
      getObjectFromStore(
        { bucket: "other-bucket", object_key: "safe/a.txt" },
        { ...config, default_bucket: "fixed-bucket" },
        { env, fetchImpl: vi.fn() },
      ),
    ).rejects.toThrow(/cannot override/);
  });

  it("fails closed when content-length or streamed bytes exceed max_bytes", async () => {
    await expect(
      getObjectFromStore(
        { bucket: "documents", object_key: "large.bin" },
        { ...config, max_bytes: 4 },
        {
          env,
          fetchImpl: async () =>
            new Response("hello", {
              status: 200,
              headers: { "content-length": "5" },
            }),
        },
      ),
    ).rejects.toThrow(/exceeds/);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("hello"));
        controller.close();
      },
    });
    await expect(
      getObjectFromStore(
        { bucket: "documents", object_key: "large.bin" },
        { ...config, max_bytes: 4 },
        { env, fetchImpl: async () => new Response(stream, { status: 200 }) },
      ),
    ).rejects.toThrow(/exceeded/);
  });

  it("produces a stable SigV4 signature for a fixed time", () => {
    const signed = signObjectStoreGet({
      host: "objects.example.test",
      canonicalPath: "/documents/a.txt",
      region: "us-east-1",
      accessKey: "AKIDEXAMPLE",
      secretKey: "secret",
      now: new Date("2026-07-13T08:00:00.000Z"),
    });
    expect(signed["x-amz-date"]).toBe("20260713T080000Z");
    expect(signed.authorization).toMatch(
      /Credential=AKIDEXAMPLE\/20260713\/us-east-1\/s3\/aws4_request/,
    );
    expect(signed.authorization).not.toContain("secret");
  });
});
