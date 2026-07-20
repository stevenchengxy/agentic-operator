import { createHash } from "node:crypto";
import { stableJson } from "@agentic/shared/cassette";
import type { RealTool } from "./tool-catalog";
import {
  isIntegrationProfileEnvironment,
  resolveIntegrationProfile,
  validateIntegrationToolConfig,
  type IntegrationProfile,
  type IntegrationProfileEnvironment,
} from "./integration-profile";
import type { GeneratedAgentSpec } from "./spec-types";

/** v3 adds the mandatory sandbox/production environment to the exact subject
 * digest. A v2 confirmation can therefore never authorize either environment. */
export const INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION = 3;
export const INTEGRATION_PROFILE_AUTHORIZATION_PREFIX = "authorize_integration_profile:v3:";
export const INTEGRATION_PROFILE_AUTHORIZATION_CONTEXT_PREFIX = "integration_profile_authorization:v3:";
export const INTEGRATION_PROFILE_AUTHORIZATION_DECLINE_PREFIX = "decline_integration_profile:v3:";
export const CONSUMED_INTEGRATION_PROFILE_AUTHORIZATION_PREFIX = "consumed_integration_profile_authorization:v3:";

export interface IntegrationProfileAuthorizationBinding {
  digest: string;
  token: string;
  configDigest: string;
  toolDefinitionDigest: string;
}

const sha256 = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

/** Digest only the non-secret, deterministically validated profile config. */
export function integrationProfileConfigDigest(config: Record<string, unknown>): string {
  return sha256(config);
}

/** Definition identity intentionally excludes runtime secret values. Secret
 * rotation is covered by the definition/config-bound probe receipt; profile
 * authorization covers the non-secret adapter contract the human reviewed. */
export function integrationProfileToolDefinitionDigest(tool: RealTool): string {
  return sha256({
    name: tool.name,
    configKeys: [...(tool.configKeys ?? [])].sort(),
    credentialEnv: [...(tool.credentialEnv ?? [])].sort(),
    catalogDefinition: tool.catalogDefinition ?? null,
    declarativeDefinition: tool.declarativeDefinition ?? null,
  });
}

/** Revalidate persisted confirmation identity at every execution gate. */
export function integrationProfileIdentityIssues(
  profile: IntegrationProfile,
  tool: RealTool,
): string[] {
  const issues: string[] = [];
  if (!profile.confirmedBy?.trim()) issues.push("profile 缺少真实确认人");
  if (!isIntegrationProfileEnvironment(profile.environment)) issues.push("profile environment 无效");
  if (profile.authorizationProtocolVersion !== INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION) {
    issues.push(`profile authorization protocol ${profile.authorizationProtocolVersion} 已失效`);
  }
  const currentDefinitionDigest = integrationProfileToolDefinitionDigest(tool);
  if (profile.toolDefinitionDigest !== currentDefinitionDigest) {
    issues.push("profile 绑定的工具 definition 已变化");
  }
  const currentConfigDigest = integrationProfileConfigDigest(profile.config);
  if (profile.configDigest !== currentConfigDigest) {
    issues.push("profile 保存的 config digest 与当前内容不一致");
  }
  return issues;
}

export interface IntegrationProfileExecutionScope {
  tenantId?: string;
  tenantSlug?: string;
  domainId: string;
  environment: IntegrationProfileEnvironment;
  actionName: string;
  requiredObjects?: string[];
}

/**
 * Validate a confirmed profile against the exact execution scope. This is the
 * single policy used by preflight, design, sandbox refresh and finish; callers
 * must not reproduce a looser, read-only-only variant.
 *
 * A missing `profileScope` declaration means the tool profile is intentionally
 * tenant/domain-wide. When metadata is present, every exact/allowlist rule is
 * enforced. Tenant ownership and profile domain are always enforced regardless
 * of metadata.
 */
