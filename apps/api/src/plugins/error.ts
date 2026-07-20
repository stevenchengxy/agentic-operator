import type { FastifyInstance, FastifyReply, FastifyError } from "fastify";
import { ZodError } from "zod";

/**
 * Uniform { ok, data } | { ok: false, error } envelope per DESIGN.md §7.
 *
 * Use reply.ok(data) / reply.fail(code, message, status) instead of
 * reply.send directly. Errors thrown from handlers (including ZodError)
 * are caught and serialized to the envelope.
 */
declare module "fastify" {
  interface FastifyReply {
    ok<T>(data: T, status?: number): FastifyReply;
    fail(
      code: string,
      message: string,
      status?: number,
      hint?: string,
      details?: unknown,
    ): FastifyReply;
  }
}

export async function registerEnvelope(app: FastifyInstance) {
  app.decorateReply(
    "ok",
    function (this: FastifyReply, data: unknown, status = 200) {
      return this.status(status).send({ ok: true, data });
    },
  );

  app.decorateReply(
    "fail",
    function (
      this: FastifyReply,
      code: string,
      message: string,
      status = 400,
      hint?: string,
      details?: unknown,
    ) {
      return this.status(status).send({
        ok: false,
        error: { code, message, hint, details },
      });
    },
  );

  app.setErrorHandler((err: FastifyError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        ok: false,
        error: {
          code: "invalid_input",
          message: "request validation failed",
          hint: err.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
      });
    }
    req.log.error({ err }, "unhandled error");
    return reply.status(err.statusCode ?? 500).send({
      ok: false,
      error: {
        code: err.code ?? "internal_error",
        message: err.message ?? "internal server error",
      },
    });
  });
}
