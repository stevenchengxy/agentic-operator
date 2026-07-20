// Generated agents (created by the Agent Factory) have NO hand-written tenant `definePrompt`.
// Their reasoning lives entirely in `ontology_instructions` (the brain-authored system prompt with
// the agent's decision logic), which `buildSystemMessage` composes into the system message. This
// module supplies the missing piece — a default USER-turn prompt — so a generated agent's single
// LLM `logic` action runs the tool-use loop driven by the trigger event, WITHOUT requiring a
// per-tenant prompt package. This is what makes humans+AI-generated functions actually runnable
// + deployable (sandbox AND promoted-to-tenant), not just registrable.

import type { PromptDescriptor, ToolContext } from "@agentic/agent-kit";

/** Build the default prompt for a generated agent's logic action. Language-neutral + structural:
 *  it feeds the trigger event payload + previous action result and defers ALL behaviour to the
 *  agent's ontology_instructions (system) + its tool roster. No business logic hardcoded here. */
export function makeGeneratedAgentPrompt(
  actionName: string,
  actionDescription = "",
): PromptDescriptor {
  return {
    kind: "prompt",
    name: `generated:${actionName}`,
    template: (ctx: ToolContext) => {
      const event = ctx.event ?? { name: "unknown", data: {} };
      // The fenced block is explicitly labelled JSON. If the trigger event
      // cannot be represented as JSON (circular, etc.), FAIL the step instead
      // of feeding the model a misleading pseudo-payload. `lastResult` is
      // best-effort context and may degrade via safeJson.
      const payload = JSON.stringify(event.data ?? {}, null, 2);
      const previous =
        ctx.lastResult === undefined || ctx.lastResult === null
          ? "(none)"
          : safeJson(ctx.lastResult);

      return [
        `Execute the workflow action "${actionName}".`,
        actionDescription ? `Action objective: ${actionDescription}` : "",
        `Trigger event: ${event.name}`,
        "Incoming event payload / 触发事件数据:",
        "```json",
        payload,
        "```",
        "Previous action result:",
        "```json",
        previous,
        "```",
        "Follow the system prompt exactly. Use an available tool only when it is necessary, then return the final result for this workflow step.",
        "按你的系统指令处理本次事件：需要数据或执行动作时调用可用工具，完成后给出结论。",
      ]
        .filter(Boolean)
        .join("\n");
    },
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
