/**
 * /v1/tools — the unified tool LIBRARY.
 *
 *   GET    /v1/tools                  → catalog: built-in globalToolRegistry tools (origin:"global")
 *                                       MERGED with persisted declarative 造工具 tools (origin:"created").
 *   POST   /v1/tools/generate-from-doc→ Tool-Smith: fetch a public API doc (or take pasted text) and
 *                                       LLM-extract a draft HTTP-tool contract (no save — returns a draft).
 *   POST   /v1/tools                  → save a declarative tool to the shared library (collision-guarded).
 *   DELETE /v1/tools/:name            → remove a created tool (built-in globals are never deletable).
 *
 * Created tools persist in `factory_tools` and are made runtime-executable by the step-engine's
 * declarative-tool resolver (see services/agent-factory/declarative-tool.ts) — so a tool authored
 * here is browsable in the library, bindable by the factory, AND really callable at runtime.
 */

import type { FastifyInstance } from "fastify";
import { listGlobalTools } from "@agentic/tools";
import { safeFetch, chatOnce, isGatewayConfigured, modelChain, type DeclarativeTool } from "@agentic/agent-factory";
import { listDeclarativeTools, saveDeclarativeTool, deleteDeclarativeTool } from "../../services/agent-factory/declarative-tool";
import { DrizzleToolStatsStore } from "../../services/agent-factory/stores";
import { requirePermission } from "../../plugins/rbac";

interface FieldSchema { type: string; required?: boolean; description?: string; default?: unknown }

/** Best-effort coerce a stored params/returns blob (string→type, or {type,description}) to the
 *  catalog's field-schema shape so created tools render in the same API-docs table as global tools. */
