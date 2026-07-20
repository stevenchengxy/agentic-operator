/**
 * /v1/llm/* — gateway introspection + provider-key management + model fleet.
 *
 * GET    /v1/llm/providers                → ProviderInfo[]
 * GET    /v1/llm/models?provider=…        → string[] (or full catalog when omitted)
 * GET    /v1/llm/catalog                  → Record<ProviderId, CatalogModel[]> (full metadata)
 * GET    /v1/llm/providers/keys           → masked metadata for every provider
 * GET    /v1/llm/providers/:id/key        → masked key + metadata for one provider
 * POST   /v1/llm/providers/:id/key        → save & rotate (body: { apiKey, scope })
 * DELETE /v1/llm/providers/:id/key        → remove a vault-managed key
 * POST   /v1/llm/providers/:id/test       → probe upstream with a candidate key
 * GET    /v1/llm/fleet                    → tenant's model fleet
 * POST   /v1/llm/fleet                    → add an entry
 * PATCH  /v1/llm/fleet/:id                → update an entry
 * DELETE /v1/llm/fleet/:id                → remove an entry
 */

import type { FastifyInstance } from "fastify";
import { PROVIDER_IDS, PROVIDER_MODEL_CATALOG, type ProviderId } from "@agentic/contracts";
import { getLLMGateway, resetLLMGateway } from "../../services/llm";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  getProviderKey,
  getProviderKeyMeta,
  deleteProviderKey,
  listProviderKeyMeta,
  setProviderKey,
  type KeyScope,
} from "../../services/provider-keys";
import { testProviderKey } from "../../services/provider-test";
import {
  addFleetEntry,
  deleteFleetEntry,
  FleetValidationError,
  listFleet,
  updateFleetEntry,
} from "../../services/model-fleet";
import {
  listAvailableModels,
  supportsLiveModelDiscovery,
} from "../../services/model-discovery";

function isProviderId(s: string): s is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(s);
}

function isKeyScope(s: unknown): s is KeyScope {
  return s === "workspace" || s === "tenant";
}

const NON_RUNTIME_PROVIDERS = new Set<ProviderId>(["mock", "bedrock", "vertex"]);

function providerAvailableInThisProcess(id: ProviderId): boolean {
  return process.env.NODE_ENV === "test" || !NON_RUNTIME_PROVIDERS.has(id);
}

function requireRuntimeProvider(id: ProviderId) {
  if (providerAvailableInThisProcess(id)) return;
  const err: Error & { statusCode?: number; code?: string } = new Error(
    `Provider ${id} is not an operational real-model provider in this build`,
  );
  err.statusCode = 409;
  err.code = "provider_unavailable";
  throw err;
}

