import type { RealTool } from "./tool-catalog";
import {
  isSensitiveEnvironmentReferenceField,
  sanitizeSensitiveInput,
} from "./sensitive-input";

type JsonRecord = Record<string, unknown>;

export const INTEGRATION_PROFILE_ENVIRONMENTS = ["sandbox", "production"] as const;
export type IntegrationProfileEnvironment = typeof INTEGRATION_PROFILE_ENVIRONMENTS[number];

export function isIntegrationProfileEnvironment(value: unknown): value is IntegrationProfileEnvironment {
  return value === "sandbox" || value === "production";
}

export interface IntegrationProfile {
  id: string;
  /** Immutable owner copied from the tenant-scoped profile store. Legacy test
   * fixtures may omit it, but a production execution scope must match it. */
  tenantId?: string;
  profileKey: string;
  toolName: string;
  domainId: string;
  /** Credentials/endpoints for sandbox and production are never interchangeable. */
  environment: IntegrationProfileEnvironment;
  config: JsonRecord;
  /** Authenticated human who confirmed this exact profile revision. */
  confirmedBy: string;
  /** Digest of the executable tool definition at confirmation time. */
  toolDefinitionDigest: string;
  /** Digest of the canonical non-secret config at confirmation time. */
  configDigest: string;
  /** Authorization protocol that produced the confirmation receipt. */
  authorizationProtocolVersion: number;
  confirmedAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export type IntegrationConfigIssueCode =
  | "config_not_object"
  | "config_contract_invalid"
  | "unknown_key"
  | "required_key_missing"
  | "at_least_one_missing"
  | "mutually_exclusive_conflict"
  | "conditional_key_missing"
  | "invalid_type"
  | "value_not_allowed"
  | "config_schema_invalid"
  | "literal_secret"
  | "invalid_env_reference"
  | "invalid_url"
  | "credential_in_url"
  | "unsafe_allowlist";

export interface IntegrationConfigIssue {
  code: IntegrationConfigIssueCode;
  path: string;
  message: string;
}

export interface IntegrationConfigValidation {
  /** Structural/security validity. Missing server env values do not make a
   * profile unsafe to save; they make it not ready to execute. */
  valid: boolean;
  ready: boolean;
  config: JsonRecord;
  issues: IntegrationConfigIssue[];
  missingConfigKeys: string[];
  invalidConfigKeys: string[];
  envRefs: string[];
  missingEnvRefs: string[];
}

export interface IntegrationConfigValidationOptions {
  env?: Record<string, string | undefined>;
  /** Defaults to true when the tool declares configSchema/configKeys. */
  rejectUnknownKeys?: boolean;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const URL_SECRET_KEY = /(?:api[-_]?key|access[-_]?token|password|secret|token|credential)/i;
const isRecord = (value: unknown): value is JsonRecord =>
  !!value && typeof value === "object" && !Array.isArray(value);
const present = (value: unknown): boolean =>
  value !== undefined && value !== null && !(typeof value === "string" && value.trim() === "");
const topLevelConfigKey = (path: string): string => path.match(/^[^.[\]]+/)?.[0] ?? "";
const humanList = (values: string[], conjunction: "和" | "或"): string =>
  values.length < 2
    ? (values[0] ?? "")
    : `${values.slice(0, -1).join("、")} ${conjunction} ${values.at(-1)}`;
const displayConditionValue = (value: unknown): string =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));

function canonicalObject(value: JsonRecord): JsonRecord {
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    const item = value[key];
    if (isRecord(item)) return [key, canonicalObject(item)];
    if (Array.isArray(item)) {
      return [key, item.map((entry) => isRecord(entry) ? canonicalObject(entry) : entry)];
    }
    return [key, item];
  }));
}

function fieldTypeMatches(expected: unknown, value: unknown): boolean {
  if (typeof expected !== "string" || !expected.trim()) return true;
  const type = expected.trim().toLowerCase();
  if (type.endsWith("[]") || type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "number" || type === "integer") return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isInteger(value));
  if (type === "boolean") return typeof value === "boolean";
  if (type === "object" || type.startsWith("record<")) return isRecord(value);
  return true;
}

