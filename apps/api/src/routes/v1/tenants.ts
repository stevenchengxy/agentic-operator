/**
 * Tenant CRUD (P5-TEN-01).
 *
 *   GET    /v1/tenants                     list (membership-filtered for non-admins)
 *   GET    /v1/tenants/:slug               detail + counts
 *   POST   /v1/tenants                     create (transactional provisioning)
 *   PUT    /v1/tenants/:slug               update name/subtitle/color
 *   DELETE /v1/tenants/:slug               soft-archive (requires `confirm: <slug>`)
 *   POST   /v1/tenants/:slug/restore       lift archive
 *
 * Provisioning transaction (POST):
 *   1. Reserve slug (409 on collision)
 *   2. Insert tenants row
 *   3. Insert tenant_budgets defaults
 *   4. Insert membership (calling user → admin)
 *   5. Seed starter content (event_types, optional workflow stub)
 *   6. mkdir -p data/logs/<slug>/{runs,events}, data/tenants/<slug>, data/artifacts/<slug>
 *   7. Mint bootstrap api_token (returned plaintext ONCE)
 *   8. Audit row in same transaction
 *
 * Inngest re-registration happens AFTER the transaction commits so we never
 * register a tenant whose row failed to land. Existing tenant code in
 * data/tenants/<slug>/<version>/ is auto-picked-up by the dynamic loader on
 * next handler invocation; no immediate register is required for an empty
 * tenant.
 *
 * Slug rules: see TENANT_SLUG_REGEX + RESERVED_TENANT_SLUGS in
 * @agentic/contracts/tenants. Slug is immutable — PUT rejects any body
 * field other than name/subtitle/color (via `.strict()` on the Zod schema).
 *
 * Authorization (current milestone): every endpoint requires `requireAuth`.
 * The platform-admin gate (`isPlatformAdmin`) is a stub that always returns
 * false; for the milestone we allow any authenticated caller to create /
 * archive tenants. Production hardening (P5-TEN-02) tightens this to
 * platform admin only and adds role-based update gating.
 */

import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import {
  apiTokens,
  auditLog,
  entityTypes,
  eventTypes,
  getDb,
  memberships,
  tenantBudgets,
  tenants,
  users,
  workflows,
  workflowVersions,
} from "@agentic/db";
import { makeId } from "@agentic/shared";
import {
  TENANT_SLUG_REGEX,
  TenantArchiveBody,
  TenantCreateBody,
  TenantRestoreBody,
  TenantUpdateBody,
  isReservedSlug,
} from "@agentic/contracts";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import {
  getTenantDetail,
  listTenantsWithCounts,
  shapeTenantRow,
  tenantHasActiveWork,
  tenantSlugExists,
} from "../../queries/tenants";
// P5-TEN-01 — the dynamic Inngest re-register hook may not exist in every
// `reregisterInngest` lives in services/inngest-registry and now drives a real
// rebuild (`bootstrapRuntime` exports `rebuildTenantFns` + seeds the mutable
// serve handler). We still import it lazily and degrade to "next manifest
// deploy will pick it up" rather than crashing the handler if the export is
// missing — defensive against partial boots / future refactors.

async function safeReregisterInngest(): Promise<number | null> {
  try {
    const mod = await import("../../services/inngest-registry");
    if (typeof mod.reregisterInngest !== "function") return null;
    const out = await mod.reregisterInngest({ scope: "tenant" });
    return out.fnCount;
  } catch {
    return null;
  }
}

/**
 * Resolve the on-disk root where tenant code packages get extracted. Matches
 * `@agentic/runtime#dataTenantsRoot()` when that helper is available; falls
 * back to `${cwd}/data/tenants` otherwise. Kept inline so this route file
 * compiles against any version of @agentic/runtime.
 */
function tenantsCodeRoot(): string {
  const env = process.env.AGENTIC_TENANTS_DIR;
  if (env && env.length > 0) return env;
  return path.join(process.cwd(), "data", "tenants");
}

