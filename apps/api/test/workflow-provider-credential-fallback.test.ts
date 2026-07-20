import type { ToolContext } from "@agentic/agent-kit";
import { setIntegrationResolver } from "@agentic/tools";
import { afterEach, describe, expect, it } from "vitest";
import { ghAuthToken } from "../../../packages/tools/src/gohire/rest-helper";
import { rhAuthToken } from "../../../packages/tools/src/robohire/rest-helper";

const ROBOHIRE_ENV = "TENANT_CREDENTIAL_TEST_ROBOHIRE_KEY";
const GOHIRE_ENV = "TENANT_CREDENTIAL_TEST_GOHIRE_KEY";

const originalEnv = {
  robohireGlobal: process.env.ROBOHIRE_API_KEY,
  gohireGlobal: process.env.GOHIRE_API_KEY,
  robohireTenant: process.env[ROBOHIRE_ENV],
  gohireTenant: process.env[GOHIRE_ENV],
};

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function context(config?: Record<string, unknown>): ToolContext {
  return {
    agentName: "credentialRegressionAgent",
    actionName: "credentialRegressionAction",
    correlationId: "corr-credential-regression",
    tenantSlug: "credential-test",
    config,
  };
}

afterEach(() => {
  restoreEnv("ROBOHIRE_API_KEY", originalEnv.robohireGlobal);
  restoreEnv("GOHIRE_API_KEY", originalEnv.gohireGlobal);
  restoreEnv(ROBOHIRE_ENV, originalEnv.robohireTenant);
  restoreEnv(GOHIRE_ENV, originalEnv.gohireTenant);
  setIntegrationResolver(null);
});

// NOTE on asymmetry: the robohire helper is env-reference-ONLY (literal
// base_url/api_key are forbidden outright and there is no global-key or
// integration-store fallback at all — strictly stronger than "refusing to
// fall back"), while the gohire helper resolves manifest config → integration
// store → env. The robohire halves below assert that stricter contract.
describe("workflow provider credential fallback", () => {
  it("never falls back to the global RoboHire key when an explicit env binding is unset", () => {
    process.env.ROBOHIRE_API_KEY = "server-global-robohire-secret";
    delete process.env[ROBOHIRE_ENV];

    // The explicit binding is unset → hard error; the global key is never read.
    expect(() =>
      rhAuthToken(context({ api_key_env: ROBOHIRE_ENV })),
    ).toThrow(new RegExp(`environment reference ${ROBOHIRE_ENV} is not configured`));
  });

  it("never falls back to a GoHire integration or global key when an explicit env binding is unset", () => {
    process.env.GOHIRE_API_KEY = "server-global-gohire-secret";
    delete process.env[GOHIRE_ENV];
    setIntegrationResolver(() => ({
      base_url: "https://integration.gohire.example/v1",
      api_key: "tenant-integration-gohire-secret",
    }));

    expect(() =>
      ghAuthToken(
        context({
          base_url: "https://approved.example.test/gohire/v1",
          api_key_env: GOHIRE_ENV,
        }),
      ),
    ).toThrow(
      /refusing to fall back to the integration store or GOHIRE_API_KEY/,
    );
  });

  it("requires an explicit env binding before a manifest customizes either provider endpoint", () => {
    process.env.ROBOHIRE_API_KEY = "server-global-robohire-secret";
    process.env.GOHIRE_API_KEY = "server-global-gohire-secret";
    setIntegrationResolver(() => ({ api_key: "tenant-integration-secret" }));

    // robohire: a literal base_url is forbidden outright (env-ref-only).
    expect(() =>
      rhAuthToken(
        context({ base_url: "https://approved.example.test/robohire/v1" }),
      ),
    ).toThrow(/literal config 'base_url' is forbidden/);
    expect(() =>
      ghAuthToken(
        context({ base_url: "https://approved.example.test/gohire/v1" }),
      ),
    ).toThrow(/custom base_url requires an explicit api_key_env/);
  });

  it("uses explicit tenant credentials and preserves defaults when no override is declared", () => {
    process.env.ROBOHIRE_API_KEY = "server-global-robohire-secret";
    process.env.GOHIRE_API_KEY = "server-global-gohire-secret";
    process.env[ROBOHIRE_ENV] = "tenant-robohire-secret";
    process.env[GOHIRE_ENV] = "tenant-gohire-secret";
    setIntegrationResolver(() => ({
      api_key: "tenant-integration-gohire-secret",
    }));

    expect(rhAuthToken(context({ api_key_env: ROBOHIRE_ENV }))).toBe(
      "tenant-robohire-secret",
    );
    expect(ghAuthToken(context({ api_key_env: GOHIRE_ENV }))).toBe(
      "tenant-gohire-secret",
    );
    // robohire has NO implicit default: config without an explicit env
    // reference is an error, never the server-global key.
    expect(() => rhAuthToken(context())).toThrow(
      /api_key_env must be an explicit valid environment variable name/,
    );
    expect(ghAuthToken(context())).toBe("tenant-integration-gohire-secret");
  });

  it("preserves server credential defaults for explicitly provider-owned URLs", () => {
    process.env.ROBOHIRE_API_KEY = "server-global-robohire-secret";
    process.env.GOHIRE_API_KEY = "server-global-gohire-secret";
    setIntegrationResolver(null);

    // robohire: provider-owned or not, a literal base_url never passes.
    expect(() =>
      rhAuthToken(context({ base_url: "https://api.robohire.io/api/v1" })),
    ).toThrow(/literal config 'base_url' is forbidden/);
    expect(ghAuthToken(context({ base_url: "https://api.gohire.io/v1" }))).toBe(
      "server-global-gohire-secret",
    );
  });
});
