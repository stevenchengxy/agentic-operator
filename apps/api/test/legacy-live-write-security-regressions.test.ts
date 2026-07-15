import path from "node:path";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { eq, inArray } from "drizzle-orm";
import {
  agentVersions,
  agents,
  auditLog,
  deployments,
  eventListeners,
  getDb,
  memberships,
  tenants,
  users,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { workflowTenantKeyPrefix } from "../src/services/workflow-secret-policy";
import { buildTestEnv, type TestEnv } from "./harness";

const suffix = Date.now().toString(36).slice(-8);
const tenant = {
  id: makeId("ten"),
  slug: `legacy-write-${suffix}`,
};
const people = {
  operator: {
    id: makeId("usr"),
    email: `legacy-operator-${suffix}@example.test`,
  },
  viewer: {
    id: makeId("usr"),
    email: `legacy-viewer-${suffix}@example.test`,
  },
};
const sessionSecret = `legacy-write-${suffix}-session-secret-32-chars`;

interface PolicyEnvelope {
  error?: {
    code?: string;
    details?: { issues?: Array<{ code?: string }> };
  };
}

function legacyManifest(
  toolUse: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> {
  return [
    {
      id: "legacy-security-agent",
      name: "legacySecurityAgent",
      title: "Legacy security agent",
      description: "A valid legacy workflow used to test write boundaries.",
      actor: ["Agent"],
      trigger: ["LEGACY_SECURITY_REQUESTED"],
      ontology_instructions:
        "Validate the request, perform the declared action, and return an auditable result.",
      tool_use: toolUse,
      actions: [
        {
          id: "complete-request",
          order: "1",
          name: "completeRequest",
          description: "Complete the validated request.",
          type: "logic",
          action_prompt: "Complete the validated request without fabrication.",
        },
      ],
      triggered_event: ["LEGACY_SECURITY_COMPLETED"],
    },
  ];
}

async function cookieFor(email: string): Promise<string> {
  const jwt = await new SignJWT({
    name: email,
    initials: "QA",
    tenant: tenant.slug,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(sessionSecret));
  return `agentic_session=${jwt}`;
}

function sorted<T extends { id: string }>(rows: T[]): T[] {
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

function tenantWriteSnapshot(): unknown {
  const db = getDb();
  const tenantWorkflows = sorted(
    db.select().from(workflows).where(eq(workflows.tenantId, tenant.id)).all(),
  );
  const workflowIds = new Set(tenantWorkflows.map((row) => row.id));
  const tenantVersions = sorted(
    db
      .select()
      .from(workflowVersions)
      .all()
      .filter((row) => workflowIds.has(row.workflowId)),
  );
  const tenantAgents = sorted(
    db
      .select()
      .from(agents)
      .all()
      .filter((row) => workflowIds.has(row.workflowId)),
  );
  const agentIds = new Set(tenantAgents.map((row) => row.id));
  const tenantAgentVersions = sorted(
    db
      .select()
      .from(agentVersions)
      .all()
      .filter((row) => agentIds.has(row.agentId)),
  );
  const tenantListeners = db
    .select()
    .from(eventListeners)
    .all()
    .filter((row) => agentIds.has(row.agentId))
    .sort((left, right) =>
      `${left.agentId}:${left.eventName}`.localeCompare(
        `${right.agentId}:${right.eventName}`,
      ),
    );
  return {
    workflows: tenantWorkflows,
    versions: tenantVersions,
    agents: tenantAgents,
    agentVersions: tenantAgentVersions,
    listeners: tenantListeners,
    deployments: sorted(
      db
        .select()
        .from(deployments)
        .where(eq(deployments.tenantId, tenant.id))
        .all(),
    ),
    audit: sorted(
      db.select().from(auditLog).where(eq(auditLog.tenantId, tenant.id)).all(),
    ),
  };
}

async function fileSnapshot(folder: string): Promise<unknown> {
  const files = (await readdir(folder)).sort();
  return Promise.all(
    files.map(async (file) => [
      file,
      await readFile(path.join(folder, file), "utf8"),
    ]),
  );
}

function expectPolicyIssue(body: PolicyEnvelope, code: string): void {
  expect(body.error?.code).toBe("invalid_workflow_manifest");
  expect(body.error?.details?.issues).toEqual(
    expect.arrayContaining([expect.objectContaining({ code })]),
  );
}

describe("legacy live-write authorization and workflow policy regressions", () => {
  let env: TestEnv;
  let tempRoot: string;
  let tenantFolder: string;
  let operatorCookie: string;
  let viewerCookie: string;

  beforeAll(async () => {
    const db = getDb();
    db.insert(tenants)
      .values({ id: tenant.id, slug: tenant.slug, name: "Legacy write guards" })
      .run();
    db.insert(users)
      .values([
        {
          id: people.operator.id,
          email: people.operator.email,
          name: "Legacy operator",
        },
        {
          id: people.viewer.id,
          email: people.viewer.email,
          name: "Legacy viewer",
        },
      ])
      .run();
    db.insert(memberships)
      .values([
        {
          tenantId: tenant.id,
          userId: people.operator.id,
          role: "operator",
        },
        { tenantId: tenant.id, userId: people.viewer.id, role: "viewer" },
      ])
      .run();

    vi.stubEnv("AUTH_MODE", "production");
    vi.stubEnv("AUTH_SESSION_SECRET", sessionSecret);
    env = await buildTestEnv();

    tempRoot = await mkdtemp(path.join(tmpdir(), "legacy-write-security-"));
    tenantFolder = path.join(tempRoot, `${tenant.slug}-v1`);
    await mkdir(tenantFolder, { recursive: true });
    await writeFile(
      path.join(tenantFolder, "workflow.json"),
      `${JSON.stringify(legacyManifest(), null, 2)}\n`,
      "utf8",
    );
    // workflow.ts resolves this env per request, so setting it after app boot
    // isolates file assertions without changing runtime bootstrap fixtures.
    vi.stubEnv("AGENTIC_MODELS_DIR", tempRoot);
    operatorCookie = await cookieFor(people.operator.email);
    viewerCookie = await cookieFor(people.viewer.email);
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
    const db = getDb();
    db.delete(tenants).where(eq(tenants.id, tenant.id)).run();
    db.delete(users)
      .where(inArray(users.id, [people.operator.id, people.viewer.id]))
      .run();
  });

  it("returns 403 to a viewer before either legacy surface mutates files or live rows", async () => {
    const beforeFiles = await fileSnapshot(tenantFolder);
    const beforeRows = tenantWriteSnapshot();

    const fileWrite = await env.fetch(`/v1/tenants/${tenant.slug}/workflow`, {
      method: "PUT",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({ manifest: legacyManifest() }),
    });
    expect(fileWrite.status).toBe(403);

    const liveWrite = await env.fetch("/v1/agents", {
      method: "POST",
      headers: {
        cookie: viewerCookie,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        workflowSlug: `viewer-forbidden-${suffix}`,
        manifest: legacyManifest(),
        actions: [],
      }),
    });
    expect(liveWrite.status).toBe(403);
    expect(await fileSnapshot(tenantFolder)).toEqual(beforeFiles);
    expect(tenantWriteSnapshot()).toEqual(beforeRows);
  });

  it.each([
    {
      label: "literal secret",
      issueCode: "literal_secret",
      fileManifest: legacyManifest([
        {
          name: "meta.ping",
          config: { api_key: "ao_live_legacy_literal_secret" },
        },
      ]),
      uploadManifest: legacyManifest(),
      uploadActions: [
        {
          name: "unsafeActionMetadata",
          api_key: "ao_live_legacy_literal_secret",
        },
      ],
    },
    {
      label: "foreign tenant env reference",
      issueCode: "tenant_secret_scope",
      fileManifest: legacyManifest([
        {
          name: "parseResumeApi",
          config: { api_key_env: "TENANT_FOREIGN_VENDOR_KEY" },
        },
      ]),
      uploadManifest: legacyManifest([
        {
          name: "parseResumeApi",
          config: { api_key_env: "TENANT_FOREIGN_VENDOR_KEY" },
        },
      ]),
      uploadActions: [],
    },
    {
      label: "unsafe endpoint",
      issueCode: "endpoint_policy",
      fileManifest: legacyManifest([
        {
          name: "http.fetch",
          config: {
            base_url: "http://169.254.169.254/latest",
            allow_host: "169.254.169.254",
            api_key_env: `TENANT_${workflowTenantKeyPrefix(tenant.slug)}_HTTP_KEY`,
          },
        },
      ]),
      uploadManifest: legacyManifest([
        {
          name: "http.fetch",
          config: {
            base_url: "http://169.254.169.254/latest",
            allow_host: "169.254.169.254",
            api_key_env: `TENANT_${workflowTenantKeyPrefix(tenant.slug)}_HTTP_KEY`,
          },
        },
      ]),
      uploadActions: [],
    },
  ])(
    "rejects $label before file, row, or live-deployment mutation",
    async ({ issueCode, fileManifest, uploadManifest, uploadActions }) => {
      const beforeFiles = await fileSnapshot(tenantFolder);
      const beforeRows = tenantWriteSnapshot();

      const fileWrite = await env.fetch(`/v1/tenants/${tenant.slug}/workflow`, {
        method: "PUT",
        headers: {
          cookie: operatorCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ manifest: fileManifest }),
      });
      expect(fileWrite.status).toBe(400);
      expectPolicyIssue((await fileWrite.json()) as PolicyEnvelope, issueCode);
      expect(await fileSnapshot(tenantFolder)).toEqual(beforeFiles);
      expect(tenantWriteSnapshot()).toEqual(beforeRows);

      const liveWrite = await env.fetch("/v1/agents", {
        method: "POST",
        headers: {
          cookie: operatorCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          workflowSlug: `policy-rejected-${issueCode}-${suffix}`,
          manifest: uploadManifest,
          actions: uploadActions,
        }),
      });
      expect(liveWrite.status).toBe(400);
      expectPolicyIssue((await liveWrite.json()) as PolicyEnvelope, issueCode);
      expect(await fileSnapshot(tenantFolder)).toEqual(beforeFiles);
      expect(tenantWriteSnapshot()).toEqual(beforeRows);
    },
  );
});
