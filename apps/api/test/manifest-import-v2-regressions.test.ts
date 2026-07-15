import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { CURRENT_SCHEMA_VERSION, migrate } from "@agentic/runtime";
import { buildTestEnv, type TestEnv } from "./harness";

const suffix = Date.now().toString(36).slice(-8);
const tenant = {
  id: makeId("ten"),
  slug: `mi-v2-${suffix}`,
};
const fixturePath = path.resolve(
  __dirname,
  "fixtures",
  "manifests",
  "happy-v1.json",
);

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string };
}

describe("manifest import v2 and pending-session regressions", () => {
  let env: TestEnv;
  let v1Manifest: unknown[];

  beforeAll(async () => {
    getDb()
      .insert(tenants)
      .values({ id: tenant.id, slug: tenant.slug, name: "Manifest v2 tests" })
      .run();
    v1Manifest = JSON.parse(await readFile(fixturePath, "utf8")) as unknown[];
    env = await buildTestEnv();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, tenant.id)).run();
  });

  it("migrates a legacy bare array through the complete v1-to-v2 chain", () => {
    const result = migrate(v1Manifest);
    expect(result.fromVersion).toBe(1);
    expect(result.toVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBe(2);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatch(/^1->2:/);
    expect(result.payload).toEqual(v1Manifest);
  });

  it("rejects the misleading staging target before creating a pending session", async () => {
    const response = await env.fetch(
      `/v1/tenants/${tenant.slug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.slug,
        },
        body: JSON.stringify({
          mode: "validate",
          target: "staging",
          workflow: v1Manifest,
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(
      getDb()
        .select()
        .from(deployments)
        .where(eq(deployments.tenantId, tenant.id))
        .all(),
    ).toEqual([]);
  });

  it("returns a canonical draft preview without creating workflow or deployment rows", async () => {
    const imported = {
      $schemaVersion: 2,
      extensions: { vendor: { retained: true } },
      agents: v1Manifest,
    };
    const response = await env.fetch(
      `/v1/tenants/${tenant.slug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.slug,
        },
        body: JSON.stringify({
          mode: "validate",
          draft_only: true,
          workflow: imported,
        }),
      },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Envelope<{
      deployment_id?: string;
      workflow_version_id?: string;
      normalized_workflow?: unknown;
      normalized_actions?: unknown[] | null;
    }>;
    expect(body.data?.deployment_id).toBeUndefined();
    expect(body.data?.workflow_version_id).toBeUndefined();
    expect(body.data?.normalized_workflow).toMatchObject({
      $schemaVersion: 2,
      extensions: { vendor: { retained: true } },
    });
    expect(body.data?.normalized_actions).toBeNull();
    expect(
      getDb()
        .select()
        .from(deployments)
        .where(eq(deployments.tenantId, tenant.id))
        .all(),
    ).toEqual([]);
    expect(
      getDb()
        .select()
        .from(workflows)
        .where(eq(workflows.tenantId, tenant.id))
        .all(),
    ).toEqual([]);
  });

  it("rejects draft_only on the production commit mode", async () => {
    const response = await env.fetch(
      `/v1/tenants/${tenant.slug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.slug,
        },
        body: JSON.stringify({
          mode: "commit",
          draft_only: true,
          workflow: v1Manifest,
        }),
      },
    );
    expect(response.status).toBe(400);
    expect(
      getDb()
        .select()
        .from(deployments)
        .where(eq(deployments.tenantId, tenant.id))
        .all(),
    ).toEqual([]);
  });

  it("preserves a full v2 envelope and binds the pending session to one workflow", async () => {
    const v2 = {
      $schemaVersion: 2,
      extensions: {
        workflow: { description: "Preserve this release metadata" },
        vendor: { nested: { retained: true }, revision: 7 },
      },
      agents: v1Manifest,
    };
    const workflowA = `pending-a-${suffix}`;
    const workflowB = `pending-b-${suffix}`;

    const validated = await env.fetch(
      `/v1/tenants/${tenant.slug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.slug,
        },
        body: JSON.stringify({
          mode: "validate",
          target: "production",
          workflow: v2,
          workflow_slug: workflowA,
          workflow_name: "Pending workflow A",
        }),
      },
    );
    expect(validated.status).toBe(200);
    const validatedBody = (await validated.json()) as Envelope<{
      deployment_id: string;
      workflow_version_id: string;
      schema_version: number;
    }>;
    expect(validatedBody.data?.schema_version).toBe(2);

    const pendingVersion = getDb()
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, validatedBody.data!.workflow_version_id))
      .all()[0]!;
    expect(pendingVersion.manifestJson).toMatchObject({
      $schemaVersion: 2,
      extensions: {
        workflow: { description: "Preserve this release metadata" },
        vendor: { nested: { retained: true }, revision: 7 },
      },
    });

    const otherWorkflowValidate = await env.fetch(
      `/v1/tenants/${tenant.slug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.slug,
        },
        body: JSON.stringify({
          mode: "validate",
          workflow: v2,
          workflow_slug: workflowB,
        }),
      },
    );
    expect(otherWorkflowValidate.status).toBe(423);
    const conflictBody =
      (await otherWorkflowValidate.json()) as Envelope<never> & {
        deployment_id?: string;
      };
    expect(conflictBody.error?.code).toBe("pending_import");
    expect(conflictBody.deployment_id).toBe(validatedBody.data!.deployment_id);

    const mismatchedCommit = await env.fetch(
      `/v1/tenants/${tenant.slug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.slug,
        },
        body: JSON.stringify({
          mode: "commit",
          workflow: v2,
          workflow_slug: workflowB,
          deployment_id: validatedBody.data!.deployment_id,
          confirm_overwrite: true,
        }),
      },
    );
    expect(mismatchedCommit.status).toBe(409);
    expect(
      ((await mismatchedCommit.json()) as Envelope<never>).error?.code,
    ).toBe("pending_import_workflow_mismatch");

    const staleCommit = await env.fetch(
      `/v1/tenants/${tenant.slug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.slug,
        },
        body: JSON.stringify({
          mode: "commit",
          workflow: v2,
          workflow_slug: workflowA,
          deployment_id: "dpl-does-not-exist",
          confirm_overwrite: true,
        }),
      },
    );
    expect(staleCommit.status).toBe(404);
    expect(((await staleCommit.json()) as Envelope<never>).error?.code).toBe(
      "pending_import_not_found",
    );

    getDb()
      .update(deployments)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(deployments.id, validatedBody.data!.deployment_id))
      .run();
    const expiredCommit = await env.fetch(
      `/v1/tenants/${tenant.slug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.slug,
        },
        body: JSON.stringify({
          mode: "commit",
          workflow: v2,
          workflow_slug: workflowA,
          deployment_id: validatedBody.data!.deployment_id,
          confirm_overwrite: true,
        }),
      },
    );
    expect(expiredCommit.status).toBe(409);
    expect(((await expiredCommit.json()) as Envelope<never>).error?.code).toBe(
      "pending_import_expired",
    );
    expect(
      getDb()
        .select()
        .from(workflowVersions)
        .where(eq(workflowVersions.id, validatedBody.data!.workflow_version_id))
        .all(),
    ).toEqual([]);
  });
});
