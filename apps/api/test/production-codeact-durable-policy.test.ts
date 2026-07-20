import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { productionCodeActManifestSha256 } from "@agentic/runtime";

import { __test } from "../src/services/agent-factory/production-codeact-authorization";
import {
  REGRESSION_ARTIFACT_SCHEMA,
  regressionModuleHash,
  regressionSpecHash,
  regressionSuiteFingerprint,
} from "../src/services/agent-factory/regression-artifact";

const CODE = "export const a=defineAgent({async handler(input,ctx){ctx.emit('DONE',input);return input}})";
const SUITE = `regression-suite:v1:${"a".repeat(64)}`;
const DOMAIN = "domain-durable";
const VERSION = "version-durable";
const SLUG = "pure-codeact";

const hostErrorPolicy = [
  { when: "meta.codeExecutionError.includes('[terminal]')", do: "terminal", suppress_emit: true },
  { when: "meta.codeExecutionError.includes('[park]')", do: "park", suppress_emit: true },
  { when: "meta.codeExecutionError.includes('[retry]')", do: "retry", suppress_emit: true },
  { default: "retry", suppress_emit: true },
];

function manifestAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: SLUG,
    name: SLUG,
    actor: ["Agent"],
    trigger: ["START"],
    triggered_event: ["DONE"],
    generated: true,
    codeExecuted: true,
    typescript_code: CODE,
    factory_domain_id: DOMAIN,
    factory_target_domain_id: DOMAIN,
    factory_promotion_version_id: VERSION,
    factory_regression_suite_fingerprint: SUITE,
    factory_execution_scope: {
      kind: "production",
      target_domain_id: DOMAIN,
    },
    actions: [
      {
        order: "1",
        name: "run",
        type: "logic",
        on_error: hostErrorPolicy,
      },
    ],
    tool_use: [],
    ...overrides,
  };
}

function request() {
  const agent = manifestAgent();
  return {
    executionKind: "codeact" as const,
    tenantId: "ten-durable",
    tenantSlug: "durable",
    domainId: DOMAIN,
    agentSlug: SLUG,
    promotionVersionId: VERSION,
    regressionSuiteFingerprint: SUITE,
    codeSha256: createHash("sha256").update(CODE).digest("hex"),
    agentManifestSha256: productionCodeActManifestSha256(agent),
    workflowManifestSha256: productionCodeActManifestSha256([agent]),
  };
}

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("durable production CodeAct policy", () => {
  it("keeps an exact promotion anchor valid after rollback history annotates its note", () => {
    expect(
      __test.deploymentNoteMatchesPromotion(
        "agent-factory-promotion:fpr-12345678; auto: superseded by import",
        "fpr-12345678",
      ),
    ).toBe(true);
    expect(
      __test.deploymentNoteMatchesPromotion(
        "agent-factory-promotion:fpr-123456789",
        "fpr-12345678",
      ),
    ).toBe(false);
  });

  it("accepts the pure handler plus only the host-owned retry classifier", () => {
    expect(() =>
      __test.assertManifestIdentity(manifestAgent(), request()),
    ).not.toThrow();
  });

  it("binds a declarative generated Agent to its complete manifest hash", () => {
    const agent = manifestAgent({
      codeExecuted: false,
      actions: [
        { order: "1", name: "vendor.read", type: "tool" },
        { order: "2", name: "route", type: "condition" },
      ],
      tool_use: [{ name: "vendor.read" }],
    });
    const manifestHash = productionCodeActManifestSha256(agent);
    const declarativeRequest = {
      ...request(),
      executionKind: "declarative" as const,
      codeSha256: manifestHash,
      agentManifestSha256: manifestHash,
    };
    expect(() =>
      __test.assertManifestIdentity(agent, declarativeRequest),
    ).not.toThrow();
    expect(() =>
      __test.assertManifestIdentity(
        { ...agent, triggered_event: ["TAMPERED"] },
        declarativeRequest,
      ),
    ).toThrow(/identity mismatch/);
  });

  it.each([
    ["tool", { tool_use: [{ name: "vendor.write" }] }],
    ["invoke", { actions: [{ order: "1", name: "child", type: "invoke" }] }],
    ["foreach", { actions: [{ order: "1", name: "each", type: "foreach" }] }],
    ["error policy", { actions: [{ order: "1", name: "run", type: "logic", on_error: "soft" }] }],
  ])("rejects historical %s ownership", (_name, override) => {
    expect(() =>
      __test.assertManifestIdentity(manifestAgent(override), request()),
    ).toThrow(/cannot own/);
  });

  it.each([
    ["version", { factory_promotion_version_id: "tampered" }],
    ["suite", { factory_regression_suite_fingerprint: `regression-suite:v1:${"f".repeat(64)}` }],
    ["code", { typescript_code: `${CODE}\n// tampered` }],
  ])("rejects a hand-edited %s pointer", (_name, override) => {
    expect(() =>
      __test.assertManifestIdentity(manifestAgent(override), request()),
    ).toThrow(/mismatch/);
  });

  it("fails closed when the regression artifact pointer is missing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codeact-missing-artifact-"));
    temporaryRoots.push(root);
    await expect(
      __test.verifyArtifactAgent({
        dataRoot: root,
        record: {
          artifact: "missing/regression.json",
        } as never,
        request: request(),
        exactManifestCode: CODE,
      }),
    ).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("verifies declarative spec and rendered-module bytes from immutable evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "declarative-artifact-"));
    temporaryRoots.push(root);
    const versionDir = path.join(root, "versions", VERSION);
    const agentsDir = path.join(versionDir, "agents");
    await mkdir(agentsDir, { recursive: true });
    const spec = {
      slug: SLUG,
      short: SLUG,
      nameZh: SLUG,
      domainId: DOMAIN,
      actionName: "run",
      actor: "Agent",
      trigger: ["START"],
      emit: ["DONE"],
      tools: [],
      codeExecuted: false,
    };
    const module = "export const declarativeDelivery = true;\n";
    await writeFile(
      path.join(agentsDir, `${SLUG}.json`),
      JSON.stringify({ spec }),
      "utf8",
    );
    await writeFile(path.join(agentsDir, `${SLUG}.ts`), module, "utf8");
    const artifactBody = {
      schema: REGRESSION_ARTIFACT_SCHEMA,
      versionId: VERSION,
      domain: DOMAIN,
      agents: [
        {
          slug: SLUG,
          short: SLUG,
          specFile: `agents/${SLUG}.json`,
          moduleFile: `agents/${SLUG}.ts`,
          specHash: regressionSpecHash(spec as never),
          moduleHash: regressionModuleHash(module),
          execution: "rendered-module" as const,
          cases: [],
        },
      ],
    };
    const suiteFingerprint = regressionSuiteFingerprint(artifactBody as never);
    await writeFile(
      path.join(versionDir, "regression.json"),
      JSON.stringify({ ...artifactBody, suiteFingerprint }),
      "utf8",
    );
    const agent = manifestAgent({ codeExecuted: false });
    const agentManifestSha256 = productionCodeActManifestSha256(agent);

    await expect(
      __test.verifyArtifactAgent({
        dataRoot: root,
        record: {
          artifact: `versions/${VERSION}/regression.json`,
        } as never,
        request: {
          ...request(),
          executionKind: "declarative",
          regressionSuiteFingerprint: suiteFingerprint,
          codeSha256: agentManifestSha256,
          agentManifestSha256,
        },
      }),
    ).resolves.toEqual({
      specHash: artifactBody.agents[0]!.specHash,
      moduleHash: artifactBody.agents[0]!.moduleHash,
    });
  });
});