export async function llmRoutes(app: FastifyInstance): Promise<void> {
  app.get("/llm/providers", async (req, reply) => {
    requirePermission(req, "models.read");
    const gateway = getLLMGateway();
    return reply.ok(gateway.listProviders().filter((p) => providerAvailableInThisProcess(p.id)));
  });

  app.get<{ Querystring: { provider?: string } }>(
    "/llm/models",
    async (req, reply) => {
      requirePermission(req, "models.read");
      const q = req.query.provider;
      if (q !== undefined && q !== "") {
        if (!isProviderId(q)) {
          return reply.fail("bad_request", `Unknown provider: ${q}`, 400);
        }
        requireRuntimeProvider(q);
        return reply.ok(PROVIDER_MODEL_CATALOG[q].map((m) => m.name));
      }

      const fullCatalog: Record<string, string[]> = {};
      for (const id of PROVIDER_IDS.filter(providerAvailableInThisProcess)) {
        fullCatalog[id] = PROVIDER_MODEL_CATALOG[id].map((m) => m.name);
      }
      return reply.ok(fullCatalog);
    },
  );

  // Full catalog with metadata (context, prices, capabilities). The plain
  // /llm/models endpoint returns names only for backwards-compat; this
  // endpoint is what the Settings UI uses to render the "Add model" picker.
  app.get("/llm/catalog", async (req, reply) => {
    requirePermission(req, "models.read");
    return reply.ok(Object.fromEntries(
      PROVIDER_IDS.filter(providerAvailableInThisProcess).map((id) => [id, PROVIDER_MODEL_CATALOG[id]]),
    ));
  });

  // ── Provider key vault ──────────────────────────────────────────────────
  // List masked key metadata for every provider — used by the Settings UI
  // to populate the credentials grid without fetching plaintext keys.
  app.get("/llm/providers/keys", async (req, reply) => {
    requirePermission(req, "models.read");
    return reply.ok(listProviderKeyMeta().filter((m) => providerAvailableInThisProcess(m.provider)));
  });

  app.get<{ Params: { id: string } }>("/llm/providers/:id/key", async (req, reply) => {
    requirePermission(req, "models.read");
    if (!isProviderId(req.params.id)) {
      return reply.fail("bad_request", `Unknown provider: ${req.params.id}`, 400);
    }
    requireRuntimeProvider(req.params.id);
    return reply.ok(getProviderKeyMeta(req.params.id));
  });

  app.post<{
    Params: { id: string };
    Body: { apiKey?: string; scope?: string };
  }>("/llm/providers/:id/key", async (req, reply) => {
    const auth = requirePermission(req, "models.write");
    const id = req.params.id;
    if (!isProviderId(id)) {
      return reply.fail("bad_request", `Unknown provider: ${id}`, 400);
    }
    requireRuntimeProvider(id);
    const { apiKey, scope } = req.body ?? {};
    if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
      return reply.fail("bad_request", "apiKey is required (min 8 chars)", 400);
    }
    if (!isKeyScope(scope)) {
      return reply.fail("bad_request", `scope must be "workspace" or "tenant"`, 400);
    }
    if (scope === "tenant") {
      return reply.fail(
        "tenant_key_scope_unavailable",
        "Tenant-scoped provider keys are not wired into the singleton runtime gateway; use workspace scope instead.",
        409,
      );
    }
    try {
      const meta = setProviderKey(id, {
        apiKey: apiKey.trim(),
        scope,
        setBy: auth.tenantSlug,
      });
      resetLLMGateway();
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "llm.key.rotate",
        targetType: "provider",
        targetId: id,
        meta: { scope, keyMasked: meta.keyMasked },
      });
      return reply.ok(meta);
    } catch (err) {
      return reply.fail("bad_request", (err as Error).message, 400);
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/llm/providers/:id/key",
    async (req, reply) => {
      const auth = requirePermission(req, "models.write");
      const id = req.params.id;
      if (!isProviderId(id)) {
        return reply.fail("bad_request", `Unknown provider: ${id}`, 400);
      }
      requireRuntimeProvider(id);
      try {
        const before = getProviderKeyMeta(id);
        if (before.source === "env") {
          return reply.fail(
            "provider_key_env_managed",
            `Provider ${id} is configured by environment and cannot be removed through the API`,
            409,
          );
        }
        if (!deleteProviderKey(id)) {
          return reply.fail("not_found", "provider key not found in vault", 404);
        }
        // The singleton captures an env overlay at construction time. Drop it
        // immediately so no subsequent call can keep using deleted material.
        resetLLMGateway();
        const effective = getProviderKeyMeta(id);
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "llm.key.delete",
          targetType: "provider",
          targetId: id,
          meta: {
            priorScope: before.scope,
            priorKeyMasked: before.keyMasked,
            effectiveSource: effective.source,
            hasEffectiveKey: effective.hasKey,
          },
        });
        return reply.ok({
          provider: id,
          deleted: true,
          effective,
        });
      } catch (error) {
        return reply.fail(
          "provider_key_delete_failed",
          error instanceof Error ? error.message : String(error),
          500,
        );
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: { apiKey?: string };
  }>("/llm/providers/:id/test", async (req, reply) => {
    const auth = requirePermission(req, "models.read");
    const id = req.params.id;
    if (!isProviderId(id)) {
      return reply.fail("bad_request", `Unknown provider: ${id}`, 400);
    }
    requireRuntimeProvider(id);
    // Candidate key from body wins; fall back to whatever the vault/env has
    // for the caller's tenant. The vault is tenant-scoped (P5-TEN-01) so we
    // pass the auth's tenantId to honor tenant-specific keys.
    const candidate = req.body?.apiKey?.trim();
    const key = candidate && candidate.length > 0
      ? candidate
      : (getProviderKey(id, auth.tenantId) ?? "");
    if (!key) {
      return reply.ok({
        ok: false,
        statusCode: null,
        latencyMs: 0,
        modelCount: null,
        message: "No key configured for this provider",
      });
    }
    const result = await testProviderKey(id, key);
    return reply.ok(result);
  });

  // ── Live model discovery ────────────────────────────────────────────────
  // The Settings "browse models" picker calls this to populate the checkbox
  // list. Only provider-confirmed live rows are selectable. The curated
  // catalog may enrich metadata for a matching live id, but it is never used
  // to manufacture "available" rows when discovery fails.
  app.get<{ Params: { id: string } }>(
    "/llm/providers/:id/available-models",
    async (req, reply) => {
      const auth = requirePermission(req, "models.read");
      const id = req.params.id;
      if (!isProviderId(id)) {
        return reply.fail("bad_request", `Unknown provider: ${id}`, 400);
      }
      requireRuntimeProvider(id);
      const key = getProviderKey(id, auth.tenantId) ?? "";
      const live = await listAvailableModels(id, key);
      const catalog = PROVIDER_MODEL_CATALOG[id];
      const catalogByName = new Map(catalog.map((m) => [m.name, m]));
      const fleetSet = new Set(
        listFleet(auth.tenantSlug)
          .filter((e) => e.provider === id)
          .map((e) => e.modelName),
      );

      type Merged = {
        id: string;
        contextLength: number | null;
        inputPricePerMTok: number | null;
        outputPricePerMTok: number | null;
        vision: boolean;
        tools: boolean;
        reasoning: boolean;
        inFleet: boolean;
        /** Where this row came from. */
        origin: "live" | "catalog";
      };

      const merged: Merged[] = [];

      // First pass: every live-discovered model (origin=live), with live
      // values taking precedence over catalog (the upstream is authoritative
      // for pricing/capabilities). Catalog only fills holes where live
      // didn't return the field — e.g. plain OpenAI /models has no pricing.
      for (const m of live.models) {
        const cat = catalogByName.get(m.id);
        merged.push({
          id: m.id,
          contextLength: m.contextLength ?? cat?.ctx ?? null,
          inputPricePerMTok: m.inputPricePerMTok ?? cat?.inP ?? null,
          outputPricePerMTok: m.outputPricePerMTok ?? cat?.outP ?? null,
          vision: m.vision ?? cat?.vision ?? false,
          tools: m.tools ?? cat?.tools ?? false,
          reasoning: cat?.reasoning ?? false,
          inFleet: fleetSet.has(m.id),
          origin: "live",
        });
      }

      merged.sort((a, b) => a.id.localeCompare(b.id));

      return reply.ok({
        provider: id,
        source: live.source,
        message: live.message,
        models: merged,
      });
    },
  );

  // ── Model fleet ─────────────────────────────────────────────────────────
  app.get("/llm/fleet", async (req, reply) => {
    const auth = requirePermission(req, "models.read");
    return reply.ok(listFleet(auth.tenantSlug).filter((e) => providerAvailableInThisProcess(e.provider)));
  });

  app.post<{
    Body: {
      provider?: string;
      modelName?: string;
      alias?: string;
      role?: string;
      dailyCapUsd?: number;
      maxOutTokens?: number;
      temperature?: number;
    };
  }>("/llm/fleet", async (req, reply) => {
    const auth = requirePermission(req, "models.write");
    try {
      const provider = req.body?.provider ?? "";
      const modelName = (req.body?.modelName ?? "").trim();
      if (!isProviderId(provider)) {
        throw new FleetValidationError(`unknown provider: ${provider}`);
      }
      requireRuntimeProvider(provider);
      if (!modelName) throw new FleetValidationError("modelName is required");

      let availability: "unverified" | "provider_confirmed" = "unverified";
      let availabilityCheckedAt: number | null = null;
      let availabilityMessage: string | null = null;
      if (supportsLiveModelDiscovery(provider)) {
        const key = getProviderKey(provider, auth.tenantId) ?? "";
        const discovered = await listAvailableModels(provider, key);
        if (discovered.source !== "live") {
          return reply.fail(
            "model_discovery_unavailable",
            discovered.message ?? `Could not verify ${provider}/${modelName}`,
            503,
          );
        }
        if (!discovered.models.some((model) => model.id === modelName)) {
          return reply.fail(
            "model_not_available",
            `${provider} did not report model '${modelName}' in its live model inventory`,
            409,
          );
        }
        availability = "provider_confirmed";
        availabilityCheckedAt = Date.now();
      } else {
        availabilityMessage = `Live discovery is unsupported for ${provider}; availability has not been provider-confirmed`;
      }
      const entry = addFleetEntry({
        tenantSlug: auth.tenantSlug,
        provider,
        modelName,
        alias: req.body?.alias,
        role: req.body?.role,
        dailyCapUsd: req.body?.dailyCapUsd,
        maxOutTokens: req.body?.maxOutTokens,
        temperature: req.body?.temperature,
        addedBy: auth.tenantSlug,
        availability,
        availabilityCheckedAt,
        availabilityMessage,
      });
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "llm.fleet.add",
        targetType: "model",
        targetId: entry.id,
        meta: {
          provider: entry.provider,
          modelName: entry.modelName,
          alias: entry.alias,
          role: entry.role,
          availability: entry.availability,
        },
      });
      return reply.ok(entry);
    } catch (err) {
      if (err instanceof FleetValidationError) {
        return reply.fail("bad_request", err.message, 400);
      }
      throw err;
    }
  });

  app.patch<{
    Params: { id: string };
    Body: {
      alias?: string;
      role?: string;
      dailyCapUsd?: number;
      maxOutTokens?: number;
      temperature?: number;
    };
  }>("/llm/fleet/:id", async (req, reply) => {
    const auth = requirePermission(req, "models.write");
    try {
      const entry = updateFleetEntry(auth.tenantSlug, req.params.id, req.body ?? {});
      if (!entry) return reply.fail("not_found", "fleet entry not found", 404);
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "llm.fleet.update",
        targetType: "model",
        targetId: entry.id,
        meta: req.body as Record<string, unknown>,
      });
      return reply.ok(entry);
    } catch (err) {
      if (err instanceof FleetValidationError) {
        return reply.fail("bad_request", err.message, 400);
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>("/llm/fleet/:id", async (req, reply) => {
    const auth = requirePermission(req, "models.write");
    const ok = deleteFleetEntry(auth.tenantSlug, req.params.id);
    if (!ok) return reply.fail("not_found", "fleet entry not found", 404);
    writeAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId ?? undefined,
      action: "llm.fleet.remove",
      targetType: "model",
      targetId: req.params.id,
    });
    return reply.ok({ id: req.params.id, deleted: true });
  });
}
