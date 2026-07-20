/** Headers that correlate one billable product interaction with its API/LLM work. */
export function usageAttributionHeaders(
  productSurface: string,
): Record<string, string> {
  const interactionId =
    globalThis.crypto?.randomUUID?.() ??
    `int-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    "X-Agentic-Product-Surface": productSurface,
    "X-Agentic-Interaction-Id": interactionId,
  };
}
