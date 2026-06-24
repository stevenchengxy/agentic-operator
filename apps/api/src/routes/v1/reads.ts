/**
 * Read endpoints — aggregations + lists that the web app pulls for views.
 * Each is a thin wrapper around queries/.
 */

import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";
import { getTenantCounts } from "../../queries/counts";
import { getDag } from "../../queries/workflows";
import { getFunnel } from "../../queries/funnel";
import { listEventTypes, listEntityTypes } from "../../queries/ontology";

export async function readsRoutes(app: FastifyInstance) {
  app.get("/counts", async (req, reply) => {
    const auth = requirePermission(req, "dashboard.read");
    return reply.ok(await getTenantCounts(auth.tenantSlug));
  });

  app.get("/funnel", async (req, reply) => {
    const auth = requirePermission(req, "dashboard.read");
    const window = (req.query as { window?: string } | undefined)?.window;
    return reply.ok(await getFunnel(auth.tenantSlug, window));
  });

  app.get("/workflows/dag", async (req, reply) => {
    const auth = requirePermission(req, "dashboard.read");
    return reply.ok(await getDag(auth.tenantSlug));
  });

  app.get("/event-types", async (req, reply) => {
    const auth = requirePermission(req, "dashboard.read");
    return reply.ok(await listEventTypes(auth.tenantSlug));
  });

  app.get("/entity-types", async (req, reply) => {
    const auth = requirePermission(req, "dashboard.read");
    return reply.ok(await listEntityTypes(auth.tenantSlug));
  });
}
