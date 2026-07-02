/**
 * @agentic/llm-gateway — public surface.
 *
 * Consumers (apps/api, packages/agents, packages/runtime):
 *   import { LLMGateway, resolveConfig, registerAllProviders } from "@agentic/llm-gateway";
 *   const { gateway: cfg, adapterEnv } = resolveConfig();
 *   const gateway = new LLMGateway(cfg);
 *   registerAllProviders(gateway, adapterEnv);
 *   const response = await gateway.chat({ messages: [...] });
 */

export { LLMGateway } from "./gateway";
export { LLMError, isLLMError, classifyHttpError, type LLMErrorCode } from "./errors";
export { resolveConfig, type ResolvedConfig, type AdapterEnvSlice } from "./config";
export { registerAllProviders } from "./providers/index";
export { redact, redactObject } from "./redact";
// P1-LLM-04 — mock adapter + the test-only id sequencer the adapter exposes.
// Surfaced from the barrel so test code can `import { MockAdapter, _resetMockIdSeq }
// from "@agentic/llm-gateway"` without reaching into adapter paths.
export { MockAdapter, _resetMockIdSeq } from "./adapters/mock";
// P1-CON-01 — adapter helper for collapsing typed content blocks into text.
export { flattenContentToText } from "./types";
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ProviderAdapter,
  ProviderInfo,
  GatewayConfig,
  ProviderId,
  ChatContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ToolDef,
  ToolCall,
} from "./types";

export { setGatewayCallSink, type GatewayCallRecord } from "./gateway";