function securityIssues(config: JsonRecord, schema: JsonRecord): IntegrationConfigIssue[] {
  const issues: IntegrationConfigIssue[] = [];
  const scan = sanitizeSensitiveInput(config, "config", {
    allowSensitiveField: ({ path, key, value }) => {
      // Invalid env references are reported by the dedicated validator below;
      // they are not literal credential values merely because their name is
      // malformed. CamelCase and dashed *_env variants use the same canonical
      // detector as every other server boundary.
      if (isSensitiveEnvironmentReferenceField(key)) return true;
      // A top-level schema-owned enum can legitimately describe an auth mode
      // (`auth: anonymous|sigv4`). Only the exact declared primitive is safe;
      // arbitrary auth/authHeader/proxyAuthorization values remain blocked.
      if (path !== `config.${key}`) return false;
      const field = isRecord(schema[key]) ? schema[key] as JsonRecord : undefined;
      const allowed = field?.allowedValues;
      return Array.isArray(allowed)
        && allowed.length > 0
        && allowed.some((candidate) => Object.is(candidate, value));
    },
  });
  for (const fullPath of scan.paths) {
    const path = fullPath.replace(/^config\.?/, "") || "config";
    issues.push({
      code: "literal_secret",
      path,
      message: `${path} 不能保存字面凭证（literal credential），请改用 *_env 引用`,
    });
  }
  const visitNested = (value: unknown, path: string): void => {
    if (isRecord(value)) {
      visit(value, path);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => visitNested(entry, `${path}[${index}]`));
    }
  };
  const visit = (record: JsonRecord, prefix: string): void => {
    for (const [key, value] of Object.entries(record)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (isSensitiveEnvironmentReferenceField(key)) {
        if (typeof value !== "string" || !ENV_NAME.test(value)) {
          issues.push({ code: "invalid_env_reference", path, message: `${path} 必须填写环境变量名，不能填写 secret 值` });
        }
      }

      if (!isSensitiveEnvironmentReferenceField(key) && /url|uri|endpoint|origin/i.test(key) && typeof value === "string" && value.trim()) {
        try {
          const url = new URL(value);
          if (!new Set(["http:", "https:"]).has(url.protocol)) {
            issues.push({ code: "invalid_url", path, message: `${path} 只允许 http/https URL` });
          } else if (url.username || url.password || [...url.searchParams.keys()].some((name) => URL_SECRET_KEY.test(name))) {
            issues.push({ code: "credential_in_url", path, message: `${path} 不能在 URL 中携带用户名、密码或 token 参数` });
          }
        } catch {
          issues.push({ code: "invalid_url", path, message: `${path} 不是合法 URL` });
        }
      }

      if (/^(?:allowed_|allowlist)/i.test(key) && Array.isArray(value)) {
        const strings = value.filter((item): item is string => typeof item === "string").map((item) => item.trim());
        if (strings.length !== value.length || strings.some((item) => !item || item === "*")) {
          issues.push({ code: "unsafe_allowlist", path, message: `${path} 必须是非空、精确值组成的 allowlist，不能使用 *` });
        }
      }
      visitNested(value, path);
    }
  };
  visit(config, "");
  return issues;
}

/** One deterministic validator used by profile persistence, agent design and
 * binding. It never returns or stores environment values—only their names and
 * whether the server currently has them. */
