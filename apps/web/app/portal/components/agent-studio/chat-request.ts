import type { CreateAgentRunBody } from "@agentic/contracts";

export interface StudioChatRunRequest extends Omit<
  CreateAgentRunBody,
  "contextMode" | "prompt"
> {
  /** The textarea value exactly as entered by the operator. */
  prompt: string;
}

/**
 * Build the event-backed Test Lab request.
 *
 * The API reserves a correlated run/session, records the selected authored
 * trigger, and dispatches one private runtime control event. Deliberately do
 * not trim or otherwise normalize `prompt`: whitespace and line breaks are
 * part of the user message the agent must receive.
 */
export function buildStudioChatRunRequest(
  request: StudioChatRunRequest,
): CreateAgentRunBody {
  return {
    ...request,
    contextMode: "session",
    prompt: request.prompt,
  };
}
