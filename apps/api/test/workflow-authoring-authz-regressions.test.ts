import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { and, eq, inArray } from "drizzle-orm";
import { CreateWorkflowBodySchema } from "@agentic/contracts";
import {
  apiTokens,
  auditLog,
  getDb,
  memberships,
  tenants,
  users,
  workflows,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { createWorkflowDraft } from "../src/services/workflow-authoring";
import { buildTestEnv, type TestEnv } from "./harness";

const suffix = Date.now().toString(36).slice(-8);
const tenant = {
  id: makeId("ten"),
  slug: `wf-az-${suffix}`,
};
const people = {
  admin: {
    id: makeId("usr"),
    email: `workflow-admin-${suffix}@example.test`,
  },
  operator: {
    id: makeId("usr"),
    email: `workflow-operator-${suffix}@example.test`,
  },
  viewer: {
    id: makeId("usr"),
    email: `workflow-viewer-${suffix}@example.test`,
  },
};
const sessionSecret = `workflow-authz-${suffix}-session-secret-32-chars`;
const tokens = {
  readOnly: `read-only-${makeId("tok")}`,
  workspaceAll: `workspace-all-${makeId("tok")}`,
  tenantWrite: `tenant-write-${makeId("tok")}`,
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

function workflowBody(slug: string): string {
  return JSON.stringify({
    slug,
    name: `Workflow ${slug}`,
    source: { type: "template", templateId: "hello-world" },
    model: { provider: "mock", model: "mock-model-v1" },
  });
}

describe("workflow authoring writer authorization regressions", () => {
  let env: TestEnv;
  let adminCookie: string;
  let operatorCookie: string;
  let viewerCookie: string;
  const guardedSlug = `guarded-${suffix}`;
  const forbiddenSlug = `forbidden-${suffix}`;
  const previousAuthMode = process.env.AUTH_MODE;
  const previousSessionSecret = process.env.AUTH_SESSION_SECRET;

  beforeAll(async () => {
    const db = getDb();
    db.insert(tenants)
      .values({ id: tenant.id, slug: tenant.slug, name: "Workflow authz" })
      .run();
    db.insert(users)
      .values([
        { id: people.admin.id, email: people.admin.email, name: "Admin" },
        {
          id: people.operator.id,
          email: people.operator.email,
          name: "Operator",
        },
        { id: people.viewer.id, email: people.viewer.email, name: "Viewer" },
      ])
      .run();
    db.insert(memberships)
      .values([
        { tenantId: tenant.id, userId: people.admin.id, role: "admin" },
        {
          tenantId: tenant.id,
          userId: people.operator.id,
          role: "operator",
        },
        { tenantId: tenant.id, userId: people.viewer.id, role: "viewer" },
      ])
      .run();
    db.insert(apiTokens)
      .values([
        {
          id: makeId("tok"),
          tenantId: tenant.id,
          hash: hash(tokens.readOnly),
          name: "Read only",
          scopes: ["tenant:read"],
        },
        {
          id: makeId("tok"),
          tenantId: tenant.id,
          hash: hash(tokens.workspaceAll),
          name: "Workspace all",
          scopes: ["workspace:all"],
        },
        {
          id: makeId("tok"),
          tenantId: tenant.id,
          hash: hash(tokens.tenantWrite),
          name: "Tenant write",
          scopes: ["tenant:write"],
        },
      ])
      .run();
    createWorkflowDraft(
      CreateWorkflowBodySchema.parse({
        slug: guardedSlug,
        name: "Authorization guard target",
        source: { type: "template", templateId: "hello-world" },
        model: { provider: "mock", model: "mock-model-v1" },
      }),
      { tenantId: tenant.id, tenantSlug: tenant.slug },
    );

    process.env.AUTH_SESSION_SECRET = sessionSecret;
    env = await buildTestEnv();
    adminCookie = await cookieFor(people.admin.email);
    operatorCookie = await cookieFor(people.operator.email);
    viewerCookie = await cookieFor(people.viewer.email);
  });

  afterAll(() => {
    process.env.AUTH_MODE = previousAuthMode;
    if (previousSessionSecret === undefined) {
      delete process.env.AUTH_SESSION_SECRET;
    } else {
      process.env.AUTH_SESSION_SECRET = previousSessionSecret;
    }
    const db = getDb();
    db.delete(tenants).where(eq(tenants.id, tenant.id)).run();
    db.delete(users)
      .where(
        inArray(users.id, [
          people.admin.id,
          people.operator.id,
          people.viewer.id,
        ]),
      )
      .run();
  });

  it.each([
    ["viewer cookie", () => ({ cookie: viewerCookie })],
    [
      "read-only bearer",
      () => ({ authorization: `Bearer ${tokens.readOnly}` }),
    ],
  ])(
    "returns 403 for every workflow mutation with a %s",
    async (_label, headers) => {
      process.env.AUTH_MODE = "production";
      const credential = headers();

      const create = await env.fetch("/v1/workflows", {
        method: "POST",
        headers: { ...credential, "content-type": "application/json" },
        body: workflowBody(forbiddenSlug),
      });
      expect(create.status).toBe(403);

      const generate = await env.fetch("/v1/workflows/generate", {
        method: "POST",
        headers: { ...credential, "content-type": "application/json" },
        body: JSON.stringify({
          purpose:
            "Classify incoming support requests and safely route uncertain outcomes.",
          provider: "mock",
          model: "mock-model-v1",
        }),
      });
      expect(generate.status).toBe(403);

      const publish = await env.fetch(`/v1/workflows/${guardedSlug}/publish`, {
        method: "POST",
        headers: { ...credential, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(publish.status).toBe(403);

      const remove = await env.fetch(`/v1/workflows/${guardedSlug}`, {
        method: "DELETE",
        headers: credential,
      });
      expect(remove.status).toBe(403);

      expect(
        getDb()
          .select()
          .from(workflows)
          .where(eq(workflows.tenantId, tenant.id))
          .all()
          .some((workflow) => workflow.slug === forbiddenSlug),
      ).toBe(false);
    },
  );

  it.each([
    [
      "operator cookie",
      () => ({ cookie: operatorCookie }),
      `operator-${suffix}`,
      people.operator.id,
    ],
    [
      "admin cookie",
      () => ({ cookie: adminCookie }),
      `admin-${suffix}`,
      people.admin.id,
    ],
    [
      "workspace:all bearer",
      () => ({ authorization: `Bearer ${tokens.workspaceAll}` }),
      `workspace-${suffix}`,
      null,
    ],
    [
      "tenant:write bearer",
      () => ({ authorization: `Bearer ${tokens.tenantWrite}` }),
      `tenant-write-${suffix}`,
      null,
    ],
  ])(
    "permits a safe create with an authorized %s",
    async (_label, headers, slug, expectedActorUserId) => {
      process.env.AUTH_MODE = "production";
      const response = await env.fetch("/v1/workflows", {
        method: "POST",
        headers: { ...headers(), "content-type": "application/json" },
        body: workflowBody(slug),
      });
      expect(response.status).toBe(201);
      const workflow = getDb()
        .select({ id: workflows.id })
        .from(workflows)
        .where(and(eq(workflows.tenantId, tenant.id), eq(workflows.slug, slug)))
        .all()[0]!;
      const audit = getDb()
        .select({ actorUserId: auditLog.actorUserId })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, tenant.id),
            eq(auditLog.action, "workflow.create"),
            eq(auditLog.targetId, workflow.id),
          ),
        )
        .all()[0];
      expect(audit?.actorUserId ?? null).toBe(expectedActorUserId);
    },
  );
});
