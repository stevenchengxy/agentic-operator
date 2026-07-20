import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadManifestFromDisk } from "./manifest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("manifest file resolution truth", () => {
  it("selects numeric v10 over v9", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "manifest-truth-"));
    roots.push(root);
    await writeFile(path.join(root, "workflow_v9.json"), "[]", "utf8");
    await writeFile(path.join(root, "workflow_v10.json"), "[]", "utf8");

    const loaded = await loadManifestFromDisk(root);
    expect(loaded.manifestPath).toBe(path.join(root, "workflow_v10.json"));
  });

  it("treats only ENOENT as absence and propagates other directory errors", async () => {
    await expect(loadManifestFromDisk("/dev/null")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });
});
