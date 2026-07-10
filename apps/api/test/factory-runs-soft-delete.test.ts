/**
 * factory_runs soft-delete + tenant scoping (migration 0021).
 *
 * Locks in the correctness/security fix behind the 历史运行 delete管理 redesign:
 *   - listRuns is now tenant-scoped (was unfiltered → every tenant saw every tenant's runs)
 *   - deleteRun is a SOFT delete (deletedAt), recoverable via restoreRun, and refuses to touch
 *     a row that belongs to another tenant or a live 'running' row
 *   - deleteRunsByDomain (清空已完成) clears finished rows for one tenant only, never a running one
 *
 * Pure store-level (no HTTP): exercises the functions the routes call. Rows are inserted under
 * a unique throwaway domain against two real seeded tenants, then hard-deleted in afterAll so the
 * shared dev DB isn't polluted.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { like } from "drizzle-orm";
import { getDb, factoryRuns, tenants } from "@agentic/db";
import { recordRunStart, recordRunFinish, listRuns, getRun, deleteRun, restoreRun, deleteRunsByDomain } from "../src/services/agent-factory";

const SUF = `${Date.now().toString(36)}`.slice(-6);
const DOMAIN = `__sdtest_${SUF}`;
const ID = (k: string) => `frn-sdt-${SUF}-${k}`;
const finish = (id: string) => recordRunFinish(id, { status: "finished", tokensUsed: 1, turns: 1, agentsCount: 1, reachedTerminal: true, transcript: [] });

describe("factory_runs soft-delete + tenant scoping (0021)", () => {
  let tenA: string;
  let tenB: string;

  beforeAll(() => {
    const ts = getDb().select({ id: tenants.id }).from(tenants).limit(2).all();
    tenA = ts[0]!.id;
    tenB = ts[1]!.id;
    recordRunStart(DOMAIN, "A1", tenA, ID("a1"));
    finish(ID("a1"));
    recordRunStart(DOMAIN, "A2", tenA, ID("a2"));
    finish(ID("a2"));
    recordRunStart(DOMAIN, "B1", tenB, ID("b1"));
    finish(ID("b1"));
    recordRunStart(DOMAIN, "running", tenA, ID("run")); // stays 'running'
  });

  afterAll(() => {
    getDb().delete(factoryRuns).where(like(factoryRuns.id, `frn-sdt-${SUF}-%`)).run();
  });

  it("scopes listRuns by tenant (no cross-tenant leak)", () => {
    const a = listRuns(DOMAIN, tenA).map((r) => r.id);
    expect(a).toContain(ID("a1"));
    expect(a).toContain(ID("a2"));
    expect(a).not.toContain(ID("b1"));
    const b = listRuns(DOMAIN, tenB).map((r) => r.id);
    expect(b).toContain(ID("b1"));
    expect(b).not.toContain(ID("a1"));
  });

  it("getRun is tenant-scoped", () => {
    expect(getRun(ID("b1"), tenA)).toBeNull();
    expect(getRun(ID("b1"), tenB)?.id).toBe(ID("b1"));
  });

  it("soft-delete hides from list, sets deletedAt, and is recoverable", () => {
    expect(deleteRun(ID("a1"), tenA)).toBe(true);
    expect(listRuns(DOMAIN, tenA).map((r) => r.id)).not.toContain(ID("a1"));
    expect(getRun(ID("a1"), tenA)?.deletedAt).toBeTruthy();
    expect(restoreRun(ID("a1"), tenA)).toBe(true);
    expect(listRuns(DOMAIN, tenA).map((r) => r.id)).toContain(ID("a1"));
  });

  it("refuses a cross-tenant delete", () => {
    expect(deleteRun(ID("a2"), tenB)).toBe(false);
    expect(listRuns(DOMAIN, tenA).map((r) => r.id)).toContain(ID("a2"));
  });

  it("never deletes a live 'running' row", () => {
    expect(deleteRun(ID("run"), tenA)).toBe(false);
  });

  it("clear-by-domain soft-deletes finished for that tenant only, skipping running", () => {
    const cleared = deleteRunsByDomain(DOMAIN, tenA);
    expect(cleared).toBeGreaterThanOrEqual(2);
    const remaining = listRuns(DOMAIN, tenA).map((r) => r.id);
    expect(remaining).not.toContain(ID("a1"));
    expect(remaining).not.toContain(ID("a2"));
    expect(remaining).toContain(ID("run")); // running row untouched
    expect(listRuns(DOMAIN, tenB).map((r) => r.id)).toContain(ID("b1")); // other tenant untouched
  });
});
