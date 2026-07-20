import { describe, expect, it, vi } from "vitest";
import type { DomainOntology, OntologySource } from "@agentic/agent-factory";
import {
  FactoryDomainDiscoveryError,
  discoverFactoryDomainBindingCandidate,
  type FactoryDomainRequestedSource,
} from "../src/services/agent-factory/factory-domain-discovery";

function source(
  id: string | null,
  ontologySource: DomainOntology["source"],
): OntologySource {
  return {
    listDomains: vi.fn(async () => id ? [{ id, name: `${id}-${ontologySource}` }] : []),
    fetchOntology: vi.fn(async (domainId) => ({
      domainId,
      source: ontologySource,
      actions: [{ id: "a", name: "a", actor: ["Agent"] }],
      events: [],
      objects: [],
      rules: [],
      workflow: [],
    })),
    fetchActionRules: vi.fn(async () => []),
  };
}

async function discover(input: {
  uploadId: string | null;
  allmetaId: string | null;
  requestedSource?: FactoryDomainRequestedSource;
}) {
  return discoverFactoryDomainBindingCandidate({
    requestedId: "Agents-generation",
    ...(input.requestedSource ? { requestedSource: input.requestedSource } : {}),
    sources: {
      upload: source(input.uploadId, "snapshot"),
      allmeta: source(input.allmetaId, "allmeta"),
    },
  });
}

describe("factory domain binding discovery", () => {
  it("can repair a stale upload pointer by discovering the same id in Allmeta", async () => {
    const candidate = await discover({ uploadId: null, allmetaId: "Agents-generation" });

    expect(candidate.domain.id).toBe("Agents-generation");
    expect(candidate.requestedSource).toBe("allmeta");
    expect(candidate.bindingSource).toBe("explicit");
  });

  it("rejects an unspecified same-id upload/Allmeta ambiguity", async () => {
    await expect(discover({
      uploadId: "Agents-generation",
      allmetaId: "Agents-generation",
    })).rejects.toMatchObject<Partial<FactoryDomainDiscoveryError>>({
      code: "domain_source_ambiguous",
    });
  });

  it.each([
    ["upload", "upload"],
    ["allmeta", "explicit"],
  ] as const)("honours an explicit %s source", async (requestedSource, bindingSource) => {
    const candidate = await discover({
      uploadId: "Agents-generation",
      allmetaId: "Agents-generation",
      requestedSource,
    });

    expect(candidate.requestedSource).toBe(requestedSource);
    expect(candidate.bindingSource).toBe(bindingSource);
  });

  it("does not contact the unselected source when the caller names one", async () => {
    const upload = source("Agents-generation", "snapshot");
    const allmeta: OntologySource = {
      ...source("Agents-generation", "allmeta"),
      listDomains: vi.fn(async () => { throw new Error("Allmeta unavailable"); }),
    };

    const candidate = await discoverFactoryDomainBindingCandidate({
      requestedId: "Agents-generation",
      requestedSource: "upload",
      sources: { upload, allmeta },
    });

    expect(candidate.bindingSource).toBe("upload");
    expect(allmeta.listDomains).not.toHaveBeenCalled();
  });

  it("fails closed when an unnamed configured catalog cannot rule out ambiguity", async () => {
    const allmeta: OntologySource = {
      ...source("Agents-generation", "allmeta"),
      listDomains: vi.fn(async () => { throw new Error("Allmeta unavailable"); }),
    };

    await expect(discoverFactoryDomainBindingCandidate({
      requestedId: "Agents-generation",
      sources: { upload: source("Agents-generation", "snapshot"), allmeta },
    })).rejects.toThrow("Allmeta unavailable");
  });

  it("reports a source-specific miss without falling through", async () => {
    await expect(discover({
      uploadId: "Agents-generation",
      allmetaId: null,
      requestedSource: "allmeta",
    })).rejects.toMatchObject<Partial<FactoryDomainDiscoveryError>>({
      code: "domain_not_found",
    });
  });
});
