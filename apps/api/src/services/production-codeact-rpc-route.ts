import type { FastifyInstance } from "fastify";
import {
  handleProductionCodeActRpc,
  productionCodeActBearerMatches,
  productionCodeActSecret,
  type ProductionCodeActRpcRequest,
} from "@agentic/runtime";

/** Narrow executor→API callback. The HMAC-bound in-memory execution context
 * owns tool/model/memory policy; browser auth and arbitrary execution ids are
 * intentionally insufficient. */
export async function productionCodeActRpcRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/internal/production-codeact/rpc",
    // Candidate JSON-lines frames are capped at 8 MiB. Keep a bounded envelope
    // margin while overriding the API's ordinary 1 MiB request limit so signed
    // RPCs are accepted/rejected by the identity ledger, not pre-handler 413s.
    {
      bodyLimit: 9 * 1024 * 1024,
      onRequest: async (request, reply) => {
        let secret: string;
        try {
          secret = productionCodeActSecret();
        } catch {
          return reply.code(503).send({ error: "production CodeAct RPC is not configured safely" });
        }
        if (!productionCodeActBearerMatches(request.headers.authorization, secret)) {
          return reply.code(401).send({ error: "unauthorized production CodeAct RPC" });
        }
      },
    },
    async (request, reply) => {
    const signature = request.headers["x-agentic-codeact-signature"] as string | undefined;
    const result = await handleProductionCodeActRpc(
      request.body as ProductionCodeActRpcRequest,
      signature,
    );
    return reply
      .header("x-agentic-codeact-signature", result.signature)
      .code(result.statusCode)
      .send(result.body);
    },
  );
}