function toFieldSchema(blob: Record<string, unknown> | undefined): Record<string, FieldSchema> | undefined {
  if (!blob || typeof blob !== "object") return undefined;
  const out: Record<string, FieldSchema> = {};
  for (const [k, v] of Object.entries(blob)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      out[k] = { type: String(o.type ?? "any"), required: Boolean(o.required), description: o.description ? String(o.description) : undefined, default: o.default };
    } else {
      out[k] = { type: typeof v === "string" ? String(v) : "any", description: typeof v === "string" ? String(v) : undefined };
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Map a persisted DeclarativeTool into the same ToolCatalogEntry shape the UI renders. */
function declToCatalogEntry(dt: DeclarativeTool): Record<string, unknown> {
  const category = dt.name.includes(".") ? dt.name.slice(0, dt.name.indexOf(".")) : "created";
  return {
    name: dt.name,
    category,
    summary: dt.description || `${dt.method} ${dt.urlTemplate}`,
    description: `${dt.method} ${dt.urlTemplate}（造工具 · 副作用:${dt.sideEffect}${dt.domain ? ` · 域:${dt.domain}` : " · 共享"}）`,
    argsSchema: toFieldSchema(dt.paramsSchema),
    returnsSchema: toFieldSchema(dt.returnsSchema),
    configSchema: undefined,
    aliases: [],
    sourcePath: "factory_tools（造工具，可删除）",
    origin: "created",
    method: dt.method,
    urlTemplate: dt.urlTemplate,
    sideEffect: dt.sideEffect,
    domain: dt.domain,
  };
}

const EXTRACT_SYS =
  "你是 API 契约提炼器。给你一个工具意图和一段 API 文档文本，提炼出【最贴合该意图的单个 HTTP 端点】的可用契约。" +
  '只输出 JSON：{"name":string(带命名空间如 acme.getJob),"method":"GET|POST|PUT|DELETE","url_template":string(可含{placeholder}),"headers":object,"body_template":string,"side_effect":"read|write|dual","params_schema":object(字段名→类型/说明),"returns_schema":object(字段名→类型/说明,注意嵌套如data.data.*),"auth_hint":string(鉴权方式与所需凭证),"confidence":number(0-1),"notes":string}。文档没写的字段就留空或合理推断并在 notes 里标注。不要任何其它文字。';

export async function toolsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET: the unified catalog (global + created) ──────────────────────────────
  app.get("/tools", async (req, reply) => {
    requirePermission(req, "tools.read");
    // #SCALE-TOOLS — join empirical sandbox effectiveness so the library shows each tool's real
    // success rate (and flags demoted ones), not just its static contract.
    const stats = await new DrizzleToolStatsStore().successRates();
    const rate = (name: string): { invoked: number; succeeded: number; successRate: number } | Record<string, never> => {
      const st = stats[name];
      return st && st.invoked > 0 ? { invoked: st.invoked, succeeded: st.succeeded, successRate: st.succeeded / st.invoked } : {};
    };
    const globals = listGlobalTools().map((t) => ({ ...t, origin: "global" as const, ...rate(t.name) }));
    // Object.assign (not spread) so declToCatalogEntry's Record<string, unknown> index signature —
    // which carries `category` — survives the enrichment (object-spread would drop it → no category).
    const created = listDeclarativeTools(req.auth?.tenantSlug).map(declToCatalogEntry).map((t) => Object.assign(t, rate(String(t.name))));
    const tools = [...globals, ...created];
    return reply.ok({
      tools,
      count: tools.length,
      createdCount: created.length,
      categories: Array.from(new Set(tools.map((t) => t.category as string))).sort(),
    });
  });

  // ── POST generate-from-doc: fetch + LLM-extract a draft contract (no save) ────
  app.post<{ Body: { url?: string; text?: string; intent?: string } }>("/tools/generate-from-doc", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    if (!isGatewayConfigured()) return reply.fail("LLM_UNCONFIGURED", "未配置 LLM 网关，无法自动提炼；可直接手填工具契约。", 400);
    const intent = String(req.body?.intent ?? "").trim();
    if (!intent) return reply.fail("BAD_REQUEST", "请提供 tool_intent（这个工具要干嘛）。", 400);
    let doc = String(req.body?.text ?? "").trim();
    const url = String(req.body?.url ?? "").trim();
    if (!doc && url) {
      try {
        const res = await safeFetch(url, { headers: { accept: "text/html,text/plain,*/*" } });
        doc = (await res.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
      } catch (e) {
        return reply.fail("FETCH_FAILED", `抓取文档失败：${(e as Error).message}`, 400);
      }
    }
    if (!doc) return reply.fail("BAD_REQUEST", "没有文档文本可提炼——给一个公网 API 文档 url 或把 text 贴进来。", 400);
    try {
      const text = await chatOnce(EXTRACT_SYS, `工具意图：${intent}\n\nAPI 文档文本（截断）：\n${doc.slice(0, 5000)}`, {
        temperature: 0.2,
        maxTokens: 1200,
        models: modelChain("review"),
      });
      const m = text.match(/\{[\s\S]*\}/);
      const draft = m ? (JSON.parse(m[0]) as Record<string, unknown>) : null;
      if (!draft || !draft.name) return reply.fail("EXTRACT_FAILED", "没能从文档提炼出契约；换个更具体的 intent，或直接手填。", 422);
      return reply.ok({ draft });
    } catch (e) {
      return reply.fail("EXTRACT_FAILED", `提炼失败：${(e as Error).message}`, 422);
    }
  });

  // ── POST: save a declarative tool to the library ─────────────────────────────
  app.post<{
    Body: {
      name?: string; description?: string; method?: string; url_template?: string;
      headers?: Record<string, string>; body_template?: string; side_effect?: string;
      params_schema?: Record<string, unknown>; returns_schema?: Record<string, unknown>;
      shared?: boolean; // shared=true → domain:null (any tenant); else scoped to this tenant
    };
  }>("/tools", async (req, reply) => {
    requirePermission(req, "agents.write");
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) return reply.fail("BAD_REQUEST", "工具名不能为空（建议带命名空间，如 acme.createTicket）。", 400);
    if (!String(b.url_template ?? "").trim()) return reply.fail("BAD_REQUEST", "url_template 不能为空。", 400);
    const dt: DeclarativeTool = {
      name,
      description: String(b.description ?? ""),
      method: String(b.method ?? "GET").toUpperCase(),
      urlTemplate: String(b.url_template ?? ""),
      headers: b.headers && typeof b.headers === "object" ? b.headers : undefined,
      bodyTemplate: b.body_template ? String(b.body_template) : undefined,
      sideEffect: b.side_effect === "write" || b.side_effect === "dual" ? b.side_effect : "read",
      // shared (default) → null so every domain/tenant can bind it; else scope to this tenant.
      domain: b.shared === false ? (req.auth?.tenantSlug ?? null) : null,
      paramsSchema: b.params_schema && typeof b.params_schema === "object" ? b.params_schema : undefined,
      returnsSchema: b.returns_schema && typeof b.returns_schema === "object" ? b.returns_schema : undefined,
    };
    const r = saveDeclarativeTool(dt);
    if (!r.ok) return reply.fail("SAVE_REJECTED", r.reason ?? "保存失败", 409);
    return reply.ok({ saved: true, name: dt.name, sideEffect: dt.sideEffect, shared: dt.domain == null });
  });

  // ── DELETE: remove a created tool (globals are immutable) ────────────────────
  app.delete<{ Params: { name: string } }>("/tools/:name", async (req, reply) => {
    requirePermission(req, "agents.write");
    const name = decodeURIComponent(req.params.name);
    const removed = deleteDeclarativeTool(name, req.auth?.tenantSlug);
    if (!removed) return reply.fail("NOT_FOUND", `没有名为「${name}」的可删除工具（内置全局工具不可删，或不属于本租户）。`, 404);
    return reply.ok({ deleted: true, name });
  });
}
