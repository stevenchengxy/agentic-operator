import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("Settings production-honesty guard", () => {
  // Channels/Notifications stub sections were removed outright (no backing
  // API); the registry must not resurrect them as inert placeholder tabs.
  it("does not register removed stub sections", () => {
    const data = source("./data.ts");
    expect(data).not.toMatch(/"channels"|"notifications"/);
  });

  it("backs People with the live membership surface, not fixtures", () => {
    const text = source("./sections/People.tsx");
    expect(text).toContain("useMembers");
    expect(text).not.toMatch(/SETTINGS_MEMBERS|Liu Wei/);
  });

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
    // The audit view must read the live /v1/audit pages hook rather than a
    // synthesized fallback array.
    expect(audit).toContain("useAuditPages");
  });
});
