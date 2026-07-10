/**
 * ontology.fetchActionRules — RUNTIME rule fetch for rule-check agents.
 *
 * The factory binds this tool onto every rule-gate agent and the agent's prompt folds the
 * returned rules fail-closed. Before R14 it was bound but registered NOWHERE in the runtime
 * registry, so the deployed gate could not resolve it → the rule check was dead. This makes it
 * a real global tool: at run time it pulls the rules that govern THIS action from the live
 * ontology (Allmeta), filtered to executor=Agent (+ flags the mandatory subset), so a gate
 * folds against real, current rules instead of anything baked into a prompt.
 *
 * Inputs come from context, not the LLM: the action is ctx.actionName (or config.action), the
 * domain is config.domain (the factory attaches it via the manifest tool_use config) or derived
 * from the tenant slug (`<domain>-sb` → `<domain>`). Allmeta base/key from env. Any failure → [].
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

const deriveDomain = (tenantSlug: string) => tenantSlug.replace(/-sb$/, "");
const execOf = (r: Record<string, unknown>) => String(r.executor ?? r.executor_json ?? r.actor ?? "").toLowerCase();
const enforceOf = (r: Record<string, unknown>) => String(r.enforcementLevel ?? r.enforcement_level ?? r.mandatory ?? "").toLowerCase();

export const fetchActionRules = defineTool({
  name: "ontology.fetchActionRules",
  description:
    "Runtime rule fetch for a rule-check agent: pulls the executor=Agent rules that govern THIS action from the live ontology (Allmeta) so the agent folds against real, current rules (never baked-in). Returns { rules, mandatory, count }. Fail-close on any mandatory rule.",
  output: z.object({
    rules: z.array(z.any()),
    mandatory: z.array(z.any()),
    count: z.number(),
    source: z.string(),
  }),
  async handler(ctx) {
    const action = String((ctx.config?.action as string) ?? ctx.actionName ?? "");
    const domain = String((ctx.config?.domain as string) ?? deriveDomain(ctx.tenantSlug));
    const base = (process.env.ALLMETA_BASE_URL ?? "").replace(/\/+$/, "");
    const key = process.env.ALLMETA_API_KEY ?? "";
    if (!base || !action) return { data: { rules: [], mandatory: [], count: 0, source: "unconfigured" }, meta: { action, domain } };
    try {
      const url = `${base}/api/v1/ontology/actions/${encodeURIComponent(action)}/rules?domain=${encodeURIComponent(domain)}`;
      const res = await fetch(url, { headers: key ? { Authorization: `Bearer ${key}` } : {} });
      // A degraded Allmeta (5xx/4xx with a body) resolves the fetch WITHOUT
      // throwing, so a missing res.ok check would stamp source:"allmeta" with an
      // empty rule set — a fail-OPEN on any rule-gate that treats "allmeta" as a
      // successful fetch. Surface the HTTP error as source:"error:…" so gates
      // fail CLOSED on an outage.
      if (!res.ok) {
        // #AUDIT-FIX(M12) — Allmeta 故障必须【抛错】而非返回 ok 的空规则集：runtime 会把 throw
        // 转成 tool_result is_error → 规则闸走失败分支（fail-close）。旧行为把 fail-close 押注在
        // "生成 prompt 会去读 source 字符串"上——mock 模型下规则闸静默零规则放行。
        throw new Error(`规则抓取失败（Allmeta HTTP ${res.status}）——规则闸必须 fail-close，禁止按零规则放行`);
      }
      const body = (await res.json().catch(() => null)) as { rules?: unknown[] } | null;
      const all = Array.isArray(body?.rules) ? (body!.rules as Array<Record<string, unknown>>) : [];
      const agentRules = all.filter((r) => execOf(r).includes("agent") || execOf(r) === "");
      const mandatory = agentRules.filter((r) => enforceOf(r).includes("mandator") || enforceOf(r) === "true");
      return { data: { rules: agentRules, mandatory, count: agentRules.length, source: "allmeta" }, meta: { action, domain, total: all.length } };
    } catch (e) {
      // #AUDIT-FIX(M12) — 同上：网络/解析故障一律抛错 fail-close（unconfigured 分支保持温和返回：
      // 上传本体域可能确实没有 Allmeta，配置缺失≠运行故障，由生成期规则闸绑定校验兜底）。
      throw new Error(`规则抓取失败（${(e as Error).message?.slice(0, 80)}）——规则闸必须 fail-close，禁止按零规则放行`);
    }
  },
});
