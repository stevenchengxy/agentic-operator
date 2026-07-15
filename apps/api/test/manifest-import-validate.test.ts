/**
 * manifest-import — validate-mode coverage.
 *
 * Exercises POST /v1/tenants/:slug/manifest-import with `mode: "validate"`
 * across happy + failure paths:
 *
 *   1. happy v1 (bare array) → ok=true, parsed.agents=5, no issues
 *   2. happy v2 ($schemaVersion wrapped) → schema_version + parsed counts
 *   3. missing actor → ok=false, issue with severity='error'
 *   4. dangling trigger → conflict.type='dangling_trigger'
 *   5. concurrency excess → conflict.type='concurrency_excess'
 *   6. model not configured → conflict.type='model_not_configured'
 *   7. orphan human actor (no taskDefinition tool) → conflict.type='orphan_actor'
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
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
  const text = await readFile(path.join(FIXTURES, name), "utf8");
  return JSON.parse(text);
}

interface PreviewEnvelope {
  ok: boolean;
  data: {
    ok: boolean;
    schema_version: number;
    parsed: { agents: number; events: number; actions: number };
    issues: Array<{ path: string; severity: string; code: string; message: string }>;
    conflicts: Array<{ path: string; type: string; severity: string; detail: string }>;
    diff: { added: string[]; removed: string[]; modified: string[]; prior_version: string | null };
    prior: { version: string | null; agents: number; live_deployment_id: string | null };
  };
}

function seedTenantWithToken(slug: string): { tenantId: string; token: string } {
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
      name: `mi-validate-${slug}`,
      scopes: ["*"],
    })
    .run();
  return { tenantId: row.id, token };
}

describe("manifest-import: validate mode", () => {
  let env: TestEnv;
  // Use the dev tenant (`__system`) the harness already authenticates as. The
  // auth plugin in dev-mode short-circuits bearer-token resolution to the
  // tenant named by AGENTIC_DEV_TENANT, so cross-tenant requests would 403
  // regardless of the Authorization header we sent.
  const slug = "__system";

  beforeAll(async () => {
    env = await buildTestEnv();
    // Reference seedTenantWithToken so the import isn't dropped on tree-shake.
    void seedTenantWithToken;
  });

  // Post-review: `validate` now inserts a `deployments(status='pending')` lock
  // row (the import session token, per A2). Each test's first validate call
  // would otherwise collide with the previous test's pending row and return
  // 423. Clear pending workflow-imports between tests so the suite is order-
  // independent.
  beforeEach(() => {
    const db = getDb();
    const t = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .all()[0];
    if (t) {
      db.delete(deploymentsTable)
        .where(
          and(
            eq(deploymentsTable.tenantId, t.id),
            eq(deploymentsTable.target, "workflow"),
            eq(deploymentsTable.status, "pending"),
          ),
        )
        .run();
    }
  });

  async function post(body: unknown): Promise<PreviewEnvelope> {
    const res = await env.fetch(`/v1/tenants/${slug}/manifest-import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as PreviewEnvelope;
  }

  it("happy v1 (bare 5-agent array) validates clean", async () => {
    const workflow = await loadFixture("happy-v1.json");
    const out = await post({ mode: "validate", workflow });
    expect(out.ok).toBe(true);
    expect(out.data.ok).toBe(true);
    expect(out.data.schema_version).toBe(2);
    expect(out.data.parsed.agents).toBe(5);
    expect(out.data.parsed.events).toBeGreaterThan(0);
    // No blocking issues; the conflict listing is best-effort.
    const errs = out.data.issues.filter((i) => i.severity === "error");
    expect(errs).toHaveLength(0);
  });

  it("happy v2 ({$schemaVersion,agents}) migrates and validates", async () => {
    const workflow = await loadFixture("happy-v2.json");
    const out = await post({ mode: "validate", workflow });
    expect(out.data.ok).toBe(true);
    expect(out.data.parsed.agents).toBe(5);
    // Schema version is whatever migrate() returns; current is 2.
    expect(typeof out.data.schema_version).toBe("number");
  });

  it("missing-actor manifest reports a Zod error", async () => {
    const workflow = await loadFixture("missing-actor.json");
    const out = await post({ mode: "validate", workflow });
    // The Zod parser emits a structured issue; `ok` should be false.
    expect(out.data.ok).toBe(false);
    const errs = out.data.issues.filter((i) => i.severity === "error");
    expect(errs.length).toBeGreaterThan(0);
    // At least one issue should point at an `actor` field.
    expect(
      errs.some(
        (i) => i.path.includes("actor") || i.message.toLowerCase().includes("actor"),
      ),
    ).toBe(true);
  });

  it("dangling-trigger surfaces as a conflict", async () => {
    const workflow = await loadFixture("dangling-trigger.json");
    const out = await post({ mode: "validate", workflow });
    expect(
      out.data.conflicts.some((c) => c.type === "dangling_trigger"),
    ).toBe(true);
  });

  it("concurrency-excess surfaces as a conflict with severity=warn", async () => {
    const workflow = await loadFixture("concurrency-excess.json");
    const out = await post({ mode: "validate", workflow });
    const c = out.data.conflicts.find((c) => c.type === "concurrency_excess");
    expect(c).toBeDefined();
    expect(c!.severity).toBe("warn");
  });

  it("model-not-configured surfaces as a blocking conflict", async () => {
    const workflow = await loadFixture("model-not-configured.json");
    const out = await post({ mode: "validate", workflow });
    const c = out.data.conflicts.find((c) => c.type === "model_not_configured");
    expect(c).toBeDefined();
    expect(c!.severity).toBe("block");
    expect(c!.detail.toLowerCase()).toContain("unicorn-3-ultra");
  });

  it("orphan-actor (Human without taskDefinition) surfaces as a blocking conflict", async () => {
    const workflow = await loadFixture("orphan-actor.json");
    const out = await post({ mode: "validate", workflow });
    const c = out.data.conflicts.find((c) => c.type === "orphan_actor");
    expect(c).toBeDefined();
    expect(c!.severity).toBe("block");
  });

  it("rejects cross-tenant requests with 403", async () => {
    // We're authenticated as `__system`; ask to import into some other slug.
    const otherSlug = "mi-other-" + Date.now().toString(36);
    const res = await env.fetch(`/v1/tenants/${otherSlug}/manifest-import`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ mode: "validate", workflow: [] }),
    });
    expect(res.status).toBe(403);
  });
});
