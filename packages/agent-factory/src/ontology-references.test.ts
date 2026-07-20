import { describe, expect, it, vi } from "vitest";
import type { DomainOntology } from "./ontology-types";
import type { OntologySource } from "./ports";
import { resolveOntologyReferences } from "./ontology-references";

const bundle = (domainId: string): DomainOntology => ({
  domainId,
  source: "allmeta",
  objects: [],
  rules: [],
  actions: [{
    id: `${domainId}-action`,
    name: "requestWork",
    actor: ["Agent"],
    trigger: [],
    triggered_event: ["WORK_REQUESTED"],
    target_objects: [],
    tool_use: [],
    system_prompt: "",
    user_prompt: "",
  }],
  events: [],
  workflow: [],
});

const source = (fetchOntology: OntologySource["fetchOntology"]): OntologySource => ({
  fetchOntology,
  listDomains: async () => [],
  fetchActionRules: async () => [],
});

describe("resolveOntologyReferences", () => {
  it("strictly resolves each distinct external source_domain once", async () => {
    const root = bundle("local");
    root.events = [
      { name: "WORK_REQUESTED", payload: { source_action: "requestWork", source_domain: "upstream", event_data: [], state_mutations: [] } },
      { name: "WORK_RETRIED", payload: { source_action: "retryWork", source_domain: "upstream", event_data: [], state_mutations: [] } },
      { name: "LOCAL_DONE", payload: { source_action: "requestWork", source_domain: "local", event_data: [], state_mutations: [] } },
    ];
    const fetch = vi.fn(async (domainId: string) => bundle(domainId));

    const resolved = await resolveOntologyReferences(root, source(fetch));

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("upstream");
    expect(resolved.referencedDomains).toEqual([
      expect.objectContaining({ domainId: "upstream", resolved: true, source: "allmeta" }),
    ]);
  });

  it("retains a failed external read as blocking evidence", async () => {
    const root = bundle("local");
    root.events = [{ name: "WORK_REQUESTED", payload: { source_action: "requestWork", source_domain: "upstream", event_data: [], state_mutations: [] } }];

    const resolved = await resolveOntologyReferences(root, source(async () => {
      throw new Error("Allmeta offline");
    }));

    expect(resolved.referencedDomains).toEqual([{
      domainId: "upstream",
      resolved: false,
      source: "allmeta",
      actions: [],
      error: "Allmeta offline",
    }]);
  });
});
