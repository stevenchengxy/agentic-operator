import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentDefinitionV2 } from "@agentic/contracts";
import { loadManifestFromDisk } from "./manifest";

const tempDirs: string[] = [];

after(async () => {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("versioned workflow manifest loading", () => {
  it("retains the legacy shape for bare arrays", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agentic-manifest-v1-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "workflow.json"),
      JSON.stringify([
        {
          id: "legacy",
          name: "legacyAgent",
          actor: ["Agent"],
          trigger: ["RUN"],
          actions: [],
          triggered_event: ["DONE"],
          input_data: { prompt: "Legacy prompt" },
          extension_key: { preserved: true },
        },
      ]),
    );

    const loaded = await loadManifestFromDisk(dir);
    assert.equal(loaded.manifest.length, 1);
    assert.equal("inputs" in loaded.manifest[0]!, false);
    assert.deepEqual(loaded.manifest[0]!.extension_key, { preserved: true });
  });

  it("returns canonical defaults for a v2 envelope", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agentic-manifest-v2-"));
    tempDirs.push(dir);
    await writeFile(
      path.join(dir, "workflow.json"),
      JSON.stringify({
        $schemaVersion: 2,
        agents: [
          {
            id: "studio",
            name: "studioAgent",
            actor: ["Agent"],
            trigger: ["RUN"],
            inputs: [
              {
                id: "prompt",
                kind: "prompt",
                required: true,
                schema: { type: "string" },
              },
            ],
            outputs: [
              {
                id: "result",
                required: true,
                schema: { type: "object" },
              },
            ],
          },
        ],
      }),
    );

    const loaded = await loadManifestFromDisk(dir);
    const agent = loaded.manifest[0]! as AgentDefinitionV2;
    assert.equal("inputs" in agent, true);
    assert.deepEqual(agent.tool_use, []);
    assert.deepEqual(agent.actions, []);
    assert.deepEqual(agent.triggered_event, []);
    assert.equal(agent.output_config?.strict, true);
    assert.equal(agent.output_config?.artifact.filename, "output.json");
  });
});