/**
 * Idempotency-Key cache. Bounded LRU keyed by `${tenantSlug}:${key}` so the
 * same operator retrying a 5xx never accidentally mints a second bootstrap
 * token. The cached value is the EXACT response body so retries see the same
 * plaintext token (else the first call's token is lost). 1-hour TTL is plenty
 * for the typical retry window without leaking memory.
 */
interface CachedResponse {
  body: unknown;
  status: number;
  at: number;
}
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
const idempotencyCache = new Map<string, CachedResponse>();

function cacheGet(key: string): CachedResponse | undefined {
  const v = idempotencyCache.get(key);
  if (!v) return undefined;
  if (Date.now() - v.at > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(key);
    return undefined;
  }
  return v;
}
function cacheSet(key: string, value: CachedResponse) {
  // Prune oldest entries if we exceed 256 — defensive, not a hot path.
  if (idempotencyCache.size >= 256) {
    const firstKey = idempotencyCache.keys().next().value;
    if (firstKey) idempotencyCache.delete(firstKey);
  }
  idempotencyCache.set(key, value);
}

/**
 * The seed user from packages/db/src/seed.ts. We attach the new tenant's admin
 * membership to this user when the caller has no identity (dev mode / token
 * with no `created_by_user_id`). Future P5-TEN-02 work replaces this with the
 * actual user id from the auth context once the token-user link lands.
 */
const SEED_ADMIN_EMAIL = "ops@agentic.local";

function resolveOperatorUserId(): string | null {
  const db = getDb();
  const u = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, SEED_ADMIN_EMAIL))
    .all()[0];
  return u?.id ?? null;
}

/**
 * Hash an opaque token the same way auth.ts does, so the mint flow stays
 * compatible with the existing bearer-token lookup.
 */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintBootstrapToken(): { plaintext: string; hash: string } {
  // 32 bytes of entropy is overkill but free; the `agentic_` prefix lets us
  // recognize our own tokens in operator logs.
  const raw = crypto.randomBytes(32).toString("base64url");
  const plaintext = `agentic_${raw}`;
  return { plaintext, hash: hashToken(plaintext) };
}

/**
 * mkdir -p the per-tenant data directories. Idempotent. Catches errors so
 * a partial filesystem doesn't roll back the DB transaction (the DB is the
 * source of truth; directories materialize on first use anyway).
 */
async function ensureTenantDirs(slug: string): Promise<string[]> {
  const repoRoot = process.cwd();
  // Walk up to find the data/ directory the same way db/client.ts does.
  // For correctness we use process.env.AGENTIC_DATA_ROOT when set.
  const dataRoot =
    process.env.AGENTIC_DATA_ROOT ?? path.join(repoRoot, "data");
  const dirs = [
    path.join(dataRoot, "logs", slug, "runs"),
    path.join(dataRoot, "logs", slug, "events"),
    path.join(dataRoot, "artifacts", slug),
    path.join(tenantsCodeRoot(), slug),
  ];
  for (const d of dirs) {
    try {
      await fs.mkdir(d, { recursive: true });
    } catch (err) {
      // Don't fail the request on FS errors — the dirs are recreated lazily
      // by the writers. Log and move on.
      console.warn(`[tenants] mkdir failed for ${d}:`, (err as Error).message);
    }
  }
  return dirs;
}

/** Starter event type catalog applied when starter='hello'. */
const HELLO_STARTER_EVENTS: Array<{
  name: string;
  category: string;
  color: string;
  description: string;
}> = [
  {
    name: "TENANT_BOOTSTRAPPED",
    category: "system",
    color: "blue",
    description: "Emitted once when the tenant is provisioned.",
  },
  {
    name: "HELLO_WORLD",
    category: "agent",
    color: "green",
    description: "Sample event for the starter workflow to react to.",
  },
];

interface CreateResult {
  body: {
    ok: true;
    data: unknown;
  };
  status: 201;
}

