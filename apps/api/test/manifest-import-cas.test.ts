import { randomUUID } from "node:crypto";

import {
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ManifestImportConcurrencyConflictError,
  __test,
} from "../src/services/manifest-import";
import { buildTestEnv } from "./harness";

describe("manifest import live-lane compare-and-swap", () => {
  const suffix = randomUUID();
  const tenantId = `ten-cas-${suffix}`;
  const tenantSlug = `cas-${suffix}`;
  const workflowId = `wf-cas-${suffix}`;
  const firstVersionId = `wfv-cas-a-${suffix}`;
  const winnerVersionId = `wfv-cas-b-${suffix}`;
  const firstDeploymentId = `dpl-cas-a-${suffix}`;
  const winnerDeploymentId = `dpl-cas-b-${suffix}`;
  const ctx = { tenantId, tenantSlug };

  beforeAll(async () => {
    await buildTestEnv();
    const db = getDb();
    db.insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: "CAS tenant" })
      .run();
    db.insert(workflows)
      .values({
        id: workflowId,
        tenantId,
        slug: `${tenantSlug}-default`,
        name: "CAS workflow",
      })
      .run();
    db.insert(workflowVersions)
      .values({
        id: firstVersionId,
        workflowId,
        version: `auto-${"a".repeat(64)}`,
        manifestJson: [],
        actionsJson: [],
      })
      .run();
    db.insert(deployments)
      .values({
        id: firstDeploymentId,
        tenantId,
        target: "workflow",
        versionId: firstVersionId,
        status: "live",
      })
      .run();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("rejects a stale phase-3 baseline and refuses to compensate over its winner", () => {
    const db = getDb();
    const preimage = __test.captureManifestImportPreimage(ctx);

    db.transaction(() => {
      db.update(deployments)
        .set({ status: "rolled_back" })
        .where(eq(deployments.id, firstDeploymentId))
        .run();
      db.insert(workflowVersions)
        .values({
          id: winnerVersionId,
          workflowId,
          version: `auto-${"b".repeat(64)}`,
          manifestJson: [],
          actionsJson: [{ winner: true }],
        })
        .run();
      db.insert(deployments)
        .values({
          id: winnerDeploymentId,
          tenantId,
          target: "workflow",
          versionId: winnerVersionId,
          status: "live",
        })
        .run();
    });

    expect(() => __test.assertLiveDeploymentBaseline(ctx, preimage.deployments))
      .toThrow(ManifestImportConcurrencyConflictError);
    expect(() =>
      __test.restoreManifestImportPreimage({
        ctx,
        preimage,
        failedWorkflowId: workflowId,
        failedDeploymentId: firstDeploymentId,
      }),
    ).toThrow(/no longer owns the live lane/);

    const live = db
      .select()
      .from(deployments)
      .where(
        and(
          eq(deployments.tenantId, tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: winnerDeploymentId,
      versionId: winnerVersionId,
      status: "live",
    });
  });
});
