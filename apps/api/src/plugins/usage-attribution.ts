import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  runWithUsageAttribution,
  type UsageAttribution,
} from "@agentic/llm-gateway";

const SURFACE_HEADER = "x-agentic-product-surface";
const ACTION_HEADER = "x-agentic-product-action";
const INTERACTION_HEADER = "x-agentic-interaction-id";
const PRODUCT_SURFACES = new Set([
  "agent-builder",
  "agent-runtime",
  "agent-studio",
  "api",
  "llm-settings",
  "workflow-authoring",
]);
const STABLE_CODE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

function oneHeader(req: FastifyRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function routeTemplate(req: FastifyRequest): string {
  return req.routeOptions.url || req.url.split("?", 1)[0] || "/";
}

function inferredSurface(route: string): string {
  if (route.includes("agent-studio") || route.includes("agents/drafts")) {
    return "agent-studio";
  }
  if (route.includes("workflow")) return "workflow-authoring";
  if (route.includes("agents") || route.includes("events")) {
    return "agent-runtime";
  }
  if (route.includes("llm")) return "llm-settings";
  return "api";
}

function requestedSurface(req: FastifyRequest, fallback: string): string {
  const value = oneHeader(req, SURFACE_HEADER);
  return value && PRODUCT_SURFACES.has(value) ? value : fallback;
}

function requestedAction(req: FastifyRequest, fallback: string): string {
  const value = oneHeader(req, ACTION_HEADER);
  return value && STABLE_CODE.test(value) ? value : fallback;
}

function requestedInteractionId(req: FastifyRequest): string | undefined {
  const value = oneHeader(req, INTERACTION_HEADER);
  return value && STABLE_CODE.test(value) ? value : undefined;
}

/**
 * Attach authenticated HTTP/product dimensions to all LLM calls made in the
 * request's async chain. Client headers may name a surface/action/interaction
 * but never control the billed account or principal.
 */
export async function registerUsageAttribution(
  app: FastifyInstance,
): Promise<void> {
  app.addHook("onRequest", (req, _reply, done) => {
    const route = routeTemplate(req);
    const auth = req.auth;
    const actorType =
      auth?.via === "cookie"
        ? "user"
        : auth?.via === "token"
          ? "api_token"
          : "system";
    const attribution: UsageAttribution = {
      billingAccountId: auth?.tenantId,
      actorType,
      actorId: auth?.userId ?? auth?.credentialId,
      credentialId: auth?.credentialId,
      product: "agentic-operator",
      productSurface: requestedSurface(req, inferredSurface(route)),
      productAction: requestedAction(
        req,
        `${req.method.toUpperCase()} ${route}`,
      ),
      interactionId: requestedInteractionId(req),
      apiRoute: route,
      httpMethod: req.method.toUpperCase(),
      requestId: req.id,
    };
    runWithUsageAttribution(attribution, done);
  });
}
