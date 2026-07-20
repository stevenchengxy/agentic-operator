/**
 * factory_runs soft-delete + tenant scoping (migration 0021).
 *
 * Locks in the correctness/security fix behind the 历史运行 delete管理 redesign:
 *   - listRuns is now tenant-scoped (was unfiltered → every tenant saw every tenant's runs)
 *   - deleteRun is a SOFT delete (deletedAt), recoverable via restoreRun, and refuses to touch
 *     a row that belongs to another tenant or a live 'running' row
 *   - deleteRunsByDomain (清空已完成) clears finished rows for one tenant only, never a running or
 *     waiting-for-human one
 *
 * Pure store-level (no HTTP): exercises the functions the routes call. Rows are inserted under
 * a unique throwaway domain against two real seeded tenants, then hard-deleted in afterAll so the
 * shared dev DB isn't polluted.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, like } from "drizzle-orm";
import { getDb, factoryRuns, tenants } from "@agentic/db";
import { recordRunStart, recordRunFinish, listRuns, getRun, deleteRun, restoreRun, deleteRunsByDomain, factoryRunExecutionEvidence } from "../src/services/agent-factory";
import { clearFactoryDomainBinding, setFactoryDomainBinding } from "../src/services/agent-factory/domain-binding";

const SUF = `${Date.now().toString(36)}`.slice(-6);
const DOMAIN = `__sdtest_${SUF}`;
const ID = (k: string) => `frn-sdt-${SUF}-${k}`;
const finish = (id: string, tenantId: string, transcript: unknown[] = []) => recordRunFinish(id, { status: "finished", tokensUsed: 1, turns: 1, agentsCount: 1, reachedTerminal: true, transcript }, tenantId);

describe("factory_runs soft-delete + tenant scoping (0021)", () => {
  let tenA: string;
  let tenB: string;

  beforeAll(() => {
    tenA = `ten-sdt-${SUF}-a`;
    tenB = `ten-sdt-${SUF}-b`;
    getDb().insert(tenants).values([
      { id: tenA, slug: `sdt-${SUF}-a`, name: "Soft delete test A" },
      { id: tenB, slug: `sdt-${SUF}-b`, name: "Soft delete test B" },
    ]).run();
    setFactoryDomainBinding(tenA, { id: DOMAIN }, "explicit");
    setFactoryDomainBinding(tenB, { id: DOMAIN }, "explicit");
    recordRunStart(DOMAIN, "A1", tenA, ID("a1"));
    finish(ID("a1"), tenA, [{ t: "sandbox", simulated: false, fullChainRan: true }]);
    recordRunStart(DOMAIN, "A2", tenA, ID("a2"));
    finish(ID("a2"), tenA, [{ t: "sandbox", simulated: true }]);
    recordRunStart(DOMAIN, "B1", tenB, ID("b1"));
    finish(ID("b1"), tenB);
    recordRunStart(DOMAIN, "running", tenA, ID("run")); // stays 'running'
    recordRunStart(DOMAIN, "waiting", tenA, ID("wait"));
    recordRunFinish(ID("wait"), { status: "waiting_human", tokensUsed: 1, turns: 1, agentsCount: 0, reachedTerminal: false, transcript: [{ t: "done", status: "waiting_human", completionKind: "incomplete" }] }, tenA);
  });

  afterAll(() => {
    getDb().delete(factoryRuns).where(like(factoryRuns.id, `frn-sdt-${SUF}-%`)).run();
    clearFactoryDomainBinding(tenA);
    clearFactoryDomainBinding(tenB);
    getDb().delete(tenants).where(eq(tenants.id, tenA)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenB)).run();
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

  it("labels real, simulated-only, and missing sandbox evidence explicitly", () => {
    const evidence = new Map(
      listRuns(DOMAIN, tenA).map((run) => [run.id, run.evidenceStatus]),
    );
    expect(evidence.get(ID("a1"))).toBe("real");
    expect(evidence.get(ID("a2"))).toBe("simulated_only");
    expect(getRun(ID("b1"), tenB)?.evidenceStatus).toBe("none");
    expect(getRun(ID("a1"), tenA)?.realExecutionSucceeded).toBe(true);
    expect(getRun(ID("a2"), tenA)?.realExecutionSucceeded).toBe(false);
    expect(getRun(ID("b1"), tenB)?.realExecutionSucceeded).toBe(false);
    expect(factoryRunExecutionEvidence([
      { t: "sandbox", simulated: false, fullChainRan: true },
      { t: "sandbox", simulated: false, fullChainRan: false },
    ])).toEqual({
      evidenceStatus: "real",
      realExecutionSucceeded: false,
    });
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

  it("does not allow ontology rebinding while a human decision is still pending", () => {
    // Temporarily finalize the separate live row so the waiting row is the
    // condition that independently blocks the identity change.
    finish(ID("run"), tenA);
    expect(() => setFactoryDomainBinding(tenA, { id: `${DOMAIN}-other` }, "explicit"))
      .toThrow(/等待人工回复/);
    expect(getRun(ID("wait"), tenA)?.status).toBe("waiting_human");
  });

  it("clear-by-domain soft-deletes terminal rows but preserves waiting-human work", () => {
    const cleared = deleteRunsByDomain(DOMAIN, tenA);
    expect(cleared).toBeGreaterThanOrEqual(2);
    const remaining = listRuns(DOMAIN, tenA).map((r) => r.id);
    expect(remaining).not.toContain(ID("a1"));
    expect(remaining).not.toContain(ID("a2"));
    expect(remaining).toContain(ID("wait")); // waiting row untouched
    expect(listRuns(DOMAIN, tenB).map((r) => r.id)).toContain(ID("b1")); // other tenant untouched
  });
});
