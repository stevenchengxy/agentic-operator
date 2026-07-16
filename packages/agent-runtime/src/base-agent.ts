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

import type { ChatMessage, ToolDef } from "@agentic/llm-gateway";
import type {
  ProviderId,
  ReasoningConfig,
  TextVerbosity,
} from "@agentic/contracts";
import type { z } from "zod";
import type {
  AgentContext,
  AgentKind,
  AgentResult,
  ToolHandlerMap,
} from "./types";
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
  /** Optional provider-neutral reasoning defaults for every invocation. */
  readonly defaultReasoning?: ReasoningConfig;
  readonly defaultVerbosity?: TextVerbosity;
  readonly storeResponses?: boolean;

  /** v1 == 1 single-shot LLM call; future tool-use agents bump this. */
  readonly maxSteps: number = 1;

  /** Inngest concurrency hints when invoked asynchronously. */
  readonly concurrency: { limit: number; key?: string } = { limit: 4 };

  /**
   * P1-RT-07 — optional Zod schema; when set, the run engine validates the
   * model's final text output against it and triggers a one-shot repair turn
   * on parse failure. Generic agents leave this undefined.
   */
  readonly outputSchema?: z.ZodType<unknown>;

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
   * P1-RT-02 — advertised tool catalog. The default implementation returns
   * `[]`. Subclasses override to expose tools to the model.
   */
  getTools(_ctx: AgentContext): ToolDef[] {
    return [];
  }

  /**
   * P1-RT-02 — companion to `getTools()`. The run engine consults this map
   * for the side-effect handler. Missing handlers surface as a tool-side
   * error via `is_error: true` so the model can recover.
   */
  getToolHandlers(_ctx: AgentContext): ToolHandlerMap {
    return {};
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
