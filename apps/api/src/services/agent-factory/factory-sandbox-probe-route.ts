import { timingSafeEqual } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import type { FastifyInstance } from "fastify";

import {
  runFactorySandboxProbe,
  type FactorySandboxProbeReport,
} from "./factory-sandbox-probe";
import { assertFactoryProductionImageTrustReady } from "./production-image-attestation";

interface ProbeBody {
  tenantSlug?: unknown;
}

const MAX_SECRET_BYTES = 4 * 1024;
let activeProbe: Promise<FactorySandboxProbeReport> | null = null;

function probeSecret(env: NodeJS.ProcessEnv = process.env): string {
  const direct = env.FACTORY_PRODUCTION_PROBE_TOKEN?.trim();
  const filename = env.FACTORY_PRODUCTION_PROBE_TOKEN_FILE?.trim();
  if (direct && filename) {
    throw new Error("FACTORY_PRODUCTION_PROBE_TOKEN and _FILE are mutually exclusive");
  }
  let value = direct ?? "";
  if (filename) {
    const stat = statSync(filename);
    if (!stat.isFile() || stat.size < 32 || stat.size > MAX_SECRET_BYTES) {
      throw new Error("Factory production probe token file is invalid");
    }
    value = readFileSync(filename, "utf8").trim();
  }
  if (Buffer.byteLength(value, "utf8") < 32) {
    throw new Error("Factory production probe token must contain at least 32 bytes");
  }
  return value;
}

function authorized(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice(7), "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function safeFailure(error: unknown): { code: string; message: string } {
  const message = String((error as Error)?.message ?? error)
    .replace(/\bBearer\s+[^\s,"'}]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*)[^\s,"'}]+/gi, "$1[REDACTED]")
    .slice(0, 500);
  return { code: "factory_sandbox_probe_failed", message };
}

/** Host-only readiness trigger. The caller owns no DB capability; all tenant
 * lookup, model grants and cleanup execute in this supervised API process. */
export async function factorySandboxProbeRoutes(
  app: FastifyInstance,
  options: {
    runProbe?: typeof runFactorySandboxProbe;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<void> {
  const runProbe = options.runProbe ?? runFactorySandboxProbe;
  const env = options.env ?? process.env;
  app.post<{ Body: ProbeBody }>(
    "/internal/factory-sandbox/probe",
    {
      bodyLimit: 8 * 1024,
      onRequest: async (request, reply) => {
        let expected: string;
        try {
          expected = probeSecret(env);
        } catch {
          return reply.code(503).send({
            error: { code: "probe_misconfigured", message: "Factory sandbox probe is not configured safely" },
          });
        }
        if (!authorized(request.headers.authorization, expected)) {
          return reply.code(401).send({
            error: { code: "unauthorized", message: "Unauthorized Factory sandbox probe request" },
          });
        }
      },
    },
    async (request, reply) => {
      if (activeProbe) {
        return reply.code(409).send({
          error: {
            code: "probe_already_running",
            message: "A Factory sandbox probe is already running; wait for it to finish instead of creating a competing App.",
          },
        });
      }
      const tenantSlug = typeof request.body?.tenantSlug === "string"
        ? request.body.tenantSlug.trim()
        : undefined;
      if (tenantSlug && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenantSlug)) {
        return reply.code(400).send({
          error: { code: "invalid_tenant", message: "tenantSlug is invalid" },
        });
      }
      // The host observer signs current Docker identities with a private key
      // unavailable to this API. Never launch a probe from a stale/untrusted
      // runtime and never derive the expected candidate from the attestation.
      try {
        assertFactoryProductionImageTrustReady({ env });
      } catch (error) {
        return reply.code(503).send({ error: safeFailure(error) });
      }
      activeProbe = runProbe({ ...(tenantSlug ? { tenantSlug } : {}), env });
      try {
        const report = await activeProbe;
        return reply.code(report.passed ? 200 : 503).send(report);
      } catch (error) {
        return reply.code(503).send({
          schema: "agent-factory-external-sandbox-probe/v1",
          passed: false,
          error: safeFailure(error),
        });
      } finally {
        activeProbe = null;
      }
    },
  );
}

export const __test = { authorized, probeSecret };
