/**
 * Pure slug helpers for the create-tenant wizard (TenantCreateModal).
 *
 * Extracted so the validation + the "should we surface this issue?" gating are
 * unit-testable (apps/api/test/tenant-slug.test.ts) without a React harness.
 * No React / Next imports here — keep it pure.
 */
import { RESERVED_TENANT_SLUGS, TENANT_SLUG_REGEX } from "@agentic/contracts";

/**
 * Auto-derive a slug from the display name: lowercase, collapse every
 * non-[a-z0-9-] run to a hyphen, trim hyphens, force a leading non-letter to
 * 't', cap at 32 chars. A name with no Latin letters (e.g. pure Chinese)
 * derives to "" — the caller must then prompt for a manual slug.
 */
export function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]/, "t")
    .slice(0, 32);
}

/**
 * Validate a slug against the same regex + reserved-list the server enforces.
 * Returns issue CODES (i18n keys under `tenantCreateModal.slugIssue.*`).
 */
export function computeSlugIssues(
  slug: string,
  existingSlugs: Set<string>,
): string[] {
  const issues: string[] = [];
  if (!slug) {
    issues.push("required");
    return issues;
  }
  if (!TENANT_SLUG_REGEX.test(slug)) {
    issues.push("format");
  }
  if (RESERVED_TENANT_SLUGS.has(slug)) issues.push("reserved");
  if (slug.startsWith("_") || slug.startsWith("-") || slug.endsWith("-")) {
    issues.push("edges");
  }
  if (existingSlugs.has(slug)) issues.push("taken");
  return issues;
}

/**
 * Whether to render the slug issue under the field. The fix: show it as soon as
 * the user has typed a display NAME (not only after they've touched the slug
 * field). Otherwise a name that auto-derives to an empty/invalid slug leaves
 * "Next" disabled with no visible reason — the "无法新建" dead-end.
 */
export function shouldShowSlugIssue(opts: {
  slugDirty: boolean;
  name: string;
  issueCount: number;
}): boolean {
  return opts.issueCount > 0 && (opts.slugDirty || opts.name.trim().length > 0);
}
