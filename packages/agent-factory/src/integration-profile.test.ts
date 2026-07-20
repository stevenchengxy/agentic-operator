import { describe, expect, it } from "vitest";
import type { RealTool } from "./tool-catalog";
import { validateIntegrationToolConfig } from "./integration-profile";

const tool: RealTool = {
  name: "ontology.writeInstance",
  credentialEnv: ["ALLMETA_API_KEY"],
  catalogDefinition: {
    name: "ontology.writeInstance",
    configSchema: {
      base_url_env: { type: "string", required: true },
      api_key_env: { type: "string", required: true },
      domain: { type: "string", required: true },
      action: { type: "string", required: true },
      allowed_tenants: { type: "string[]", required: true },
      allowed_domains: { type: "string[]", required: true },
      allowed_objects: { type: "string[]", required: true },
      allowed_actions: { type: "string[]", required: true },
      timeout_ms: { type: "number" },
    },
  },
};

const safeConfig = {
  base_url_env: "ALLMETA_BASE_URL",
  api_key_env: "ALLMETA_API_KEY",
  domain: "RAAS-v1",
  action: "processResume",
  allowed_tenants: ["raas"],
  allowed_domains: ["RAAS-v1"],
  allowed_objects: ["Candidate", "Resume"],
  allowed_actions: ["processResume"],
  timeout_ms: 15_000,
};

