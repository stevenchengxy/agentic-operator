import { afterEach, describe, expect, it } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";

import { rhAuthToken, rhBaseUrl, rhTimeoutMs } from "./rest-helper";

const ctx = (config?: Record<string, unknown>) => ({ config } as ToolContext);

afterEach(() => {
  delete process.env.ROBOHIRE_API_KEY;
  delete process.env.ROBOHIRE_API_BASE_URL;
  delete process.env.ROBOHIRE_TIMEOUT_MS;
});

describe("RoboHire explicit environment-reference config", () => {
  it("has no hardcoded/global fallback when profile references are absent", () => {
    process.env.ROBOHIRE_API_KEY = "live-secret";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.example/api/v1";
    expect(() => rhAuthToken(ctx())).toThrow(/api_key_env.*explicit/i);
    expect(() => rhBaseUrl(ctx())).toThrow(/base_url_env.*explicit/i);
  });

  it("rejects literal credential and endpoint config", () => {
    expect(() => rhAuthToken(ctx({ api_key: "live-secret" }))).toThrow(/literal config 'api_key' is forbidden/);
    expect(() => rhBaseUrl(ctx({ base_url: "https:\/\/robohire.example" }))).toThrow(/literal config 'base_url' is forbidden/);
  });

  it("resolves only explicitly named server env values", () => {
    process.env.ROBOHIRE_API_KEY = "live-secret";
    process.env.ROBOHIRE_API_BASE_URL = "https://robohire.example/api/v1/";
    const config = { api_key_env: "ROBOHIRE_API_KEY", base_url_env: "ROBOHIRE_API_BASE_URL" };
    expect(rhAuthToken(ctx(config))).toBe("live-secret");
    expect(rhBaseUrl(ctx(config))).toBe("https://robohire.example/api/v1");
  });

  it("uses only the profile timeout or the code safety default", () => {
    process.env.ROBOHIRE_TIMEOUT_MS = "987654";
    expect(rhTimeoutMs(ctx())).toBe(30_000);
    expect(rhTimeoutMs(ctx({ timeout_ms: 45_000 }))).toBe(45_000);
    expect(() => rhTimeoutMs(ctx({ timeout_ms: -1 }))).toThrow(/positive finite/i);
  });
});
