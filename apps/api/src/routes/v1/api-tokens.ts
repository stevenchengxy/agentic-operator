/**
 * Tenant-scoped workspace API-token lifecycle.
 *
 *   GET    /v1/api-tokens              — list public metadata
 *   POST   /v1/api-tokens              — create; plaintext returned once
 *   POST   /v1/api-tokens/:id/rotate   — replace secret; plaintext returned once
 *   DELETE /v1/api-tokens/:id          — revoke immediately
 *
 * Only the SHA-256 digest is persisted, matching the bearer-auth lookup in
 * `plugins/auth.ts`. Every id lookup is constrained by the authenticated
 * tenant, preventing token enumeration or mutation across workspaces.
 */

import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq } from "drizzle-orm";
import {
  API_TOKEN_DISPLAY_PREFIX,
  API_TOKEN_SCOPE,
  ApiTokenParams,
  ApiTokenPublic,
  ApiTokenSecret,
  CreateApiTokenBody,
  ListApiTokensResponse,
  RevokeApiTokenResponse,
} from "@agentic/contracts";
import { apiTokens, getDb } from "@agentic/db";
import { makeId } from "@agentic/shared";
import { requireTenantAdmin } from "../../plugins/auth";
import { writeAudit } from "../../plugins/audit";

function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

function mintToken(): { plaintext: string; hash: string } {
  const plaintext = `${API_TOKEN_DISPLAY_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { plaintext, hash: hashToken(plaintext) };
}

function toPublic(row: typeof apiTokens.$inferSelect) {
  return ApiTokenPublic.parse({
    id: row.id,
    name: row.name,
    prefix: API_TOKEN_DISPLAY_PREFIX,
    scopes: row.scopes,
    createdAt: row.createdAt.getTime(),
    lastUsedAt: row.lastUsedAt?.getTime() ?? null,
  });
}

export async function apiTokensRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api-tokens", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const rows = getDb()
      .select()
      .from(apiTokens)
      .where(eq(apiTokens.tenantId, auth.tenantId))
      .orderBy(desc(apiTokens.createdAt))
      .all();

    reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    return reply.ok(
      ListApiTokensResponse.parse({
        items: rows.map(toPublic),
        count: rows.length,
      }),
    );
  });

  app.post("/api-tokens", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const body = CreateApiTokenBody.parse(req.body);
    const token = mintToken();
    const now = new Date();
    const row: typeof apiTokens.$inferSelect = {
      id: makeId("tok"),
      tenantId: auth.tenantId,
      hash: token.hash,
      name: body.name,
      scopes: [API_TOKEN_SCOPE],
      createdAt: now,
      lastUsedAt: null,
    };

    const db = getDb();
    db.transaction(() => {
      db.insert(apiTokens).values(row).run();
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "token.create",
        targetType: "api_token",
        targetId: row.id,
        meta: {
          name: row.name,
          scope: API_TOKEN_SCOPE,
          auth_via: auth.via,
        },
      });
    });

    reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    return reply.ok(
      ApiTokenSecret.parse({ ...toPublic(row), plaintext: token.plaintext }),
      201,
    );
  });

  app.post("/api-tokens/:id/rotate", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const params = ApiTokenParams.parse(req.params);
    const db = getDb();
    const existing = db
      .select()
      .from(apiTokens)
      .where(
        and(eq(apiTokens.id, params.id), eq(apiTokens.tenantId, auth.tenantId)),
      )
      .all()[0];

    if (!existing) {
      return reply.fail("not_found", "API token not found", 404);
    }

    const token = mintToken();
    const rotated: typeof apiTokens.$inferSelect = {
      ...existing,
      hash: token.hash,
      scopes: [API_TOKEN_SCOPE],
      lastUsedAt: null,
    };

    db.transaction(() => {
      db.update(apiTokens)
        .set({
          hash: rotated.hash,
          scopes: rotated.scopes,
          lastUsedAt: null,
        })
        .where(
          and(
            eq(apiTokens.id, params.id),
            eq(apiTokens.tenantId, auth.tenantId),
          ),
        )
        .run();
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "token.rotate",
        targetType: "api_token",
        targetId: existing.id,
        meta: {
          name: existing.name,
          scope: API_TOKEN_SCOPE,
          auth_via: auth.via,
        },
      });
    });

    reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
    return reply.ok(
      ApiTokenSecret.parse({
        ...toPublic(rotated),
        plaintext: token.plaintext,
      }),
    );
  });

  app.delete("/api-tokens/:id", async (req, reply) => {
    const auth = requireTenantAdmin(req);
    const params = ApiTokenParams.parse(req.params);
    const db = getDb();
    const existing = db
      .select()
      .from(apiTokens)
      .where(
        and(eq(apiTokens.id, params.id), eq(apiTokens.tenantId, auth.tenantId)),
      )
      .all()[0];

    if (!existing) {
      return reply.fail("not_found", "API token not found", 404);
    }

    db.transaction(() => {
      db.delete(apiTokens)
        .where(
          and(
            eq(apiTokens.id, params.id),
            eq(apiTokens.tenantId, auth.tenantId),
          ),
        )
        .run();
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "token.revoke",
        targetType: "api_token",
        targetId: existing.id,
        meta: {
          name: existing.name,
          scope: API_TOKEN_SCOPE,
          auth_via: auth.via,
        },
      });
    });

    return reply.ok(
      RevokeApiTokenResponse.parse({ id: existing.id, revoked: true }),
    );
  });
}
