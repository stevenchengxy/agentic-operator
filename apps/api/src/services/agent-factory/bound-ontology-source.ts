import type { OntologySource } from "@agentic/agent-factory";

import { AllmetaOntologySource } from "./allmeta-ontology-source";
import { CompositeOntologySource } from "./composite-ontology-source";
import { getFactoryDomainBinding } from "./domain-binding";
import { ManifestOntologySource } from "./ontology-source";
import {
  UploadedFirstOntologySource,
  UploadedOntologySource,
} from "./uploaded-ontology-source";

/**
 * Select the authoritative Ontology transport from persisted binding
 * provenance. This is shared by normal Factory execution and the independent
 * preview/promotion TOCTOU guards; callers cannot inject a different reader.
 */
export function makeBoundFactoryOntologySource(
  tenantSlug: string,
  tenantId: string,
): OntologySource {
  const binding = getFactoryDomainBinding(tenantId);
  const manifest = new ManifestOntologySource();
  const allmeta = new AllmetaOntologySource();
  const uploaded = new UploadedOntologySource(tenantSlug);

  if (binding?.source === "upload") {
    return new UploadedFirstOntologySource(
      uploaded,
      allmeta,
      binding.ontologyDomainId,
    );
  }
  if (binding?.source === "explicit") {
    return new UploadedFirstOntologySource(
      uploaded,
      allmeta,
      undefined,
      binding.ontologyDomainId,
    );
  }
  if (binding?.source === "auto") {
    const legacyBase = allmeta.configured
      ? new CompositeOntologySource(allmeta, manifest)
      : manifest;
    return new UploadedFirstOntologySource(uploaded, legacyBase);
  }
  return new UploadedFirstOntologySource(uploaded, allmeta);
}
