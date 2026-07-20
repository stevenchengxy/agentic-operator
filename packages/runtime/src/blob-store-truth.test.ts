import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BlobIntegrityError,
  fetchBlobRemote,
  getBlob,
  makeDurableBlobOffloader,
} from "./blob-store";
import {
  resetBlobBackendCache,
  setBlobRemoteBackend,
  type BlobRemoteBackend,
} from "./blob-backend";

let root = "";
let originalDir: string | undefined;

beforeEach(() => {
  originalDir = process.env.AGENTIC_BLOB_DIR;
  root = mkdtempSync(path.join(tmpdir(), "blob-truth-"));
  process.env.AGENTIC_BLOB_DIR = root;
  setBlobRemoteBackend(null);
  resetBlobBackendCache();
});

afterEach(async () => {
  setBlobRemoteBackend(undefined);
  resetBlobBackendCache();
  if (originalDir === undefined) delete process.env.AGENTIC_BLOB_DIR;
  else process.env.AGENTIC_BLOB_DIR = originalDir;
  await rm(root, { recursive: true, force: true });
});

function backend(
  overrides: Partial<BlobRemoteBackend>,
): BlobRemoteBackend {
  return {
    name: "truth-test",
    async put() {},
    async get() {
      return null;
    },
    ...overrides,
  };
}

describe("blob persistence truth", () => {
  it("propagates non-ENOENT local read failures", async () => {
    const hash = "a".repeat(64);
    await mkdir(path.join(root, "aa", hash), { recursive: true });
    expect(() => getBlob(hash)).toThrow();
  });

  it("rejects a corrupt local content-addressed entry", async () => {
    const hash = "b".repeat(64);
    await mkdir(path.join(root, "bb"), { recursive: true });
    await writeFile(path.join(root, "bb", hash), "wrong bytes", "utf8");
    expect(() => getBlob(hash)).toThrow(BlobIntegrityError);
  });

  it("awaits shared-backend persistence and propagates a failed PUT", async () => {
    setBlobRemoteBackend(
      backend({
        async put() {
          throw new Error("remote disk full");
        },
      }),
    );
    const durable = makeDurableBlobOffloader({ thresholdBytes: 1 });
    expect(durable.offload("payload", "large payload")).not.toBeNull();
    await expect(durable.flush()).rejects.toThrow(/remote disk full/);
  });

  it("deduplicates remote PUTs for repeated bytes in one envelope", async () => {
    const put = vi.fn(async () => undefined);
    setBlobRemoteBackend(backend({ put }));
    const durable = makeDurableBlobOffloader({ thresholdBytes: 1 });
    durable.offload("payload", "same payload");
    durable.offload("last_result.payload", "same payload");
    await durable.flush();
    expect(put).toHaveBeenCalledTimes(1);
  });

  it("rejects remote bytes that do not match the requested hash", async () => {
    const expected = createHash("sha256").update("expected").digest("hex");
    setBlobRemoteBackend(backend({ async get() { return "tampered"; } }));
    await expect(fetchBlobRemote(expected)).rejects.toBeInstanceOf(
      BlobIntegrityError,
    );
  });
});
