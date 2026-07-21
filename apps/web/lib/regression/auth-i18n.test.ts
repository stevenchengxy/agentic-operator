import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const WEB_ROOT = resolve(__dirname, "..", "..");
const authForm = readFileSync(
  resolve(WEB_ROOT, "app/(auth)/auth-form.tsx"),
  "utf8",
);

describe("authentication i18n wiring", () => {
  it("shares the persisted portal language preference", () => {
    expect(authForm).toContain("<PreferencesProvider>");
    expect(authForm).toContain("<LanguageToggle />");
    expect(authForm).toContain("const { t } = useI18n()");
  });

  it("translates both modes and their validation feedback", () => {
    expect(authForm).toContain('"auth.signInTitle"');
    expect(authForm).toContain('"auth.signUpTitle"');
    expect(authForm).toContain('t("auth.passwordMin")');
    expect(authForm).toContain('t("auth.genericError")');
  });
});
