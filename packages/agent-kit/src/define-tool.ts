/**
 * `defineTool` — typed builder for tenant-specific tools.
 *
 * Example:
 * ```ts
 * import { defineTool } from "@agentic/agent-kit";
 * import { z } from "zod";
 *
 * export const loadEvaluatedCandidates = defineTool({
 *   name: "loadEvaluatedCandidates",
 *   output: z.object({
 *     candidates: z.array(z.object({ candidate_id: z.string() })),
 *   }),
 *   async handler(ctx) {
 *     // ctx.event.data has the trigger payload
 *     // ctx.subject is the subject id
 *     return { data: { candidates: [] } };
 *   },
 * });
 * ```
 *
 * The returned descriptor is a plain object — no decorators, no DI. The
 * runtime picks it up via the tenant registry's `tools` map (keyed by name).
 */

import type { z } from "zod";
import type {
  ToolContext,
  ToolDescriptor,
  ToolFactoryMetadata,
  ToolResult,
  ToolWriteProbeLifecycle,
} from "./types";

export interface DefineToolInput<TOutput> {
  name: string;
  description?: string;
  output?: z.ZodType<TOutput>;
  factory?: ToolFactoryMetadata;
  factoryWriteProbeLifecycle?: ToolWriteProbeLifecycle;
  handler(ctx: ToolContext): Promise<ToolResult<TOutput>>;
}

export function defineTool<TOutput>(
  input: DefineToolInput<TOutput>,
): ToolDescriptor<TOutput> {
  return {
    kind: "tool",
    name: input.name,
    description: input.description,
    output: input.output,
    ...(input.factory ? { factory: input.factory } : {}),
    ...(input.factoryWriteProbeLifecycle
      ? { factoryWriteProbeLifecycle: input.factoryWriteProbeLifecycle }
      : {}),
    handler: input.handler,
  };
}
