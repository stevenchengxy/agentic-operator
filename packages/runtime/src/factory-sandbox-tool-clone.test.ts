import { describe, expect, it } from "vitest";

import { selectFactoryToolsForManifest } from "./bootstrap";

const sandboxTenantId = "ten-sandbox-clone";
const ownerTenantId = "ten-production-owner";
const domainId = "Agents-generation";

function row(id: string, scopeKey: string) {
  return {
    id,
    scopeKey,
    domainKey: domainId,
    name: "ontology.lookup",
    tenantId: scopeKey === "shared" ? null : scopeKey,
    domain: domainId,
  } as any;
}

const manifest = [{
  id: "generated-agent",
  name: "generated-agent",
  actor: ["Agent"],
  trigger: ["GENERATION_REQUESTED"],
  triggered_event: ["GENERATION_COMPLETED"],
  actions: [],
  factory_domain_id: domainId,
  tool_use: [{ name: "ontology.lookup", side_effect: "read" }],
}] as any;

describe("factory sandbox declarative tool resolution", () => {
  it("resolves only the sandbox-owned clone", () => {
    const shared = row("tol-shared", "shared");
    const productionPrivate = row("tol-production-private", ownerTenantId);
    const sandboxClone = row("tol-sandbox-clone", sandboxTenantId);

    const selected = selectFactoryToolsForManifest(
      [shared, productionPrivate, sandboxClone],
      manifest,
      sandboxTenantId,
      { sandboxCloneOnly: true },
    );

    expect(selected.map((entry) => entry.id)).toEqual([sandboxClone.id]);
  });

  it("does not fall back to a shared or production-private source when the clone is missing", () => {
    const selected = selectFactoryToolsForManifest(
      [row("tol-shared", "shared"), row("tol-production-private", ownerTenantId)],
      manifest,
      sandboxTenantId,
      { sandboxCloneOnly: true },
    );

    expect(selected).toEqual([]);
  });
});
