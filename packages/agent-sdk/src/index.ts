export { defineTool, type DefineToolInput } from "./define-tool";
export { definePrompt, type DefinePromptInput } from "./define-prompt";
export type {
  ToolContext,
  ToolResult,
  ToolDescriptor,
  PromptDescriptor,
  TenantRegistry,
} from "./types";
export type {
  MemoryHandle,
  MemoryScope,
  MemoryBinding,
  MemoryDriverRef,
} from "./memory";
export {
  type MemoryDriver,
  type MemoryMirrorRow,
  type MemoryHit,
  type MemorySearchScope,
  NoMemoryDriverError,
} from "./memory-driver";
// #REDESIGN P2 — the power-strip contract both tiers implement.
export {
  type AgentRuntime,
  type UnifiedAgentContract,
  type AgentTier,
  type SpawnResult,
  isAgentRuntime,
} from "./contract";
