/**
 * TC-60 — RBAC permission matrix (pure unit tests on @agentic/contracts).
 *
 * The matrix is the single source of truth shared by the api guard and the web
 * capability gating, so it gets exhaustive coverage independent of any route.
 */

import { describe, it, expect } from "vitest";
import {
  ROLE_PERMISSIONS,
  can,
  capabilitiesFor,
  PERMISSIONS,
} from "@agentic/contracts";

describe("TC-60: permission matrix", () => {
  it("viewer is read-only and cannot act or manage", () => {
    expect(can("viewer", "none", "runs.read")).toBe(true);
    expect(can("viewer", "none", "agents.read")).toBe(true);
    expect(can("viewer", "none", "runs.cancel")).toBe(false);
    expect(can("viewer", "none", "agents.invoke")).toBe(false);
    expect(can("viewer", "none", "members.write")).toBe(false);
    // Sensitive reads are admin-only, not granted to viewers.
    expect(can("viewer", "none", "members.read")).toBe(false);
    expect(can("viewer", "none", "audit.read")).toBe(false);
    expect(can("viewer", "none", "tokens.read")).toBe(false);
  });

  it("operator can run/operate but not configure or manage members", () => {
    expect(can("operator", "none", "runs.read")).toBe(true);
    expect(can("operator", "none", "agents.invoke")).toBe(true);
    expect(can("operator", "none", "runs.cancel")).toBe(true);
    expect(can("operator", "none", "tasks.resolve")).toBe(true);
    expect(can("operator", "none", "agents.write")).toBe(false);
    expect(can("operator", "none", "settings.write")).toBe(false);
    expect(can("operator", "none", "members.write")).toBe(false);
    expect(can("operator", "none", "members.read")).toBe(false);
  });

  it("admin has full tenant authority but no platform powers", () => {
    expect(can("admin", "none", "members.read")).toBe(true);
    expect(can("admin", "none", "members.write")).toBe(true);
    expect(can("admin", "none", "settings.write")).toBe(true);
    expect(can("admin", "none", "tokens.write")).toBe(true);
    expect(can("admin", "none", "tenant.update")).toBe(true);
    expect(can("admin", "none", "audit.read")).toBe(true);
    // Platform perms remain superadmin-only.
    expect(can("admin", "none", "platform.tenants.create")).toBe(false);
    expect(can("admin", "none", "platform.users.read")).toBe(false);
    expect(can("admin", "none", "platform.memberships.write")).toBe(false);
  });

  it("superadmin holds every permission, even with no tenant role", () => {
    for (const p of PERMISSIONS) {
      expect(can(null, "superadmin", p)).toBe(true);
    }
  });

  it("a user with no role holds nothing", () => {
    expect(can(null, "none", "runs.read")).toBe(false);
    expect(can(null, "none", "dashboard.read")).toBe(false);
  });

  it("role inclusion is monotonic: viewer ⊂ operator ⊂ admin", () => {
    for (const p of ROLE_PERMISSIONS.viewer) {
      expect(ROLE_PERMISSIONS.operator).toContain(p);
    }
    for (const p of ROLE_PERMISSIONS.operator) {
      expect(ROLE_PERMISSIONS.admin).toContain(p);
    }
  });

  it("capabilitiesFor reflects the matrix", () => {
    expect(capabilitiesFor("viewer", "none")).toEqual(ROLE_PERMISSIONS.viewer);
    expect(capabilitiesFor(null, "superadmin")).toHaveLength(PERMISSIONS.length);
    expect(capabilitiesFor(null, "none")).toEqual([]);
  });
});
