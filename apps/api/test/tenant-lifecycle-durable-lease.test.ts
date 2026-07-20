import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditLog, getDb, operationLeases, tenants } from "@agentic/db";
import {
  beginFactoryActiveWork,
  hasFactoryActiveWork,
  listFactoryActiveWork,
} from "../src/services/agent-factory/active-work";
import { acquireDurableLease } from "../src/services/durable-lease";
import {
  TenantLifecycleError,
  transitionTenantLifecycle,
} from "../src/services/tenant-lifecycle";
import { tenantRuntimeMutationResourceKey } from "../src/services/tenant-runtime-mutation";

const SUFFIX = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const TENANT_ID = `ten-lifecycle-${SUFFIX}`;
const SLUG = `lifecycle-${SUFFIX}`.toLowerCase().slice(0, 52);

describe("durable lifecycle and factory leases", () => {
  beforeAll(() => {
    getDb()
      .insert(tenants)
      .values({ id: TENANT_ID, slug: SLUG, name: "Lifecycle lease fixture" })
      .run();
  });

  afterAll(() => {
    getDb().delete(tenants).where(eq(tenants.id, TENANT_ID)).run();
  });

  it("retains the legacy Factory wire key during the shared-lock migration", () => {
    expect(tenantRuntimeMutationResourceKey(TENANT_ID)).toBe(
      `factory-mutex:${TENANT_ID}`,
    );
  });

  it("restores the exact active state when archive sync fails", async () => {
    const db = getDb();
    const before = db
      .select()
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .all()[0]!;
    const sync = vi
      .fn<(slug: string) => Promise<number>>()
      .mockRejectedValueOnce(new Error("Inngest archive sync rejected"))
      .mockResolvedValueOnce(0);

    await expect(
      transitionTenantLifecycle(
        {
          tenantId: TENANT_ID,
          slug: SLUG,
          action: "archive",
          actorUserId: null,
          callerSlug: "__system",
          reason: "compensation test",
        },
        sync,
      ),
    ).rejects.toMatchObject<TenantLifecycleError>({
      code: "inngest_sync_failed",
      statusCode: 503,
    });

    expect(sync).toHaveBeenCalledTimes(2);
    const after = db
      .select()
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .all()[0]!;
    expect(after.archivedAt).toBeNull();
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, TENANT_ID),
            eq(auditLog.action, "tenant.archive"),
          ),
        )
        .all(),
    ).toHaveLength(0);
    expect(
      db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenantId, TENANT_ID),
            eq(auditLog.action, "tenant.archive.failed"),
          ),
        )
        .all(),
    ).toHaveLength(1);
  });

  it("restores the exact archived state when restore sync fails", async () => {
    const db = getDb();
    const archivedAt = new Date(Date.now() - 60_000);
    const updatedAt = new Date(Date.now() - 30_000);
    db.update(tenants)
      .set({ archivedAt, updatedAt })
      .where(eq(tenants.id, TENANT_ID))
      .run();
    const sync = vi
      .fn<(slug: string) => Promise<number>>()
      .mockRejectedValueOnce(new Error("Inngest restore sync rejected"))
      .mockResolvedValueOnce(1);

    await expect(
      transitionTenantLifecycle(
        {
          tenantId: TENANT_ID,
          slug: SLUG,
          action: "restore",
          actorUserId: null,
          callerSlug: "__system",
        },
        sync,
      ),
    ).rejects.toMatchObject<TenantLifecycleError>({
      code: "inngest_sync_failed",
      statusCode: 503,
    });

    const after = db
      .select()
      .from(tenants)
      .where(eq(tenants.id, TENANT_ID))
      .all()[0]!;
    expect(after.archivedAt?.getTime()).toBe(archivedAt.getTime());
    expect(after.updatedAt.getTime()).toBe(updatedAt.getTime());
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("refuses a concurrent lifecycle transition through the SQLite lease", async () => {
    const db = getDb();
    db.update(tenants)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(tenants.id, TENANT_ID))
      .run();
    const held = acquireDurableLease({
      resourceKey: tenantRuntimeMutationResourceKey(TENANT_ID),
      tenantId: TENANT_ID,
      kind: "tenant_lifecycle",
      workId: "held-by-other-process",
    });
    try {
      await expect(
        transitionTenantLifecycle(
          {
            tenantId: TENANT_ID,
            slug: SLUG,
            action: "archive",
            actorUserId: null,
            callerSlug: "__system",
          },
          async () => 0,
        ),
      ).rejects.toMatchObject<TenantLifecycleError>({
        code: "tenant_lifecycle_busy",
        statusCode: 409,
      });
      expect(
        db
          .select({ archivedAt: tenants.archivedAt })
          .from(tenants)
          .where(eq(tenants.id, TENANT_ID))
          .all()[0]?.archivedAt,
      ).toBeNull();
    } finally {
      held.release();
    }
  });

  it("stores detached Factory work in durable lease rows", () => {
    const endFirst = beginFactoryActiveWork(TENANT_ID, "report-one", "report");
    const endSecond = beginFactoryActiveWork(TENANT_ID, "report-two", "report");
    try {
      expect(hasFactoryActiveWork(TENANT_ID)).toBe(true);
      expect(listFactoryActiveWork(TENANT_ID)).toEqual(
        expect.arrayContaining([
          { id: "report-one", kind: "report" },
          { id: "report-two", kind: "report" },
        ]),
      );
      expect(
        getDb()
          .select()
          .from(operationLeases)
          .where(
            and(
              eq(operationLeases.tenantId, TENANT_ID),
              eq(operationLeases.kind, "factory_report"),
            ),
          )
          .all(),
      ).toHaveLength(2);
    } finally {
      endFirst();
      endSecond();
    }
    expect(hasFactoryActiveWork(TENANT_ID)).toBe(false);
  });
});
