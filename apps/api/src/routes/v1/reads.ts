/**
 * Read endpoints — aggregations + lists that the web app pulls for views.
 * Each is a thin wrapper around queries/.
 */

import type { FastifyInstance } from "fastify";
import { requireAuth } from "../../plugins/auth";
import { getTenantCounts } from "../../queries/counts";
import { getDag } from "../../queries/workflows";
import { listEventTypes, listEntityTypes } from "../../queries/ontology";

export async function readsRoutes(app: FastifyInstance) {
  app.get("/counts", async (req, reply) => {
    const auth = requireAuth(req);
    return reply.ok(await getTenantCounts(auth.tenantSlug));
  });

  app.get<{ Querystring: { workflow?: string } }>(
    "/workflows/dag",
    async (req, reply) => {
      const auth = requireAuth(req);
      const workflow =
        typeof req.query?.workflow === "string" && req.query.workflow.trim()
          ? req.query.workflow.trim()
          : undefined;
      return reply.ok(await getDag(auth.tenantSlug, workflow));
    },
  );

  app.get("/event-types", async (req, reply) => {
    const auth = requireAuth(req);
    return reply.ok(await listEventTypes(auth.tenantSlug));
  });

  app.get("/entity-types", async (req, reply) => {
    const auth = requireAuth(req);
    return reply.ok(await listEntityTypes(auth.tenantSlug));
  });
}
