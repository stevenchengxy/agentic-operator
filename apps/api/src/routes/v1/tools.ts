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
import { globalToolRegistry, listGlobalTools } from "@agentic/tools";
import { inspectWriteProbeSafety } from "@agentic/shared";
import {
  safeFetch,
  chatOnce,
  isGatewayConfigured,
  modelChain,
  findSensitiveProbeInputPath,
  findSensitiveInputPath,
  parseCapabilityDescriptors,
  persistedToolAsRealTool,
  realToolExecutionPolicy,
  isGeneratedToolExecutionPolicy,
  validateDeclarativeToolPolicy,
  validateIntegrationToolConfig,
  isIntegrationProfileEnvironment,
  type DeclarativeTool,
  type RealTool,
} from "@agentic/agent-factory";
import { listDeclarativeTools, saveDeclarativeTool, deleteDeclarativeTool } from "../../services/agent-factory/declarative-tool";
import { DrizzleToolStatsStore, DrizzleToolStore } from "../../services/agent-factory/stores";
import { getFactoryDomainBinding } from "../../services/agent-factory/domain-binding";
import {
  listGlobalToolProbeReceipts,
  summarizeGlobalToolProbeReceiptsByTool,
} from "../../services/agent-factory/tool-probe-store";
import { requirePermission } from "../../plugins/rbac";
import { writeAudit } from "../../plugins/audit";
import {
  deleteIntegrationProfile,
  listIntegrationProfiles,
  saveIntegrationProfile,
} from "../../services/agent-factory/integration-profile-store";
import {
  hasAnyFactoryActiveWork,
  hasFactoryActiveWork,
} from "../../services/agent-factory/active-work";

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
  const evidenceMode = dt.probeEvidence?.evidenceMode;
  const productionProbeVerified = dt.probeStatus === "verified"
    && evidenceMode === "live-probe"
    && typeof dt.probeEvidence?.attestationKeyId === "string"
    && typeof dt.probeEvidence?.attestationExpiresAt === "string"
    && Date.parse(dt.probeEvidence.attestationExpiresAt) > Date.now();
  const writeProof = dt.probeEvidence?.writeProbeProof as {
    create?: { completed?: unknown };
    cleanup?: { completed?: unknown };
    absence?: { verified?: unknown };
    idempotencyKeyHash?: unknown;
  } | undefined;
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
    probeEvidenceMode: evidenceMode,
    productionProbeVerified,
    writeProbeComplete: Boolean(
      writeProof?.create?.completed === true
      && writeProof.cleanup?.completed === true
      && writeProof.absence?.verified === true
      && typeof writeProof.idempotencyKeyHash === "string"
      && /^[a-f0-9]{64}$/i.test(writeProof.idempotencyKeyHash),
    ),
    method: dt.method,
    urlTemplate: dt.urlTemplate,
    sideEffect: dt.sideEffect,
    operation: dt.operation,
    effectScope: dt.effectScope,
    sandboxPolicy: dt.sandboxPolicy,
    domain: dt.domain,
    capabilities: dt.capabilities ?? [],
    probeStatus: dt.probeStatus ?? "required",
    definitionHash: dt.definitionHash,
    probeEvidence: dt.probeEvidence,
    verifiedAt: dt.verifiedAt,
  };
}

function globalCatalogAsRealTool(catalog: ReturnType<typeof listGlobalTools>[number]): RealTool {
  return {
    name: catalog.name,
    summary: catalog.summary,
    aliases: catalog.aliases,
    category: catalog.category,
    sideEffect: catalog.sideEffect ?? "call",
    operation: catalog.operation,
    effectScope: catalog.effectScope,
    sandboxPolicy: catalog.sandboxPolicy,
    configKeys: catalog.configSchema ? Object.keys(catalog.configSchema) : [],
    credentialEnv: catalog.credentialEnv ?? [],
    capabilities: catalog.capabilities ?? [],
    catalogDefinition: {
      name: catalog.name,
      category: catalog.category,
      sourcePath: catalog.sourcePath,
      sideEffect: catalog.sideEffect,
      operation: catalog.operation,
      effectScope: catalog.effectScope,
      sandboxPolicy: catalog.sandboxPolicy,
      argsSchema: catalog.argsSchema,
      returnsSchema: catalog.returnsSchema,
      configSchema: catalog.configSchema,
      ...(catalog.configContract !== undefined ? { configContract: catalog.configContract } : {}),
      capabilities: catalog.capabilities,
      profileScope: catalog.profileScope,
      probeSafety: catalog.probeSafety,
    },
  };
}

