import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { appIdForTenant } from "@agentic/runtime";
import { baseServeSlug, getHandlerForApp } from "../services/inngest-registry";

/**
 * Inngest serve adapter — ONE app per tenant.
 *
 *   - `/inngest`         → the base app auto-discovered by the inngest-cli
 *                          `-u .../inngest` flag. By default this is the
 *                          platform `__system` app; when INNGEST_MAIN_TENANT is
 *                          set, it is that tenant's legacy-compatible app.
 *   - `/inngest/:slug`   → the tenant app `agentic-operator-<slug>`, registered
 *                          explicitly via `inngest-sync.ts` PUT self-sync.
 *
 * Both routes delegate to the MUTABLE per-app handler held in
 * `inngest-registry`, so a runtime re-register (deploy / agent enable-disable /
 * archive / tenant onboarding) swaps the served function set for one app
 * without a restart. The registry is seeded by `bootstrapRuntime` before this
 * route takes a request.
 */
export async function inngestRoute(app: FastifyInstance): Promise<void> {
  // Base app at the base path.
  app.route({
    method: ["GET", "POST", "PUT"],
    url: "/inngest",
    handler: (req: FastifyRequest, reply: FastifyReply) => {
      const slug = baseServeSlug();
      const handler = getHandlerForApp(appIdForTenant(slug));
      if (!handler) {
        return reply
          .code(503)
          .send({ error: "inngest registry not initialized" });
      }
      return handler(req, reply);
    },
  });

  // Per-tenant apps.
  app.route({
    method: ["GET", "POST", "PUT"],
    url: "/inngest/:slug",
    handler: (req: FastifyRequest, reply: FastifyReply) => {
      const slug = (req.params as { slug: string }).slug;
      const handler = getHandlerForApp(appIdForTenant(slug));
      if (!handler) {
        // Unknown / never-registered / hard-removed tenant.
        return reply
          .code(404)
          .send({ error: `no inngest app registered for tenant '${slug}'` });
      }
      return handler(req, reply);
    },
  });
}
