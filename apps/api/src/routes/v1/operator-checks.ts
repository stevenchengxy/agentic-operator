import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  GetOperatorCheckResponseSchema,
  ListOperatorChecksQuerySchema,
  ListOperatorChecksResponseSchema,
  StartOperatorCheckResponseSchema,
} from "@agentic/contracts";
import { requireAuth } from "../../plugins/auth";
import {
  getOperatorCheck,
  listOperatorChecks,
  OperatorCheckNotFoundError,
  startOperatorCheck,
  type OperatorCheckHttpClient,
} from "../../services/operator-checks";

function forwardedAuthHeaders(req: FastifyRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  if (typeof req.headers.authorization === "string") {
    headers.authorization = req.headers.authorization;
  }
  if (typeof req.headers.cookie === "string") {
    headers.cookie = req.headers.cookie;
  }
  const tenant = req.headers["x-agentic-tenant"];
  const tenantValue = Array.isArray(tenant) ? tenant[0] : tenant;
  if (typeof tenantValue === "string") {
    headers["x-agentic-tenant"] = tenantValue;
  }
  return headers;
}

export async function operatorChecksRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post("/operator-checks", async (req, reply) => {
    const auth = requireAuth(req);
    const authHeaders = forwardedAuthHeaders(req);
    const client: OperatorCheckHttpClient = async (request) => {
      const response = await app.inject({
        method: request.method ?? "GET",
        url: request.path,
        headers: {
          ...authHeaders,
          ...(request.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(request.headers ?? {}),
        },
        payload:
          request.body === undefined ? undefined : JSON.stringify(request.body),
      });
      return { statusCode: response.statusCode, body: response.body };
    };
    const started = startOperatorCheck(auth, client);
    return reply.ok(
      StartOperatorCheckResponseSchema.parse({
        checkId: started.checkId,
        status: "queued",
        detailUrl: `/portal/${encodeURIComponent(auth.tenantSlug)}/system-check?check=${encodeURIComponent(started.checkId)}`,
      }),
      202,
    );
  });

  app.get<{ Params: { id: string } }>(
    "/operator-checks/:id",
    async (req, reply) => {
      const auth = requireAuth(req);
      try {
        return reply.ok(
          GetOperatorCheckResponseSchema.parse({
            check: getOperatorCheck(auth, req.params.id),
          }),
        );
      } catch (error) {
        if (error instanceof OperatorCheckNotFoundError) {
          return reply.fail("not_found", error.message, 404);
        }
        throw error;
      }
    },
  );

  app.get<{
    Querystring: { limit?: string | number; cursor?: string };
  }>("/operator-checks", async (req, reply) => {
    const auth = requireAuth(req);
    const query = ListOperatorChecksQuerySchema.parse(req.query);
    return reply.ok(
      ListOperatorChecksResponseSchema.parse(listOperatorChecks(auth, query)),
    );
  });
}