export function integrationProfileScopeIssues(
  profile: IntegrationProfile,
  tool: RealTool,
  scope: IntegrationProfileExecutionScope,
): string[] {
  const issues: string[] = [];
  if (profile.toolName !== tool.name) {
    issues.push("profile 声明的 tool 与当前工具不一致");
  }
  if (scope.tenantId && profile.tenantId !== scope.tenantId) {
    issues.push(profile.tenantId
      ? "profile 不属于当前 tenant"
      : "profile 缺少可验证的 tenant 归属");
  }
  if (profile.domainId !== scope.domainId) {
    issues.push("profile 声明的 domain 与当前 domain 不一致");
  }
  if (profile.environment !== scope.environment) {
    issues.push(`profile 属于 ${profile.environment}，不能用于 ${scope.environment}`);
  }
  if (!profile.confirmedAt.trim()) {
    issues.push("profile 尚未经过人工确认");
  }
  issues.push(...integrationProfileIdentityIssues(profile, tool));

  const metadata = tool.catalogDefinition?.profileScope;
  if (!metadata) return [...new Set(issues)];
  const scalarSource = {
    tenantId: scope.tenantId,
    tenantSlug: scope.tenantSlug,
    domain: scope.domainId,
    action: scope.actionName,
  } as const;
  const listSource = {
    tenant: [scope.tenantId, scope.tenantSlug].filter((value): value is string => Boolean(value)),
    domain: [scope.domainId],
    action: [scope.actionName],
    objects: [...new Set(scope.requiredObjects ?? [])],
  } as const;
  for (const rule of metadata.exact ?? []) {
    const configured = profile.config[rule.configKey];
    const expected = scalarSource[rule.source];
    if (!expected) {
      issues.push(`无法验证 ${rule.configKey} 的 ${rule.source} scope`);
    } else if (typeof configured !== "string" || configured.trim() !== expected) {
      issues.push(`${rule.configKey} 不匹配 ${rule.source} scope`);
    }
  }
  for (const rule of metadata.allowlists ?? []) {
    const configured = profile.config[rule.configKey];
    const expected = listSource[rule.source];
    if (!Array.isArray(configured)) {
      issues.push(`${rule.configKey} 没有提供 metadata 要求的 scope allowlist`);
      continue;
    }
    if (expected.length === 0) {
      issues.push(`无法验证 ${rule.configKey} 的 ${rule.source} scope`);
      continue;
    }
    const allowed = new Set(configured.filter((value): value is string => typeof value === "string"));
    const covered = rule.match === "any"
      ? expected.some((value) => allowed.has(value))
      : expected.every((value) => allowed.has(value));
    if (!covered) issues.push(`${rule.configKey} 不覆盖 ${rule.source} scope`);
  }
  return [...new Set(issues)];
}

export type GeneratedSpecIntegrationProfileIssueCode =
  | "tool_not_found"
  | "profile_required"
  | "profile_reference_ambiguous"
  | "profile_environment_mismatch"
  | "profile_not_found"
  | "profile_identity_invalid"
  | "profile_scope_invalid"
  | "profile_config_invalid"
  | "spec_config_missing"
  | "spec_config_digest_mismatch"
  | "unconfirmed_spec_config";

export interface GeneratedSpecIntegrationProfileIssue {
  code: GeneratedSpecIntegrationProfileIssueCode;
  specSlug: string;
  actionName: string;
  toolName: string;
  environment?: IntegrationProfileEnvironment;
  profileRef?: string;
  message: string;
}

export interface GeneratedSpecIntegrationProfileValidation {
  ok: boolean;
  issues: GeneratedSpecIntegrationProfileIssue[];
}

export interface GeneratedSpecIntegrationProfileScope {
  tenantId?: string;
  tenantSlug?: string;
  domainId: string;
}

function toolHasProfileConfigSurface(tool: RealTool): boolean {
  const schema = tool.catalogDefinition?.configSchema;
  return Boolean((schema && Object.keys(schema).length > 0) || (tool.configKeys?.length ?? 0) > 0);
}

/**
 * Pure commit-boundary validation for immutable generated specs.
 *
 * Callers supply the current tool definitions and, optionally, the current
 * profile rows as a separate snapshot. When `profiles` is provided it is
 * authoritative; otherwise each tool's `integrationProfiles` snapshot is
 * used. No environment values or external I/O are read.
 *
 * Both environments are checked independently. A production profile can never
 * satisfy sandbox (or vice versa), and the expanded config captured in the
 * spec must still hash to the exact currently confirmed profile revision.
 */
