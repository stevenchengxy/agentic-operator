import { createHash } from "node:crypto";
import { stableJson } from "@agentic/shared/cassette";
import { catalogToolDefinitionHash, declarativeToolDefinitionHash } from "./declarative-tool-hash";
import type { RealTool } from "./tool-catalog";
import { findSensitiveInputPath } from "./sensitive-input";
import { isGeneratedToolExecutionPolicy } from "./tool-execution-policy";

export const PROBE_AUTHORIZATION_PROTOCOL_VERSION = 2;
export const PROBE_AUTHORIZATION_PREFIX = "authorize_probe:v2:";
export const CONSUMED_PROBE_AUTHORIZATION_PREFIX = "consumed_probe_authorization:v2:";

export interface ProbeAuthorizationBinding {
  digest: string;
  token: string;
  definitionHash: string;
  sideEffectSummary: {
    sideEffect: string;
    systems: string[];
    roles: string[];
    operations: string[];
    objectTypes: string[];
  };
}

const sha256 = (value: unknown): string => createHash("sha256").update(stableJson(value)).digest("hex");

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

export function probeDefinitionHash(
  tool: RealTool,
  config: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (tool.declarativeDefinition) {
    if (!isGeneratedToolExecutionPolicy(tool.declarativeDefinition)) return undefined;
    return declarativeToolDefinitionHash({
      ...tool.declarativeDefinition,
      operation: tool.declarativeDefinition.operation,
      effectScope: tool.declarativeDefinition.effectScope,
      sandboxPolicy: tool.declarativeDefinition.sandboxPolicy,
    }, config, env);
  }
  if (tool.catalogDefinition) return catalogToolDefinitionHash(tool.catalogDefinition, config, env);
  return undefined;
}

/** Human authorization is bound to the exact execution subject. The token is
 * a digest only: neither args nor resolved environment values are embedded. */
export function createProbeAuthorizationBinding(
  tool: RealTool,
  args: Record<string, unknown>,
  config: Record<string, unknown> = {},
  env: Record<string, string | undefined> = process.env,
  scope: {
    tenantId?: string;
    actor?: string;
    domainId?: string;
    runId?: string;
    conversationId?: string;
  } = {},
): ProbeAuthorizationBinding | undefined {
  // A digest must never become an oracle for a credential accidentally placed
  // in model/API arguments. Reject before hashing; callers can record only the
  // safe path returned by findSensitiveProbeInputPath.
  if (findSensitiveProbeInputPath(args)) return undefined;
  const definitionHash = probeDefinitionHash(tool, config, env);
  if (!definitionHash) return undefined;
  const capabilities = tool.capabilities ?? [];
  const sideEffectSummary = {
    sideEffect: tool.sideEffect ?? "unknown",
    systems: sortedUnique(capabilities.flatMap((capability) => capability.systems)),
    roles: sortedUnique(capabilities.flatMap((capability) => capability.roles)),
    operations: sortedUnique(capabilities.flatMap((capability) => capability.operations ?? [])),
    objectTypes: sortedUnique(capabilities.flatMap((capability) => capability.objectTypes ?? [])),
  };
  const digest = sha256({
    version: PROBE_AUTHORIZATION_PROTOCOL_VERSION,
    toolName: tool.name,
    // Sensitive inputs were rejected above. Hash the complete canonical safe
    // args so distinct PII/business requests cannot collapse onto one human
    // authorization merely because a generic redactor changed their shape.
    exactArgs: args,
    definitionHash,
    sideEffectSummary,
    scope: {
      tenantId: scope.tenantId ?? null,
      actor: scope.actor ?? null,
      domainId: scope.domainId ?? null,
      runId: scope.runId ?? null,
      conversationId: scope.conversationId ?? null,
    },
  });
  return {
    digest,
    token: `${PROBE_AUTHORIZATION_PREFIX}${digest}`,
    definitionHash,
    sideEffectSummary,
  };
}

/** Reject secret-shaped probe inputs at any nesting level. Redaction remains a
 * second line of defence, not permission to send credentials through chat. */
export function findSensitiveProbeInputPath(value: unknown, path = "args", depth = 0): string | undefined {
  void depth; // retained for source compatibility with older callers
  return findSensitiveInputPath(value, path);
}
