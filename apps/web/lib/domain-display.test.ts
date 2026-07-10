import { describe, expect, it } from "vitest";
import {
  buildRuntimeDomainNameMap,
  isVisibleRuntimeDomain,
  runtimeDomainSlug,
} from "./domain-display";

describe("domain display helpers", () => {
  it("maps knowledge-domain ids to runtime domain slugs", () => {
    expect(runtimeDomainSlug("RAAS-v1")).toBe("zhaopin");
    expect(runtimeDomainSlug("招聘-v1")).toBe("zhaopin");
    expect(runtimeDomainSlug("Agents-generation")).toBe("agents-generation");
  });

  it("prefers the user-facing knowledge-domain label for runtime rows", () => {
    const labels = buildRuntimeDomainNameMap([
      { id: "raas", name: "RAAS" },
      { id: "RAAS-v1", name: "RAAS-v1" },
      { id: "招聘-v1", name: "招聘-v1" },
      { id: "zhaopin", name: "zhaopin-v1" },
    ]);

    expect(labels.get("raas")).toBe("RAAS");
    expect(labels.get("zhaopin")).toBe("RAAS-v1");
  });

  it("uses aliased labels when Allmeta returns a legacy runtime id", () => {
    const labels = buildRuntimeDomainNameMap([
      { id: "raas", name: "RAAS-v1" },
    ]);

    expect(labels.get("raas")).toBeUndefined();
    expect(labels.get("zhaopin")).toBe("RAAS-v1");
  });

  it("hides internal and empty leftover runtime rows from Domain lists", () => {
    const domainSlugs = new Set(["raas"]);
    expect(isVisibleRuntimeDomain({ slug: "raas", name: "RAAS", agentCount: 0 }, domainSlugs)).toBe(true);
    expect(isVisibleRuntimeDomain({ slug: "pgvec-e2e", name: "pgvec e2e", agentCount: 0 }, domainSlugs)).toBe(false);
    expect(isVisibleRuntimeDomain({ slug: "raas-sb", name: "raas sandbox", agentCount: 6 }, domainSlugs)).toBe(false);
  });
});
