import type { FastifyInstance, FastifyReply } from "fastify";
import type { AuthedContext } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { getRun } from "../../services/agent-factory";
import {
  FACTORY_FIXTURE_ASSET_MAX_BYTES,
  FactoryFixtureAssetError,
  FsFactoryFixtureAssetStore,
  type FactoryFixtureAssetPutInput,
  type FactoryFixtureAssetScope,
} from "../../services/agent-factory/fixture-asset-store";

// An 8 MiB binary needs 11.19 MiB of canonical base64.  Leave a bounded
// allowance for JSON field names and the validated filename/path metadata;
// this route-level limit intentionally overrides the smaller general API body
// limit without making every endpoint accept oversized requests.
export const FACTORY_FIXTURE_UPLOAD_BODY_LIMIT =
  4 * Math.ceil(FACTORY_FIXTURE_ASSET_MAX_BYTES / 3) + 128 * 1024;

type FactoryFixtureConversation = {
  id: string;
  domain: string;
  deletedAt: string | null;
};

export interface FactoryFixtureAssetRouteDependencies {
  requireBoundDomain: (
    auth: AuthedContext,
    domain: string,
  ) => Promise<unknown>;
  store?: FsFactoryFixtureAssetStore;
  loadConversation?: (
    id: string,
    tenantId: string,
  ) => FactoryFixtureConversation | null;
}

const DOMAIN_ERROR_CODES = new Set([
  "domain_unbound",
  "domain_mismatch",
  "domain_unavailable",
]);

function domainFailure(reply: FastifyReply, error: unknown) {
  const code = String((error as { code?: unknown })?.code ?? "");
  if (DOMAIN_ERROR_CODES.has(code)) {
    return reply.fail(code, (error as Error).message, 409);
  }
  throw error;
}

function fixtureFailure(reply: FastifyReply, error: unknown) {
  if (!(error instanceof FactoryFixtureAssetError)) throw error;
  const status =
    error.code === "fixture_too_large"
      ? 413
      : error.code === "fixture_hash_mismatch"
        ? 422
        : error.code === "fixture_asset_corrupt"
          ? 503
          : 400;
  return reply.fail(error.code, error.message, status);
}

function exactUploadBody(value: unknown): FactoryFixtureAssetPutInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FactoryFixtureAssetError(
      "invalid_fixture_request",
      "fixture upload body must be a JSON object",
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "caseId",
    "path",
    "base64",
    "mimeType",
    "filename",
    "sha256",
  ]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length) {
    const names = unknown
      .slice(0, 5)
      .map((key) => key.replace(/[\r\n\t]/g, " ").slice(0, 64))
      .join(", ");
    throw new FactoryFixtureAssetError(
      "invalid_fixture_request",
      `fixture upload contains unsupported fields: ${names}${unknown.length > 5 ? ` (+${unknown.length - 5} more)` : ""}`,
    );
  }
  return {
    caseId: record.caseId as string,
    path: record.path as string,
    base64: record.base64 as string,
    ...(record.mimeType !== undefined
      ? { mimeType: record.mimeType as string }
      : {}),
    ...(record.filename !== undefined
      ? { filename: record.filename as string }
      : {}),
    ...(record.sha256 !== undefined
      ? { sha256: record.sha256 as string }
      : {}),
  };
}

/**
 * Register the HTTP-only fixture asset transport under Agent Factory runs.
 * Domain identity is derived from the tenant-owned run; callers cannot submit
 * or override a domain/conversation scope in JSON.
 */
export async function registerFactoryFixtureAssetRoutes(
  app: FastifyInstance,
  dependencies: FactoryFixtureAssetRouteDependencies,
): Promise<void> {
  const store = dependencies.store ?? new FsFactoryFixtureAssetStore();
  const loadConversation = dependencies.loadConversation ?? getRun;

  const resolveScope = async (
    auth: AuthedContext,
    runId: string,
    reply: FastifyReply,
  ): Promise<FactoryFixtureAssetScope | null> => {
    const run = loadConversation(runId, auth.tenantId);
    if (!run || run.deletedAt) {
      reply.fail("conversation_not_found", "factory conversation not found", 404);
      return null;
    }
    try {
      await dependencies.requireBoundDomain(auth, run.domain);
    } catch (error) {
      domainFailure(reply, error);
      return null;
    }
    return {
      tenantId: auth.tenantId,
      domain: run.domain,
      conversationId: run.id,
    };
  };

  app.post<{
    Params: { runId: string };
    Body: unknown;
  }>(
    "/agent-factory/runs/:runId/fixtures",
    { bodyLimit: FACTORY_FIXTURE_UPLOAD_BODY_LIMIT },
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const scope = await resolveScope(auth, req.params.runId, reply);
      if (!scope) return reply;
      try {
        const asset = await store.put(scope, exactUploadBody(req.body));
        // Deliberately return only non-content metadata. caseId/path remain in
        // the server-owned record and base64 is never reflected over HTTP.
        return reply.ok(asset, 201);
      } catch (error) {
        return fixtureFailure(reply, error);
      }
    },
  );

  app.get<{ Params: { runId: string; assetId: string } }>(
    "/agent-factory/runs/:runId/fixtures/:assetId",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.read");
      const scope = await resolveScope(auth, req.params.runId, reply);
      if (!scope) return reply;
      try {
        const asset = await store.inspect(scope, req.params.assetId);
        if (!asset) {
          return reply.fail("fixture_not_found", "fixture asset not found", 404);
        }
        return reply.ok(asset);
      } catch (error) {
        return fixtureFailure(reply, error);
      }
    },
  );

  app.delete<{ Params: { runId: string; assetId: string } }>(
    "/agent-factory/runs/:runId/fixtures/:assetId",
    async (req, reply) => {
      const auth = requirePermission(req, "agents.invoke");
      const scope = await resolveScope(auth, req.params.runId, reply);
      if (!scope) return reply;
      try {
        const deleted = await store.delete(scope, req.params.assetId);
        if (!deleted) {
          return reply.fail("fixture_not_found", "fixture asset not found", 404);
        }
        return reply.ok({ deleted: true });
      } catch (error) {
        return fixtureFailure(reply, error);
      }
    },
  );
}
