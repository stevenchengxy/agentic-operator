/**
 * Bootstrap — on import, auto-discover every tenant model dir under
 * `AGENTIC_MODELS_DIR`, upsert the ontology (event_types + entity_types
 * tables) for each tenant, and register all agent functions with Inngest.
 *
 * Convention: each subdir of AGENTIC_MODELS_DIR is one tenant's ontology
 * version. The directory name encodes the tenant + optional version, e.g.
 * `RAAS-v1`, `supportflow-v3`. The slug is derived (lowercase, strip -vN
 * suffix) and must match a row in the `tenants` table (seeded via
 * `pnpm db:seed`).
 */

import crypto from "node:crypto";
import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import {
  agents,
  agentVersions,
  deployments,
  entityTypes,
  eventListeners,
  eventTypes,
  tenants,
  workflows,
  workflowVersions,
  factoryTools,
  getDb,
} from "@agentic/db";
import { buildDeclarativeOverlay } from "@agentic/tools";
import { makeId } from "@agentic/shared";
import { and, eq } from "drizzle-orm";
import {
  loadModelsFromDisk,
  tenantSlugFromFolder,
  type LoadedModels,
  type WorkflowManifest,
} from "./manifest";
import {
  findMissingTenantPrompts,
  formatMissingPromptsError,
  registerAgent,
} from "./register";
import type { TenantRegistry, ToolDescriptor } from "@agentic/agent-kit";
import type { InngestFunction } from "inngest";

/**
 * What `bootstrapTenant` returns. Spelled out so TS 6 doesn't try to infer
 * a type that references Inngest v4 internal `api/api` symbols (TS2883).
 */
export interface BootstrapTenantResult {
  tenant: { id: string; slug: string };
  workflow: { id: string; slug: string };
  workflowVersion: { id: string; version: string };
  functions: InngestFunction.Any[];
  agentCount: number;
  registeredCount: number;
  eventTypeCount: number;
  entityTypeCount: number;
  tenantTools: number;
  tenantPrompts: number;
  hasTenantPackage: boolean;
  /**
   * True when this call wrote a new `deployments` row (either because no live
   * row existed for this tenant/workflow_version, or `AGENTIC_REBOOTSTRAP=force`
   * forced a fresh insert). P0-RT-07: must be false for no-op reboots.
   */
  deploymentInserted: boolean;
}

/**
 * Map of tenant slug → tenant code registry, passed in by the api server.
 *
 * The runtime stays tenant-agnostic: it doesn't `import("@tenants/<slug>")`
 * itself because that would force `@agentic/runtime` to depend on every
 * tenant package (or sidestep pnpm's isolated-module resolution). Instead
 * `apps/api/src/bootstrap.ts` imports tenants it ships with and hands the
 * registries in here. Pure-declarative tenants just don't get an entry.
 */
export type TenantRegistries = Record<string, TenantRegistry | undefined>;

function modelsRoot(): string {
  return (
    process.env.AGENTIC_MODELS_DIR ??
    "/Users/kenny/CSI-AICOE/agentic-operator/models"
  );
}

async function discoverTenantFolders(): Promise<
  Array<{ folder: string; slug: string; dir: string }>
> {
  const root = modelsRoot();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (err) {
    console.warn(`[bootstrap] AGENTIC_MODELS_DIR not readable: ${root}`, err);
    return [];
  }
  const found: Array<{ folder: string; slug: string; dir: string }> = [];
  for (const folder of entries) {
    if (folder.startsWith(".")) continue;
    const dir = path.join(root, folder);
    try {
      const st = await stat(dir);
      if (!st.isDirectory()) continue;
    } catch {
      continue;
    }
    found.push({ folder, slug: tenantSlugFromFolder(folder), dir });
  }
  return found;
}

