/**
 * Structural guard for the production App Router navigation rail.
 *
 * The sidebar interaction depends on the shell reserving only the compact
 * rail width while the expanded surface overflows that grid track. These
 * assertions catch a future refactor that silently restores the old 232px
 * fixed column or removes the keyboard/touch affordances.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB_ROOT = resolve(__dirname, "..", "..");

function read(relativePath: string): string {
  return readFileSync(resolve(WEB_ROOT, relativePath), "utf8");
}

describe("production sidebar auto-collapse", () => {
  const sidebar = read("app/portal/components/shell/sidebar.tsx");
  const nav = read("app/portal/components/shell/nav.tsx");
  const tenantSwitcher = read(
    "app/portal/components/shell/tenant-switcher.tsx",
  );
  const chrome = read("app/portal/components/shell/chrome.tsx");
  const css = read("app/portal/components/shell/sidebar.module.css");

  it("keeps a compact grid track while expansion overlays the main view", () => {
    expect(chrome).toContain("className={styles.shell}");
    expect(css).toContain("--portal-nav-rail: 64px");
    expect(css).toContain(
      "grid-template-columns: var(--portal-nav-rail) minmax(0, 1fr)",
    );
    expect(css).toContain('.sidebar[data-expanded="true"]');
    expect(css).toContain("width: min(var(--portal-nav-expanded)");
  });

  it("opens automatically for pointer and keyboard users", () => {
    expect(sidebar).toContain("data-expanded={expanded}");
    expect(sidebar).toContain("onPointerEnter={handlePointerEnter}");
    expect(sidebar).toContain("onPointerLeave={handlePointerLeave}");
    expect(sidebar).toContain("onFocusCapture={handleFocus}");
    expect(sidebar).toContain("onBlurCapture={handleBlur}");
    expect(sidebar).toContain("aria-pressed={pinnedOpen}");
    expect(sidebar).toContain('target.closest("[data-sidebar-pin]")');
    expect(sidebar).toContain("data-sidebar-pin");
  });

  it("labels collapsed actions and renders a real tooltip", () => {
    expect(nav).toContain("data-sidebar-tooltip={accessibleLabel}");
    expect(nav).toContain("aria-label={accessibleLabel}");
    expect(nav).toContain('aria-current={active ? "page" : undefined}');
    expect(sidebar).toContain('role="tooltip"');
    expect(sidebar).toContain("createPortal(");
  });

  it("lets touch users expand before opening the tenant menu", () => {
    expect(tenantSwitcher).toContain("if (!expanded)");
    expect(tenantSwitcher).toContain("onRequestExpand()");
    expect(tenantSwitcher).toContain("data-sidebar-tooltip={`Tenant:");
  });

  it("respects compact screens and reduced-motion preferences", () => {
    expect(css).toContain("@media (max-width: 720px)");
    expect(css).toContain("--portal-nav-rail: 56px");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
