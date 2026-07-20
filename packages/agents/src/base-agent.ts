/**
 * BaseAgent — abstract class for code-defined LLM agents.
 *
 * Subclasses MUST implement `buildMessages()` and SHOULD override
 * `parseOutput()` if they need anything beyond identity-on-string.
 *
 * The `run()` method is sealed — it delegates to the run engine which
 * handles the run/step rows, file logs, gateway dispatch, and result
 * shaping. Concrete agents never reach into the DB themselves.
 *
 * Example:
 *   class SummarizeAgent extends BaseAgent<{ text: string }, string> {
 *     readonly name = "summarize";
 *     readonly description = "Summarize a passage in one sentence.";
 *     protected buildMessages({ text }: { text: string }): ChatMessage[] {
 *       return [
 *         { role: "system", content: "You summarize text in exactly one sentence." },
 *         { role: "user", content: text },
 *       ];
 *     }
 *   }
 */

import type { ChatMessage } from "@agentic/llm-gateway";
import type {
  ProviderId,
  ReasoningConfig,
  TextVerbosity,
} from "@agentic/contracts";
import type { AgentContext, AgentKind, AgentResult } from "./types";
import { executeAgentRun } from "./run-engine";

export abstract class BaseAgent<TInput = unknown, TOutput = string> {
  abstract readonly name: string;
  abstract readonly description: string;

  readonly kind: AgentKind = "code";
  readonly enabled: boolean = true;

  /** Optional default provider override. Falls back to gateway default. */
  readonly defaultProvider?: ProviderId;
  /** Optional default model override. Falls back to gateway default. */
  readonly defaultModel?: string;
  /** Task-routing category used by the tenant AI settings policy. */
  readonly taskClass: string = "tool.loop";
  /** Optional provider-neutral reasoning defaults for every invocation. */
  readonly defaultReasoning?: ReasoningConfig;
  readonly defaultVerbosity?: TextVerbosity;
  readonly storeResponses?: boolean;

  /** v1 == 1 single-shot LLM call; future tool-use agents bump this. */
  readonly maxSteps: number = 1;

  /** Inngest concurrency hints when invoked asynchronously. */
  readonly concurrency: { limit: number; key?: string } = { limit: 4 };

  /** Required override — return the chat messages for this invocation. */
  protected abstract buildMessages(
    input: TInput,
    ctx: AgentContext,
  ): ChatMessage[] | Promise<ChatMessage[]>;

  /** Default = trim the model's text output. Override for JSON / Zod schemas. */
  protected parseOutput(
    text: string,
    _ctx: AgentContext,
  ): TOutput | Promise<TOutput> {
    return text.trim() as unknown as TOutput;
  }

  /**
   * Entry point. Sealed — do not override in subclasses; override the hooks
   * above instead. Run-row + step-row + file-log management lives in the
   * run engine to keep the contract uniform.
   */
  async run(input: TInput, ctx: AgentContext): Promise<AgentResult<TOutput>> {
    return executeAgentRun<TInput, TOutput>(this, input, ctx);
  }

  /** Internal accessor for run-engine; not part of the public surface. */
  _buildMessages(input: TInput, ctx: AgentContext): Promise<ChatMessage[]> {
    return Promise.resolve(this.buildMessages(input, ctx));
  }

  _parseOutput(text: string, ctx: AgentContext): Promise<TOutput> {
    return Promise.resolve(this.parseOutput(text, ctx));
  }
}
