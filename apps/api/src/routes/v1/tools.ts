/**
 * GET /v1/tools — catalog of every tool registered in
 * @agentic/tools's globalToolRegistry.
 *
 * Powers the "Tools" view in the portal so manifest authors can browse
 * what's available without grepping the codebase. Every catalog entry
 * includes:
 *   - canonical name (use this verbatim in `tool_use[]`)
 *   - category (for UI grouping)
 *   - summary + description
 *   - configSchema      — keys the tool honours under `tool_use[].config`
 *   - configExample     — copy/paste-ready config block
 *   - aliases           — back-compat names that resolve to the same impl
 *   - sourcePath        — pointer into the repo for the curious
 *
 * The endpoint is read-only and unauthenticated-but-tenant-scoped (the
 * envelope wrapping requires auth context to land in the tenant's
 * portal anyway). Result is sorted by category, then name.
 */

import type { FastifyInstance } from "fastify";
import { listGlobalTools } from "@agentic/tools";
import { requireAuth } from "../../plugins/auth";
import { requirePermission } from "../../plugins/rbac";

export async function toolsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tools", async (req, reply) => {
    // requireAuth here purely to scope the response to a logged-in
    // operator. The catalog itself is global (same for every tenant) —
    // there's no per-tenant filtering today.
    requirePermission(req, "tools.read");
    const tools = listGlobalTools();
    return reply.ok({
      tools,
      count: tools.length,
      categories: Array.from(
        new Set(tools.map((t) => t.category)),
      ).sort(),
    });
  });
}
