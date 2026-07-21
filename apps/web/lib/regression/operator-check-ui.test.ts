import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB_ROOT = resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return readFileSync(resolve(WEB_ROOT, relativePath), "utf8");
}

describe("production two-agent system check UI", () => {
  const hook = read("lib/hooks/useOperatorChecks.ts");
  const page = read("app/portal/[tenant]/(views)/system-check/page.tsx");
  const dashboard = read("app/portal/[tenant]/(views)/dashboard/page.tsx");
  const sidebar = read("app/portal/components/shell/sidebar.tsx");

  it("uses the shared contracts and polls only the selected check", () => {
    expect(hook).toContain("StartOperatorCheckResponseSchema.parse");
    expect(hook).toContain("GetOperatorCheckResponseSchema.parse");
    expect(hook).toContain("ListOperatorChecksResponseSchema.parse");
    expect(hook).toContain('"/v1/operator-checks"');
    expect(hook).toContain("refetchInterval:");
    expect(hook).toContain("TERMINAL_STATUSES.has(response.check.status)");
  });

  it("shows accessible progress, failure, evidence, and two fixed scenarios", () => {
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain('role="progressbar"');
    expect(page).toContain('role="alert"');
    expect(page).toContain("OPERATOR_CHECK_SCENARIOS.map");
    expect(page).toContain('t("systemCheck.openFullRun")');
    expect(page).toContain('t("systemCheck.manifestEvidence")');
    expect(page).toContain('t("systemCheck.historyTitle")');
  });

  it("starts from Dashboard in one click and navigates to the API-provided detail URL", () => {
    expect(dashboard).toContain("useStartOperatorCheck()");
    expect(dashboard).toContain("operatorCheckStartGuard.current");
    expect(dashboard).toContain("router.push(result.detailUrl as never)");
    expect(dashboard).toContain('t("dashboard.runFullCheck")');
  });

  it("keeps saved checks discoverable in Manage navigation", () => {
    expect(sidebar).toContain("href={`${base}/system-check`}");
    // The label routes through the shell's i18n dictionary (nav.systemCheck)
    // rather than a hardcoded English string.
    expect(sidebar).toContain('label={t("nav.systemCheck")}');
    expect(sidebar).toContain('icon="check"');
  });
});
