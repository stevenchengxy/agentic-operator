import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { factoryDomainBindings, getDb, tenants } from "@agentic/db";
import { buildTestEnv, type TestEnv } from "./harness";
import {
  setTenantReasoningConfig,
} from "../src/services/reasoning/tenant-config";
import {
  setReasoningOntologyClient,
} from "../src/services/reasoning/context";

const suffix = Date.now().toString(36);
const tenantId = `ten-reasoning-isolation-${suffix}`;
const tenantSlug = `reasoning-${suffix}`.slice(0, 60);
const domainId = `reasoning-domain-${suffix}`;
const actionName = `realAction${suffix}`;
const headers = {
  "content-type": "application/json",
  "x-agentic-tenant": tenantSlug,
};

describe("standalone reasoning ontology isolation", () => {
  let env: TestEnv;

  beforeAll(async () => {
    process.env.AGENTIC_DEV_USER_EMAIL ??= "test-platform-admin@agentic.invalid";
    getDb()
      .insert(tenants)
      .values({ id: tenantId, slug: tenantSlug, name: "Reasoning isolation" })
      .run();
    env = await buildTestEnv();
    setTenantReasoningConfig(tenantSlug, {
      ontology: { provider: "allmeta", domainId },
      allowedActions: [actionName],
    });
    setReasoningOntologyClient({
      async listActions(requestedDomain) {
        expect(requestedDomain).toBe(domainId);
        return [
          {
            id: "action-1",
            name: actionName,
            description: "A real action from the dedicated Reasoning client",
            actor: ["Agent"],
          },
          {
            id: "action-hidden",
            name: "notPermittedByTenantPolicy",
            description: null,
            actor: ["Agent"],
          },
        ];
      },
    });
  });

  afterAll(async () => {
    setTenantReasoningConfig(tenantSlug, null);
    setReasoningOntologyClient(null);
    await env.cleanup();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("serves real Actions through the dedicated Reasoning context", async () => {
    const response = await env.fetch("/v1/reasoning-agent/context", { headers });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        domainId: string;
        provider: string;
        actions: Array<{ name: string }>;
      };
    };
    expect(body.data).toMatchObject({
      domainId,
      provider: "allmeta",
    });
    expect(body.data.actions.map((action) => action.name)).toEqual([actionName]);
  });

  it("rejects foreign domains and unknown Actions without a Factory binding", async () => {
    const foreign = await env.fetch("/v1/agents/reasoningAgent/invoke", {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: {
          prompt: "check",
          domainId: "foreign-domain",
          action: actionName,
        },
      }),
    });
    expect(foreign.status).toBe(403);
    expect(
      ((await foreign.json()) as { error: { code: string } }).error.code,
    ).toBe("ontology_domain_mismatch");

    const missingAction = await env.fetch("/v1/agents/reasoningAgent/invoke", {
      method: "POST",
      headers,
      body: JSON.stringify({
        input: {
          prompt: "check",
          domainId,
          action: "notPresentInOntology",
        },
      }),
    });
    expect(missingAction.status).toBe(400);
    expect(
      ((await missingAction.json()) as { error: { code: string } }).error.code,
    ).toBe("ontology_action_not_found");

    const factoryRows = getDb()
      .select()
      .from(factoryDomainBindings)
      .where(eq(factoryDomainBindings.tenantId, tenantId))
      .all();
    expect(factoryRows).toEqual([]);
  });
});
