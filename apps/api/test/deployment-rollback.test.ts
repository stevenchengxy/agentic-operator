import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  deployments,
  getDb,
  operationLeases,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import {
  canonicalWorkflowVersionId,
  legacyWorkflowVersionId,
  loadManifestFromDisk,
  resolveLiveVersion,
  WorkflowManifestSchema,
} from "@agentic/runtime";
import {
  DeploymentRollbackAlreadyLiveError,
  DeploymentRollbackPendingImportError,
  rollbackDeployment,
  withTenantRollbackLock,
} from "../src/services/deployment-rollback";
import { tenantRuntimeMutationResourceKey } from "../src/services/tenant-runtime-mutation";

function verifiedRegistration(slug: string, expectedFunctionCount = 1) {
  return {
    slug,
    appId: `tenant-${slug}`,
    expectedFunctionCount,
    observedFunctionCount: expectedFunctionCount,
    connected: true,
    verified: true,
    evidence: "test_only_bypass" as const,
    checkedAt: new Date().toISOString(),
  };
}

function workflow(id: string) {
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

function workflowVersion(
  id: string,
  actions: ReadonlyArray<Record<string, unknown>> = [],
): string {
  const parsed = WorkflowManifestSchema.parse(workflow(id));
  return canonicalWorkflowVersionId(parsed, actions);
}

describe("durable deployment rollback", () => {
  let root = "";
  let modelDir = "";
  let tenantId = "";
  let tenantSlug = "";
  let workflowId = "";
  let oldVersionId = "";
  let currentVersionId = "";
  let oldDeploymentId = "";
  let currentDeploymentId = "";

  beforeEach(async () => {
    const suffix = randomUUID().slice(0, 8);
    tenantId = `ten-rb-${suffix}`;
    tenantSlug = `rollback-${suffix}`;
    workflowId = `wf-rb-${suffix}`;
    oldVersionId = `wfv-rb-old-${suffix}`;
    currentVersionId = `wfv-rb-new-${suffix}`;
    oldDeploymentId = `dpl-rb-old-${suffix}`;
    currentDeploymentId = `dpl-rb-new-${suffix}`;

    root = await mkdtemp(path.join(os.tmpdir(), "deployment-rollback-"));
    modelDir = path.join(root, `${tenantSlug}-v1`);
    await mkdir(modelDir, { recursive: true });
    await writeFile(
      path.join(modelDir, "workflow_v9.json"),
      JSON.stringify(workflow("current")),
    );

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
      .values([
        {
          id: oldVersionId,
          workflowId,
          version: workflowVersion("historical"),
          manifestJson: workflow("historical"),
        },
        {
          id: currentVersionId,
          workflowId,
          version: workflowVersion("current"),
          manifestJson: workflow("current"),
        },
      ])
      .run();
    db.insert(deployments)
      .values([
        {
          id: oldDeploymentId,
          tenantId,
          target: "workflow",
          versionId: oldVersionId,
          status: "rolled_back",
        },
        {
          id: currentDeploymentId,
          tenantId,
          target: "workflow",
          versionId: currentVersionId,
          status: "live",
        },
      ])
      .run();
  });

  afterEach(async () => {
    const db = getDb();
    db.delete(deployments).where(eq(deployments.tenantId, tenantId)).run();
    const tenantWorkflows = db
      .select()
      .from(workflows)
      .where(eq(workflows.tenantId, tenantId))
      .all();
    for (const row of tenantWorkflows) {
      db.delete(workflowVersions)
        .where(eq(workflowVersions.workflowId, row.id))
        .run();
    }
    db.delete(workflows).where(eq(workflows.tenantId, tenantId)).run();
    db.delete(tenants).where(eq(tenants.id, tenantId)).run();
    await rm(root, { recursive: true, force: true });
  });

  it("hot-swaps the target manifest and a restarted loader selects the same new head", async () => {
    const observed: string[] = [];
    const result = await rollbackDeployment(
      { deploymentId: oldDeploymentId, tenantId, tenantSlug },
      {
        modelsRoot: () => root,
        reregister: async () => {
          const loaded = await loadManifestFromDisk(modelDir);
          observed.push(loaded.manifest[0]!.id);
          return { fnCount: 1, appFnCount: 1, scope: "tenant" };
        },
        verify: async (slug, expected) => verifiedRegistration(slug, expected),
      },
    );

    expect(observed).toEqual(["historical"]);
    expect(path.basename(result.fileWritten!)).toBe("workflow_v10.json");
    expect(path.basename(result.actionsFileWritten!)).toBe("actions_v10.json");
    expect(result.inngestFunctions).toBe(1);

    const db = getDb();
    expect(
      db
        .select()
        .from(deployments)
        .where(eq(deployments.id, oldDeploymentId))
        .all()[0]?.status,
    ).toBe("live");
    expect(
      db
        .select()
        .from(deployments)
        .where(eq(deployments.id, currentDeploymentId))
        .all()[0]?.status,
    ).toBe("rolled_back");

    // A fresh disk load models a process restart; it must execute the same
    // historical manifest without consulting any in-memory pointer.
    const restarted = await loadManifestFromDisk(modelDir);
    expect(path.basename(restarted.manifestPath)).toBe("workflow_v10.json");
    expect(restarted.manifest[0]?.id).toBe("historical");
  });

  it("accepts an exact legacy short workflow identity for historical rollback", async () => {
    const parsed = WorkflowManifestSchema.parse(workflow("historical"));
    getDb()
      .update(workflowVersions)
      .set({ version: legacyWorkflowVersionId(parsed) })
      .where(eq(workflowVersions.id, oldVersionId))
      .run();

    const result = await rollbackDeployment(
      { deploymentId: oldDeploymentId, tenantId, tenantSlug },
      {
        modelsRoot: () => root,
        reregister: async () => ({
          fnCount: 1,
          appFnCount: 1,
          scope: "tenant",
        }),
        verify: async (slug, expected) => verifiedRegistration(slug, expected),
      },
    );

    expect(result.version).toBe(legacyWorkflowVersionId(parsed));
    expect((await loadManifestFromDisk(modelDir)).manifest[0]?.id).toBe(
      "historical",
    );
  });

  it("publishes the historical actions with the same version as the workflow", async () => {
    const historicalActions = [{ name: "historical-action", mode: "old" }];
    const currentActions = [{ name: "current-action", mode: "new" }];
    const historicalManifest = WorkflowManifestSchema.parse(
      workflow("historical"),
    );
    const currentManifest = WorkflowManifestSchema.parse(workflow("current"));
    const db = getDb();
    db.update(workflowVersions)
      .set({
        version: canonicalWorkflowVersionId(
          historicalManifest,
          historicalActions,
        ),
        actionsJson: historicalActions,
      })
      .where(eq(workflowVersions.id, oldVersionId))
      .run();
    db.update(workflowVersions)
      .set({
        version: canonicalWorkflowVersionId(currentManifest, currentActions),
        actionsJson: currentActions,
      })
      .where(eq(workflowVersions.id, currentVersionId))
      .run();
    await writeFile(
      path.join(modelDir, "actions_v9.json"),
      JSON.stringify(currentActions),
    );

    const result = await rollbackDeployment(
      { deploymentId: oldDeploymentId, tenantId, tenantSlug },
      {
        modelsRoot: () => root,
        reregister: async () => ({
          fnCount: 1,
          appFnCount: 1,
          scope: "tenant",
        }),
        verify: async (slug, expected) => verifiedRegistration(slug, expected),
      },
    );

    expect(path.basename(result.fileWritten!)).toBe("workflow_v10.json");
    expect(path.basename(result.actionsFileWritten!)).toBe("actions_v10.json");
    const restarted = await loadManifestFromDisk(modelDir);
    expect(restarted.manifest[0]?.id).toBe("historical");
    expect(restarted.actionsExt).toEqual(historicalActions);
  });

  it("rejects a rollback request for the already-live deployment without writing a head", async () => {
    await expect(
      rollbackDeployment(
        { deploymentId: currentDeploymentId, tenantId, tenantSlug },
        { modelsRoot: () => root },
      ),
    ).rejects.toMatchObject<DeploymentRollbackAlreadyLiveError>({
      deploymentId: currentDeploymentId,
      statusCode: 409,
    });
    const restarted = await loadManifestFromDisk(modelDir);
    expect(path.basename(restarted.manifestPath)).toBe("workflow_v9.json");
  });

  it("restores both disk and DB last-good state when the hot swap fails", async () => {
    const observed: string[] = [];
    let calls = 0;

    await expect(
      rollbackDeployment(
        { deploymentId: oldDeploymentId, tenantId, tenantSlug },
        {
          modelsRoot: () => root,
          reregister: async () => {
            calls += 1;
            if (calls === 1) throw new Error("synthetic swap failure");
            const loaded = await loadManifestFromDisk(modelDir);
            observed.push(loaded.manifest[0]!.id);
            return { fnCount: 1, appFnCount: 1, scope: "tenant" };
          },
          verify: async (slug, expected) =>
            verifiedRegistration(slug, expected),
        },
      ),
    ).rejects.toThrow("synthetic swap failure");

    expect(calls).toBe(2);
    expect(observed).toEqual(["current"]);
    const restarted = await loadManifestFromDisk(modelDir);
    expect(restarted.manifest[0]?.id).toBe("current");

    const db = getDb();
    expect(
      db
        .select()
        .from(deployments)
        .where(eq(deployments.id, oldDeploymentId))
        .all()[0]?.status,
    ).toBe("rolled_back");
    expect(
      db
        .select()
        .from(deployments)
        .where(eq(deployments.id, currentDeploymentId))
        .all()[0]?.status,
    ).toBe("live");
  });

  it("CAS-restores last-good state when the durable lease is lost after DB activation", async () => {
    let registerCalls = 0;
    await expect(
      rollbackDeployment(
        { deploymentId: oldDeploymentId, tenantId, tenantSlug },
        {
          modelsRoot: () => root,
          reregister: async () => {
            registerCalls += 1;
            if (registerCalls === 1) {
              getDb()
                .delete(operationLeases)
                .where(
                  eq(
                    operationLeases.resourceKey,
                    tenantRuntimeMutationResourceKey(tenantId),
                  ),
                )
                .run();
            }
            return { fnCount: 1, appFnCount: 1, scope: "tenant" };
          },
          verify: async (slug, expected) =>
            verifiedRegistration(slug, expected),
        },
      ),
    ).rejects.toThrow("operation lease ownership was lost");

    expect(registerCalls).toBe(2);
    expect(
      getDb()
        .select()
        .from(deployments)
        .where(eq(deployments.id, currentDeploymentId))
        .all()[0]?.status,
    ).toBe("live");
    const restarted = await loadManifestFromDisk(modelDir);
    expect(path.basename(restarted.manifestPath)).toBe("workflow_v9.json");
    expect(restarted.manifest[0]?.id).toBe("current");
  });

  it.each([
    {
      label: "the broker has not converged",
      connected: false,
      observedFunctionCount: null,
    },
    {
      label: "the broker reports the wrong function count",
      connected: true,
      observedFunctionCount: 0,
    },
  ])(
    "compensates a sync-accepted rollback when $label",
    async ({ connected, observedFunctionCount }) => {
      let registerCalls = 0;
      let syncCalls = 0;
      let verifyCalls = 0;

      await expect(
        rollbackDeployment(
          { deploymentId: oldDeploymentId, tenantId, tenantSlug },
          {
            modelsRoot: () => root,
            reregister: async () => {
              registerCalls += 1;
              return { fnCount: 1, appFnCount: 1, scope: "tenant" };
            },
            sync: async (slug) => {
              syncCalls += 1;
              return {
                slug,
                appId: `tenant-${slug}`,
                url: `http://api.test/inngest/${slug}`,
                ok: true,
              };
            },
            verify: async (slug, expected) => {
              verifyCalls += 1;
              if (verifyCalls > 1) {
                return verifiedRegistration(slug, expected);
              }
              return {
                slug,
                appId: `tenant-${slug}`,
                expectedFunctionCount: expected ?? 1,
                observedFunctionCount,
                connected,
                verified: false,
                evidence: "dev_graphql" as const,
                checkedAt: new Date().toISOString(),
                error: "synthetic broker convergence mismatch",
              };
            },
          },
        ),
      ).rejects.toThrow("rollback activation was not verified");

      expect(registerCalls).toBe(2);
      expect(syncCalls).toBe(2);
      expect(verifyCalls).toBe(2);
      expect(
        getDb()
          .select()
          .from(deployments)
          .where(eq(deployments.id, currentDeploymentId))
          .all()[0]?.status,
      ).toBe("live");
      expect((await loadManifestFromDisk(modelDir)).manifest[0]?.id).toBe(
        "current",
      );
    },
  );

  it("refuses rollback while a manifest import is pending", async () => {
    const pendingDeploymentId = `dpl-rb-pending-${randomUUID().slice(0, 8)}`;
    getDb()
      .insert(deployments)
      .values({
        id: pendingDeploymentId,
        tenantId,
        target: "workflow",
        versionId: oldVersionId,
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .run();

    await expect(
      rollbackDeployment(
        { deploymentId: oldDeploymentId, tenantId, tenantSlug },
        { modelsRoot: () => root },
      ),
    ).rejects.toMatchObject<DeploymentRollbackPendingImportError>({
      deploymentId: pendingDeploymentId,
      statusCode: 409,
    });
    expect((await loadManifestFromDisk(modelDir)).manifest[0]?.id).toBe(
      "current",
    );
  });

  it("uses the live deployment generation as a CAS and preserves a bypassing writer", async () => {
    let concurrentDeployedAt: Date | null = null;
    await expect(
      rollbackDeployment(
        { deploymentId: oldDeploymentId, tenantId, tenantSlug },
        {
          modelsRoot: () => {
            const db = getDb();
            const current = db
              .select()
              .from(deployments)
              .where(eq(deployments.id, currentDeploymentId))
              .all()[0]!;
            concurrentDeployedAt = new Date(
              current.deployedAt.getTime() + 1_000,
            );
            db.update(deployments)
              .set({ deployedAt: concurrentDeployedAt })
              .where(eq(deployments.id, currentDeploymentId))
              .run();
            return root;
          },
        },
      ),
    ).rejects.toThrow("live workflow deployment changed");

    const current = getDb()
      .select()
      .from(deployments)
      .where(eq(deployments.id, currentDeploymentId))
      .all()[0]!;
    expect(current.status).toBe("live");
    expect(current.deployedAt.getTime()).toBe(concurrentDeployedAt!.getTime());
    const restarted = await loadManifestFromDisk(modelDir);
    expect(path.basename(restarted.manifestPath)).toBe("workflow_v9.json");
    expect(restarted.manifest[0]?.id).toBe("current");
  });

  it("serializes rollback mutations for the same tenant", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const run = (name: string) =>
      withTenantRollbackLock(tenantId, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        order.push(`${name}:start`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        order.push(`${name}:end`);
        active -= 1;
      });

    await Promise.all([run("a"), run("b"), run("c")]);

    expect(maxActive).toBe(1);
    expect(order).toHaveLength(6);
    for (const name of ["a", "b", "c"]) {
      expect(order.indexOf(`${name}:start`)).toBeLessThan(
        order.indexOf(`${name}:end`),
      );
    }
  });

  it("switches tenant-code selection immediately and remains selected after restart", async () => {
    const codeWorkflowId = `${workflowId}-code`;
    const oldCodeVersionId = `${oldVersionId}-code`;
    const newCodeVersionId = `${currentVersionId}-code`;
    const oldCodeDeploymentId = `${oldDeploymentId}-code`;
    const newCodeDeploymentId = `${currentDeploymentId}-code`;
    const codeRoot = path.join(root, "tenant-code");
    const priorTenantRoot = process.env.AGENTIC_TENANTS_DIR;
    process.env.AGENTIC_TENANTS_DIR = codeRoot;
    try {
      for (const value of ["1.0.0", "2.0.0"]) {
        const dir = path.join(codeRoot, tenantSlug, value);
        await mkdir(dir, { recursive: true });
        await writeFile(
          path.join(dir, "agentic.json"),
          JSON.stringify({ slug: tenantSlug, schemaVersion: 1 }),
        );
      }

      const db = getDb();
      db.insert(workflows)
        .values({
          id: codeWorkflowId,
          tenantId,
          slug: "__tenant_code__",
          name: `${tenantSlug} code`,
        })
        .run();
      db.insert(workflowVersions)
        .values([
          {
            id: oldCodeVersionId,
            workflowId: codeWorkflowId,
            version: "1.0.0",
            manifestJson: {
              kind: "tenant_code",
              slug: tenantSlug,
              version: "1.0.0",
            },
          },
          {
            id: newCodeVersionId,
            workflowId: codeWorkflowId,
            version: "2.0.0",
            manifestJson: {
              kind: "tenant_code",
              slug: tenantSlug,
              version: "2.0.0",
            },
          },
        ])
        .run();
      db.insert(deployments)
        .values([
          {
            id: oldCodeDeploymentId,
            tenantId,
            target: "tenant_code",
            versionId: oldCodeVersionId,
            status: "rolled_back",
          },
          {
            id: newCodeDeploymentId,
            tenantId,
            target: "tenant_code",
            versionId: newCodeVersionId,
            status: "live",
          },
        ])
        .run();

      const observed: Array<string | null> = [];
      await rollbackDeployment(
        { deploymentId: oldCodeDeploymentId, tenantId, tenantSlug },
        {
          reregister: async () => {
            observed.push(await resolveLiveVersion(tenantSlug));
            return { fnCount: 1, appFnCount: 1, scope: "tenant" };
          },
          verify: async (slug, expected) =>
            verifiedRegistration(slug, expected),
        },
      );

      expect(observed).toEqual(["1.0.0"]);
      expect(await resolveLiveVersion(tenantSlug)).toBe("1.0.0");
    } finally {
      if (priorTenantRoot === undefined) delete process.env.AGENTIC_TENANTS_DIR;
      else process.env.AGENTIC_TENANTS_DIR = priorTenantRoot;
    }
  });
});
