import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("Settings production-honesty guard", () => {
  it.each(["People", "Channels", "Notifications"])(
    "%s exposes capability status without inert form controls",
    (section) => {
      const text = source(`./sections/${section}.tsx`);
      expect(text).toMatch(/unavailable|not configured/i);
      expect(text).not.toMatch(/<Button|<TextIn|<SelectIn|<Toggle/);
    },
  );

  it("backs Billing with the real budget hooks and no synthesized plan", () => {
    const text = source("./sections/Billing.tsx");
    expect(text).toContain("useBudget()");
    expect(text).toContain("useUpdateBudget()");
    expect(text).not.toMatch(/PER_TENANT_BUDGETS|Open invoice|billing@/);
  });

  it("persists workspace identity and leaves runtime policy read-only", () => {
    const text = source("./sections/Workspace.tsx");
    expect(text).toContain("useUpdateTenant()");
    expect(text).toContain('value="Managed by runtime configuration"');
    expect(text).not.toMatch(/<Toggle|Save changes/);
  });

  it("does not render inert documentation or export actions", () => {
    const text = source("../../[tenant]/(views)/settings/page.tsx");
    expect(text).not.toMatch(/Settings docs|Export config/);

    const audit = source("./sections/Audit.tsx");
    expect(audit).not.toContain("Export CSV");
    expect(audit).toContain('setApiState("live")');
  });
});
