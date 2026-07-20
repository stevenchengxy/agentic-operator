import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getDb, tenants } from "@agentic/db";
import {
  bootstrapTenant,
  setProductionGeneratedAgentAuthorizationVerifier,
} from "@agentic/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const tenantId = "ten-generated-declarative-bootstrap";
const tenantSlug = "generated-declarative-bootstrap";
let modelDir = "";

beforeAll(async () => {
  const { buildTestEnv } = await import("./harness");
  await buildTestEnv();
  getDb()
    .insert(tenants)
    .values({ id: tenantId, slug: tenantSlug, name: tenantSlug })
    .onConflictDoNothing()
    .run();
  modelDir = await mkdtemp(
    path.join(tmpdir(), "generated-declarative-bootstrap-"),
  );
  await writeFile(
    path.join(modelDir, "workflow_v1.json"),
    JSON.stringify([
      {
        id: "reviewed-declarative-agent",
        name: "ReviewedDeclarativeAgent",
        actor: ["Agent"],
        trigger: ["DECLARATIVE_REQUESTED"],
        triggered_event: ["DECLARATIVE_COMPLETED"],
        actions: [
          {
            order: "1",
            name: "decide",
            description: "reviewed declarative plan",
            type: "logic",
          },
        ],
        generated: true,
        codeExecuted: false,
        factory_domain_id: "domain-reviewed",
        factory_target_domain_id: "domain-reviewed",
        factory_execution_scope: {
          kind: "production",
          target_domain_id: "domain-reviewed",
        },
        factory_promotion_version_id: "version-reviewed",
        factory_regression_suite_fingerprint: `regression-suite:v1:${"a".repeat(64)}`,
      },
    ]),
    "utf8",
  );
});

afterEach(() => {
  setProductionGeneratedAgentAuthorizationVerifier(null);
});

afterAll(async () => {
  if (modelDir) await rm(modelDir, { recursive: true, force: true });
});

describe("generated declarative production bootstrap authorization", () => {
  it("fails closed when no durable promotion verifier is installed", async () => {
    setProductionGeneratedAgentAuthorizationVerifier(null);

    await expect(
      bootstrapTenant({ tenantSlug, modelDir }),
    ).rejects.toThrow(/authorization verifier is unavailable/);
  });

  it("registers only after the verifier returns the same exact identities", async () => {
    const observed: string[] = [];
    let live = true;
    setProductionGeneratedAgentAuthorizationVerifier(async (request, purpose) => {
      observed.push(request.executionKind);
      if (!live && purpose === "execution") {
        throw new Error("deployment rolled back");
      }
      return {
        ...request,
        authorizationId: "fca-declarative-test",
        promotionId: "fpr-declarative-test",
        activationPromotionId: "fpr-declarative-activation-test",
        deploymentId: "dpl-declarative-test",
        workflowVersionId: "wfv-declarative-test",
        reviewReceiptId: "review-declarative-test",
        activationReviewReceiptId: "review-declarative-activation-test",
      };
    });

    const result = await bootstrapTenant({ tenantSlug, modelDir });

    expect(observed).toEqual(["declarative"]);
    expect(result.agentCount).toBe(1);
    expect(result.registeredCount).toBe(1);

    live = false;
    const registered = result.functions[0] as unknown as {
      fn(input: Record<string, unknown>): Promise<unknown>;
    };
    await expect(
      registered.fn({
        event: {
          name: `${tenantSlug}/DECLARATIVE_REQUESTED`,
          data: { subject: "revoked-1" },
        },
        step: {
          run: async (_id: string, work: () => Promise<unknown>) => work(),
        },
        logger: {
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
        },
      }),
    ).rejects.toThrow(/authorization is absent or revoked/);
    expect(observed).toEqual(["declarative", "declarative"]);
  });
});
