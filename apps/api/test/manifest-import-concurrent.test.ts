/**
 * manifest-import — concurrent stage guard (423).
 *
 * One in-flight stage per tenant. A second `stage` call while a pending
 * deployment exists must return HTTP 423 LOCKED with the in-flight session
 * id echoed in the body so the SPA can offer "resume or cancel".
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  apiTokens,
  deployments as deploymentsTable,
  getDb,
  tenants,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import { createHash } from "node:crypto";
import { buildTestEnv, type TestEnv } from "./harness";

const FIXTURES = path.resolve(__dirname, "fixtures", "manifests");

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(path.join(FIXTURES, name), "utf8"));
}

function seedTenantWithToken(slug: string): {
  tenantId: string;
  token: string;
} {
  const db = getDb();
  let row = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
  if (!row) {
    const id = makeId("ten");
    db.insert(tenants).values({ id, slug, name: slug, color: "#000" }).run();
    row = db.select().from(tenants).where(eq(tenants.id, id)).all()[0]!;
  }
  const token = "tok-" + makeId("tok");
  const hash = createHash("sha256").update(token).digest("hex");
  db.insert(apiTokens)
    .values({
      id: makeId("tok"),
      tenantId: row.id,
      hash,
      name: `mi-conc-${slug}`,
      scopes: ["*"],
    })
    .run();
  return { tenantId: row.id, token };
}

describe("manifest-import: concurrent stage guard", () => {
  let env: TestEnv;
  // Use the dev tenant (`__system`); see manifest-import-validate.test.ts.
  const slug = "__system";

  beforeAll(async () => {
    env = await buildTestEnv();
    void seedTenantWithToken;
    // Clear any pending deployments left from earlier test files so the
    // first stage in this suite is fresh.
    const db = getDb();
    const t = db.select().from(tenants).where(eq(tenants.slug, slug)).all()[0]!;
    db.delete(deploymentsTable)
      .where(
        and(
          eq(deploymentsTable.tenantId, t.id),
          eq(deploymentsTable.status, "pending"),
        ),
      )
      .run();
  });

  it("validate inserts a pending lock; a second validate with a different deployment_id is 423", async () => {
    // Post-review C3 the `stage` mode is gone — `validate` itself inserts
    // the pending `deployments` lock row (the deployment row's id IS the
    // session token per A2). The 423 contract still holds for the
    // SPA's "Resume or cancel" affordance, but only fires when the second
    // caller references a different deployment_id (i.e. another operator
    // started a wizard while the first was mid-flow).
    const workflow = await loadFixture("happy-v1.json");

    const first = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "validate", workflow }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      ok: boolean;
      data: { deployment_id: string };
    };
    expect(firstBody.ok).toBe(true);
    expect(firstBody.data.deployment_id).toMatch(/^dpl-/);

    // A second validate that references a different (made-up) deployment_id
    // collides with the in-flight pending row → 423 with the live id echoed.
    const second = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "validate",
        workflow,
        deployment_id: "dpl-other-operator-fake",
      }),
    });
    expect(second.status).toBe(423);
    const secondBody = (await second.json()) as {
      ok: false;
      deployment_id?: string;
      in_flight_session_id?: string;
      error: { code: string };
    };
    expect(secondBody.ok).toBe(false);
    expect(secondBody.error.code).toBe("pending_import");
    expect(secondBody.deployment_id).toBe(firstBody.data.deployment_id);
    // Legacy alias preserved for v0 SPA callers.
    expect(secondBody.in_flight_session_id).toBe(firstBody.data.deployment_id);
  });

  it("DELETE releases the pending lock so the next validate can start fresh", async () => {
    // Stage a pending row …
    const workflow = await loadFixture("happy-v1.json");
    const first = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "validate", workflow }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      data: { deployment_id: string };
    };
    const deploymentId = firstBody.data.deployment_id;

    // … cancel it.
    const cancel = await env.fetch(
      `/v1/tenants/${slug}/manifest-import/${deploymentId}`,
      { method: "DELETE" },
    );
    expect(cancel.status).toBe(200);

    // A stale resume id is never silently converted into a fresh import. This
    // prevents a cancelled or expired wizard from publishing against a new
    // session that the caller did not explicitly create.
    const staleResume = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "validate",
        workflow,
        deployment_id: "dpl-fresh-attempt",
      }),
    });
    expect(staleResume.status).toBe(404);

    // Omitting the resume id explicitly starts a fresh import, proving that
    // DELETE released the tenant lock.
    const next = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "validate", workflow }),
    });
    expect(next.status).toBe(200);
    const nextBody = (await next.json()) as { data: { deployment_id: string } };
    // The new validate mints a fresh dpl- id.
    expect(nextBody.data.deployment_id).toMatch(/^dpl-/);
    expect(nextBody.data.deployment_id).not.toBe(deploymentId);
  });
});