export function validateGeneratedSpecIntegrationProfiles(input: {
  specs: readonly GeneratedAgentSpec[];
  tools: readonly RealTool[];
  profiles?: readonly IntegrationProfile[];
  scope: GeneratedSpecIntegrationProfileScope;
  /** Limit validation to the environment used by the current lifecycle stage.
   * Authoring does not call this gate; sandbox verifies only sandbox profiles,
   * while finish/promotion verifies production profiles.  Omitting the field
   * preserves the historical commit-boundary check of both environments. */
  environments?: readonly IntegrationProfileEnvironment[];
}): GeneratedSpecIntegrationProfileValidation {
  const issues: GeneratedSpecIntegrationProfileIssue[] = [];
  const toolsByName = new Map(input.tools.map((tool) => [tool.name, tool] as const));
  const authoritativeProfiles = input.profiles;
  const environments: readonly IntegrationProfileEnvironment[] = input.environments?.length
    ? [...new Set(input.environments)]
    : ["production", "sandbox"];

  const add = (
    spec: GeneratedAgentSpec,
    toolName: string,
    code: GeneratedSpecIntegrationProfileIssueCode,
    message: string,
    environment?: IntegrationProfileEnvironment,
    profileRef?: string,
  ): void => {
    issues.push({
      code,
      specSlug: spec.slug,
      actionName: spec.actionName,
      toolName,
      ...(environment ? { environment } : {}),
      ...(profileRef ? { profileRef } : {}),
      message,
    });
  };

  for (const spec of input.specs) {
    const requiredObjects = [...new Set(
      spec.integrationRequirements?.length
        ? spec.integrationRequirements.flatMap((requirement) => requirement.objectTypes)
        : (spec.objects ?? []),
    )];
    for (const toolName of spec.tools ?? []) {
      const baseTool = toolsByName.get(toolName);
      if (!baseTool) {
        add(spec, toolName, "tool_not_found", `agent ${spec.short} 的工具 ${toolName} 已不在当前 registry`);
        continue;
      }
      const currentProfiles = authoritativeProfiles
        ? authoritativeProfiles.filter((profile) => profile.toolName === toolName)
        : (baseTool.integrationProfiles ?? []);
      const tool: RealTool = { ...baseTool, integrationProfiles: [...currentProfiles] };
      const requiresProfile = toolHasProfileConfigSurface(tool);

      for (const environment of environments) {
        const refs = environment === "production" ? spec.toolProfileRefs : spec.sandboxToolProfileRefs;
        const configs = environment === "production" ? spec.toolConfigs : spec.sandboxToolConfigs;
        const profileRef = refs?.[toolName]?.trim();
        const capturedConfig = configs?.[toolName];
        if (!profileRef) {
          if (requiresProfile) {
            add(
              spec,
              toolName,
              "profile_required",
              environment === "sandbox"
                ? `agent ${spec.short} 的工具 ${toolName} 没有绑定独立 sandbox integration profile；不能借用 production 配置`
                : `agent ${spec.short} 的工具 ${toolName} 没有绑定用户确认过的 production integration profile`,
              environment,
            );
          } else if (capturedConfig) {
            add(
              spec,
              toolName,
              "unconfirmed_spec_config",
              `agent ${spec.short} 的 ${environment} config 没有可验证的 integration profile 来源`,
              environment,
            );
          }
          continue;
        }

        const sameEnvironmentMatches = currentProfiles.filter((profile) =>
          profile.environment === environment
          && (profile.id === profileRef || profile.profileKey === profileRef));
        if (sameEnvironmentMatches.length > 1) {
          add(
            spec,
            toolName,
            "profile_reference_ambiguous",
            `agent ${spec.short} 的 ${environment} profile 引用 ${profileRef} 命中多条当前记录，不能猜选`,
            environment,
            profileRef,
          );
          continue;
        }
        const profile = resolveIntegrationProfile(tool, profileRef, environment);
        if (!profile) {
          const otherEnvironment = currentProfiles.find((candidate) =>
            candidate.environment !== environment
            && (candidate.id === profileRef || candidate.profileKey === profileRef));
          add(
            spec,
            toolName,
            otherEnvironment ? "profile_environment_mismatch" : "profile_not_found",
            otherEnvironment
              ? `agent ${spec.short} 的 ${profileRef} 属于 ${otherEnvironment.environment}，不能用于 ${environment}`
              : `agent ${spec.short} 的 ${environment} integration profile ${profileRef} 已删除或不再属于工具 ${toolName}`,
            environment,
            profileRef,
          );
          continue;
        }

        const identityIssues = integrationProfileIdentityIssues(profile, tool);
        if (identityIssues.length) {
          add(
            spec,
            toolName,
            "profile_identity_invalid",
            `agent ${spec.short} 的 ${environment} integration profile ${profile.profileKey} 身份已失效：${identityIssues.join("；")}`,
            environment,
            profileRef,
          );
        }
        const scopeIssues = integrationProfileScopeIssues(profile, tool, {
          tenantId: input.scope.tenantId,
          tenantSlug: input.scope.tenantSlug,
          domainId: input.scope.domainId,
          environment,
          actionName: spec.actionName,
          requiredObjects,
        }).filter((issue) => !identityIssues.includes(issue));
        if (scopeIssues.length) {
          add(
            spec,
            toolName,
            "profile_scope_invalid",
            `agent ${spec.short} 的 ${environment} integration profile ${profile.profileKey} 不适用于当前执行：${scopeIssues.join("；")}`,
            environment,
            profileRef,
          );
        }
        const configValidation = validateIntegrationToolConfig(tool, profile.config, {
          // This boundary is pure: runtime environment availability is checked
          // separately by preflight. Structural/security validity still fails.
          env: {},
          rejectUnknownKeys: true,
        });
        if (!configValidation.valid) {
          add(
            spec,
            toolName,
            "profile_config_invalid",
            `agent ${spec.short} 的 ${environment} integration profile ${profile.profileKey} 配置已失效：${configValidation.issues.map((issue) => issue.message).join("；")}`,
            environment,
            profileRef,
          );
        }
        if (!capturedConfig) {
          add(
            spec,
            toolName,
            "spec_config_missing",
            `agent ${spec.short} 没有保存 ${environment} integration profile ${profile.profileKey} 的不可变 config 快照`,
            environment,
            profileRef,
          );
        } else if (integrationProfileConfigDigest(capturedConfig) !== integrationProfileConfigDigest(profile.config)) {
          add(
            spec,
            toolName,
            "spec_config_digest_mismatch",
            `agent ${spec.short} 的 ${environment} integration profile ${profile.profileKey} 已变更；必须重新 design_agent${environment === "sandbox" ? " 并重跑沙箱" : " 并重新 sandbox"}`,
            environment,
            profileRef,
          );
        }
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Bind a human confirmation to the exact tool definition, ontology domain,
 * profile key and non-secret config. The token contains digests only; config
 * values and environment values are never embedded in it.
 */
export function createIntegrationProfileAuthorizationBinding(input: {
  tool: RealTool;
  domainId: string;
  profileKey: string;
  environment: IntegrationProfileEnvironment;
  config: Record<string, unknown>;
  scope?: {
    tenantId?: string;
    actor?: string;
    runId?: string;
    conversationId?: string;
  };
}): IntegrationProfileAuthorizationBinding {
  const configDigest = integrationProfileConfigDigest(input.config);
  const toolDefinitionDigest = integrationProfileToolDefinitionDigest(input.tool);
  const digest = sha256({
    version: INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
    toolName: input.tool.name,
    domainId: input.domainId,
    profileKey: input.profileKey,
    environment: input.environment,
    configDigest,
    toolDefinitionDigest,
    scope: {
      tenantId: input.scope?.tenantId ?? null,
      actor: input.scope?.actor ?? null,
      runId: input.scope?.runId ?? null,
      conversationId: input.scope?.conversationId ?? null,
    },
  });
  return {
    digest,
    token: `${INTEGRATION_PROFILE_AUTHORIZATION_PREFIX}${digest}`,
    configDigest,
    toolDefinitionDigest,
  };
}
