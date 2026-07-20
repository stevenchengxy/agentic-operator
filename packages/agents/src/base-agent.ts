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
import type { ZodType } from "zod";
import type {
  AgentContext,
  AgentKind,
  AgentRunScope,
  AgentScope,
  AgentResult,
  ToolHandlerMap,
} from "./types";
import { executeAgentRun } from "./run-engine";

export abstract class BaseAgent<TInput = unknown, TOutput = string> {
  abstract readonly name: string;
  abstract readonly description: string;

  readonly kind: AgentKind = "code";
  readonly enabled: boolean = true;

  /**
   * Ownership of the code definition. System utilities are persisted once
   * under `__system` and may write caller-tenant run rows without materializing
   * themselves inside every business-domain catalog.
   */
  readonly scope: AgentScope = "tenant";

  /**
   * Run ownership is deliberately separate from definition ownership. A
   * system definition may still process tenant data and therefore write its
   * run under the caller tenant (reasoning/report), while operator-only
   * utilities can keep runs under their system owner (testAgent).
   */
  readonly runScope: AgentRunScope = "caller";

  /**
   * Explicit opt-in for a durable Inngest consumer. Most code agents are
   * direct/nested runtime capabilities; registering one in the code registry
   * alone must not silently turn it into a deployable Inngest function.
   */
  readonly inngestEnabled: boolean = false;

  /** Optional default provider override. Falls back to gateway default. */
  readonly defaultProvider?: ProviderId;
  /** Optional default model override. Falls back to gateway default. */
  readonly defaultModel?: string;
  /** Optional hard output ceiling for budget reservation and provider calls.
   * Agents with predictably short output should set this instead of reserving
   * the model catalog's entire maximum response on every retry attempt. */
  readonly maxOutputTokens?: number;
  /** Task-routing category used by the tenant AI settings policy. */
  readonly taskClass: string = "tool.loop";
  /** Optional provider-neutral reasoning defaults for every invocation. */
  readonly defaultReasoning?: ReasoningConfig;
  readonly defaultVerbosity?: TextVerbosity;
  readonly storeResponses?: boolean;

  /** Maximum provider turns in the tool-use loop (repair is one extra turn). */
  readonly maxSteps: number = 1;

  /** Inngest concurrency hints when `inngestEnabled` is explicitly true. */
  readonly concurrency: { limit: number; key?: string } = { limit: 4 };

  /**
   * Optional structured-output contract. The run engine validates the final
   * JSON value and performs one separately persisted repair turn on failure.
   */
  readonly outputSchema?: ZodType<TOutput>;

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

  /** Tool definitions advertised to the selected real provider. */
  getTools(_ctx: AgentContext): ToolDef[] {
    return [];
  }

  /**
   * Local dispatch handlers for advertised tools. Missing/unadvertised calls
   * are returned to the model as tool errors and are never executed.
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
  async _buildMessages(
    input: TInput,
    ctx: AgentContext,
  ): Promise<ChatMessage[]> {
    return this.buildMessages(input, ctx);
  }

  async _parseOutput(text: string, ctx: AgentContext): Promise<TOutput> {
    return this.parseOutput(text, ctx);
  }

  /** Decode a previously accepted final response during idempotent recovery. */
  async _parsePersistedOutput(
    text: string,
    ctx: AgentContext,
  ): Promise<TOutput> {
    if (!this.outputSchema) return this.parseOutput(text, ctx);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new TypeError("Persisted structured output is not valid JSON", {
        cause: error,
      });
    }
    const parsed = this.outputSchema.safeParse(value);
    if (!parsed.success) {
      throw new TypeError(
        `Persisted structured output no longer matches its schema: ${JSON.stringify(parsed.error.issues)}`,
      );
    }
    return parsed.data;
  }
}