export async function bootstrapTenant(spec: {
  tenantSlug: string;
  modelDir: string;
  tenantRegistry?: TenantRegistry;
}): Promise<BootstrapTenantResult> {
  const db = getDb();
  const loaded = await loadModelsFromDisk(spec.modelDir);
  const { manifest } = loaded;

  // UC-V11-25 / AR-GAP-13 — refuse-to-boot when any `logic` action lacks
  // a tenant `definePrompt`. The legacy fallback shipped
  // `${action.name}: ${action.description}` as the LLM user message —
  // for RAAS that streams a Chinese description to the model. Strict
  // validation per `docs/tech-design/ar-tool.md` § Option B. The throw
  // bubbles to `bootstrapAll`'s per-tenant try/catch so OTHER tenants
  // still boot.
  const missingPrompts = findMissingTenantPrompts({
    manifest,
    tenantRegistry: spec.tenantRegistry,
  });
  if (missingPrompts.length > 0) {
    throw new Error(formatMissingPromptsError(spec.tenantSlug, missingPrompts));
  }

  const tenant = db
    .select()
    .from(tenants)
    .where(eq(tenants.slug, spec.tenantSlug))
    .all()[0];
  if (!tenant) {
    throw new Error(
      `[bootstrap] tenant slug=${spec.tenantSlug} not seeded — run \`pnpm db:seed\` first`,
    );
  }

  const workflowSlug = `${spec.tenantSlug}-default`;
  let workflow = db
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, tenant.id),
        eq(workflows.slug, workflowSlug),
      ),
    )
    .all()[0];
  if (!workflow) {
    const id = makeId("wf");
    db.insert(workflows)
      .values({
        id,
        tenantId: tenant.id,
        slug: workflowSlug,
        name: workflowSlug,
      })
      .run();
    workflow = db.select().from(workflows).where(eq(workflows.id, id)).all()[0]!;
  }

  const versionStr = `auto-${hashManifest(manifest)}`;
  const forceRebootstrap = process.env.AGENTIC_REBOOTSTRAP === "force";
  let deploymentInserted = false;
  let workflowVersion = db
    .select()
    .from(workflowVersions)
    .where(
      and(
        eq(workflowVersions.workflowId, workflow.id),
        eq(workflowVersions.version, versionStr),
      ),
    )
    .all()[0];
  const isNewVersion = !workflowVersion;
  if (!workflowVersion) {
    const wfvId = makeId("wfv");
    db.insert(workflowVersions)
      .values({
        id: wfvId,
        workflowId: workflow.id,
        version: versionStr,
        manifestJson: manifest as unknown as object,
        actionsJson: loaded.actionsExt as unknown as object,
      })
      .run();
    workflowVersion = db
      .select()
      .from(workflowVersions)
      .where(eq(workflowVersions.id, wfvId))
      .all()[0]!;
  }

  // P0-RT-07: insert a fresh deployment row only when (a) we just made a new
  // version, OR (b) the operator explicitly forced a re-bootstrap. A no-op
  // reboot must leave the existing live row in place — never tombstone it.
  if (isNewVersion || forceRebootstrap) {
    db.update(deployments)
      .set({ status: "rolled_back" })
      .where(
        and(
          eq(deployments.tenantId, tenant.id),
          eq(deployments.target, "workflow"),
          eq(deployments.status, "live"),
        ),
      )
      .run();
    db.insert(deployments)
      .values({
        id: makeId("dpl"),
        tenantId: tenant.id,
        target: "workflow",
        versionId: workflowVersion.id,
        status: "live",
        note: `auto-bootstrapped from ${path.basename(spec.modelDir)}${
          forceRebootstrap ? " (forced)" : ""
        }`,
      })
      .run();
    deploymentInserted = true;
  }

  // Tenant code registry comes from the caller (api server). Pure-declarative
  // tenants pass nothing; that's expected.
  const tenantRegistry = spec.tenantRegistry;
  const toolCount = Object.keys(tenantRegistry?.tools ?? {}).length;
  const promptCount = Object.keys(tenantRegistry?.prompts ?? {}).length;

  // Upsert agents + agent_versions + event_listeners
  // Phase 2 — fold brain-authored declarative HTTP tools (factory_tools) into this tenant's
  // runtime resolution, so a deployed agent can actually CALL a tool the brain DECLARED (the
  // create_tool → DrizzleToolStore → here → step-engine path). Domain-scoped (the tenant slug, or
  // the factory domain it was derived from: "<domain>-sb") + globals (domain null). Best-effort:
  // a load failure never blocks boot, and the name-collision guard in create_tool keeps these from
  // shadowing real global tools.
  let declarativeTools: Record<string, ToolDescriptor> | undefined;
  try {
    const slug = spec.tenantSlug;
    const baseDomain = slug.replace(/-sb$/, "");
    const rows = db.select().from(factoryTools).all();
    const matched = rows.filter((r) => r.domain == null || r.domain === slug || r.domain === baseDomain);
    if (matched.length) {
      declarativeTools = buildDeclarativeOverlay(
        matched.map((r) => ({
          name: r.name,
          description: r.description ?? undefined,
          method: r.method,
          urlTemplate: r.urlTemplate,
          headers: (r.headers as Record<string, string> | null) ?? undefined,
          bodyTemplate: r.bodyTemplate ?? undefined,
          sideEffect: r.sideEffect,
          returnsSchema: (r.returnsSchema as Record<string, unknown> | null) ?? undefined,
        })),
      );
    }
  } catch {
    /* declarative tool overlay is best-effort — never block boot */
  }

  const registered = [];
  // Phase 1a — sibling-function registry for synchronous `type:"invoke"` steps. Populated as
  // each function is built; the resolver closure reads it lazily at handler-run time (after boot
  // finishes), so an invoke action can resolve a sibling agent registered later in this loop.
  const fnRegistry = new Map<string, InngestFunction.Any>();
  const resolveFunction = (ref: string): InngestFunction.Any | undefined => fnRegistry.get(ref);
  for (const a of manifest) {
    let agentRow = db
      .select()
      .from(agents)
      .where(
        and(eq(agents.workflowId, workflow.id), eq(agents.kebabId, a.id)),
      )
      .all()[0];
    if (!agentRow) {
      const agentId = makeId("agt");
      const now = new Date();
      db.insert(agents)
        .values({
          id: agentId,
          workflowId: workflow.id,
          kebabId: a.id,
          name: a.name,
          title: a.title ?? a.name,
          actor: a.actor[0] === "Human" ? "Human" : "Agent",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      agentRow = db
        .select()
        .from(agents)
        .where(eq(agents.id, agentId))
        .all()[0]!;
    }

    const existingAv = db
      .select()
      .from(agentVersions)
      .where(
        and(
          eq(agentVersions.agentId, agentRow.id),
          eq(agentVersions.workflowVersionId, workflowVersion.id),
        ),
      )
      .all()[0];
    if (!existingAv) {
      db.insert(agentVersions)
        .values({
          id: makeId("agv"),
          agentId: agentRow.id,
          workflowVersionId: workflowVersion.id,
          manifestJson: a as unknown as object,
        })
        .run();
    }

    for (const trigger of a.trigger) {
      const exists = db
        .select()
        .from(eventListeners)
        .where(
          and(
            eq(eventListeners.eventName, trigger),
            eq(eventListeners.agentId, agentRow.id),
          ),
        )
        .all()[0];
      if (!exists) {
        db.insert(eventListeners)
          .values({ eventName: trigger, agentId: agentRow.id })
          .run();
      }
    }

    // 下线 (disable): a disabled agent stays in the catalog — its agents /
    // agent_versions / event_listeners rows are upserted above — but its
    // Inngest function is NOT registered, so no event routes to it until it is
    // re-enabled and the tenant re-registers. `enabled` defaults to true, so
    // this is a no-op for every agent that was never explicitly disabled.
    if (agentRow.enabled !== false) {
      const fn = registerAgent(a, {
        tenantId: tenant.id,
        tenantSlug: spec.tenantSlug,
        workflowVersionId: workflowVersion.id,
        tenantRegistry: tenantRegistry ?? undefined,
        resolveFunction,
        declarativeTools,
      });
      if (fn) {
        registered.push(fn);
        // Index by agent name + namespaced fn id so an invoke step can target either.
        fnRegistry.set(a.name, fn as InngestFunction.Any);
        fnRegistry.set(`${spec.tenantSlug}.${a.name}`, fn as InngestFunction.Any);
      }
    }
  }

  // Upsert ontology catalogs (RF-1.4 additive tables)
  upsertEventTypes(tenant.id, loaded);
  upsertEntityTypes(tenant.id, loaded);

  return {
    tenant,
    workflow,
    workflowVersion,
    functions: registered,
    agentCount: manifest.length,
    registeredCount: registered.length,
    eventTypeCount: loaded.events.events?.length ?? 0,
    entityTypeCount: loaded.objects.payload?.length ?? 0,
    tenantTools: toolCount,
    tenantPrompts: promptCount,
    hasTenantPackage: tenantRegistry !== null,
    deploymentInserted,
  };
}

function upsertEventTypes(tenantId: string, loaded: LoadedModels) {
  const db = getDb();
  const list = loaded.events.events ?? [];
  for (const e of list) {
    const existing = db
      .select()
      .from(eventTypes)
      .where(and(eq(eventTypes.tenantId, tenantId), eq(eventTypes.name, e.name)))
      .all()[0];
    const row = {
      tenantId,
      name: e.name,
      category: e.category ?? null,
      color: e.color ?? null,
      description: e.description ?? null,
      payloadJson: (e.payload ?? null) as never,
    };
    if (existing) {
      db.update(eventTypes)
        .set(row)
        .where(
          and(eq(eventTypes.tenantId, tenantId), eq(eventTypes.name, e.name)),
        )
        .run();
    } else {
      db.insert(eventTypes).values(row).run();
    }
  }
}

function upsertEntityTypes(tenantId: string, loaded: LoadedModels) {
  const db = getDb();
  const list = loaded.objects.payload ?? [];
  for (const o of list) {
    const existing = db
      .select()
      .from(entityTypes)
      .where(
        and(
          eq(entityTypes.tenantId, tenantId),
          eq(entityTypes.entityId, o.id),
        ),
      )
      .all()[0];
    const row = {
      tenantId,
      entityId: o.id,
      name: o.name ?? o.id,
      description: o.description ?? null,
      primaryKeyName: o.primary_key ?? null,
      propertiesJson: (o.properties ?? null) as never,
    };
    if (existing) {
      db.update(entityTypes)
        .set(row)
        .where(
          and(
            eq(entityTypes.tenantId, tenantId),
            eq(entityTypes.entityId, o.id),
          ),
        )
        .run();
    } else {
      db.insert(entityTypes).values(row).run();
    }
  }
}

/** Slugs that are archived (tenant-level 下线) — read once per call. */
function archivedSlugSet(): Set<string> {
  return new Set(
    getDb()
      .select({ slug: tenants.slug, archivedAt: tenants.archivedAt })
      .from(tenants)
      .all()
      .filter((r) => r.archivedAt != null)
      .map((r) => r.slug),
  );
}

/**
 * Bootstrap every discovered tenant, returning their Inngest functions GROUPED
 * BY slug. This is the per-app boot path: one Inngest app per tenant, so the
 * api boot (`apps/api/src/bootstrap.ts`) hands each slug's functions to its own
 * `serve()` handler. A tenant whose manifest throws is logged and skipped (its
 * map entry is simply absent) — exactly the per-tenant fault isolation that the
 * single-app boot already had, now extended to the per-app registry.
 */
export async function bootstrapAllByTenant(
  tenantRegistries: TenantRegistries = {},
): Promise<Map<string, InngestFunction.Any[]>> {
  const byTenant = new Map<string, InngestFunction.Any[]>();
  const folders = await discoverTenantFolders();
  if (folders.length === 0) {
    console.warn(
      `[bootstrap] no tenant model folders found in ${modelsRoot()}`,
    );
    return byTenant;
  }

  // archive (tenant-level 下线): an archived tenant is taken fully offline —
  // none of its agents register, so its app serves zero functions. The rows
  // stay in the DB; clearing `archived_at` (restore) + a re-register brings it
  // back. Read once per bootstrap so a re-register reflects the latest state.
  const archivedSlugs = archivedSlugSet();

  for (const f of folders) {
    if (archivedSlugs.has(f.slug)) {
      console.log(`[bootstrap] ${f.slug} (${f.folder}): archived — skipped`);
      continue;
    }
    try {
      const result = await bootstrapTenant({
        tenantSlug: f.slug,
        modelDir: f.dir,
        tenantRegistry: tenantRegistries[f.slug],
      });
      const arr = byTenant.get(f.slug) ?? [];
      arr.push(...result.functions);
      byTenant.set(f.slug, arr);
      const tenantPkgNote = result.hasTenantPackage
        ? `· tenant pkg: ${result.tenantTools} tools, ${result.tenantPrompts} prompts`
        : "· no tenant pkg (declarative)";
      console.log(
        `[bootstrap] ${f.slug} (${f.folder}): ${result.registeredCount}/${result.agentCount} agents · ${result.eventTypeCount} event types · ${result.entityTypeCount} entities ${tenantPkgNote}`,
      );
    } catch (err) {
      console.error(`[bootstrap] failed to load ${f.folder}:`, err);
    }
  }
  return byTenant;
}

/**
 * Flat-array boot path, kept for back-compat. Delegates to
 * `bootstrapAllByTenant` and flattens. Callers that need the per-app grouping
 * (the api registry) should use `bootstrapAllByTenant` directly.
 */
export async function bootstrapAll(
  tenantRegistries: TenantRegistries = {},
): Promise<InngestFunction.Any[]> {
  const byTenant = await bootstrapAllByTenant(tenantRegistries);
  return [...byTenant.values()].flat();
}

/**
 * Rebuild ONE tenant's Inngest functions — the scoped counterpart to
 * `bootstrapAll`. `reregisterInngest({ tenantSlug })` calls this so a deploy /
 * agent enable-disable / archive of tenant X only re-reads X's manifest + DB
 * and only touches X's app, never the whole fleet.
 *
 *   - Archived or unknown slug → `[]` (the caller serves zero functions for
 *     that app = tenant 下线 / app offline).
 *   - A broken manifest → THROWS, so the registry keeps the tenant's
 *     last-good function set (a failed re-register must never drop a tenant
 *     that was previously live). One tenant's bad deploy cannot affect another:
 *     this only ever reads/rebuilds the requested slug.
 *
 * A slug may map from multiple version folders (e.g. `raas-v1`, `raas-v2`);
 * all matching folders are bootstrapped and their functions concatenated,
 * mirroring `bootstrapAllByTenant`.
 */
export async function bootstrapTenantBySlug(
  slug: string,
  tenantRegistries: TenantRegistries = {},
): Promise<InngestFunction.Any[]> {
  const folders = (await discoverTenantFolders()).filter((f) => f.slug === slug);
  if (folders.length === 0) return [];
  if (archivedSlugSet().has(slug)) return [];
  const fns: InngestFunction.Any[] = [];
  for (const f of folders) {
    const result = await bootstrapTenant({
      tenantSlug: f.slug,
      modelDir: f.dir,
      tenantRegistry: tenantRegistries[f.slug],
    });
    fns.push(...result.functions);
  }
  return fns;
}

function hashManifest(m: WorkflowManifest): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(m))
    .digest("hex")
    .slice(0, 8);
}
