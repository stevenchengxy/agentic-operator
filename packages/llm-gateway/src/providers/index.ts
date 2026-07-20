/**
 * Provider registry — single function that registers every provider on a
 * gateway instance. Called once at gateway construction.
 *
 * Each provider wiring file is responsible for building its adapter from
 * env. The registry just iterates and calls registerProvider().
 */

import type { LLMGateway } from "../gateway";
import type { AdapterEnvSlice } from "../config";
import { makeMock } from "./mock";
import { makeAnthropic } from "./anthropic";
import { makeOpenAI } from "./openai";
import { makeOpenRouter } from "./openrouter";
import { makeGemini } from "./gemini";
import { makeGroq } from "./groq";
import { makeTogether } from "./together";
import { makeMistral } from "./mistral";
import { makeDeepSeek } from "./deepseek";
import { makeQwen } from "./qwen";
import { makeAzure } from "./azure";
import { makeCustom } from "./custom";
import { makeMoonshot } from "./moonshot";
import { makeZai } from "./zai";

export function registerAllProviders(
  gateway: LLMGateway,
  env: AdapterEnvSlice,
): void {
  // The deterministic echo adapter is test-only. Do not even expose it in
  // listProviders() for a real process; that prevents per-request overrides
  // from turning an otherwise real gateway into a synthetic one.
  if (gateway.allowMock) gateway.registerProvider(makeMock());
  gateway.registerProvider(makeAnthropic(env));
  gateway.registerProvider(makeOpenAI(env));
  gateway.registerProvider(makeOpenRouter(env));
  gateway.registerProvider(makeGemini(env));
  gateway.registerProvider(makeGroq(env));
  gateway.registerProvider(makeTogether(env));
  gateway.registerProvider(makeMistral(env));
  gateway.registerProvider(makeDeepSeek(env));
  gateway.registerProvider(makeMoonshot(env));
  gateway.registerProvider(makeZai(env));
  gateway.registerProvider(makeQwen(env));
  gateway.registerProvider(makeAzure(env));
  gateway.registerProvider(makeCustom(env));
}
