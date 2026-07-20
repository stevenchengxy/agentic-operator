import { describe, expect, it } from "vitest";
import { resolveFactorySessionTokenLimit } from "./session-budget";

describe("Factory whole-session token backstop", () => {
  // 用户拍板：token 不设上限（「别再加回 token cap 当护栏」）。这个 cap 尤其有害是因为它不只
  // 熔断——逼近上限时 planProviderCall 会压 completionTokenCap、select_strategy 会把 maxLlmCalls
  // 从 10 砍到 2，AI 的推理深度被静默削弱且它自己无从得知。默认必须"不限"，要限只能显式配 env。
  it("默认不限——任何环境都一样（没有藏在生产默认里的 cap）", () => {
    expect(resolveFactorySessionTokenLimit({ NODE_ENV: "production" })).toBeNull();
    expect(resolveFactorySessionTokenLimit({ NODE_ENV: "development" })).toBeNull();
    expect(resolveFactorySessionTokenLimit({ NODE_ENV: "test" })).toBeNull();
    expect(resolveFactorySessionTokenLimit({})).toBeNull();
  });

  it("运维要熔断可以【显式】opt-in", () => {
    expect(resolveFactorySessionTokenLimit({
      NODE_ENV: "production",
      FACTORY_BRAIN_MAX_SESSION_TOKENS: "12000",
    })).toBe(12_000);
    expect(resolveFactorySessionTokenLimit({
      NODE_ENV: "test",
      FACTORY_BRAIN_MAX_SESSION_TOKENS: "12000",
    })).toBe(12_000);
  });

  it("supports explicit opt-out but rejects ambiguous configuration", () => {
    expect(resolveFactorySessionTokenLimit({
      NODE_ENV: "production",
      FACTORY_BRAIN_MAX_SESSION_TOKENS: "0",
    })).toBeNull();
    for (const value of ["-1", "1.5", "disabled", "Infinity", "9007199254740992"]) {
      expect(() => resolveFactorySessionTokenLimit({
        NODE_ENV: "production",
        FACTORY_BRAIN_MAX_SESSION_TOKENS: value,
      })).toThrow(/positive/);
    }
  });
});
