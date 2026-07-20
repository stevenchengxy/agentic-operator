import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { factoryIntegrationProfiles, getDb } from "@agentic/db";
import {
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  integrationProfileConfigDigest,
  integrationProfileToolDefinitionDigest,
  isIntegrationProfileEnvironment,
  validateIntegrationToolConfig,
  type IntegrationConfigValidation,
  type IntegrationProfile,
  type IntegrationProfileEnvironment,
  type RealTool,
} from "@agentic/agent-factory";
import { hasFactoryActiveWork } from "./active-work";

const PROFILE_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function rowAsProfile(row: typeof factoryIntegrationProfiles.$inferSelect): IntegrationProfile {
  if (!row.confirmedBy?.trim()) throw new Error(`integration profile ${row.id} is missing confirmed_by`);
  if (!isIntegrationProfileEnvironment(row.environment)) throw new Error(`integration profile ${row.id} has invalid environment`);
  return {
    id: row.id,
    tenantId: row.tenantId,
    profileKey: row.profileKey,
    toolName: row.toolName,
    domainId: row.domainKey,
    environment: row.environment,
    config: row.configJson as Record<string, unknown>,
    confirmedBy: row.confirmedBy,
    toolDefinitionDigest: row.toolDefinitionDigest,
    configDigest: row.configDigest,
    authorizationProtocolVersion: row.authorizationProtocolVersion,
    confirmedAt: row.confirmedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function listIntegrationProfiles(
  tenantId: string,
  domainId?: string | null,
  toolName?: string,
  environment?: IntegrationProfileEnvironment,
): IntegrationProfile[] {
  const scope = [
    eq(factoryIntegrationProfiles.tenantId, tenantId),
    eq(factoryIntegrationProfiles.domainKey, domainId ?? ""),
    ...(toolName ? [eq(factoryIntegrationProfiles.toolName, toolName)] : []),
    ...(environment ? [eq(factoryIntegrationProfiles.environment, environment)] : []),
  ];
  return getDb()
    .select()
    .from(factoryIntegrationProfiles)
    .where(and(...scope))
    .all()
    // Legacy rows without an authenticated confirmer are not executable
    // profiles. Keep them in storage for audit, but never expose them as a
    // selectable confirmed profile.
    .filter((row) => Boolean(row.confirmedBy?.trim()))
    .map(rowAsProfile)
    .sort((left, right) => left.toolName.localeCompare(right.toolName)
      || left.environment.localeCompare(right.environment)
      || left.profileKey.localeCompare(right.profileKey));
}

export function saveIntegrationProfile(input: {
  tenantId: string;
  domainId?: string | null;
  profileKey: string;
  environment: IntegrationProfileEnvironment;
  tool: RealTool;
  config: unknown;
  confirmedBy: string;
  authorizationProtocolVersion?: number;
  env?: Record<string, string | undefined>;
}): { ok: true; profile: IntegrationProfile; validation: IntegrationConfigValidation } | {
  ok: false;
  error: string;
  validation?: IntegrationConfigValidation;
} {
  if (hasFactoryActiveWork(input.tenantId)) {
    return {
      ok: false,
      error: "当前 tenant 正在执行 sandbox/report/promotion，不能在执行证据窗口内替换 integration profile",
    };
  }
  const profileKey = input.profileKey.trim();
  if (!PROFILE_KEY.test(profileKey)) {
    return { ok: false, error: "profile key 只能包含字母、数字、点、下划线和短横线，最长 64 个字符" };
  }
  const confirmedBy = input.confirmedBy.trim();
  if (!confirmedBy) {
    return { ok: false, error: "integration profile 必须记录真实的认证确认人，不能使用 run starter 或空 actor 代替" };
  }
  if (input.environment !== "sandbox" && input.environment !== "production") {
    return { ok: false, error: "integration profile environment 必须是 sandbox 或 production" };
  }
  const validation = validateIntegrationToolConfig(input.tool, input.config, {
    env: input.env,
    rejectUnknownKeys: true,
  });
  if (!validation.valid) {
    return {
      ok: false,
      error: validation.issues.map((issue) => issue.message).join("；"),
      validation,
    };
  }

  const now = new Date();
  const toolDefinitionDigest = integrationProfileToolDefinitionDigest(input.tool);
  const configDigest = integrationProfileConfigDigest(validation.config);
  const authorizationProtocolVersion = input.authorizationProtocolVersion
    ?? INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION;
  if (authorizationProtocolVersion !== INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: `integration profile authorization protocol ${authorizationProtocolVersion} 已失效，请重新确认 ${input.environment} 配置`,
      validation,
    };
  }
  getDb()
    .insert(factoryIntegrationProfiles)
    .values({
      id: `ipr-${randomUUID()}`,
      tenantId: input.tenantId,
      domainKey: input.domainId ?? "",
      toolName: input.tool.name,
      profileKey,
      environment: input.environment,
      configJson: validation.config,
      confirmedBy,
      toolDefinitionDigest,
      configDigest,
      authorizationProtocolVersion,
      confirmedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        factoryIntegrationProfiles.tenantId,
        factoryIntegrationProfiles.domainKey,
        factoryIntegrationProfiles.toolName,
        factoryIntegrationProfiles.profileKey,
        factoryIntegrationProfiles.environment,
      ],
      set: {
        configJson: validation.config,
        confirmedBy,
        toolDefinitionDigest,
        configDigest,
        authorizationProtocolVersion,
        confirmedAt: now,
        updatedAt: now,
      },
    })
    .run();
  const profile = listIntegrationProfiles(input.tenantId, input.domainId, input.tool.name, input.environment)
    .find((candidate) => candidate.profileKey === profileKey);
  if (!profile) return { ok: false, error: "integration profile 保存后未能回读" };
  return { ok: true, profile, validation };
}

export function deleteIntegrationProfile(
  tenantId: string,
  domainId: string | null | undefined,
  toolName: string,
  profileKey: string,
  environment: IntegrationProfileEnvironment,
): boolean {
  if (hasFactoryActiveWork(tenantId)) return false;
  const result = getDb()
    .delete(factoryIntegrationProfiles)
    .where(and(
      eq(factoryIntegrationProfiles.tenantId, tenantId),
      eq(factoryIntegrationProfiles.domainKey, domainId ?? ""),
      eq(factoryIntegrationProfiles.toolName, toolName),
      eq(factoryIntegrationProfiles.profileKey, profileKey),
      eq(factoryIntegrationProfiles.environment, environment),
    ))
    .run();
  return result.changes > 0;
}