const EXTRACT_SYS =
  "你是 API 契约提炼器。给你一个工具意图和一段 API 文档文本，提炼出【最贴合该意图的单个 HTTP 端点】的可用契约。" +
  '只输出 JSON：{"name":string(带命名空间如 acme.getJob),"method":"GET|POST|PUT|DELETE","url_template":string(可含{placeholder}),"headers":object,"body_template":string,"side_effect":"read|write|dual","operation":"read|compute|write|read_write","effect_scope":"external","sandbox_policy":"live_external|requires_attempt_grant","params_schema":object(JSON Schema或字段map),"returns_schema":object(JSON Schema或字段map),"capabilities":[{"systems":string[],"kinds":string[],"roles":string[],"operations":string[],"objectTypes":string[],"probeRequired":boolean}],"auth_hint":string(鉴权方式与所需凭证),"confidence":number(0-1),"notes":string}。operation/effect_scope/sandbox_policy 是执行安全契约：只有确定不改变外部状态时才可用 live_external，任何可能修改外部状态的操作必须用 requires_attempt_grant。文档没有足够证据时不要从 HTTP method、side_effect 或工具名推断这三个字段，应将它们留空并在 notes 里用人话说明需要人确认。不要任何其它文字。';

export async function toolsRoutes(app: FastifyInstance): Promise<void> {
  // ── GET: the unified catalog (global + created) ──────────────────────────────
  app.get("/tools", async (req, reply) => {
    requirePermission(req, "tools.read");
    // #SCALE-TOOLS — join empirical sandbox effectiveness so the library shows each tool's real
    // success rate (and flags demoted ones), not just its static contract.
    const binding = req.auth ? getFactoryDomainBinding(req.auth.tenantId) : null;
    const stats = await new DrizzleToolStatsStore(req.auth?.tenantId, binding?.ontologyDomainId).successRates();
    const globalProbeReceipts = req.auth
      ? summarizeGlobalToolProbeReceiptsByTool(listGlobalToolProbeReceipts(req.auth.tenantId, binding?.ontologyDomainId))
      : new Map();
    const integrationProfilesByTool = new Map<string, ReturnType<typeof listIntegrationProfiles>>();
    for (const profile of req.auth ? listIntegrationProfiles(req.auth.tenantId, binding?.ontologyDomainId) : []) {
      const current = integrationProfilesByTool.get(profile.toolName) ?? [];
      current.push(profile);
      integrationProfilesByTool.set(profile.toolName, current);
    }
    const rate = (name: string): { invoked: number; succeeded: number; successRate: number } | Record<string, never> => {
      const st = stats[name];
      return st && st.invoked > 0 ? { invoked: st.invoked, succeeded: st.succeeded, successRate: st.succeeded / st.invoked } : {};
    };
    const globals = listGlobalTools().map((t) => {
      const receipt = globalProbeReceipts.get(t.name);
      const probeRequired =
        t.effectScope === "external" ||
        t.operation === "write" ||
        t.operation === "read_write" ||
        t.sideEffect === "write" ||
        t.sideEffect === "dual" ||
        t.capabilities?.some((capability) => capability.probeRequired) === true;
      return {
        ...t,
        origin: "global" as const,
        probeStatus: probeRequired ? (receipt?.status ?? "required") : "verified",
        definitionHash: receipt?.definitionHash,
        verifiedDefinitionHashes: receipt?.verifiedDefinitionHashes,
        productionVerifiedDefinitionHashes: receipt?.productionVerifiedDefinitionHashes,
        probeEvidenceMode: receipt?.evidenceMode,
        productionProbeVerified: probeRequired ? (receipt?.productionVerified ?? false) : true,
        writeProbeComplete: receipt?.writeProbeComplete ?? false,
        integrationProfiles: integrationProfilesByTool.get(t.name) ?? [],
        probeEvidence: receipt?.evidence,
        verifiedAt: receipt?.verifiedAt,
        ...rate(t.name),
      };
    });
    // Object.assign (not spread) so declToCatalogEntry's Record<string, unknown> index signature —
    // which carries `category` — survives the enrichment (object-spread would drop it → no category).
    const created = listDeclarativeTools(req.auth?.tenantId, binding?.ontologyDomainId ?? null).map(declToCatalogEntry).map((t) => Object.assign(t, rate(String(t.name))));
    const tools = [...globals, ...created];
    return reply.ok({
      tools,
      count: tools.length,
      createdCount: created.length,
      categories: Array.from(new Set(tools.map((t) => t.category as string))).sort(),
    });
  });

  // ── Human-confirmed, non-secret integration profiles ───────────────────────
  app.get<{ Params: { name: string }; Querystring: { environment?: string } }>("/tools/:name/profiles", async (req, reply) => {
    const auth = requirePermission(req, "tools.read");
    const name = decodeURIComponent(req.params.name);
    const binding = getFactoryDomainBinding(auth.tenantId);
    const globalCatalog = listGlobalTools().find((candidate) => candidate.name === name);
    const declarative = globalCatalog
      ? undefined
      : listDeclarativeTools(auth.tenantId, binding?.ontologyDomainId ?? null).find((candidate) => candidate.name === name);
    const tool = globalCatalog ? globalCatalogAsRealTool(globalCatalog) : declarative ? persistedToolAsRealTool(declarative) : undefined;
    if (!tool) return reply.fail("NOT_FOUND", `没有工具「${name}」`, 404);
    const environment = req.query.environment;
    if (environment !== undefined && !isIntegrationProfileEnvironment(environment)) {
      return reply.fail("INVALID_PROFILE_ENVIRONMENT", "environment 必须是 sandbox 或 production。", 400);
    }
    const profiles = listIntegrationProfiles(auth.tenantId, binding?.ontologyDomainId, name, environment).map((profile) => ({
      ...profile,
      validation: validateIntegrationToolConfig(tool, profile.config),
    }));
    return reply.ok({ profiles, count: profiles.length });
  });

  app.put<{
    Params: { name: string; profileKey: string };
    Body: { environment?: string; config?: unknown };
  }>("/tools/:name/profiles/:profileKey", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    if (hasFactoryActiveWork(auth.tenantId)) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "这个 tenant 正在做沙箱验证、报告生成或 promotion。为避免运行中途替换集成配置，请等本轮结束后再修改 profile。",
        409,
      );
    }
    const name = decodeURIComponent(req.params.name);
    const profileKey = decodeURIComponent(req.params.profileKey);
    const environment = req.body?.environment;
    if (!isIntegrationProfileEnvironment(environment)) {
      return reply.fail("INVALID_PROFILE_ENVIRONMENT", "请明确选择 sandbox 或 production；两套配置不能共用。", 400);
    }
    const binding = getFactoryDomainBinding(auth.tenantId);
    const globalCatalog = listGlobalTools().find((candidate) => candidate.name === name);
    const declarative = globalCatalog
      ? undefined
      : listDeclarativeTools(auth.tenantId, binding?.ontologyDomainId ?? null).find((candidate) => candidate.name === name);
    const tool = globalCatalog ? globalCatalogAsRealTool(globalCatalog) : declarative ? persistedToolAsRealTool(declarative) : undefined;
    if (!tool) return reply.fail("NOT_FOUND", `没有工具「${name}」`, 404);
    const confirmedBy = auth.userId ?? auth.email;
    if (!confirmedBy) {
      return reply.fail("AUTH_ACTOR_REQUIRED", "当前登录凭据没有可验证的用户身份，不能确认集成配置。", 403);
    }
    const result = saveIntegrationProfile({
      tenantId: auth.tenantId,
      domainId: binding?.ontologyDomainId,
      profileKey,
      environment,
      tool,
      config: req.body?.config,
      confirmedBy,
    });
    if (!result.ok) {
      return reply.fail("INVALID_INTEGRATION_PROFILE", result.error, 400);
    }
    writeAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId ?? undefined,
      action: "integration_profile.confirm",
      targetType: "tool",
      targetId: name,
      meta: {
        profileKey,
        environment,
        domain: binding?.ontologyDomainId ?? null,
        ready: result.validation.ready,
        envRefs: result.validation.envRefs,
        missingEnvRefs: result.validation.missingEnvRefs,
      },
    });
    return reply.ok({ profile: result.profile, validation: result.validation });
  });

  app.delete<{ Params: { name: string; profileKey: string }; Querystring: { environment?: string } }>("/tools/:name/profiles/:profileKey", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    if (hasFactoryActiveWork(auth.tenantId)) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "这个 tenant 正在做沙箱验证、报告生成或 promotion。为避免撤销正在使用的集成配置，请等本轮结束后再删除 profile。",
        409,
      );
    }
    const name = decodeURIComponent(req.params.name);
    const profileKey = decodeURIComponent(req.params.profileKey);
    const environment = req.query.environment;
    if (!isIntegrationProfileEnvironment(environment)) {
      return reply.fail("INVALID_PROFILE_ENVIRONMENT", "删除 profile 时必须明确 environment=sandbox 或 environment=production。", 400);
    }
    const binding = getFactoryDomainBinding(auth.tenantId);
    const deleted = deleteIntegrationProfile(auth.tenantId, binding?.ontologyDomainId, name, profileKey, environment);
    if (!deleted) return reply.fail("NOT_FOUND", `没有 integration profile「${profileKey}」`, 404);
    writeAudit({
      tenantId: auth.tenantId,
      actorUserId: auth.userId ?? undefined,
      action: "integration_profile.delete",
      targetType: "tool",
      targetId: name,
      meta: { profileKey, environment, domain: binding?.ontologyDomainId ?? null },
    });
    return reply.ok({ deleted: true, name, profileKey, environment });
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
      operation?: string; effect_scope?: string; sandbox_policy?: string;
      params_schema?: Record<string, unknown>; returns_schema?: Record<string, unknown>;
      capabilities?: DeclarativeTool["capabilities"];
      shared?: boolean; // shared=true → domain:null (any tenant); else scoped to this tenant
    };
  }>("/tools", async (req, reply) => {
    requirePermission(req, "agents.write");
    const b = req.body ?? {};
    const name = String(b.name ?? "").trim();
    if (!name) return reply.fail("BAD_REQUEST", "工具名不能为空（建议带命名空间，如 acme.createTicket）。", 400);
    if (!String(b.url_template ?? "").trim()) return reply.fail("BAD_REQUEST", "url_template 不能为空。", 400);
    if (!req.auth) return reply.fail("UNAUTHORIZED", "需要租户上下文", 401);
    const shared = b.shared === true;
    if (shared && req.auth.platformRole !== "superadmin") {
      return reply.fail("FORBIDDEN", "只有平台管理员可以发布全平台共享工具。", 403);
    }
    if (shared ? hasAnyFactoryActiveWork() : hasFactoryActiveWork(req.auth.tenantId)) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "沙箱验证、报告或 promotion 正在使用当前工具快照。为避免运行中途换掉能力定义，请等本轮结束后再保存工具。",
        409,
      );
    }
    const binding = getFactoryDomainBinding(req.auth.tenantId);
    const method = String(b.method ?? "").trim().toUpperCase();
    const urlTemplate = String(b.url_template ?? "").trim();
    if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).has(method)) {
      return reply.fail("INVALID_TOOL_CONTRACT", "method 必须明确为 GET/HEAD/POST/PUT/PATCH/DELETE；未知 method 不能按只读保存。", 400);
    }
    try {
      const parsedUrl = new URL(urlTemplate);
      if (!new Set(["http:", "https:"]).has(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password) {
        return reply.fail("INVALID_TOOL_CONTRACT", "url_template 只允许不含用户名/密码的绝对 http(s) URL。", 400);
      }
    } catch {
      return reply.fail("INVALID_TOOL_CONTRACT", "url_template 必须是绝对 http(s) URL。", 400);
    }
    if (b.headers !== undefined) {
      if (!b.headers || typeof b.headers !== "object" || Array.isArray(b.headers)) {
        return reply.fail("INVALID_TOOL_CONTRACT", "headers 必须是字符串映射对象。", 400);
      }
      const invalidHeader = Object.entries(b.headers).find(([key, value]) => !key.trim() || typeof value !== "string");
      if (invalidHeader) return reply.fail("INVALID_TOOL_CONTRACT", `header ${invalidHeader[0] || "(empty)"} 必须是字符串。`, 400);
    }
    if (b.body_template !== undefined && (typeof b.body_template !== "string" || !b.body_template)) {
      return reply.fail("INVALID_TOOL_CONTRACT", "body_template 必须是非空字符串。", 400);
    }
    const sensitiveDefinitionPath = findSensitiveInputPath({
      url_template: urlTemplate,
      headers: b.headers,
      body_template: b.body_template,
    }, "tool");
    if (sensitiveDefinitionPath) {
      return reply.fail("SECRET_INPUT_REJECTED", `${sensitiveDefinitionPath} 含字面凭证；请使用 {config_key} 占位符。`, 400);
    }
    const parsedCapabilities = parseCapabilityDescriptors(b.capabilities);
    if (!parsedCapabilities.ok) return reply.fail("INVALID_TOOL_CONTRACT", parsedCapabilities.error, 400);
    const sideEffectPolicy = validateDeclarativeToolPolicy({
      method,
      declaredSideEffect: b.side_effect,
      bodyTemplate: b.body_template ? String(b.body_template) : undefined,
      capabilities: parsedCapabilities.capabilities,
    });
    if (!sideEffectPolicy.ok) return reply.fail("INVALID_TOOL_CONTRACT", sideEffectPolicy.error, 400);
    const executionPolicy = {
      operation: b.operation,
      effectScope: b.effect_scope,
      sandboxPolicy: b.sandbox_policy,
    };
    if (!isGeneratedToolExecutionPolicy(executionPolicy) || executionPolicy.effectScope !== "external") {
      return reply.fail(
        "INVALID_TOOL_CONTRACT",
        "请明确提供 operation、effect_scope=external 和 sandbox_policy。我们不会根据 HTTP method、side_effect 或工具名替你猜执行权限。",
        400,
      );
    }
    const dt: DeclarativeTool = {
      name,
      description: String(b.description ?? ""),
      method,
      urlTemplate,
      headers: b.headers && typeof b.headers === "object" ? b.headers : undefined,
      bodyTemplate: b.body_template ? String(b.body_template) : undefined,
      sideEffect: sideEffectPolicy.sideEffect,
      ...executionPolicy,
      // Domain is descriptive/selection metadata; ownership is the tenant scope
      // persisted separately in factory_tools.scope_key.
      // An unbound tenant may still author a private, tenant-wide tool. `null`
      // no longer means "shared" (scope_key does), it means the tool is not
      // restricted to one ontology id and will remain available after a later
      // explicit ontology connection.
      domain: shared ? null : (binding?.ontologyDomainId ?? null),
      paramsSchema: b.params_schema && typeof b.params_schema === "object" ? b.params_schema : undefined,
      returnsSchema: b.returns_schema && typeof b.returns_schema === "object" ? b.returns_schema : undefined,
      capabilities: parsedCapabilities.capabilities.length ? parsedCapabilities.capabilities : undefined,
      probeStatus: "required",
    };
    const r = saveDeclarativeTool(dt, { tenantId: req.auth.tenantId, shared });
    if (!r.ok) return reply.fail("SAVE_REJECTED", r.reason ?? "保存失败", 409);
    writeAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId ?? undefined,
      action: "tool.create",
      targetType: "tool",
      targetId: dt.name,
      meta: {
        method: dt.method,
        urlTemplate: dt.urlTemplate,
        sideEffect: dt.sideEffect,
        operation: dt.operation,
        effectScope: dt.effectScope,
        sandboxPolicy: dt.sandboxPolicy,
        shared,
        probeStatus: dt.probeStatus,
      },
    });
    return reply.ok({
      saved: true,
      name: dt.name,
      sideEffect: dt.sideEffect,
      operation: dt.operation,
      effectScope: dt.effectScope,
      sandboxPolicy: dt.sandboxPolicy,
      shared,
    });
  });

  // ── POST probe: real guarded call + schema validation + canonical cassette ───
  app.post<{
    Params: { name: string };
    Body: {
      args?: Record<string, unknown>;
      config?: Record<string, unknown>;
      persist_cassette?: boolean;
    };
  }>("/tools/:name/probe", async (req, reply) => {
    requirePermission(req, "agents.invoke");
    if (!req.auth) return reply.fail("UNAUTHORIZED", "需要租户上下文", 401);
    if (hasFactoryActiveWork(req.auth.tenantId)) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "这个 tenant 正在做沙箱验证、报告或 promotion；本轮结束前不能刷新工具探针证据。",
        409,
      );
    }
    const binding = getFactoryDomainBinding(req.auth.tenantId);
    const name = decodeURIComponent(req.params.name);
    const args = req.body?.args && typeof req.body.args === "object" ? req.body.args : {};
    let config = req.body?.config && typeof req.body.config === "object" ? req.body.config : undefined;
    const secretArg = findSensitiveProbeInputPath(args);
    if (secretArg) return reply.fail("SECRET_INPUT_REJECTED", `${secretArg} 不能携带凭证；请通过服务器环境变量配置。`, 400);
    const literalSecret = Object.entries(config ?? {}).find(([key, value]) =>
      /^(?:api[_-]?key|access[_-]?token|token|secret|password|authorization)$/i.test(key) && value != null && String(value).trim() !== "",
    );
    if (literalSecret) return reply.fail("SECRET_INPUT_REJECTED", `config.${literalSecret[0]} 禁止传字面 secret；请改用 *_env 字段引用服务器环境变量名。`, 400);
    const badEnvRef = Object.entries(config ?? {}).find(([key, value]) => /_env$/i.test(key) && (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)));
    if (badEnvRef) return reply.fail("BAD_CONFIG_ENV_REF", `config.${badEnvRef[0]} 必须是合法环境变量名。`, 400);
    const actor = req.auth.userId ?? req.auth.email ?? `token:${req.auth.tenantId}`;
    const persisted = listDeclarativeTools(req.auth.tenantId, binding?.ontologyDomainId ?? null).find((candidate) => candidate.name === name);
    const globalCatalog = persisted ? undefined : listGlobalTools().find((candidate) => candidate.name === name);
    const globalDescriptor = globalCatalog ? globalToolRegistry.get(globalCatalog.name) : undefined;
    if (!persisted && (!globalCatalog || !globalDescriptor)) return reply.fail("NOT_FOUND", `没有可 probe 的工具「${name}」`, 404);
    const realTool = globalCatalog ? globalCatalogAsRealTool(globalCatalog) : persisted ? persistedToolAsRealTool(persisted) : undefined;
    const executionPolicy = realToolExecutionPolicy(realTool);
    if (!executionPolicy) {
      return reply.fail(
        "TOOL_EXECUTION_POLICY_REQUIRED",
        "这个工具还没有完整、可审核的 operation/effectScope/sandboxPolicy，所以本次不会执行。请先在工具库补齐；系统不会从 sideEffect、HTTP method 或名字推断。",
        428,
      );
    }
    // This direct API has no durable factory ask_user challenge/consumption
    // proof. A request boolean is not human authorization, so every tool whose
    // reviewed policy requires an attempt grant is disabled here. Such probes
    // must run through probe_tool's exact one-shot human authorization path.
    if (executionPolicy.sandboxPolicy === "requires_attempt_grant") {
      const safety = inspectWriteProbeSafety(
        realTool!.sideEffect,
        realTool!.catalogDefinition?.probeSafety ?? realTool!.declarativeDefinition?.probeSafety,
      );
      if (safety.status === "needs_config") {
        return reply.code(428).send({
          ok: false,
          error: { code: "PROBE_CANARY_CONFIG_REQUIRED", message: safety.question },
          status: safety.status,
          next: safety.next,
          missing: safety.missing,
        });
      }
      return reply.fail(
        "PROBE_HUMAN_AUTHORIZATION_REQUIRED",
        "这个工具可能修改真实系统。直接 API 无法证明一次性人工授权，因此禁止执行；请在 Agent 工厂里确认这一次具体探针。",
        428,
      );
    }
    const configValidation = validateIntegrationToolConfig(realTool!, config ?? {});
    if (!configValidation.valid) {
      return reply.fail("BAD_TOOL_CONFIG", configValidation.issues.map((issue) => issue.message).join("；"), 400);
    }
    if (!configValidation.ready) {
      return reply.fail("TOOL_CONFIG_NOT_READY", `服务器尚未配置环境变量：${configValidation.missingEnvRefs.join(", ")}`, 428);
    }
    config = configValidation.config;
    // A verified receipt is useful only when the exact redacted cassette is
    // API-attested and durable.  `persist_cassette:false` is retained as a
    // backwards-compatible request field but no longer creates a green,
    // unusable receipt.  The unbound sentinel keeps pre-ontology diagnostics
    // isolated; connecting a real domain necessarily requires a fresh probe.
    const domainId = binding?.ontologyDomainId ?? "__unbound__";
    const result = await new DrizzleToolStore(
      req.auth.tenantId,
      domainId,
      req.auth.tenantSlug,
    ).probe({
      domain: domainId,
      name,
      args,
      config,
      actor,
    });
    if (result.classification === "authorization_required") {
      return reply.fail("PROBE_AUTHORIZATION_REQUIRED", result.error ?? "写操作 probe 需要明确确认", 428);
    }
    writeAudit({
      tenantId: req.auth.tenantId,
      actorUserId: req.auth.userId ?? undefined,
      action: "tool.probe",
      targetType: "tool",
      targetId: name,
      meta: {
        origin: persisted ? "created" : "global",
        verified: result.verified,
        classification: result.classification,
        status: result.status,
        durationMs: result.durationMs,
        definitionHash: result.definitionHash,
        schemaHash: result.schemaHash,
        sideEffectsAuthorized: false,
      },
    });
    return reply.code(result.verified ? 200 : 422).send({ ok: result.verified, data: result });
  });

  // ── DELETE: remove a created tool (globals are immutable) ────────────────────
  app.delete<{ Params: { name: string } }>("/tools/:name", async (req, reply) => {
    const auth = requirePermission(req, "agents.write");
    const name = decodeURIComponent(req.params.name);
    if (
      auth.platformRole === "superadmin"
        ? hasAnyFactoryActiveWork()
        : hasFactoryActiveWork(auth.tenantId)
    ) {
      return reply.fail(
        "FACTORY_EXECUTION_ACTIVE",
        "沙箱验证、报告或 promotion 正在使用当前工具快照。为避免运行中途移除能力，请等本轮结束后再删除工具。",
        409,
      );
    }
    let binding: ReturnType<typeof getFactoryDomainBinding> = null;
    try {
      binding = getFactoryDomainBinding(auth.tenantId);
      const removed = deleteDeclarativeTool(name, auth.tenantId, auth.platformRole === "superadmin", binding?.ontologyDomainId ?? null);
      if (!removed) {
        writeAudit({
          tenantId: auth.tenantId,
          actorUserId: auth.userId ?? undefined,
          action: "tool.delete",
          targetType: "tool",
          targetId: name,
          meta: { decision: "deny", outcome: "failed", errorCode: "NOT_FOUND", domain: binding?.ontologyDomainId ?? null },
        });
        return reply.fail("NOT_FOUND", `没有名为「${name}」的可删除工具（内置全局工具不可删，或不属于本租户）。`, 404);
      }
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "tool.delete",
        targetType: "tool",
        targetId: name,
        meta: { decision: "allow", outcome: "succeeded", domain: binding?.ontologyDomainId ?? null },
      });
      return reply.ok({ deleted: true, name });
    } catch (error) {
      writeAudit({
        tenantId: auth.tenantId,
        actorUserId: auth.userId ?? undefined,
        action: "tool.delete",
        targetType: "tool",
        targetId: name,
        meta: {
          decision: "deny",
          outcome: "failed",
          errorCode: "DELETE_FAILED",
          error: String((error as Error).message ?? error).replace(/[\r\n\t]+/g, " ").slice(0, 240),
          domain: binding?.ontologyDomainId ?? null,
        },
      });
      return reply.fail("DELETE_FAILED", "工具持久化删除失败", 503);
    }
  });
}
