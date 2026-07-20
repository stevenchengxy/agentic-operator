/**
 * TC-101 — the runtime Domain is a tenant, while the factory Domain is an
 * ontology id. Their relationship is an explicit persisted binding; all
 * mutable factory state remains owned by tenant id even when two tenants use
 * the same ontology.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  factoryDomainBindings,
  getDb,
  getRawSqlite,
  tenants,
} from "@agentic/db";
import {
  bindingMatchesDomain,
  catalogDomain,
  clearFactoryDomainBinding,
  getFactoryDomainBinding,
  setFactoryDomainBinding,
} from "../src/services/agent-factory/domain-binding";
import {
  DrizzleConversationStore,
  DrizzleReflectionWriter,
  DrizzleSkillStore,
  DrizzleToolStatsStore,
  DrizzleToolStore,
} from "../src/services/agent-factory/stores";
import { beginFactoryActiveWork, listFactoryActiveWork } from "../src/services/agent-factory/active-work";

const suffix = Date.now().toString(36);
const tenantAId = `ten-tc101-a-${suffix}`;
const tenantBId = `ten-tc101-b-${suffix}`;
const sharedOntology = `Hiring-v2-${suffix}`;
const externalReadPolicy = {
  operation: "read" as const,
  effectScope: "external" as const,
  sandboxPolicy: "live_external" as const,
};

describe("TC-101: factory Domain binding and tenant isolation", () => {
  beforeAll(() => {
    const now = new Date();
    getDb().insert(tenants).values([
      { id: tenantAId, slug: `runtime-a-${suffix}`, name: "Runtime A", createdAt: now, updatedAt: now },
      { id: tenantBId, slug: `runtime-b-${suffix}`, name: "Runtime B", createdAt: now, updatedAt: now },
    ]).run();
  });

  afterAll(() => {
    clearFactoryDomainBinding(tenantAId);
    clearFactoryDomainBinding(tenantBId);
    getDb().delete(tenants).where(eq(tenants.id, tenantAId)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantBId)).run();
  });

  it("runs the latest migration on the isolated test clone", () => {
    const bindingColumns = getRawSqlite()
      .prepare("PRAGMA table_info(factory_domain_bindings)")
      .all() as Array<{ name: string }>;
    expect(bindingColumns.map((c) => c.name)).toEqual(expect.arrayContaining([
      "tenant_id",
      "ontology_domain_id",
      "source",
    ]));

    const toolColumns = getRawSqlite()
      .prepare("PRAGMA table_info(factory_tools)")
      .all() as Array<{ name: string }>;
    expect(toolColumns.map((c) => c.name)).toEqual(expect.arrayContaining([
      "id",
      "scope_key",
      "domain_key",
      "tenant_id",
      "name",
      "request_spec",
      "response_spec",
      "examples",
    ]));

    const statsColumns = getRawSqlite()
      .prepare("PRAGMA table_info(tool_stats)")
      .all() as Array<{ name: string }>;
    expect(statsColumns.map((c) => c.name)).toEqual(expect.arrayContaining([
      "id",
      "scope_key",
      "domain_key",
      "tenant_id",
      "tool_name",
    ]));
  });

  it("persists one explicit ontology binding per immutable tenant id", () => {
    const a = setFactoryDomainBinding(
      tenantAId,
      { id: sharedOntology, name: "招聘本体 v2" },
      "explicit",
    );
    const b = setFactoryDomainBinding(
      tenantBId,
      { id: sharedOntology, name: "同一份招聘本体" },
      "upload",
    );

    expect(a.tenantId).toBe(tenantAId);
    expect(b.tenantId).toBe(tenantBId);
    expect(getFactoryDomainBinding(tenantAId)?.ontologyDomainId).toBe(sharedOntology);
    expect(getFactoryDomainBinding(tenantBId)?.ontologyDomainId).toBe(sharedOntology);

    setFactoryDomainBinding(tenantAId, { id: `Finance-${suffix}` }, "explicit");
    expect(getFactoryDomainBinding(tenantAId)?.ontologyDomainId).toBe(`Finance-${suffix}`);
    expect(getFactoryDomainBinding(tenantBId)?.ontologyDomainId).toBe(sharedOntology);
  });

  it("uses catalog identity, not punctuation/version heuristics, during normal operation", () => {
    const catalog = [{ id: "Hiring-v2", name: "Hiring" }];
    expect(catalogDomain(catalog, "Hiring-v2")?.id).toBe("Hiring-v2");
    expect(catalogDomain(catalog, "hiring-v2")?.id).toBe("Hiring-v2");
    expect(catalogDomain(catalog, "Hiring v2")).toBeNull();
    expect(catalogDomain(catalog, "Hiring")).toBeNull();

    const binding = setFactoryDomainBinding(tenantAId, { id: "Hiring-v2" });
    expect(bindingMatchesDomain(binding, "Hiring-v2")).toBe(true);
    expect(bindingMatchesDomain(binding, "hiring-v2")).toBe(false);
    expect(bindingMatchesDomain(binding, "Hiring")).toBe(false);
  });

  it("keeps every overlapping detached task as an independent rebind guard", () => {
    setFactoryDomainBinding(tenantAId, { id: sharedOntology });
    const endFirst = beginFactoryActiveWork(tenantAId, `sandbox:${sharedOntology}`, "sandbox");
    const endSecond = beginFactoryActiveWork(tenantAId, `sandbox:${sharedOntology}`, "sandbox");
    expect(listFactoryActiveWork(tenantAId)).toHaveLength(2);
    expect(() => setFactoryDomainBinding(tenantAId, { id: `other-${suffix}` })).toThrow(/factory_running/);
    endFirst();
    expect(listFactoryActiveWork(tenantAId)).toHaveLength(1);
    expect(() => setFactoryDomainBinding(tenantAId, { id: `other-${suffix}` })).toThrow(/factory_running/);
    endSecond();
    expect(setFactoryDomainBinding(tenantAId, { id: `other-${suffix}` }).ontologyDomainId).toBe(`other-${suffix}`);
    setFactoryDomainBinding(tenantAId, { id: sharedOntology });
  });

  it("does not leak conversations or reflections between tenants sharing an ontology", async () => {
    const conversationId = `frn-tc101-${suffix}`;
    const conversationsA = new DrizzleConversationStore(tenantAId);
    const conversationsB = new DrizzleConversationStore(tenantBId);
    await conversationsA.save(conversationId, {
      domain: sharedOntology,
      messages: [{ role: "user", content: "tenant A secret" }],
      ctx: { owner: "A" },
    });

    expect(await conversationsA.has(conversationId)).toBe(true);
    expect(await conversationsB.has(conversationId)).toBe(false);
    expect(await conversationsB.load(conversationId)).toBeNull();
    await expect(conversationsB.save(conversationId, {
      domain: sharedOntology,
      messages: [],
      ctx: {},
    })).rejects.toThrow(/another tenant/);

    const reflectionsA = new DrizzleReflectionWriter(tenantAId);
    const reflectionsB = new DrizzleReflectionWriter(tenantBId);
    await reflectionsA.record(sharedOntology, {
      kind: "failure",
      summary: `only-a-${suffix}`,
      lesson: "A lesson",
    });
    await reflectionsB.record(sharedOntology, {
      kind: "success",
      summary: `only-b-${suffix}`,
      lesson: "B lesson",
    });
    expect((await reflectionsA.list(sharedOntology)).map((r) => r.summary)).toContain(`only-a-${suffix}`);
    expect((await reflectionsA.list(sharedOntology)).map((r) => r.summary)).not.toContain(`only-b-${suffix}`);
    expect((await reflectionsB.list(sharedOntology)).map((r) => r.summary)).toContain(`only-b-${suffix}`);
    expect((await reflectionsB.list(sharedOntology)).map((r) => r.summary)).not.toContain(`only-a-${suffix}`);
  });

  it("keeps generated tools tenant-owned even with the same name and ontology", async () => {
    const name = `tc101.same-tool.${suffix}`;
    const toolsA = new DrizzleToolStore(tenantAId);
    const toolsB = new DrizzleToolStore(tenantBId);
    await toolsA.save({
      name,
      description: "tenant A implementation",
      method: "GET",
      urlTemplate: "https://a.example.com/items",
      sideEffect: "read",
      ...externalReadPolicy,
      domain: sharedOntology,
    });
    await toolsB.save({
      name,
      description: "tenant B implementation",
      method: "GET",
      urlTemplate: "https://b.example.com/items",
      sideEffect: "read",
      ...externalReadPolicy,
      domain: sharedOntology,
    });

    expect((await toolsA.list(sharedOntology)).find((t) => t.name === name)?.description).toBe("tenant A implementation");
    expect((await toolsB.list(sharedOntology)).find((t) => t.name === name)?.description).toBe("tenant B implementation");
  });

  it("round-trips executable request/response contracts and grounded examples", async () => {
    const name = `tc101.http-contract.${suffix}`;
    const store = new DrizzleToolStore(tenantAId, sharedOntology);
    const manifest = {
      requestSpec: {
        encoding: "multipart" as const,
        fields: { candidate_id: "{candidateId}" },
        files: [{ field: "file", base64Path: "resume.base64", filenamePath: "resume.filename", mime: "application/pdf", required: true }],
        maxBytes: 2_000_000,
      },
      responseSpec: {
        assertions: [{ path: "success", op: "eq" as const, value: true, failure: "terminal" as const, code: "VENDOR_REJECTED" }],
        mappings: { candidateId: "data.candidate_id", resumeText: "data.text" },
      },
      examples: [{ request: { candidateId: "cand-1", resume: { base64: "[REDACTED]" } }, response: { success: true, data: { candidate_id: "cand-1", text: "Engineer" } }, source: "documentation" as const }],
    };
    await store.save({
      name,
      description: "Parse a resume",
      method: "POST",
      urlTemplate: "https://api.example.com/resumes",
      sideEffect: "read",
      ...externalReadPolicy,
      domain: sharedOntology,
      ...manifest,
    });
    expect((await store.list(sharedOntology)).find((tool) => tool.name === name)).toMatchObject(manifest);
  });

  it("keeps same-name tools and same-slug skills separate across a tenant rebind", async () => {
    const domainA = `Ontology-A-${suffix}`;
    const domainB = `Ontology-B-${suffix}`;
    const toolName = `tc101.rebind-tool.${suffix}`;
    const tools = new DrizzleToolStore(tenantAId);
    await tools.save({ name: toolName, description: "domain A", method: "GET", urlTemplate: "https://a.example.com", sideEffect: "read", ...externalReadPolicy, domain: domainA });
    await tools.save({ name: toolName, description: "domain B", method: "GET", urlTemplate: "https://b.example.com", sideEffect: "read", ...externalReadPolicy, domain: domainB });
    expect((await tools.list(domainA)).find((t) => t.name === toolName)?.description).toBe("domain A");
    expect((await tools.list(domainB)).find((t) => t.name === toolName)?.description).toBe("domain B");

    const slug = `same-skill-${suffix}`;
    const skillBase = { slug, name: "Same skill", purpose: "test", promptFragment: "prompt", tools: [], decisionRule: "rule" };
    const skillsA = new DrizzleSkillStore(tenantAId, domainA);
    const skillsB = new DrizzleSkillStore(tenantAId, domainB);
    await skillsA.save({ ...skillBase, domain: domainA });
    await skillsB.save({ ...skillBase, domain: domainB });
    await skillsA.bumpUse(slug);
    await skillsA.recordEval(slug, true);
    expect((await skillsA.list(domainA)).find((s) => s.slug === slug)).toMatchObject({ domain: domainA, useCount: 1, evalCount: 1, successCount: 1 });
    expect((await skillsB.list(domainB)).find((s) => s.slug === slug)).toMatchObject({ domain: domainB, useCount: 0, evalCount: 0, successCount: 0 });
  });

  it("isolates empirical tool ranking by tenant and ontology", async () => {
    const toolName = `tc101.stats.${suffix}`;
    const domainA = `Stats-A-${suffix}`;
    const domainB = `Stats-B-${suffix}`;
    const a = new DrizzleToolStatsStore(tenantAId, domainA);
    const aOtherDomain = new DrizzleToolStatsStore(tenantAId, domainB);
    const b = new DrizzleToolStatsStore(tenantBId, domainA);
    await a.record(toolName, false);
    await a.record(toolName, false);
    await aOtherDomain.record(toolName, true);
    await b.record(toolName, true);
    expect((await a.successRates())[toolName]).toEqual({ invoked: 2, succeeded: 0 });
    expect((await aOtherDomain.successRates())[toolName]).toEqual({ invoked: 1, succeeded: 1 });
    expect((await b.successRates())[toolName]).toEqual({ invoked: 1, succeeded: 1 });
  });

  it("cascades a binding with tenant deletion", () => {
    const id = `ten-tc101-c-${suffix}`;
    const now = new Date();
    getDb().insert(tenants).values({
      id,
      slug: `runtime-c-${suffix}`,
      name: "Runtime C",
      createdAt: now,
      updatedAt: now,
    }).run();
    setFactoryDomainBinding(id, { id: sharedOntology });
    getDb().delete(tenants).where(eq(tenants.id, id)).run();
    expect(getDb().select().from(factoryDomainBindings).where(eq(factoryDomainBindings.tenantId, id)).all()).toHaveLength(0);
  });
});
