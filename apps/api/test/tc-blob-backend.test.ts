import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  sigV4Sign,
  EMPTY_PAYLOAD_SHA256,
  makeS3Backend,
  makeHttpBackend,
  activeBlobBackend,
  setBlobRemoteBackend,
  resetBlobBackendCache,
  putBlob,
  getBlob,
  fetchBlobRemote,
  rehydratePayloadAsync,
  resolveBlobRefAsync,
  type BlobRemoteBackend,
} from "@agentic/runtime";

// #SCALE-BLOB — the pluggable shared blob backend: hand-rolled SigV4, backend selection, and the
// miss→remote→re-cache path that makes multi-instance rehydration actually work.

afterEach(() => {
  setBlobRemoteBackend(undefined); // drop manual override
  resetBlobBackendCache();
});

describe("SigV4 signer", () => {
  it("reproduces the official AWS get-vanilla test vector", () => {
    // aws-sig-v4-test-suite/get-vanilla: GET / on example.amazonaws.com, region us-east-1,
    // service "service", date 20150830T123600Z, well-known demo credentials.
    const headers = sigV4Sign({
      method: "GET",
      host: "example.amazonaws.com",
      path: "/",
      query: "",
      payloadHash: EMPTY_PAYLOAD_SHA256,
      region: "us-east-1",
      service: "service",
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      amzDate: "20150830T123600Z",
    });
    expect(headers.authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, " +
        "SignedHeaders=host;x-amz-date, " +
        "Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
  it("includes x-amz-content-sha256 for the s3 service (S3 requires it signed)", () => {
    const h = sigV4Sign({
      method: "PUT", host: "b.s3.us-east-1.amazonaws.com", path: "/k", payloadHash: EMPTY_PAYLOAD_SHA256,
      region: "us-east-1", service: "s3", accessKeyId: "A", secretAccessKey: "S", amzDate: "20260101T000000Z",
    });
    expect(h["x-amz-content-sha256"]).toBe(EMPTY_PAYLOAD_SHA256);
    expect(h.authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
  });
});

describe("S3 backend request shape", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("virtual-hosted AWS URL + signed headers on put; path-style for a custom endpoint", async () => {
    const seen: Array<{ url: string; method?: string; auth?: string }> = [];
    globalThis.fetch = (async (url: unknown, init?: { method?: string; headers?: Record<string, string> }) => {
      seen.push({ url: String(url), method: init?.method, auth: init?.headers?.authorization });
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const aws = makeS3Backend({ AGENTIC_BLOB_S3_BUCKET: "my-blobs", AGENTIC_BLOB_S3_REGION: "eu-west-1", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" })!;
    await aws.put("abc123", "hello");
    expect(seen[0]!.url).toBe("https://my-blobs.s3.eu-west-1.amazonaws.com/blobs/abc123");
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/eu-west-1\/s3\/aws4_request/);

    const r2 = makeS3Backend({ AGENTIC_BLOB_S3_BUCKET: "b", AGENTIC_BLOB_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com", AGENTIC_BLOB_S3_REGION: "auto", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK", AGENTIC_BLOB_S3_PREFIX: "" })!;
    const got = await r2.get("deadbeef");
    expect(seen[1]!.url).toBe("https://acct.r2.cloudflarestorage.com/b/deadbeef");
    expect(got).toBe("ok");
  });

  it("returns null (not throw) on a non-2xx get", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;
    const b = makeS3Backend({ AGENTIC_BLOB_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S" })!;
    expect(await b.get("missing")).toBeNull();
  });
});

describe("backend selection", () => {
  it("S3 wins over HTTP when both configured; HTTP alone; none → null", () => {
    const both = { AGENTIC_BLOB_S3_BUCKET: "b", AWS_ACCESS_KEY_ID: "A", AWS_SECRET_ACCESS_KEY: "S", AGENTIC_BLOB_HTTP_BASE: "https://x" };
    resetBlobBackendCache();
    expect(activeBlobBackend(both)?.name).toBe("s3");
    resetBlobBackendCache();
    expect(activeBlobBackend({ AGENTIC_BLOB_HTTP_BASE: "https://x/" })?.name).toBe("http");
    resetBlobBackendCache();
    expect(activeBlobBackend({})).toBeNull();
    expect(makeHttpBackend({})).toBeNull();
    expect(makeS3Backend({ AGENTIC_BLOB_S3_BUCKET: "b" })).toBeNull(); // creds missing → inert
  });
});

describe("miss → remote → local re-cache (the multi-instance path)", () => {
  it("fetchBlobRemote pulls from the plugged backend and caches to local fs", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ao-blob-"));
    const prev = process.env.AGENTIC_BLOB_DIR;
    process.env.AGENTIC_BLOB_DIR = dir;
    try {
      const store = new Map<string, string>();
      const fake: BlobRemoteBackend = {
        name: "fake",
        put: async (h, b) => void store.set(h, b),
        get: async (h) => store.get(h) ?? null,
      };
      setBlobRemoteBackend(fake);

      // "instance A" wrote the blob: local put replicates to the shared backend.
      const ref = putBlob("written-on-instance-A");
      expect(getBlob(ref.hash)).toBe("written-on-instance-A");
      await new Promise((r) => setTimeout(r, 5)); // fire-and-forget replication settles
      expect(store.get(ref.hash)).toBe("written-on-instance-A");

      // simulate "instance B": wipe the local copy, keep the shared backend.
      const { rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
      expect(getBlob(ref.hash)).toBeNull(); // local miss
      expect(await fetchBlobRemote(ref.hash)).toBe("written-on-instance-A"); // remote hit
      expect(getBlob(ref.hash)).toBe("written-on-instance-A"); // re-cached locally

      // and the full consume-path resolver (register.ts uses this via rehydratePayloadAsync)
      rmSync(dir, { recursive: true, force: true });
      const payload = { doc: ref, nested: { doc: ref }, plain: 1 };
      const hydrated = await rehydratePayloadAsync(payload as Record<string, unknown>, async (r) => (await resolveBlobRefAsync(r)) ?? r);
      expect(hydrated.doc).toBe("written-on-instance-A");
      expect((hydrated.nested as Record<string, unknown>).doc).toBe("written-on-instance-A");
      expect(hydrated.plain).toBe(1);
    } finally {
      if (prev === undefined) delete process.env.AGENTIC_BLOB_DIR;
      else process.env.AGENTIC_BLOB_DIR = prev;
    }
  });
});

describe("redis fanout wiring", () => {
  it("is inert without REDIS_URL", async () => {
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    try {
      const { wireRedisFanout, fanoutStatus } = await import("../src/services/fanout-redis");
      expect(await wireRedisFanout()).toBe(false);
      expect(fanoutStatus()).toBe("local");
    } finally {
      if (prev !== undefined) process.env.REDIS_URL = prev;
    }
  });
});
