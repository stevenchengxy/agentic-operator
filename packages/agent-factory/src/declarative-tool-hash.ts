import { createHash } from "node:crypto";
import { stableJson } from "@agentic/shared/cassette";
import type { ToolConfigContract, WriteProbeSafetyContract } from "@agentic/shared";
import type { DeclarativeTool } from "./ports";

export type { ToolConfigContract } from "@agentic/shared";

const hash = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");
const GLOBAL_TOOL_PROBE_ABI = 2;

/** Materialize only for identity calculation/execution. Returned secret values
 * must never be logged or persisted; callers store only the resulting digest. */
export function materializeToolConfigForHash(
  config: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
): { resolved: Record<string, unknown>; missingEnv: string[] } {
  const missingEnv: string[] = [];
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const source = value as Record<string, unknown>;
    const resolved: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(source)) resolved[key] = visit(item);
    for (const [key, item] of Object.entries(source)) {
      if (!/_env$/i.test(key) || typeof item !== "string" || !item.trim()) continue;
      const envName = item.trim();
      const secret = env[envName];
      if (typeof secret === "string" && secret.length > 0) {
        const target = key.replace(/_env$/i, "");
        if (!(target in resolved)) resolved[target] = secret;
      } else {
        missingEnv.push(envName);
      }
    }
    return resolved;
  };
  const resolved = visit(config) as Record<string, unknown>;
  return { resolved, missingEnv: [...new Set(missingEnv)] };
}

/** Canonical identity shared by live probe and design-time binding. It includes
 * a digest of resolved config/credentials, never the values themselves. */
type DeclarativeHashableTool = Pick<DeclarativeTool, "name" | "method" | "urlTemplate" | "headers" | "bodyTemplate" | "sideEffect" | "operation" | "effectScope" | "sandboxPolicy" | "paramsSchema" | "returnsSchema" | "capabilities" | "probeSafety"> & {
  requestSpec?: unknown;
  responseSpec?: unknown;
  examples?: unknown;
};

export function declarativeToolDefinitionHash(
  tool: DeclarativeHashableTool,
  config: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
): string {
  const materialized = materializeToolConfigForHash(config, env);
  return hash({
    name: tool.name,
    method: tool.method.toUpperCase(),
    urlTemplate: tool.urlTemplate,
    headers: tool.headers ?? {},
    bodyTemplate: tool.bodyTemplate ?? null,
    requestSpec: tool.requestSpec ?? null,
    responseSpec: tool.responseSpec ?? null,
    examples: tool.examples ?? [],
    sideEffect: tool.sideEffect,
    operation: tool.operation ?? null,
    effectScope: tool.effectScope ?? null,
    sandboxPolicy: tool.sandboxPolicy ?? null,
    paramsSchema: tool.paramsSchema ?? {},
    returnsSchema: tool.returnsSchema ?? {},
    capabilities: tool.capabilities ?? [],
    probeSafety: tool.probeSafety ?? null,
    configDigest: hash({ resolved: materialized.resolved, missingEnv: materialized.missingEnv }),
  });
}

export interface CatalogToolDefinition {
  name: string;
  category?: string;
  sourcePath?: string;
  /** Exact executable source selected by the runtime. Tenant-native providers
   * include registry version and a handler digest so a code hot-swap invalidates
   * stale profile/probe evidence without exposing handler source. */
  sourceIdentity?: Record<string, unknown>;
  sideEffect?: string;
  operation?: string;
  effectScope?: string;
  sandboxPolicy?: string;
  argsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
  configSchema?: Record<string, unknown>;
  /** Declarative relationships between config fields. Validators consume this
   * generically; adding/changing a rule changes definition identity. */
  configContract?: ToolConfigContract;
  capabilities?: unknown[];
  /** Declarative mapping from profile config fields to runtime/Ontology scope.
   * This replaces key-name conventions in preflight. */
  profileScope?: {
    exact?: Array<{
      configKey: string;
      source: "tenantId" | "tenantSlug" | "domain" | "action";
    }>;
    allowlists?: Array<{
      configKey: string;
      source: "tenant" | "domain" | "action" | "objects";
      match: "any" | "all";
    }>;
  };
  /** Complete disposable-canary lifecycle for write/dual live probes. */
  probeSafety?: WriteProbeSafetyContract;
}

export function catalogToolDefinitionHash(
  tool: CatalogToolDefinition,
  config: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
): string {
  const materialized = materializeToolConfigForHash(config, env);
  return hash({
    abi: GLOBAL_TOOL_PROBE_ABI,
    name: tool.name,
    category: tool.category ?? null,
    sourcePath: tool.sourcePath ?? null,
    ...(tool.sourceIdentity !== undefined ? { sourceIdentity: tool.sourceIdentity } : {}),
    sideEffect: tool.sideEffect ?? null,
    operation: tool.operation ?? null,
    effectScope: tool.effectScope ?? null,
    sandboxPolicy: tool.sandboxPolicy ?? null,
    argsSchema: tool.argsSchema ?? {},
    returnsSchema: tool.returnsSchema ?? {},
    configSchema: tool.configSchema ?? {},
    ...(tool.configContract !== undefined ? { configContract: tool.configContract } : {}),
    capabilities: tool.capabilities ?? [],
    profileScope: tool.profileScope ?? null,
    probeSafety: tool.probeSafety ?? null,
    configDigest: hash({ resolved: materialized.resolved, missingEnv: materialized.missingEnv }),
  });
}

/** Stable, non-secret identity for one disposable write canary. It is scoped
 * to the exact definition/config and current factory execution, so retries are
 * idempotent while another run cannot collide with the same target. */
export function writeProbeCanarySeed(input: {
  definitionHash: string;
  domainId: string;
  runId: string;
  conversationId: string;
}): string {
  return hash({
    purpose: "agent-factory-write-probe/v1",
    definitionHash: input.definitionHash,
    domainId: input.domainId,
    runId: input.runId,
    conversationId: input.conversationId,
  });
}
