import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { serve } from "inngest/fastify";
import type { Inngest } from "inngest";
import { getActiveHandler } from "../services/inngest-registry";

/**
 * Register Inngest's serve adapter at /inngest. Inngest CLI auto-discovers
 * by hitting this URL during dev sync. The handler responds to GET/POST/PUT.
 *
 * The route delegates to the MUTABLE handler held in `inngest-registry` so a
 * runtime re-register (deploy / undeploy / archive) swaps the served function
 * set without a restart. `bootstrapRuntime` seeds that registry via
 * `initInngestRegistry` before this route ever takes a request. If the
 * registry was never initialized (a partial test boot that wires the route
 * directly), we fall back to a STATIC handler built from `opts.functions`,
 * preserving the old behavior.
 */
export async function inngestRoute(
  app: FastifyInstance,
  opts: { client: Inngest; functions: unknown[] },
) {
  // Static fallback — only used if the mutable registry is uninitialized.
  const staticHandler = serve({
    client: opts.client,
    functions: opts.functions as never,
  });

  app.route({
    method: ["GET", "POST", "PUT"],
    url: "/inngest",
    handler: (req: FastifyRequest, reply: FastifyReply) => {
      let handler: (req: FastifyRequest, reply: FastifyReply) => unknown;
      try {
        handler = getActiveHandler() as typeof handler;
      } catch {
        handler = staticHandler as unknown as typeof handler;
      }
      return handler(req, reply);
    },
  });
}
