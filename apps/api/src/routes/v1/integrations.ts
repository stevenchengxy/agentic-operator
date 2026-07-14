/**
 * /v1/integrations — per-tenant external-service integrations backing
 * Settings → Integrations. First provider: the GoHire ATS.
 *
 *   GET    /v1/integrations                  — list configured + available
 *   PUT    /v1/integrations                  — upsert one (base URL + API key)
 *   DELETE /v1/integrations/:provider        — remove one
 *   POST   /v1/integrations/:provider/test   — connection test (health probe)
 *
 * Tenant-scoped via requireAuth — every read/write is bound to the caller's
 * tenant; a provider row in tenant A is invisible + unmodifiable from tenant
 * B. API keys are write-only over the wire: the upsert body accepts the
 * plaintext, but every response carries only a masked fragment.
 */

import type { FastifyInstance } from "fastify";
import {
  ListIntegrationsResponse,
  UpsertIntegrationBody,
  INTEGRATION_PROVIDERS,
  type IntegrationStatus,
} from "@agentic/contracts";
import { gohire } from "@agentic/tools";
import { requireAuth } from "../../plugins/auth";
import {
  deleteIntegration,
  getIntegrationRow,
  listIntegrations,
  setIntegrationHealth,
  toPublic,
  upsertIntegration,
} from "../../services/integration-store";

const AVAILABLE = INTEGRATION_PROVIDERS.map((p) => ({
  id: p.id,
  name: p.name,
  kind: p.kind,
  defaultBaseUrl: p.defaultBaseUrl,
  description: p.description,
  docsUrl: p.docsUrl,
}));

/** Map a provider id to its health-probe tool, when one exists. */
function healthToolFor(provider: string) {
  if (provider === "gohire") return gohire.gohireHealthApi;
  return null;
}

export async function integrationsRoutes(app: FastifyInstance): Promise<void> {
  // GET /v1/integrations — configured rows + the provider catalog.
  app.get("/integrations", async (req, reply) => {
    const auth = requireAuth(req);
    const payload = ListIntegrationsResponse.parse({
      integrations: listIntegrations(auth.tenantId),
      available: AVAILABLE,
    });
    return reply.ok(payload);
  });

  // PUT /v1/integrations — upsert (keyed on tenant + provider).
  app.put("/integrations", async (req, reply) => {
    const auth = requireAuth(req);
    const body = UpsertIntegrationBody.parse(req.body);
    const saved = upsertIntegration({
      tenantId: auth.tenantId,
      provider: body.provider,
      name: body.name,
      baseUrl: body.baseUrl,
      apiKey: body.apiKey,
      enabled: body.enabled,
      createdBy: auth.via,
    });
    try {
      const audit = await import("../../plugins/audit");
      audit.writeAudit({
        tenantId: auth.tenantId,
        action: "integration.upsert",
        targetType: "integration",
        targetId: saved.id,
        // Field names only — never the key value.
        meta: {
          provider: body.provider,
          base_url_set: body.baseUrl !== undefined,
          key_changed: body.apiKey !== undefined,
          auth_via: auth.via ?? null,
        },
      });
    } catch (err) {
      req.log.warn({ err }, "integration.upsert: audit write failed");
    }
    return reply.ok(saved);
  });

  // DELETE /v1/integrations/:provider
  app.delete<{ Params: { provider: string } }>(
    "/integrations/:provider",
    async (req, reply) => {
      const auth = requireAuth(req);
      const removed = deleteIntegration(auth.tenantId, req.params.provider);
      if (!removed) return reply.fail("not_found", "integration not found", 404);
      try {
        const audit = await import("../../plugins/audit");
        audit.writeAudit({
          tenantId: auth.tenantId,
          action: "integration.delete",
          targetType: "integration",
          targetId: req.params.provider,
          meta: { provider: req.params.provider, auth_via: auth.via ?? null },
        });
      } catch {
        /* audit best-effort */
      }
      return reply.ok({ deleted: true });
    },
  );

  // POST /v1/integrations/:provider/test — probe the provider's health
  // endpoint using the stored creds, then cache the result on the row so the
  // Settings list can show a health pill without re-probing.
  app.post<{ Params: { provider: string } }>(
    "/integrations/:provider/test",
    async (req, reply) => {
      const auth = requireAuth(req);
      const provider = req.params.provider;
      const row = getIntegrationRow(auth.tenantId, provider);
      if (!row) return reply.fail("not_found", "integration not found", 404);

      const tool = healthToolFor(provider);
      if (!tool) {
        return reply.fail(
          "unsupported",
          `no connection test available for provider '${provider}'`,
          400,
        );
      }

      let status: IntegrationStatus = "ok";
      let message: string | null = null;
      try {
        // The tool reads base URL + key for this tenant via the injected
        // integration resolver (set at bootstrap), so no secret is passed
        // through this layer.
        await tool.handler({
          agentName: "settings",
          actionName: `${provider}.health`,
          correlationId: `integration-test-${provider}`,
          tenantSlug: auth.tenantSlug,
          subject: undefined,
          event: { name: `integration:${provider}:test`, data: {} },
        });
      } catch (err) {
        status = "error";
        message = err instanceof Error ? err.message : String(err);
      }

      setIntegrationHealth(auth.tenantId, provider, status, message);
      const updated = getIntegrationRow(auth.tenantId, provider);
      return reply.ok({
        ok: status === "ok",
        status,
        message,
        checkedAt: updated?.lastCheckedAt ? updated.lastCheckedAt.getTime() : Date.now(),
        integration: updated ? toPublic(updated) : null,
      });
    },
  );
}
