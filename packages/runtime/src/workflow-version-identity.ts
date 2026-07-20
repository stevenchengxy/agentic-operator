import crypto from "node:crypto";
import { canonicalEvidenceJson } from "@agentic/shared";

export interface StoredWorkflowVersionContent {
  manifestJson: unknown;
  actionsJson: unknown;
}

/** Full content identity used by all newly written workflow versions. */
export function workflowVersionContentSha256(
  manifest: unknown,
  actions: unknown,
): string {
  return crypto
    .createHash("sha256")
    .update(canonicalEvidenceJson({ manifest, actions: actions ?? [] }), "utf8")
    .digest("hex");
}

export function canonicalWorkflowVersionId(
  manifest: unknown,
  actions: unknown,
): string {
  return `auto-${workflowVersionContentSha256(manifest, actions)}`;
}

/** Historical identity retained only for exact-content backwards compatibility. */
export function legacyWorkflowVersionId(manifest: unknown): string {
  const short = crypto
    .createHash("sha256")
    .update(JSON.stringify(manifest))
    .digest("hex")
    .slice(0, 8);
  return `auto-${short}`;
}

export function workflowVersionContentMatches(
  row: StoredWorkflowVersionContent,
  manifest: unknown,
  actions: unknown,
): boolean {
  return (
    canonicalEvidenceJson(row.manifestJson) ===
      canonicalEvidenceJson(manifest) &&
    canonicalEvidenceJson(row.actionsJson ?? []) ===
      canonicalEvidenceJson(actions ?? [])
  );
}

/**
 * Validate a stored version identifier against its exact manifest+actions
 * bytes. Legacy short ids are accepted only when their old manifest-only hash
 * matches; callers reusing another row must additionally call
 * workflowVersionContentMatches against the desired content.
 */
export function workflowVersionIdentityKind(
  version: string,
  manifest: unknown,
  actions: unknown,
): "full" | "legacy" | null {
  if (version === canonicalWorkflowVersionId(manifest, actions)) return "full";
  if (version === legacyWorkflowVersionId(manifest)) return "legacy";
  return null;
}
