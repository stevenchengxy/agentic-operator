// Generated agents (created by the Agent Factory) have NO hand-written tenant `definePrompt`.
// Their reasoning lives entirely in `ontology_instructions` (the brain-authored system prompt with
// the agent's decision logic), which `buildSystemMessage` composes into the system message. This
// module supplies the missing piece — a default USER-turn prompt — so a generated agent's single
// LLM `logic` action runs the tool-use loop driven by the trigger event, WITHOUT requiring a
// per-tenant prompt package. This is what makes humans+AI-generated functions actually runnable
// + deployable (sandbox AND promoted-to-tenant), not just registrable.

import type { PromptDescriptor, ToolContext } from "@agentic/agent-kit";

/** Build the default prompt for a generated agent's logic action. Language-neutral + structural:
 *  it feeds the trigger event payload and defers ALL behaviour to the agent's ontology_instructions
 *  (system) + its tool roster. No business logic is hardcoded here. */
export function makeGeneratedAgentPrompt(actionName: string): PromptDescriptor {
  return {
    kind: "prompt",
    name: `generated:${actionName}`,
    template: (ctx: ToolContext) => {
      const data = (ctx?.event?.data ?? {}) as Record<string, unknown>;
      let payload: string;
      try {
        payload = JSON.stringify(data, null, 2);
      } catch {
        payload = String(data);
      }
      return [
        `Incoming event payload / 触发事件数据:`,
        "```json",
        payload,
        "```",
        ``,
        `You are the agent for action "${actionName}". Follow your system instructions, call the`,
        `available tools when you need data or to act, then produce your result.`,
        `按你的系统指令处理本次事件：需要数据或执行动作时调用可用工具，完成后给出结论。`,
      ].join("\n");
    },
  };
}
