import path from "node:path";
import { rm, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  CreateWorkflowBodySchema,
  SaveWorkflowBodySchema,
  WorkflowDetailSchema,
  type WorkflowManifestV2,
} from "@agentic/contracts";
import {
  deployments,
  getDb,
  tenants,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  WorkflowManifestInputError,
  createWorkflowDraft,
  saveWorkflowDraft,
  validateWorkflowManifest,
} from "../src/services/workflow-authoring";
import { workflowTenantKeyPrefix } from "../src/services/workflow-secret-policy";
import { getWorkflowTemplate } from "../src/services/workflow-templates";
import { isInngestFunctionRegistered } from "../src/services/inngest-registry";
import { buildTestEnv, type TestEnv } from "./harness";

const suffix = Date.now().toString(36).slice(-8);
const tenant = {
  tenantId: makeId("ten"),
  tenantSlug: `wf-rel-${suffix}`,
};

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; details?: unknown };
}

function helloWorld(): WorkflowManifestV2 {
  return structuredClone(getWorkflowTemplate("hello-world")!.manifest);
}

describe("workflow authoring release regressions", () => {
  let env: TestEnv;

  beforeAll(async () => {
    getDb()
      .insert(tenants)
      .values({
        id: tenant.tenantId,
        slug: tenant.tenantSlug,
        name: "Workflow release regressions",
      })
      .run();
    env = await buildTestEnv();
  });

  afterAll(async () => {
    getDb().delete(tenants).where(eq(tenants.id, tenant.tenantId)).run();
    await rm(
      path.resolve(
        process.env.AGENTIC_MODELS_DIR ?? "models",
        `${tenant.tenantSlug}-v1`,
      ),
      { recursive: true, force: true },
    );
  });

  it("finds a literal nested Authorization credential but permits environment references", () => {
    const literal = helloWorld();
    literal.agents[0]!.tool_use = [
      {
        name: "meta.ping",
        config: {
          request: {
            headers: {
              Authorization: "Bearer sk-release-regression-secret",
            },
          },
        },
      },
    ];
    const rejected = validateWorkflowManifest(literal);
    expect(rejected.valid).toBe(false);
    expect(rejected.issues).toContainEqual(
      expect.objectContaining({
        path: "agents[0].tool_use[0].config.request.headers.Authorization",
        code: "literal_secret",
        severity: "error",
      }),
    );

    const referenced = helloWorld();
    referenced.agents[0]!.tool_use = [
      {
        name: "meta.ping",
        config: {
          authorization_env: "EXTERNAL_SERVICE_AUTHORIZATION",
          nested: { api_key_env: "EXTERNAL_SERVICE_API_KEY" },
        },
      },
    ];
    const accepted = validateWorkflowManifest(referenced);
    expect(
      accepted.issues.filter((issue) => issue.code === "literal_secret"),
    ).toEqual([]);
    expect(accepted.valid).toBe(true);

    for (const config of [
      { authorization_env: "Bearer sk-not-an-env-reference" },
      { credential_ref: "Bearer sk-not-a-named-reference" },
      { api_key_secret_name: "invalid reference with spaces" },
    ]) {
      const invalidReference = helloWorld();
      invalidReference.agents[0]!.tool_use = [{ name: "meta.ping", config }];
      expect(validateWorkflowManifest(invalidReference).issues).toContainEqual(
        expect.objectContaining({
          code: "invalid_secret_reference",
          severity: "error",
        }),
      );
    }
  });

  it("scopes persisted environment and named secret references to the tenant or an exact shared allowlist", async () => {
    const externalEnv = "EXTERNAL_SERVICE_API_KEY";
    const externalNamedRef = "vault:another-tenant:service-key";
    const unsafe = helloWorld();
    unsafe.agents[0]!.tool_use = [
      {
        name: "meta.ping",
        config: {
          api_key_env: externalEnv,
          credential_ref: externalNamedRef,
        },
      },
    ];

    // Syntax-only callers remain useful for editing manifests without tenant
    // context, while every persistence boundary applies tenant ownership.
    expect(validateWorkflowManifest(unsafe).valid).toBe(true);
    expect(
      validateWorkflowManifest(unsafe, { tenantSlug: tenant.tenantSlug })
        .issues,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "tenant_secret_scope" }),
      ]),
    );

    expect(() =>
      createWorkflowDraft(
        CreateWorkflowBodySchema.parse({
          slug: `tenant-ref-create-${suffix}`,
          name: "Tenant reference create rejection",
          source: { type: "manifest", manifest: unsafe },
        }),
        tenant,
      ),
    ).toThrow(WorkflowManifestInputError);

    const clean = createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug: `tenant-ref-save-${suffix}`,
        name: "Tenant reference save rejection",
        source: { type: "manifest", manifest: helloWorld() },
      }),
      tenant,
    );
    expect(() =>
      saveWorkflowDraft(
        clean.slug,
        SaveWorkflowBodySchema.parse({
          baseVersionId: clean.latestVersionId,
          manifest: unsafe,
        }),
        tenant,
      ),
    ).toThrow(WorkflowManifestInputError);

    const importSlug = `tenant-ref-import-${suffix}`;
    const imported = await env.fetch(
      `/v1/tenants/${tenant.tenantSlug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.tenantSlug,
        },
        body: JSON.stringify({
          mode: "validate",
          draft_only: true,
          workflow: unsafe,
          workflow_slug: importSlug,
          workflow_name: "Tenant reference import rejection",
        }),
      },
    );
    expect(imported.status).toBe(400);
    const importBody = (await imported.json()) as Envelope<unknown> & {
      issues?: Array<{ code?: string }>;
    };
    expect(importBody.error?.code).toBe("blocking_issues");
    expect(importBody.issues).toContainEqual(
      expect.objectContaining({ code: "tenant_secret_scope" }),
    );
    expect(
      getDb()
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.tenantId, tenant.tenantId),
            eq(workflows.slug, importSlug),
          ),
        )
        .all(),
    ).toEqual([]);

    const priorShared = process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST;
    process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST = `${externalEnv},${externalNamedRef}`;
    try {
      const shared = createWorkflowDraft(
        CreateWorkflowBodySchema.parse({
          slug: `tenant-ref-shared-${suffix}`,
          name: "Explicitly shared references",
          source: { type: "manifest", manifest: unsafe },
        }),
        tenant,
      );
      expect(shared.manifest.agents[0]!.tool_use[0]!.config).toMatchObject({
        api_key_env: externalEnv,
        credential_ref: externalNamedRef,
      });
    } finally {
      if (priorShared === undefined) {
        delete process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST;
      } else {
        process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST = priorShared;
      }
    }

    const tenantOwned = helloWorld();
    tenantOwned.agents[0]!.tool_use = [
      {
        name: "meta.ping",
        config: {
          api_key_env: `TENANT_${workflowTenantKeyPrefix(tenant.tenantSlug)}_SERVICE_KEY`,
          credential_ref: `vault:${tenant.tenantSlug}:service-key`,
        },
      },
    ];
    expect(
      validateWorkflowManifest(tenantOwned, {
        tenantSlug: tenant.tenantSlug,
      }).issues.filter((issue) => issue.code === "tenant_secret_scope"),
    ).toEqual([]);
  });

  it("binds authored endpoints to HTTPS hosts and tenant-owned credentials", async () => {
    const mismatchedHttp = helloWorld();
    mismatchedHttp.agents[0]!.tool_use = [
      {
        name: "http.fetch",
        config: {
          base_url: "https://api.example.test/v1",
          allow_host: "other.example.test",
        },
      },
    ];
    expect(
      validateWorkflowManifest(mismatchedHttp, {
        tenantSlug: tenant.tenantSlug,
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: "endpoint_policy" }));

    const plaintext = structuredClone(mismatchedHttp);
    plaintext.agents[0]!.tool_use[0]!.config = {
      base_url: "http://api.example.test/v1",
      allow_host: "api.example.test",
    };
    expect(
      validateWorkflowManifest(plaintext, {
        tenantSlug: tenant.tenantSlug,
      }).issues,
    ).toContainEqual(expect.objectContaining({ code: "endpoint_policy" }));

    const providerDefault = helloWorld();
    providerDefault.agents[0]!.tool_use = [
      {
        name: "robohireHealthApi",
        config: { base_url: "https://api.robohire.io/api/v1" },
      },
    ];
    expect(
      validateWorkflowManifest(providerDefault, {
        tenantSlug: tenant.tenantSlug,
      }).issues.filter(
        (issue) =>
          issue.code === "endpoint_policy" ||
          issue.code === "tenant_secret_scope",
      ),
    ).toEqual([]);

    const customProvider = helloWorld();
    customProvider.agents[0]!.tool_use = [
      {
        name: "robohireHealthApi",
        config: {
          base_url: "https://approved.example.test/robohire/v1",
          api_key_env: "SHARED_ROBOHIRE_KEY",
        },
      },
    ];
    const priorEndpoint = process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST;
    const priorShared = process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST;
    process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST =
      "https://approved.example.test/robohire";
    process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST = "SHARED_ROBOHIRE_KEY";
    try {
      // A shared/global credential remains forbidden for a custom host even
      // when both the reference and endpoint are explicitly allowlisted.
      expect(
        validateWorkflowManifest(customProvider, {
          tenantSlug: tenant.tenantSlug,
        }).issues,
      ).toContainEqual(
        expect.objectContaining({ code: "tenant_secret_scope" }),
      );

      customProvider.agents[0]!.tool_use[0]!.config!.api_key_env = `TENANT_${workflowTenantKeyPrefix(tenant.tenantSlug)}_ROBOHIRE_KEY`;
      const accepted = createWorkflowDraft(
        CreateWorkflowBodySchema.parse({
          slug: `custom-endpoint-${suffix}`,
          name: "Allowlisted custom provider endpoint",
          source: { type: "manifest", manifest: customProvider },
        }),
        tenant,
      );
      expect(accepted.manifest.agents[0]!.tool_use[0]!.config).toMatchObject({
        base_url: "https://approved.example.test/robohire/v1",
        api_key_env: `TENANT_${workflowTenantKeyPrefix(tenant.tenantSlug)}_ROBOHIRE_KEY`,
      });
    } finally {
      if (priorEndpoint === undefined) {
        delete process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST;
      } else {
        process.env.AGENTIC_WORKFLOW_ENDPOINT_ALLOWLIST = priorEndpoint;
      }
      if (priorShared === undefined) {
        delete process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST;
      } else {
        process.env.AGENTIC_WORKFLOW_SHARED_ENV_ALLOWLIST = priorShared;
      }
    }

    const importSlug = `endpoint-import-${suffix}`;
    const unsafeImport = helloWorld();
    unsafeImport.agents[0]!.tool_use = [
      {
        name: "gohireHealthApi",
        config: {
          base_url: "https://unapproved.example.test/gohire",
          api_key_env: `TENANT_${workflowTenantKeyPrefix(tenant.tenantSlug)}_GOHIRE_KEY`,
        },
      },
    ];
    const imported = await env.fetch(
      `/v1/tenants/${tenant.tenantSlug}/manifest-import`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-agentic-tenant": tenant.tenantSlug,
        },
        body: JSON.stringify({
          mode: "validate",
          draft_only: true,
          workflow: unsafeImport,
          workflow_slug: importSlug,
          workflow_name: "Endpoint import rejection",
        }),
      },
    );
    expect(imported.status).toBe(400);
    const importBody = (await imported.json()) as Envelope<unknown> & {
      issues?: Array<{ code?: string }>;
    };
    expect(importBody.error?.code).toBe("blocking_issues");
    expect(importBody.issues).toContainEqual(
      expect.objectContaining({ code: "endpoint_policy" }),
    );
    expect(
      getDb()
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.tenantId, tenant.tenantId),
            eq(workflows.slug, importSlug),
          ),
        )
        .all(),
    ).toEqual([]);
  });

  it("blocks literal secrets before direct-import validation or commit can persist them", async () => {
    const workflowSlug = `secret-import-${suffix}`;
    const manifest = helloWorld();
    manifest.agents[0]!.tool_use = [
      {
        name: "meta.ping",
        config: {
          headers: { Authorization: "Bearer sk-direct-import-secret" },
        },
      },
    ];
    for (const mode of ["validate", "commit"] as const) {
      const response = await env.fetch(
        `/v1/tenants/${tenant.tenantSlug}/manifest-import`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-agentic-tenant": tenant.tenantSlug,
          },
          body: JSON.stringify({
            mode,
            workflow: manifest,
            workflow_slug: workflowSlug,
            workflow_name: "Secret import rejection",
            confirm_overwrite: true,
          }),
        },
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Envelope<unknown> & {
        issues?: Array<{ code?: string }>;
      };
      expect(body.error?.code).toBe("blocking_issues");
      expect(body.issues).toContainEqual(
        expect.objectContaining({ code: "literal_secret" }),
      );
    }
    expect(
      getDb()
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.tenantId, tenant.tenantId),
            eq(workflows.slug, workflowSlug),
          ),
        )
        .all(),
    ).toEqual([]);
  });

  it("preserves the complete v2 envelope when the canvas saves a bare agent array", () => {
    const manifest = helloWorld() as WorkflowManifestV2 & {
      extensions?: Record<string, unknown>;
    };
    manifest.extensions = {
      ...(manifest.extensions ?? {}),
      releaseRegression: {
        nested: { preserved: true },
        labels: ["one", "two"],
      },
    };
    const created = createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug: `bare-save-${suffix}`,
        name: "Bare save preservation",
        description: "Top-level metadata must survive canvas saves.",
        source: { type: "manifest", manifest },
      }),
      tenant,
    );

    const agents = structuredClone(created.manifest.agents);
    agents[0]!.title = "Edited on canvas";
    const saved = saveWorkflowDraft(
      created.slug,
      SaveWorkflowBodySchema.parse({
        baseVersionId: created.latestVersionId,
        manifest: agents,
      }),
      tenant,
    );

    expect(saved.manifest.$schemaVersion).toBe(2);
    expect(saved.manifest.agents[0]?.title).toBe("Edited on canvas");
    expect(
      (saved.manifest.extensions as Record<string, unknown>).releaseRegression,
    ).toEqual({
      nested: { preserved: true },
      labels: ["one", "two"],
    });
    expect(
      (saved.manifest.extensions as { workflow?: { description?: string } })
        .workflow?.description,
    ).toBe("Top-level metadata must survive canvas saves.");
  });

  it("rejects literal draft saves and publishes the explicitly selected valid version", async () => {
    const manifest = helloWorld() as WorkflowManifestV2 & {
      extensions?: Record<string, unknown>;
    };
    manifest.agents[0]!.title = "Selected release candidate";
    manifest.extensions = {
      ...(manifest.extensions ?? {}),
      releaseRegression: { selected: "original" },
    };
    const workflowSlug = `publish-${suffix}`;
    const create = await env.fetch("/v1/workflows", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenant.tenantSlug,
      },
      body: JSON.stringify({
        slug: workflowSlug,
        name: "Exact publish regression",
        description: "Publish a selected immutable version.",
        source: { type: "manifest", manifest },
      }),
    });
    expect(create.status).toBe(201);
    const created = WorkflowDetailSchema.parse(
      ((await create.json()) as Envelope<unknown>).data,
    );

    const unsafe = structuredClone(created.manifest);
    unsafe.agents[0]!.title = "Unsafe newer draft";
    unsafe.agents[0]!.tool_use = [
      {
        name: "meta.ping",
        config: {
          transport: {
            headers: { Authorization: "Bearer ao_live_literal_secret" },
          },
        },
      },
    ];
    const save = await env.fetch(`/v1/workflows/${workflowSlug}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenant.tenantSlug,
      },
      body: JSON.stringify({
        baseVersionId: created.latestVersionId,
        manifest: unsafe,
      }),
    });
    expect(save.status).toBe(400);
    const saveBody = (await save.json()) as Envelope<unknown>;
    expect(saveBody.error?.code).toBe("invalid_workflow_manifest");

    // Seed a legacy unsafe row directly to prove the publish boundary still
    // validates an explicitly selected immutable version. Public create/save
    // paths above can no longer create this state.
    const workflowId = getDb()
      .select({ id: workflows.id })
      .from(workflows)
      .where(
        and(
          eq(workflows.tenantId, tenant.tenantId),
          eq(workflows.slug, workflowSlug),
        ),
      )
      .all()[0]!.id;
    const unsafeVersionId = makeId("wfv");
    getDb()
      .insert(workflowVersions)
      .values({
        id: unsafeVersionId,
        workflowId,
        version: `legacy-unsafe-${suffix}`,
        manifestJson: unsafe as never,
        createdAt: new Date(Date.now() + 1),
      })
      .run();

    const rejected = await env.fetch(`/v1/workflows/${workflowSlug}/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenant.tenantSlug,
      },
      body: JSON.stringify({ versionId: unsafeVersionId }),
    });
    expect(rejected.status).toBe(400);
    const rejectedBody = (await rejected.json()) as Envelope<unknown>;
    expect(rejectedBody.error?.code).toBe("workflow_validation_failed");
    expect(
      getDb()
        .select()
        .from(deployments)
        .where(eq(deployments.tenantId, tenant.tenantId))
        .all(),
    ).toEqual([]);

    const published = await env.fetch(`/v1/workflows/${workflowSlug}/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenant.tenantSlug,
      },
      body: JSON.stringify({ versionId: created.latestVersionId }),
    });
    expect(published.status).toBe(200);
    const publishedBody = (await published.json()) as Envelope<{
      workflow_version_id: string;
      target: string;
      file_written: string;
    }>;
    expect(publishedBody.data?.target).toBe("production");

    const publishedVersion = getDb()
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, publishedBody.data!.workflow_version_id))
      .all()[0]!;
    const persisted = publishedVersion.manifestJson as {
      $schemaVersion?: number;
      agents?: Array<{ title?: string }>;
      extensions?: Record<string, unknown>;
    };
    expect(persisted.$schemaVersion).toBe(2);
    expect(persisted.agents?.[0]?.title).toBe("Selected release candidate");
    expect(persisted.extensions?.releaseRegression).toEqual({
      selected: "original",
    });
    expect(JSON.stringify(persisted)).not.toContain("ao_live_literal_secret");

    const disk = JSON.parse(
      await readFile(publishedBody.data!.file_written, "utf8"),
    ) as typeof persisted;
    expect(disk.$schemaVersion).toBe(2);
    expect(disk.extensions?.releaseRegression).toEqual({
      selected: "original",
    });
    expect(
      isInngestFunctionRegistered(
        `${tenant.tenantSlug}.${created.manifest.agents[0]!.name}`,
      ),
    ).toBe(true);

    // The publish route already completed a hot re-registration. Bootstrap
    // must match the live auto-hash to this named workflow rather than lazily
    // creating or moving ownership to the legacy <tenant>-default row.
    const liveOwners = getDb()
      .select({
        slug: workflows.slug,
        versionId: deployments.versionId,
      })
      .from(deployments)
      .innerJoin(
        workflowVersions,
        eq(workflowVersions.id, deployments.versionId),
      )
      .innerJoin(workflows, eq(workflows.id, workflowVersions.workflowId))
      .where(
        and(
          eq(deployments.tenantId, tenant.tenantId),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .all();
    expect(liveOwners).toEqual([
      {
        slug: workflowSlug,
        versionId: publishedBody.data!.workflow_version_id,
      },
    ]);
    expect(
      liveOwners.some((owner) => owner.slug === `${tenant.tenantSlug}-default`),
    ).toBe(false);
  });

  it("returns a controlled 400 for a structurally corrupt stored version", async () => {
    const workflowId = makeId("wf");
    const versionId = makeId("wfv");
    const slug = `corrupt-${suffix}`;
    getDb().transaction((tx) => {
      tx.insert(workflows)
        .values({
          id: workflowId,
          tenantId: tenant.tenantId,
          slug,
          name: "Corrupt stored workflow",
        })
        .run();
      tx.insert(workflowVersions)
        .values({
          id: versionId,
          workflowId,
          version: "draft-corrupt",
          manifestJson: { notAgents: true },
        })
        .run();
    });

    const response = await env.fetch(`/v1/workflows/${slug}/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-agentic-tenant": tenant.tenantSlug,
      },
      body: JSON.stringify({ versionId }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Envelope<unknown>;
    expect(body.error?.code).toBe("invalid_workflow_manifest");
  });
});
