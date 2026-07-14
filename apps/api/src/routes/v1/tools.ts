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
import { getExpandedTenantRegistry } from "../../bootstrap";

export async function toolsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/tools", async (req, reply) => {
    // The effective catalog is tenant-scoped: tenant overrides and expanded
    // MCP/skill tools are merged with the global catalog after authentication.
    const auth = requireAuth(req);
    const registry = getExpandedTenantRegistry(auth.tenantSlug);
    const global = listGlobalTools();
    const globalNames = new Set(
      global.flatMap((tool) => [tool.name, ...(tool.aliases ?? [])]),
    );
    const tools = global.map((tool) => ({
      ...tool,
      source: registry?.tools?.[tool.name] ? "tenant_override" : "global",
      available: true,
    }));
    for (const [name, descriptor] of Object.entries(registry?.tools ?? {})) {
      if (globalNames.has(name)) continue;
      const source = name.includes(".") ? "mcp_or_skill" : "tenant";
      tools.push({
        name,
        category: source === "tenant" ? "tenant" : name.split(".")[0]!,
        summary: descriptor.description ?? `Tenant-effective tool '${name}'.`,
        description: descriptor.description,
        sourcePath: "tenant-effective registry",
        source,
        available: true,
        sideEffect: "write",
        testPolicy: "block",
      });
    }
    tools.sort((left, right) =>
      left.category === right.category
        ? left.name.localeCompare(right.name)
        : left.category.localeCompare(right.category),
    );
    return reply.ok({
      tools,
      count: tools.length,
      categories: Array.from(new Set(tools.map((t) => t.category))).sort(),
    });
  });
}
