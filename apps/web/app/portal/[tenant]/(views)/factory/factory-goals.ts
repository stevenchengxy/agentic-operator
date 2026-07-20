import type { DomainRow } from "./model";

export interface FactoryGoalAction {
  name: string;
  /**
   * Ontology executor designation, e.g. `["Agent"]` | `["Human"]`. Absent on
   * legacy ontologies that predate the actor field.
   */
  actor?: string[];
}

/**
 * The factory only generates agents for actions the ontology marks as
 * Agent-executed. A Human action (approval/manual-entry/etc.) must never seed
 * an agent suggestion. An action with no actor designation is treated as
 * automatable — back-compat with ontologies that predate the `actor` field.
 * Mirrors the server-side anchor filter in
 * `packages/agent-factory/src/ontology-anchor.ts`.
 */
function isAgentAction(action: FactoryGoalAction): boolean {
  const actor = action.actor;
  if (!actor || actor.length === 0) return true;
  return actor.some((role) => role.trim().toLowerCase() === "agent");
}

/**
 * The uploaded-ontology display marker「（上传）」is appended by the API when it
 * lists an uploaded domain. A re-upload once echoed the already-decorated name
 * back and compounded it (「…（上传）（上传）」). Collapse any run to a single
 * marker so a suggestion never surfaces the doubled artifact even if a stale
 * name reaches us. The root fix lives in the API source; this is defense in depth.
 */
function cleanDomainLabel(raw: string): string {
  return raw.replace(/(（上传）)+/gu, "（上传）");
}

/**
 * Suggestions are projections of the currently persisted ontology binding.
 * With no bound *Agent* action evidence there is nothing trustworthy to
 * suggest — the factory does not generate agents for Human actions.
 */
export function buildFactoryGoalSuggestions(
  domain: DomainRow | null,
  actions: readonly FactoryGoalAction[],
): string[] {
  if (!domain) return [];

  const agentActionNames = Array.from(
    new Set(
      actions
        .filter(isAgentAction)
        .map((action) => action.name.trim())
        .filter(Boolean),
    ),
  );
  if (agentActionNames.length === 0) return [];

  const domainLabel = cleanDomainLabel(domain.name?.trim() || domain.id);
  const visibleNames = agentActionNames.slice(0, 3);
  const actionSummary = `${visibleNames.join("、")}${
    agentActionNames.length > visibleNames.length ? " 等" : ""
  }`;
  const suggestions = [
    `为「${domainLabel}」生成覆盖 ${agentActionNames.length} 个 Agent 执行动作的智能体，并通过真实运行验证完整事件链。`,
    `优先围绕 Agent 动作「${actionSummary}」生成智能体，并验证每个动作的真实工具与输入输出契约。`,
  ];

  const ruleCount = domain.counts?.rules ?? 0;
  if (ruleCount > 0) {
    suggestions.push(
      `基于「${domainLabel}」已连接的 ${ruleCount} 条本体规则生成智能体，并用真实执行证据验证规则约束。`,
    );
  }

  return suggestions;
}
