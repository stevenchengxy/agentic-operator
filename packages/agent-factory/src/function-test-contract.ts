/** Machine-readable assertions for one generated-function execution.
 *
 * The contract deliberately uses a small JSON-only vocabulary so it can be
 * fingerprinted into a regression artifact and executed in every isolation
 * tier. `partial` is a recursive subset match; `equals` is exact JSON value
 * equality. Paths are dotted own-property paths (for example
 * `candidate.id` or `data.interview_url`). */
export type FunctionJsonType =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "object"
  | "array"
  | "null";

export interface FunctionValueAssertion {
  requiredPaths?: string[];
  types?: Record<string, FunctionJsonType>;
  partial?: unknown;
  equals?: unknown;
}

export interface FunctionEmitAssertion {
  event: string;
  /** Exact occurrence count. Omit to require at least one occurrence. */
  count?: number;
  /** Applied to every payload emitted under `event`. */
  payload?: FunctionValueAssertion;
}

export interface FunctionToolCallAssertion {
  tool: string;
  /** Exact invocation count. Omit to require at least one invocation. */
  count?: number;
  /** Applied to every invocation's args. */
  args?: FunctionValueAssertion;
}

export interface FunctionStepResultAssertion {
  stepId: string;
  /** Exact execution count. Omit to require at least one execution. */
  count?: number;
  /** Applied to every recorded result for this durable step id. */
  result?: FunctionValueAssertion;
}

export interface FunctionTestAssertions {
  /** When true, every emitted event must belong to the expected/declared
   * assertion set. This checks the full set instead of merely finding one
   * expected event. */
  exactEmits?: boolean;
  forbiddenEmits?: string[];
  emits?: FunctionEmitAssertion[];
  toolCalls?: FunctionToolCallAssertion[];
  /** Handler return value. */
  result?: FunctionValueAssertion;
  /** Optional state snapshot supplied by the execution adapter (CodeAct
   * regression exposes its in-memory state here). */
  state?: FunctionValueAssertion;
  stepResults?: FunctionStepResultAssertion[];
}
