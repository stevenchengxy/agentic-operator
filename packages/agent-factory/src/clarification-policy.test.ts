import { describe, expect, it } from "vitest";
import {
  normalizeClarificationOptions,
  resolveClarificationTimeout,
} from "./clarification-policy";

describe("clarification timeout policy", () => {
  it("suspends without turning a recommended option into a human answer", () => {
    const result = resolveClarificationTimeout([
      { label: "执行真实写入", value: "authorize_write", recommended: true },
      { label: "先不执行", value: "deny_write" },
    ]);

    expect(result.action).toBe("suspend");
    expect(result.answer).toBeNull();
    expect(result.message).toContain("不会自动选择推荐项");
    expect(JSON.stringify(result)).not.toContain("authorize_write");
  });
});

describe("clarification option validation", () => {
  it("allows a free-text question without choices", () => {
    expect(normalizeClarificationOptions(undefined)).toEqual({
      ok: true,
      options: undefined,
    });
  });

  it("accepts two to four unique choices with one recommendation", () => {
    expect(
      normalizeClarificationOptions([
        { label: "保留完整邀请流程", value: "full_flow", recommended: true },
        { label: "只保留发送成功", value: "sent_only" },
      ]),
    ).toMatchObject({ ok: true });
  });

  it("rejects ambiguous choice sets", () => {
    expect(
      normalizeClarificationOptions([
        { label: "A", value: "same", recommended: true },
        { label: "B", value: "same" },
      ]),
    ).toMatchObject({ ok: false });
    expect(
      normalizeClarificationOptions([
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ]),
    ).toMatchObject({ ok: false });
  });
});
