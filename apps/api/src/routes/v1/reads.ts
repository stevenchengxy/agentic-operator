/**
 * Read endpoints — aggregations + lists that the web app pulls for views.
 * Each is a thin wrapper around queries/.
 */

import type { FastifyInstance } from "fastify";
import { can, requirePermission } from "../../plugins/rbac";
import { getTenantCounts } from "../../queries/counts";
import { getDag } from "../../queries/workflows";
import { getThroughput } from "../../queries/throughput";
import { getRecentActivity } from "../../queries/activity";
import { listEventTypes, listEntityTypes } from "../../queries/ontology";

export async function readsRoutes(app: FastifyInstance) {
  app.get("/counts", async (req, reply) => {
    const auth = requirePermission(req, "dashboard.read");
    return reply.ok(await getTenantCounts(auth.tenantSlug));
  });

  app.get("/throughput", async (req, reply) => {
    const auth = requirePermission(req, "dashboard.read");
    const window = (req.query as { window?: string } | undefined)?.window;
    return reply.ok(await getThroughput(auth.tenantSlug, window));
  });

  // Backfill for the live terminal — recent lifecycle reconstructed from the
  // database plus exact runtime file logs as RunStreamEvent[] (chronological).
  app.get("/activity", async (req, reply) => {
    const auth = requirePermission(req, "events.read");
    const limit = (req.query as { limit?: string } | undefined)?.limit;
    return reply.ok(
      await getRecentActivity(auth.tenantSlug, limit, {
        includeAudit: can(auth, "audit.read"),
        includeFileLogs: can(auth, "runs.read"),
        includeRuns: can(auth, "runs.read"),
        includeTasks: can(auth, "tasks.read"),
        includeUsage: can(auth, "usage.read"),
        includeDeployments: can(auth, "deployments.read"),
      }),
    );
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