describe("integration profile config validator", () => {
  it("accepts only non-secret config and reports missing env names without exposing values", () => {
    const missing = validateIntegrationToolConfig(tool, safeConfig, { env: {} });
    expect(missing).toMatchObject({
      valid: true,
      ready: false,
      envRefs: ["ALLMETA_API_KEY", "ALLMETA_BASE_URL"],
      missingEnvRefs: ["ALLMETA_API_KEY", "ALLMETA_BASE_URL"],
    });
    expect(JSON.stringify(missing)).not.toContain("secret-value");

    const ready = validateIntegrationToolConfig(tool, safeConfig, {
      env: { ALLMETA_API_KEY: "secret-value", ALLMETA_BASE_URL: "https://allmeta.example.test" },
    });
    expect(ready).toMatchObject({ valid: true, ready: true, missingEnvRefs: [] });
    expect(JSON.stringify(ready)).not.toContain("secret-value");
  });

  it("is deterministic across object key order", () => {
    const reversed = Object.fromEntries(Object.entries(safeConfig).reverse());
    const first = validateIntegrationToolConfig(tool, safeConfig, { env: {} });
    const second = validateIntegrationToolConfig(tool, reversed, { env: {} });
    expect(first).toEqual(second);
  });

  it("rejects literal credentials, unknown keys, invalid types and wildcard allowlists", () => {
    const result = validateIntegrationToolConfig(tool, {
      ...safeConfig,
      api_key: "literal-secret",
      timeout_ms: "fast",
      allowed_objects: ["*"],
      invented: true,
    }, { env: {} });
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "literal_secret",
      "unknown_key",
      "invalid_type",
      "unsafe_allowlist",
    ]));
  });

  it("keeps missing required fields out of invalidConfigKeys", () => {
    const result = validateIntegrationToolConfig(tool, {}, { env: {} });
    expect(result.valid).toBe(false);
    expect(result.missingConfigKeys).toEqual([
      "action",
      "allowed_actions",
      "allowed_domains",
      "allowed_objects",
      "allowed_tenants",
      "api_key_env",
      "base_url_env",
      "domain",
    ]);
    expect(result.invalidConfigKeys).toEqual([]);
  });

  it("executes declarative cross-field rules without branching on a tool name", () => {
    const relationalTool: RealTool = {
      name: "vendor.readBlob",
      catalogDefinition: {
        name: "vendor.readBlob",
        configSchema: {
          endpoint: { type: "string" },
          endpoint_env: { type: "string" },
          access_key_env: { type: "string" },
          secret_key_env: { type: "string" },
          auth: { type: "string", allowedValues: ["sigv4", "anonymous"] },
        },
        configContract: {
          atLeastOne: [{ keys: ["endpoint", "endpoint_env"] }],
          mutuallyExclusive: [{ keys: ["endpoint", "endpoint_env"] }],
          requiredUnless: [{
            keys: ["access_key_env", "secret_key_env"],
            unless: { key: "auth", equals: "anonymous" },
          }],
        },
      },
    };

    const empty = validateIntegrationToolConfig(relationalTool, {}, { env: {} });
    expect(empty).toMatchObject({
      valid: false,
      ready: false,
      missingConfigKeys: ["access_key_env", "endpoint|endpoint_env", "secret_key_env"],
      invalidConfigKeys: [],
    });
    expect(empty.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "at_least_one_missing" }),
      expect.objectContaining({ code: "conditional_key_missing" }),
    ]));
    expect(empty.issues.map((issue) => issue.message).join(" ")).toContain("endpoint 或 endpoint_env");
    expect(empty.issues.map((issue) => issue.message).join(" ")).toContain("除非 auth 设置为 anonymous");

    const anonymous = validateIntegrationToolConfig(relationalTool, {
      endpoint: "https://objects.example.test",
      auth: "anonymous",
    }, { env: {} });
    expect(anonymous).toMatchObject({ valid: true, ready: true });

    const conflicting = validateIntegrationToolConfig(relationalTool, {
      endpoint: "https://objects.example.test",
      endpoint_env: "OBJECT_STORE_ENDPOINT",
      auth: "anonymous",
    }, { env: { OBJECT_STORE_ENDPOINT: "configured" } });
    expect(conflicting).toMatchObject({
      valid: false,
      invalidConfigKeys: ["endpoint", "endpoint_env"],
      missingConfigKeys: [],
    });
    expect(conflicting.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "mutually_exclusive_conflict" }),
    ]));

    const unsupportedAuth = validateIntegrationToolConfig(relationalTool, {
      endpoint: "https://objects.example.test",
      auth: "garbage",
      access_key_env: "OBJECT_STORE_ACCESS_KEY",
      secret_key_env: "OBJECT_STORE_SECRET_KEY",
    }, {
      env: {
        OBJECT_STORE_ACCESS_KEY: "configured",
        OBJECT_STORE_SECRET_KEY: "configured",
      },
    });
    expect(unsupportedAuth).toMatchObject({
      valid: false,
      invalidConfigKeys: ["auth"],
      missingConfigKeys: [],
    });
    expect(unsupportedAuth.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "value_not_allowed", path: "auth" }),
    ]));
  });

  it("rejects credentials embedded in non-secret URL config", () => {
    const urlTool: RealTool = {
      name: "vendor.call",
      catalogDefinition: {
        name: "vendor.call",
        configSchema: { base_url: { type: "string", required: true } },
      },
    };
    const result = validateIntegrationToolConfig(urlTool, {
      base_url: "https://user:pass@example.test/api?access_token=hidden",
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "credential_in_url", path: "base_url" }),
    ]));
  });

  it("rejects secret-shaped values recursively, including inside arrays", () => {
    const nestedTool: RealTool = {
      name: "vendor.call",
      catalogDefinition: {
        name: "vendor.call",
        configSchema: {
          transport: { type: "object" },
          interceptors: { type: "array" },
        },
      },
    };
    const result = validateIntegrationToolConfig(nestedTool, {
      transport: { header: "Bearer should-not-be-stored" },
      interceptors: [{ value: "sk-array-secret-123456" }],
    });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "literal_secret", path: "transport.header" }),
      expect.objectContaining({ code: "literal_secret", path: "interceptors[0].value" }),
    ]));
  });

  it("uses the shared recursive credential detector for auth/header/key variants while allowing env refs", () => {
    const profileTool: RealTool = {
      name: "vendor.profile",
      catalogDefinition: {
        name: "vendor.profile",
        configSchema: {
          transport: { type: "object" },
          auth_env: { type: "string" },
          authHeaderEnv: { type: "string" },
          proxyAuthorizationEnv: { type: "string" },
          key_env: { type: "string" },
        },
      },
    };
    const literal = "this-is-a-real-secret-value";
    const rejected = validateIntegrationToolConfig(profileTool, {
      transport: {
        auth: literal,
        authHeader: literal,
        proxyAuthorization: literal,
        key: literal,
      },
      auth_env: "VENDOR_AUTH_ENV",
      authHeaderEnv: "VENDOR_AUTH_HEADER_ENV",
      proxyAuthorizationEnv: "VENDOR_PROXY_AUTH_ENV",
      key_env: "VENDOR_SIGNING_KEY_ENV",
    }, { env: {} });
    expect(rejected.valid).toBe(false);
    expect(rejected.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "literal_secret", path: "transport.auth" }),
      expect.objectContaining({ code: "literal_secret", path: "transport.authHeader" }),
      expect.objectContaining({ code: "literal_secret", path: "transport.proxyAuthorization" }),
      expect.objectContaining({ code: "literal_secret", path: "transport.key" }),
    ]));
    expect(JSON.stringify(rejected.issues)).not.toContain(literal);

    const envOnly = validateIntegrationToolConfig(profileTool, {
      transport: {},
      auth_env: "VENDOR_AUTH_ENV",
      authHeaderEnv: "VENDOR_AUTH_HEADER_ENV",
      proxyAuthorizationEnv: "VENDOR_PROXY_AUTH_ENV",
      key_env: "VENDOR_SIGNING_KEY_ENV",
    }, {
      env: {
        VENDOR_AUTH_ENV: "configured",
        VENDOR_AUTH_HEADER_ENV: "configured",
        VENDOR_PROXY_AUTH_ENV: "configured",
        VENDOR_SIGNING_KEY_ENV: "configured",
      },
    });
    expect(envOnly).toMatchObject({ valid: true, ready: true, missingEnvRefs: [] });
  });
});
