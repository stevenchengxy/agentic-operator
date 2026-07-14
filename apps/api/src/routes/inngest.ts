import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { serve } from "inngest/fastify";
import type { Inngest } from "inngest";
import { getActiveHandler } from "../services/inngest-registry";

/**
 * Register Inngest's serve adapter at /inngest. Inngest CLI auto-discovers
 * by hitting this URL during dev sync. The handler responds to GET/POST/PUT.
 */
export async function inngestRoute(
  app: FastifyInstance,
  opts: { client: Inngest; functions: unknown[] },
) {
  const staticHandler = serve({
    client: opts.client,
    functions: opts.functions as never,
  }) as unknown as (
    req: FastifyRequest,
    reply: FastifyReply,
  ) => unknown;

  app.route({
    method: ["GET", "POST", "PUT"],
    url: "/inngest",
    handler: (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return getActiveHandler()(req, reply);
      } catch {
        // Keeps direct route-level tests and partial boots usable. Normal API
        // boot always initializes the mutable registry first.
        return staticHandler(req, reply);
      }
    },
  });
}