async function performCreate(
  req: FastifyRequest,
  body: TenantCreateBody,
  operatorUserId: string | null,
  callerSlug: string,
): Promise<CreateResult> {
  const db = getDb();

  if (tenantSlugExists(body.slug)) {
    const err: Error & { statusCode?: number; code?: string } = new Error(
      `tenant slug "${body.slug}" already exists`,
    );
    err.statusCode = 409;
    err.code = "slug_taken";
    throw err;
  }

  let copyFromTenantId: string | null = null;
  let copyFromSlug: string | null = null;
  if (typeof body.starter === "string" && body.starter.startsWith("copy-from:")) {
    copyFromSlug = body.starter.slice("copy-from:".length);
    const src = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, copyFromSlug))
      .all()[0];
    if (!src) {
      const err: Error & { statusCode?: number; code?: string } = new Error(
        `cannot copy from unknown tenant "${copyFromSlug}"`,
      );
      err.statusCode = 400;
      err.code = "copy_source_unknown";
      throw err;
    }
    copyFromTenantId = src.id;
  }

  const tenantId = makeId("ten");
  const now = new Date();
  const tokenMaterial = body.mintToken ? mintBootstrapToken() : null;
  const tokenId = makeId("tok");
  const auditId = makeId("aud");

  // Single transaction: tenant row + budget + membership + starter content
  // + token + audit. If any step throws, none persist — slug is freed.
  let seededEventTypes = 0;
  db.transaction(() => {
    db.insert(tenants)
      .values({
        id: tenantId,
        slug: body.slug,
        name: body.name,
        subtitle: body.subtitle ?? null,
        color: body.color ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(tenantBudgets)
      .values({
        tenantId,
        monthlyTokenCap: body.budget?.monthlyTokenCap ?? null,
        monthlyUsdCap: body.budget?.monthlyUsdCap ?? null,
        usedTokensMonth: 0,
        usedUsdMonth: 0,
        periodStart: now,
        updatedAt: now,
      })
      .run();

    if (operatorUserId) {
      db.insert(memberships)
        .values({
          userId: operatorUserId,
          tenantId,
          role: "admin",
        })
        .onConflictDoNothing({
          target: [memberships.userId, memberships.tenantId],
        })
        .run();
    }

    // Starter content. Note: `eventTypes` / `entityTypes` have only the
    // (tenantId, name, category, color, description, payloadJson) / (…entityId,
    // primaryKeyName, propertiesJson) shape in the HEAD schema — no
    // createdAt/updatedAt timestamp columns. Keep inserts minimal.
    if (body.starter === "hello") {
      for (const e of HELLO_STARTER_EVENTS) {
        db.insert(eventTypes)
          .values({
            tenantId,
            name: e.name,
            category: e.category,
            color: e.color,
            description: e.description,
            payloadJson: null,
          })
          .run();
        seededEventTypes++;
      }
    } else if (copyFromTenantId) {
      const srcEvents = db
        .select()
        .from(eventTypes)
        .where(eq(eventTypes.tenantId, copyFromTenantId))
        .all();
      for (const e of srcEvents) {
        db.insert(eventTypes)
          .values({
            tenantId,
            name: e.name,
            category: e.category,
            color: e.color,
            description: e.description,
            payloadJson: e.payloadJson,
          })
          .run();
        seededEventTypes++;
      }
      const srcEntities = db
        .select()
        .from(entityTypes)
        .where(eq(entityTypes.tenantId, copyFromTenantId))
        .all();
      for (const e of srcEntities) {
        db.insert(entityTypes)
          .values({
            tenantId,
            entityId: e.entityId,
            name: e.name,
            description: e.description,
            primaryKeyName: e.primaryKeyName,
            propertiesJson: e.propertiesJson,
          })
          .run();
      }
      // Clone the live workflow manifest (if any) as the new tenant's v1.
      const srcWf = db
        .select()
        .from(workflows)
        .where(eq(workflows.tenantId, copyFromTenantId))
        .all()[0];
      if (srcWf) {
        const srcWfv = db
          .select()
          .from(workflowVersions)
          .where(eq(workflowVersions.workflowId, srcWf.id))
          .all();
        if (srcWfv.length > 0) {
          const newWfId = makeId("wf");
          db.insert(workflows)
            .values({
              id: newWfId,
              tenantId,
              slug: srcWf.slug,
              name: srcWf.name,
              createdAt: now,
            })
            .run();
          const head = srcWfv[srcWfv.length - 1]!;
          db.insert(workflowVersions)
            .values({
              id: makeId("wfv"),
              workflowId: newWfId,
              version: "1.0.0",
              manifestJson: head.manifestJson,
              actionsJson: head.actionsJson,
              createdAt: now,
              createdBy: operatorUserId ?? null,
            })
            .run();
        }
      }
    }

    if (tokenMaterial) {
      db.insert(apiTokens)
        .values({
          id: tokenId,
          tenantId,
          hash: tokenMaterial.hash,
          name: "bootstrap",
          scopes: ["tenant:read", "tenant:write", "agents:invoke", "runs:read"],
          createdAt: now,
        })
        .run();
    }

    db.insert(auditLog)
      .values({
        id: auditId,
        tenantId,
        actorUserId: operatorUserId ?? null,
        action: "tenant.create",
        targetType: "tenant",
        targetId: tenantId,
        at: now,
        metaJson: {
          slug: body.slug,
          name: body.name,
          starter: body.starter,
          copy_from: copyFromSlug,
          mintToken: body.mintToken,
          by_tenant: callerSlug,
          seeded_event_types: seededEventTypes,
        } as never,
      })
      .run();
  });

  // Outside the transaction: filesystem + Inngest re-register.
  await ensureTenantDirs(body.slug);

  // The new tenant has no manifest yet, so reregister is mostly a no-op,
  // but call it so the dynamic loader picks up any pre-staged code dir.
  // safeReregisterInngest() returns null when the hook isn't wired in this
  // build — we still report success to the caller because the row is in.
  const inngestFnCount = await safeReregisterInngest();
  if (inngestFnCount === null) {
    req.log.debug?.("[tenants] reregister hook unavailable; deferred to next deploy");
  }

  const detail = await getTenantDetail(body.slug, { forUserId: operatorUserId });

  const starterSummary =
    body.starter === "empty"
      ? null
      : body.starter === "hello"
        ? { kind: "hello" as const, seededEventTypes }
        : {
            kind: "copy-from" as const,
            seededEventTypes,
            sourceSlug: copyFromSlug ?? undefined,
          };

  const responseData = {
    tenant: detail,
    membership: { role: "admin" as const },
    token: tokenMaterial
      ? {
          id: tokenId,
          name: "bootstrap",
          plaintext: tokenMaterial.plaintext,
          scopes: ["tenant:read", "tenant:write", "agents:invoke", "runs:read"],
        }
      : null,
    starter: starterSummary,
    inngestFns: inngestFnCount,
  };

  return {
    body: { ok: true, data: responseData },
    status: 201,
  };
}

export async function tenantsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET /v1/tenants ────────────────────────────────────────────────────
  app.get<{ Querystring: { include_archived?: string } }>(
    "/tenants",
    async (req, reply) => {
      const auth = requireAuth(req);
      const includeArchived =
        req.query?.include_archived === "1" ||
        req.query?.include_archived === "true";

      const operatorUserId = resolveOperatorUserId();
      const items = await listTenantsWithCounts({
        includeArchived,
        // Pre-platform-admin: in dev/op mode show every tenant. Once RBAC
        // lands we filter by membership for non-admin callers.
        forUserId: null,
      });

      return reply.ok({
        items,
        count: items.length,
        viewer: {
          tenantId: auth.tenantId,
          tenantSlug: auth.tenantSlug,
          userId: operatorUserId,
        },
      });
    },
  );

  // ── GET /v1/tenants/:slug ──────────────────────────────────────────────
  app.get<{ Params: { slug: string } }>("/tenants/:slug", async (req, reply) => {
    requireAuth(req);
    const slug = req.params.slug;
    if (!TENANT_SLUG_REGEX.test(slug)) {
      return reply.fail("invalid_slug", `slug "${slug}" is malformed`, 400);
    }
    const operatorUserId = resolveOperatorUserId();
    const detail = await getTenantDetail(slug, { forUserId: operatorUserId });
    if (!detail) {
      return reply.fail("tenant_not_found", `no tenant with slug "${slug}"`, 404);
    }
    return reply.ok(detail);
  });

  // ── POST /v1/tenants ───────────────────────────────────────────────────
  app.post("/tenants", async (req, reply) => {
    // P6-AUTH — creating a tenant is a platform-superadmin operation.
    const auth = requirePermission(req, "platform.tenants.create");
    const body = TenantCreateBody.parse(req.body);

    // Defense in depth: the Zod superRefine catches reserved slugs, but we
    // also guard against prefix/suffix patterns and direct-string matches.
    if (isReservedSlug(body.slug)) {
      return reply.fail(
        "reserved_slug",
        `slug "${body.slug}" is reserved and cannot be created`,
        400,
      );
    }

    const idemKey = req.headers["idempotency-key"];
    const cacheKey =
      typeof idemKey === "string" && idemKey.length > 0
        ? `${auth.tenantSlug}:${idemKey}`
        : null;
    if (cacheKey) {
      const cached = cacheGet(cacheKey);
      if (cached) {
        return reply.status(cached.status).send(cached.body);
      }
    }

    const operatorUserId = resolveOperatorUserId();
    let result: CreateResult;
    try {
      result = await performCreate(req, body, operatorUserId, auth.tenantSlug);
    } catch (err) {
      const e = err as Error & { statusCode?: number; code?: string };
      if (e.statusCode && e.code) {
        return reply.fail(e.code, e.message, e.statusCode);
      }
      throw err;
    }

    if (cacheKey) {
      cacheSet(cacheKey, {
        body: result.body,
        status: result.status,
        at: Date.now(),
      });
    }

    return reply.status(result.status).send(result.body);
  });

  // ── PUT /v1/tenants/:slug ──────────────────────────────────────────────
  app.put<{ Params: { slug: string } }>(
    "/tenants/:slug",
    async (req, reply) => {
      const auth = requireAuth(req);
      const slug = req.params.slug;
      const body = TenantUpdateBody.parse(req.body ?? {});

      const db = getDb();
      const row = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!row) {
        return reply.fail("tenant_not_found", `no tenant with slug "${slug}"`, 404);
      }

      // P6-AUTH — updating tenant attributes requires admin of THIS tenant or
      // a platform superadmin. (requirePermission checks the *active* tenant,
      // but the tenants page edits arbitrary rows, so we check :slug directly.)
      if (auth.platformRole !== "superadmin") {
        const m = db
          .select({ role: memberships.role })
          .from(memberships)
          .where(and(eq(memberships.userId, auth.userId ?? ""), eq(memberships.tenantId, row.id)))
          .all()[0];
        if (m?.role !== "admin") {
          return reply.fail("forbidden", "must be an admin of this tenant", 403);
        }
      }

      const now = new Date();
      const update: Partial<typeof tenants.$inferInsert> = { updatedAt: now };
      if (body.name !== undefined) update.name = body.name;
      if (body.subtitle !== undefined) update.subtitle = body.subtitle;
      if (body.color !== undefined) update.color = body.color;

      db.transaction(() => {
        db.update(tenants)
          .set(update)
          .where(eq(tenants.id, row.id))
          .run();
        db.insert(auditLog)
          .values({
            id: makeId("aud"),
            tenantId: row.id,
            actorUserId: resolveOperatorUserId(),
            action: "tenant.update",
            targetType: "tenant",
            targetId: row.id,
            at: now,
            metaJson: {
              changed: Object.keys(update).filter((k) => k !== "updatedAt"),
              before: {
                name: row.name,
                subtitle: row.subtitle,
                color: row.color,
              },
              by_tenant: auth.tenantSlug,
            } as never,
          })
          .run();
      });

      const detail = await getTenantDetail(slug, {
        forUserId: resolveOperatorUserId(),
      });
      return reply.ok(detail);
    },
  );

  // ── DELETE /v1/tenants/:slug (soft-archive) ────────────────────────────
  app.delete<{ Params: { slug: string } }>(
    "/tenants/:slug",
    async (req, reply) => {
      // P6-AUTH — archiving a tenant is a platform-superadmin operation.
      const auth = requirePermission(req, "platform.tenants.archive");
      const slug = req.params.slug;
      const body = TenantArchiveBody.parse(req.body ?? {});

      if (body.confirm !== slug) {
        return reply.fail(
          "confirm_mismatch",
          `confirm must equal the slug ("${slug}")`,
          400,
        );
      }
      if (slug === "__system" || isReservedSlug(slug)) {
        return reply.fail(
          "cannot_archive_system",
          `system tenant "${slug}" cannot be archived`,
          400,
        );
      }

      const db = getDb();
      const row = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!row) {
        return reply.fail("tenant_not_found", `no tenant with slug "${slug}"`, 404);
      }
      if (row.archivedAt) {
        return reply.fail(
          "already_archived",
          `tenant "${slug}" is already archived`,
          409,
        );
      }

      const active = tenantHasActiveWork(row.id);
      if (active.runs > 0 || active.tasks > 0) {
        return reply.fail(
          "has_active_work",
          `tenant has ${active.runs} active runs and ${active.tasks} open tasks; resolve them before archiving`,
          409,
        );
      }

      const now = new Date();
      db.transaction(() => {
        db.update(tenants)
          .set({ archivedAt: now, updatedAt: now })
          .where(eq(tenants.id, row.id))
          .run();
        db.insert(auditLog)
          .values({
            id: makeId("aud"),
            tenantId: row.id,
            actorUserId: resolveOperatorUserId(),
            action: "tenant.archive",
            targetType: "tenant",
            targetId: row.id,
            at: now,
            metaJson: {
              slug,
              reason: body.reason ?? null,
              by_tenant: auth.tenantSlug,
            } as never,
          })
          .run();
      });

      await safeReregisterInngest();

      return reply.ok({
        slug,
        archivedAt: now.getTime(),
      });
    },
  );

  // ── POST /v1/tenants/:slug/restore ─────────────────────────────────────
  app.post<{ Params: { slug: string } }>(
    "/tenants/:slug/restore",
    async (req, reply) => {
      // P6-AUTH — restoring a tenant is a platform-superadmin operation.
      const auth = requirePermission(req, "platform.tenants.archive");
      const slug = req.params.slug;
      const body = TenantRestoreBody.parse(req.body ?? {});

      const db = getDb();
      const row = db
        .select()
        .from(tenants)
        .where(eq(tenants.slug, slug))
        .all()[0];
      if (!row) {
        return reply.fail("tenant_not_found", `no tenant with slug "${slug}"`, 404);
      }
      if (!row.archivedAt) {
        return reply.fail(
          "not_archived",
          `tenant "${slug}" is not archived`,
          409,
        );
      }

      const now = new Date();
      db.transaction(() => {
        db.update(tenants)
          .set({ archivedAt: null, updatedAt: now })
          .where(eq(tenants.id, row.id))
          .run();
        db.insert(auditLog)
          .values({
            id: makeId("aud"),
            tenantId: row.id,
            actorUserId: resolveOperatorUserId(),
            action: "tenant.restore",
            targetType: "tenant",
            targetId: row.id,
            at: now,
            metaJson: {
              slug,
              reason: body.reason ?? null,
              by_tenant: auth.tenantSlug,
            } as never,
          })
          .run();
      });

      await safeReregisterInngest();

      const detail = await getTenantDetail(slug, {
        forUserId: resolveOperatorUserId(),
      });
      return reply.ok(detail);
    },
  );

  // Defensive: a poller hitting GET /tenants/active (very-common SPA mistake)
  // returns a useful 404 rather than 500 from Drizzle.
  void and;
  void isNull;
}
