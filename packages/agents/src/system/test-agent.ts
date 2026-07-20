/**
 * TestAgent — the first concrete code-defined agent.
 *
 * Single LLM call with the prompt "Introduce what is Agentic Operator." The
 * response is persisted through the standard run/step + file log pipeline.
 *
 * Used as the smoke test for the entire LLM gateway + BaseAgent stack.
 */

import type { ChatMessage } from "@agentic/llm-gateway";
import { BaseAgent } from "../base-agent";

export class TestAgent extends BaseAgent<void, string> {
  readonly name = "testAgent";
  readonly description =
    "Sanity-check agent. Asks the configured LLM to introduce the Agentic Operator.";
  override readonly scope = "system" as const;
  override readonly runScope = "owner" as const;
  override readonly inngestEnabled = true;
  override readonly maxOutputTokens = 512;

  protected buildMessages(): ChatMessage[] {
    return [
      {
        role: "system",
        content: "You are a concise technical writer. Reply in one paragraph.",
      },
      {
        role: "user",
        content: "Introduce what is Agentic Operator.",
      },
    ];
  }
}
