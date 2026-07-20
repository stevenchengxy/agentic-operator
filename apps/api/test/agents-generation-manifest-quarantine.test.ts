import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  loadManifestFromDisk,
  WorkflowManifestSchema,
} from "@agentic/runtime";
import { describe, expect, it } from "vitest";

import { productionGeneratedAgentImportIssues } from "../src/services/manifest-import";

const modelDir = path.resolve(
  __dirname,
  "../../../models/agents-generation-v1",
);

describe("Agents-generation legacy generated manifest quarantine", () => {
  it("boots the empty quarantine head instead of registering the six stale agents", async () => {
    const loaded = await loadManifestFromDisk(modelDir);

    expect(path.basename(loaded.manifestPath)).toBe("workflow_v2.json");
    expect(loaded.manifest).toEqual([]);
  });

  it("rejects every stale generated declarative agent without promotion evidence", async () => {
    const legacy = WorkflowManifestSchema.parse(
      JSON.parse(
        await readFile(path.join(modelDir, "workflow_v1.json"), "utf8"),
      ),
    );
    const issues = productionGeneratedAgentImportIssues({
      manifest: legacy,
      rawWorkflow: legacy,
      ctx: {
        tenantId: "tenant-agents-generation",
        tenantSlug: "agents-generation",
      },
    });

    expect(legacy).toHaveLength(6);
    expect(issues).toHaveLength(6);
    expect(
      issues.every(
        (issue) =>
          issue.code === "production_generated_agent_promotion_untrusted",
      ),
    ).toBe(true);
  });
});
