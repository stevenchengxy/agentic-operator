// Draft → live promotion. A finished factory run persists its agents as durable DRAFTS
// (FsAgentDraftStore, off the live tables). Promotion is the EXPLICIT step that turns
// chosen drafts into real, running Fleet agents for a tenant.
//
// Safety: promotion is ADDITIVE. We load the tenant's CURRENT live workflow manifest and
// merge the promoted agents into it (replace/add by id, keep everything else), then run
// the SAME validate → commit pipeline a normal manifest deploy uses (which registers the
// Inngest functions). So promoting never clobbers a tenant's existing agents, and it
// fails CLOSED — a hard validation issue aborts before any commit.

import { validate as miValidate, commit as miCommit, loadLiveManifest, type TenantCtx } from "../manifest-import";
import { mapToManifest } from "./sandbox-deployer";
import { FsAgentDraftStore } from "./agent-draft-store";

export interface PromoteResult {
  promoted: string[]; // slugs that were committed
  total: number; // how many drafts matched the request
  functionsRegistered: number; // Inngest functions registered by the commit
  liveAgents: number; // total agents in the tenant's workflow after the merge
}

const idOf = (a: unknown): string | undefined => (a && typeof a === "object" ? (a as { id?: string }).id : undefined);

/** Promote a domain's drafts (all, or the given slugs) into the tenant's live workflow. */
export async function promoteDrafts(domain: string, slugs: string[] | undefined, ctx: TenantCtx): Promise<PromoteResult> {
  const all = await new FsAgentDraftStore().list(domain);
  const want = slugs && slugs.length ? new Set(slugs) : null;
  const chosen = want ? all.filter((d) => want.has(d.slug)) : all;
  if (!chosen.length) return { promoted: [], total: 0, functionsRegistered: 0, liveAgents: loadLiveManifest(ctx).length };

  // Map the chosen drafts to manifest agents (same mapping the sandbox deploy uses).
  const promoted = mapToManifest(chosen.map((d) => d.spec));
  const promotedIds = new Set(promoted.map(idOf).filter(Boolean));

  // ADDITIVE merge: keep every existing agent, replace/add the promoted ones by id.
  const live = loadLiveManifest(ctx);
  const merged = [...live.filter((a) => !promotedIds.has(idOf(a))), ...promoted];

  // validate (fail closed on hard issues) → commit (registers Inngest fns).
  const preview = await miValidate({ mode: "validate", workflow: merged, target: "production", confirm_overwrite: true, conflict_resolutions: [] }, ctx);
  const blocking = preview.issues.filter((i) => i.severity === "error");
  if (blocking.length) throw new Error(`晋升校验未通过：${blocking.map((i) => i.message ?? i.code).join("；")}`);

  const committed = await miCommit({ mode: "commit", workflow: merged, target: "production", confirm_overwrite: true, deployment_id: preview.deployment_id, conflict_resolutions: [] }, ctx);
  return {
    promoted: chosen.map((d) => d.slug),
    total: chosen.length,
    functionsRegistered: committed.inngest_fns_registered ?? 0,
    liveAgents: merged.length,
  };
}
