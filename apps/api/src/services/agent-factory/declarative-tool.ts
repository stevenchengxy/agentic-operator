// Declarative 造工具 LIBRARY helpers (persistence + listing for the /v1/tools endpoints).
//
// NOTE on layering: the RUNTIME EXECUTION of these tools — turning a factory_tools row into a
// runtime-invocable, SSRF-guarded ToolDescriptor and folding it into the per-step tenant tool map —
// lives in packages/tools (makeDeclarativeTool / buildDeclarativeOverlay) and is wired in
// packages/runtime/src/bootstrap.ts. THIS module is only the library-management surface: save (with
// a collision guard so a created tool can never shadow a real global tool), list (for the catalog),
// and tenant-scoped delete. All three operate on the same `factory_tools` table the overlay reads,
// so a tool authored here is browsable in the library AND runtime-callable (after the tenant builds).

import { type DeclarativeTool } from "@agentic/agent-factory";
import { globalToolRegistry } from "@agentic/tools";
import { getDb, factoryTools, eq } from "@agentic/db";

type DbToolRow = typeof factoryTools.$inferSelect;

function rowToDeclarativeTool(r: DbToolRow): DeclarativeTool {
  return {
    name: r.name,
    description: r.description,
    method: r.method,
    urlTemplate: r.urlTemplate,
    headers: (r.headers as Record<string, string>) ?? undefined,
    bodyTemplate: r.bodyTemplate ?? undefined,
    sideEffect: r.sideEffect,
    domain: r.domain,
    paramsSchema: (r.paramsSchema as Record<string, unknown>) ?? undefined,
    returnsSchema: (r.returnsSchema as Record<string, unknown>) ?? undefined,
  };
}

/** True iff this tool's domain belongs to `tenantSlug` (its own scope, or the `-sb` sandbox of its
 *  base domain). A null/empty domain is SHARED (every tenant). Matches the runtime overlay's scoping
 *  in packages/runtime/src/bootstrap.ts so the library shows exactly what the tenant can actually run. */
function inTenantScope(domain: string | null, tenantSlug?: string): boolean {
  if (domain == null || domain === "") return true; // shared
  if (!tenantSlug) return false; // no tenant context → only shared (never leak domain-scoped tools)
  const slug = tenantSlug.toLowerCase();
  const base = slug.replace(/-sb$/, "");
  const d = domain.toLowerCase();
  return d === slug || d === base;
}

/** List persisted declarative tools for the catalog: the SHARED ones + the given tenant's own. */
export function listDeclarativeTools(tenantSlug?: string): DeclarativeTool[] {
  let rows: DbToolRow[];
  try {
    rows = getDb().select().from(factoryTools).all();
  } catch {
    return [];
  }
  return rows.filter((r) => inTenantScope(r.domain, tenantSlug)).map(rowToDeclarativeTool);
}

/** Persist a declarative tool (standalone 造工具 endpoint). Refuses a name that collides with a
 *  built-in global tool (the runtime overlay would otherwise be un-shadowable). */
export function saveDeclarativeTool(dt: DeclarativeTool): { ok: boolean; reason?: string } {
  if (!dt.name || !dt.name.trim()) return { ok: false, reason: "工具名不能为空" };
  if (globalToolRegistry.get(dt.name)) return { ok: false, reason: `「${dt.name}」与内置全局工具同名，请换个带命名空间的名字（如 acme.${dt.name}）` };
  try {
    const now = new Date();
    const cols = {
      description: dt.description ?? "",
      method: (dt.method || "GET").toUpperCase(),
      urlTemplate: dt.urlTemplate ?? "",
      headers: dt.headers ?? null,
      bodyTemplate: dt.bodyTemplate ?? null,
      sideEffect: dt.sideEffect || "read",
      domain: dt.domain ?? null,
      paramsSchema: dt.paramsSchema ?? null,
      returnsSchema: dt.returnsSchema ?? null,
    };
    getDb()
      .insert(factoryTools)
      .values({ name: dt.name, ...cols, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: factoryTools.name, set: { ...cols, updatedAt: now } })
      .run();
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Delete a created tool by name. TENANT-ISOLATED: a tenant may delete a SHARED tool or one of its
 *  OWN domain-scoped tools, but NOT another tenant's domain-scoped tool. Returns false if not found
 *  or out of scope. */
export function deleteDeclarativeTool(name: string, tenantSlug?: string): boolean {
  try {
    const row = getDb().select().from(factoryTools).where(eq(factoryTools.name, name)).all()[0];
    if (!row) return false;
    if (!inTenantScope(row.domain, tenantSlug)) return false; // another tenant's tool — refuse
    const res = getDb().delete(factoryTools).where(eq(factoryTools.name, name)).run() as { changes?: number };
    return (res?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}
