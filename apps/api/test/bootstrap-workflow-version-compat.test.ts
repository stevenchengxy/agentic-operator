import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import {
  bootstrapTenant,
  canonicalWorkflowVersionId,
  legacyWorkflowVersionId,
  WorkflowManifestSchema,
} from "@agentic/runtime";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildTestEnv } from "./harness";

function workflow(id: string) {
  return WorkflowManifestSchema.parse([
    {
      id,
      name: id,
      actor: ["Agent"],
      trigger: [`${id}.requested`],
      actions: [],
      triggered_event: [`${id}.completed`],
    },
  ]);
}

describe("runtime bootstrap workflow-version compatibility", () => {
  const roots: string[] = [];
  const tenantIds: string[] = [];

  beforeAll(async () => {
    await buildTestEnv();
  });

  afterEach(async () => {
    const db = getDb();
    for (const tenantId of tenantIds.splice(0)) {
      db.delete(tenants).where(eq(tenants.id, tenantId)).run();
    }
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  async function arrange(storedManifest: ReturnType<typeof workflow>) {
    const suffix = randomUUID().slice(0, 12);
    const tenantId = `ten-version-compat-${suffix}`;
    const tenantSlug = `version-compat-${suffix}`;
    const workflowId = `wf-version-compat-${suffix}`;
    const workflowVersionId = `wfv-version-compat-${suffix}`;
    const deploymentId = `dpl-version-compat-${suffix}`;
    const desiredManifest = workflow("desired-agent");
    const root = await mkdtemp(
      path.join(os.tmpdir(), "bootstrap-version-compat-"),
    );
    roots.push(root);
    tenantIds.push(tenantId);
    const modelDir = path.join(root, `${tenantSlug}-v1`);
    await mkdir(modelDir, { recursive: true });
    await writeFile(
      path.join(modelDir, "workflow.json"),
      `${JSON.stringify(desiredManifest)}\n`,
    );
    await writeFile(path.join(modelDir, "actions.json"), "[]\n");

    const db = getDb();
    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: tenantSlug })
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: `${tenantSlug}-default`,
        name: tenantSlug,
      })
      .run();
    db.insert(workflowVersions)
      .values({
        id: workflowVersionId,
        workflowId,
        // Deliberately use the desired manifest's historical short id. The
        // second test supplies different stored bytes to model a real prefix
        // collision without brute-forcing SHA-256 during the test.
        version: legacyWorkflowVersionId(desiredManifest),
        manifestJson: storedManifest,
        actionsJson: [],
      })
      .run();
    db.insert(deployments)
      .values({
        id: deploymentId,
        tenantId,
        target: "workflow",
        versionId: workflowVersionId,
        status: "live",
      })
      .run();
    return {
      tenantId,
      tenantSlug,
      workflowId,
      workflowVersionId,
      deploymentId,
      modelDir,
      desiredManifest,
    };
  }

  it("reuses an exact legacy short row without redeploying", async () => {
    const arranged = await arrange(workflow("desired-agent"));
    const result = await bootstrapTenant({
      tenantSlug: arranged.tenantSlug,
      modelDir: arranged.modelDir,
    });

    expect(result.workflowVersion.id).toBe(arranged.workflowVersionId);
    expect(result.workflowVersion.version).toBe(
      legacyWorkflowVersionId(arranged.desiredManifest),
    );
    expect(result.deploymentInserted).toBe(false);
    const rows = getDb()
      .select()
      .from(deployments)
      .where(eq(deployments.tenantId, arranged.tenantId))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: arranged.deploymentId,
      status: "live",
    });
  });

  it("never overwrites a colliding legacy row and creates the full id", async () => {
    const storedCollision = workflow("different-stored-agent");
    const arranged = await arrange(storedCollision);
    const result = await bootstrapTenant({
      tenantSlug: arranged.tenantSlug,
      modelDir: arranged.modelDir,
    });

    expect(result.workflowVersion.id).not.toBe(arranged.workflowVersionId);
    expect(result.workflowVersion.version).toBe(
      canonicalWorkflowVersionId(arranged.desiredManifest, []),
    );
    expect(result.deploymentInserted).toBe(true);
    const original = getDb()
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, arranged.workflowVersionId))
      .all()[0]!;
    expect(original.version).toBe(
      legacyWorkflowVersionId(arranged.desiredManifest),
    );
    expect(original.manifestJson).toEqual(storedCollision);
    const live = getDb()
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, arranged.tenantId),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(live).toHaveLength(1);
    expect(live[0]!.versionId).toBe(result.workflowVersion.id);
  });
});
