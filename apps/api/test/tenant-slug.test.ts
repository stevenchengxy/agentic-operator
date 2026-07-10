/**
 * Regression guard for the "新建租户" (create-tenant) silent dead-end.
 *
 * Bug: the create wizard auto-derives the slug from the display name by
 * stripping every non-[a-z0-9-] char. A pure-Chinese name (the natural input
 * for a Chinese operator) strips to "" → `canNextFrom1` is false → the "Next"
 * button is disabled. The slug error was gated on `slugDirty`, which is false
 * because the user never touched the slug field, so NO error rendered — the
 * user saw a disabled button with no explanation ("无法新建").
 *
 * These tests pin the three pure pieces extracted out of TenantCreateModal:
 *   - deriveSlug         — the auto-derivation (proves the empty-slug trigger)
 *   - computeSlugIssues  — the validation
 *   - shouldShowSlugIssue — the render gating (the actual fix: surface the
 *                           issue once a name is typed, not only when dirty)
 */
import { describe, it, expect } from "vitest";
import {
  deriveSlug,
  computeSlugIssues,
  shouldShowSlugIssue,
} from "../../web/app/portal/components/shell/tenant-slug";

describe("deriveSlug", () => {
  it("derives a clean slug from a Latin name", () => {
    expect(deriveSlug("Acme Corp")).toBe("acme-corp");
  });
  it("derives from a mixed Latin/Chinese name by keeping the Latin run", () => {
    expect(deriveSlug("ACME 招聘")).toBe("acme");
  });
  it("derives EMPTY from a pure-Chinese name — the bug trigger", () => {
    expect(deriveSlug("测试租户")).toBe("");
    expect(deriveSlug("深圳前端团队")).toBe("");
  });
  it("forces a leading non-letter to 't'", () => {
    expect(deriveSlug("2026 team")).toBe("t026-team");
  });
});

describe("computeSlugIssues", () => {
  it("flags an empty slug as required", () => {
    expect(computeSlugIssues("", new Set())).toEqual(["required"]);
  });
  it("passes a clean slug", () => {
    expect(computeSlugIssues("acme", new Set())).toEqual([]);
  });
  it("flags a reserved slug", () => {
    expect(computeSlugIssues("admin", new Set())).toContain("reserved");
  });
  it("flags an already-taken slug", () => {
    expect(computeSlugIssues("acme", new Set(["acme"]))).toContain("taken");
  });
  it("flags a bad format (uppercase / spaces lowercased to space)", () => {
    expect(computeSlugIssues("ab c", new Set())).toContain("format");
  });
});

describe("shouldShowSlugIssue (the fix)", () => {
  it("SHOWS the issue once a name is typed even if the slug field is untouched", () => {
    // Chinese name → empty slug → required issue, slugDirty=false.
    // This is the case that used to render nothing (silent dead-end).
    expect(
      shouldShowSlugIssue({ slugDirty: false, name: "测试租户", issueCount: 1 }),
    ).toBe(true);
  });
  it("stays silent on a pristine modal (no name, untouched slug)", () => {
    expect(
      shouldShowSlugIssue({ slugDirty: false, name: "", issueCount: 1 }),
    ).toBe(false);
  });
  it("shows the issue when the user has edited the slug field", () => {
    expect(
      shouldShowSlugIssue({ slugDirty: true, name: "", issueCount: 1 }),
    ).toBe(true);
  });
  it("shows nothing when there are no issues", () => {
    expect(
      shouldShowSlugIssue({ slugDirty: true, name: "Acme", issueCount: 0 }),
    ).toBe(false);
  });
});