export function validateIntegrationToolConfig(
  tool: Pick<RealTool, "name" | "configKeys" | "credentialEnv" | "catalogDefinition">,
  rawConfig: unknown,
  options: IntegrationConfigValidationOptions = {},
): IntegrationConfigValidation {
  if (!isRecord(rawConfig)) {
    const issue: IntegrationConfigIssue = {
      code: "config_not_object",
      path: tool.name,
      message: `工具 ${tool.name} 的 config 必须是对象`,
    };
    return {
      valid: false,
      ready: false,
      config: {},
      issues: [issue],
      missingConfigKeys: [],
      invalidConfigKeys: [],
      envRefs: [],
      missingEnvRefs: [],
    };
  }

  const config = canonicalObject(rawConfig);
  const schema = isRecord(tool.catalogDefinition?.configSchema)
    ? tool.catalogDefinition!.configSchema as Record<string, unknown>
    : {};
  const declaredKeys = Object.keys(schema).length > 0
    ? Object.keys(schema)
    : [...(tool.configKeys ?? [])];
  const declared = new Set(declaredKeys);
  const rejectUnknown = options.rejectUnknownKeys ?? declared.size > 0;
  const issues = securityIssues(config, schema);
  const missingConfigKeys = new Set<string>();
  const invalidConfigKeys = new Set<string>();

  for (const issue of issues) {
    const topLevel = topLevelConfigKey(issue.path);
    if (topLevel) invalidConfigKeys.add(topLevel);
  }

  if (rejectUnknown) {
    for (const key of Object.keys(config)) {
      if (!declared.has(key)) {
        issues.push({ code: "unknown_key", path: key, message: `工具 ${tool.name} 没有声明配置项 ${key}` });
        invalidConfigKeys.add(key);
      }
    }
  }
  for (const [key, rawField] of Object.entries(schema)) {
    const field = isRecord(rawField) ? rawField : {};
    const value = config[key];
    if (field.required === true && !present(value)) {
      missingConfigKeys.add(key);
      issues.push({ code: "required_key_missing", path: key, message: `还需要填写 ${key}。` });
    } else if (present(value) && !fieldTypeMatches(field.type, value)) {
      issues.push({ code: "invalid_type", path: key, message: `${key} 必须符合类型 ${String(field.type)}` });
      invalidConfigKeys.add(key);
    } else if (field.allowedValues !== undefined) {
      const allowed = field.allowedValues;
      const validAllowedValues = Array.isArray(allowed)
        && allowed.length > 0
        && allowed.every((item) => item === null
          || typeof item === "string"
          || typeof item === "boolean"
          || (typeof item === "number" && Number.isFinite(item)));
      if (!validAllowedValues) {
        issues.push({
          code: "config_schema_invalid",
          path: `configSchema.${key}.allowedValues`,
          message: `工具 ${tool.name} 的 allowedValues 声明有误，当前配置不能继续使用。`,
        });
      } else if (present(value) && !allowed.some((item) => Object.is(item, value))) {
        issues.push({
          code: "value_not_allowed",
          path: key,
          message: `${key} 只能填写 ${humanList(allowed.map(displayConditionValue), "或")}。`,
        });
        invalidConfigKeys.add(key);
      }
    }
  }

  const rawContract = tool.catalogDefinition?.configContract as unknown;
  const addInvalidContract = (path: string, message: string): void => {
    issues.push({ code: "config_contract_invalid", path, message: `工具 ${tool.name} 的配置规则有误：${message}` });
  };
  const contract = rawContract === undefined
    ? undefined
    : isRecord(rawContract)
      ? rawContract
      : (addInvalidContract("configContract", "configContract 必须是对象"), undefined);
  const ruleList = (name: "atLeastOne" | "mutuallyExclusive" | "requiredUnless"): unknown[] => {
    const value = contract?.[name];
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      addInvalidContract(`configContract.${name}`, `${name} 必须是规则数组`);
      return [];
    }
    return value;
  };
  const ruleKeys = (rawRule: unknown, path: string): { rule: JsonRecord; keys: string[] } | undefined => {
    if (!isRecord(rawRule) || !Array.isArray(rawRule.keys)) {
      addInvalidContract(path, "规则必须包含非空 keys 数组");
      return undefined;
    }
    const keys = [...new Set(rawRule.keys.map((key) => typeof key === "string" ? key.trim() : "").filter(Boolean))];
    if (keys.length === 0 || keys.length !== rawRule.keys.length) {
      addInvalidContract(path, "keys 必须由不重复的非空配置项名称组成");
      return undefined;
    }
    const undeclared = keys.filter((key) => !declared.has(key));
    if (undeclared.length > 0) {
      addInvalidContract(path, `引用了 configSchema 未声明的配置项 ${undeclared.join("、")}`);
      return undefined;
    }
    return { rule: rawRule, keys };
  };

  for (const [index, rawRule] of ruleList("atLeastOne").entries()) {
    const parsed = ruleKeys(rawRule, `configContract.atLeastOne[${index}]`);
    if (!parsed || parsed.keys.some((key) => present(config[key]))) continue;
    const path = parsed.keys.join("|");
    missingConfigKeys.add(path);
    issues.push({
      code: "at_least_one_missing",
      path,
      message: typeof parsed.rule.message === "string" && parsed.rule.message.trim()
        ? parsed.rule.message.trim()
        : `请填写 ${humanList(parsed.keys, "或")} 中的一项。`,
    });
  }

  for (const [index, rawRule] of ruleList("mutuallyExclusive").entries()) {
    const parsed = ruleKeys(rawRule, `configContract.mutuallyExclusive[${index}]`);
    if (!parsed) continue;
    const configured = parsed.keys.filter((key) => present(config[key]));
    if (configured.length < 2) continue;
    configured.forEach((key) => invalidConfigKeys.add(key));
    issues.push({
      code: "mutually_exclusive_conflict",
      path: configured.join("|"),
      message: typeof parsed.rule.message === "string" && parsed.rule.message.trim()
        ? parsed.rule.message.trim()
        : `${humanList(configured, "和")} 不能同时填写，请只保留一个。`,
    });
  }

  for (const [index, rawRule] of ruleList("requiredUnless").entries()) {
    const path = `configContract.requiredUnless[${index}]`;
    const parsed = ruleKeys(rawRule, path);
    if (!parsed) continue;
    const exception = parsed.rule.unless;
    if (!isRecord(exception) || typeof exception.key !== "string" || !exception.key.trim() || !("equals" in exception)) {
      addInvalidContract(path, "requiredUnless 必须声明 unless.key 和 unless.equals");
      continue;
    }
    const exceptionKey = exception.key.trim();
    const expected = exception.equals;
    const validExpected = expected === null
      || typeof expected === "string"
      || typeof expected === "boolean"
      || (typeof expected === "number" && Number.isFinite(expected));
    if (!declared.has(exceptionKey) || !validExpected) {
      addInvalidContract(path, !declared.has(exceptionKey)
        ? `unless.key 引用了 configSchema 未声明的配置项 ${exceptionKey}`
        : "unless.equals 只允许 JSON primitive");
      continue;
    }
    if (Object.is(config[exceptionKey], expected)) continue;
    const missing = parsed.keys.filter((key) => !present(config[key]));
    if (missing.length === 0) continue;
    missing.forEach((key) => missingConfigKeys.add(key));
    issues.push({
      code: "conditional_key_missing",
      path: missing.join("|"),
      message: typeof parsed.rule.message === "string" && parsed.rule.message.trim()
        ? parsed.rule.message.trim()
        : `除非 ${exceptionKey} 设置为 ${displayConditionValue(expected)}，否则还需要填写 ${humanList(missing, "和")}。`,
    });
  }

  const envRefs: string[] = [];
  const collectEnvRefs = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectEnvRefs);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveEnvironmentReferenceField(key) && typeof item === "string" && ENV_NAME.test(item)) {
        envRefs.push(item);
      }
      collectEnvRefs(item);
    }
  };
  collectEnvRefs(config);
  const uniqueEnvRefs = [...new Set(envRefs)].sort();
  const env = options.env ?? process.env;
  const missingConfiguredEnv = uniqueEnvRefs.filter((name) => !(env[name] ?? "").trim());
  const fallbackEnv = [...new Set(tool.credentialEnv ?? [])].sort();
  const fallbackSatisfied = fallbackEnv.length === 0 || fallbackEnv.some((name) => (env[name] ?? "").trim());
  const missingFallbackEnv = uniqueEnvRefs.length === 0 && !fallbackSatisfied ? fallbackEnv : [];
  const missingEnvRefs = [...new Set([...missingConfiguredEnv, ...missingFallbackEnv])].sort();
  const valid = issues.length === 0;
  return {
    valid,
    ready: valid && missingEnvRefs.length === 0,
    config,
    issues,
    missingConfigKeys: [...missingConfigKeys].sort(),
    invalidConfigKeys: [...invalidConfigKeys].sort(),
    envRefs: uniqueEnvRefs,
    missingEnvRefs,
  };
}

export function resolveIntegrationProfile(
  tool: RealTool,
  profileIdOrKey: string,
  environment: IntegrationProfileEnvironment,
): IntegrationProfile | undefined {
  return (tool.integrationProfiles ?? []).find((profile) =>
    (profile.id === profileIdOrKey || profile.profileKey === profileIdOrKey)
    && profile.environment === environment);
}
