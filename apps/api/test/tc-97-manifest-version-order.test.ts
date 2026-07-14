import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadManifestFromDisk } from "@agentic/runtime";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function manifest(version: number) {
  return [
    {
      id: `${version}-version-probe`,
      name: `versionProbe${version}`,
      actor: ["Agent"],
      trigger: ["VERSION_PROBE_REQUESTED"],
      actions: [],
      triggered_event: [],
    },
  ];
}

describe("TC-97: versioned manifest selection", () => {
  it("loads the numerically newest workflow file after portal deploys", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "agentic-manifest-order-"));
    await Promise.all(
      [9, 10, 100].map((version) =>
        writeFile(
          path.join(tempDir!, `workflow_v${version}.json`),
          JSON.stringify(manifest(version)),
          "utf8",
        ),
      ),
    );

    const loaded = await loadManifestFromDisk(tempDir);

    expect(path.basename(loaded.manifestPath)).toBe("workflow_v100.json");
    expect(loaded.manifest[0]?.name).toBe("versionProbe100");
  });
});
