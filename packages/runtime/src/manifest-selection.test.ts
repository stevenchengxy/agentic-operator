import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadManifestFromDisk } from "./manifest";

const dirs: string[] = [];

function manifest(id: string) {
  return [
    {
      id,
      name: id,
      actor: ["Agent"],
      trigger: [`${id}.requested`],
      actions: [],
      triggered_event: [`${id}.completed`],
    },
  ];
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("manifest numeric head selection", () => {
  it("prefers a versioned workflow over the legacy bare workflow", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "manifest-head-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "workflow.json"), JSON.stringify(manifest("bare")));
    await writeFile(path.join(dir, "workflow_v2.json"), JSON.stringify(manifest("v2")));

    const loaded = await loadManifestFromDisk(dir);

    expect(path.basename(loaded.manifestPath)).toBe("workflow_v2.json");
    expect(loaded.manifest[0]?.id).toBe("v2");
  });

  it("orders v10 after v9 numerically so a rollback head survives restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "manifest-head-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "workflow_v9.json"), JSON.stringify(manifest("v9")));
    await writeFile(path.join(dir, "workflow_v10.json"), JSON.stringify(manifest("v10")));

    const firstBoot = await loadManifestFromDisk(dir);
    const restartedBoot = await loadManifestFromDisk(dir);

    expect(path.basename(firstBoot.manifestPath)).toBe("workflow_v10.json");
    expect(restartedBoot.manifest[0]?.id).toBe("v10");
  });
});

