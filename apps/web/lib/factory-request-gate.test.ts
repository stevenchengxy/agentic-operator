import { describe, expect, it } from "vitest";
import {
  FactoryRequestGate,
  factoryRequestScopeKey,
} from "./factory-request-gate";

describe("FactoryRequestGate", () => {
  it("keeps tenant and ontology identities distinct even when ids repeat", () => {
    expect(factoryRequestScopeKey({ tenant: "tenant-a", domain: "sales" }))
      .not.toBe(factoryRequestScopeKey({ tenant: "tenant-b", domain: "sales" }));
    expect(factoryRequestScopeKey({ tenant: "tenant-a", domain: "sales" }))
      .not.toBe(factoryRequestScopeKey({ tenant: "tenant-a", domain: "support" }));
  });

  it("rejects a response after tenant navigation or ontology rebind", () => {
    const gate = new FactoryRequestGate();
    const ticket = gate.begin("runs", { tenant: "tenant-a", domain: "sales" });

    expect(gate.isCurrent(ticket, { tenant: "tenant-b", domain: "sales" })).toBe(false);
    expect(gate.isCurrent(ticket, { tenant: "tenant-a", domain: "support" })).toBe(false);
  });

  it("lets the newest same-scope request win without cancelling other channels", () => {
    const gate = new FactoryRequestGate();
    const first = gate.begin("catalog", { tenant: "tenant-a" });
    const tools = gate.begin("tools", { tenant: "tenant-a", domain: "sales" });
    const second = gate.begin("catalog", { tenant: "tenant-a" });

    expect(gate.isCurrent(first, { tenant: "tenant-a" })).toBe(false);
    expect(gate.isCurrent(second, { tenant: "tenant-a" })).toBe(true);
    expect(gate.isCurrent(tools, { tenant: "tenant-a", domain: "sales" })).toBe(true);
  });

  it("supports explicit invalidation when a scoped component unmounts", () => {
    const gate = new FactoryRequestGate();
    const ticket = gate.begin("drafts", { tenant: "tenant-a", domain: "sales" });
    gate.invalidate("drafts");
    expect(gate.isCurrent(ticket, { tenant: "tenant-a", domain: "sales" })).toBe(false);
  });
});
