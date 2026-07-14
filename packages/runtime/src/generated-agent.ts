/**
 * Generated agents have no hand-written tenant `definePrompt`. Their
 * authored system prompt lives in `ontology_instructions`; this descriptor
 * supplies the user turn that carries each trigger's runtime context.
 */

import type { PromptDescriptor, ToolContext } from "@agentic/agent-kit";

export function makeGeneratedAgentPrompt(
  actionName: string,
  actionDescription = "",
): PromptDescriptor {
  return {
    kind: "prompt",
    name: `generated:${actionName}`,
    template: (ctx: ToolContext) => {
      const event = ctx.event ?? { name: "unknown", data: {} };
      const payload = safeJson(event.data ?? {});
      const previous =
        ctx.lastResult === undefined || ctx.lastResult === null
          ? "(none)"
          : safeJson(ctx.lastResult);

      return [
        `Execute the workflow action "${actionName}".`,
        actionDescription ? `Action objective: ${actionDescription}` : "",
        `Trigger event: ${event.name}`,
        "Incoming event payload:",
        "```json",
        payload,
        "```",
        "Previous action result:",
        "```json",
        previous,
        "```",
        "Follow the system prompt exactly. Use an available tool only when it is necessary, then return the final result for this workflow step.",
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
