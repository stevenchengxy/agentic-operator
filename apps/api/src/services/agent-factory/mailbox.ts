// In-process HITL mailbox: messages a human injects into a running brain via
// POST /v1/agent-factory/inject are queued by conversationId and drained by the
// conductor at the next turn boundary (ConversationStore.drainHumanMessages).
// In-process is correct for the single-API-process dev model; a multi-process
// deployment would back this with Redis/PG NOTIFY (same push/drain contract).

const boxes = new Map<string, string[]>();

export function pushHumanMessage(conversationId: string, text: string): void {
  if (!conversationId || !text.trim()) return;
  const box = boxes.get(conversationId) ?? [];
  box.push(text.trim());
  boxes.set(conversationId, box);
}

export function drainHumanMessages(conversationId: string): string[] {
  const box = boxes.get(conversationId);
  if (!box || !box.length) return [];
  boxes.set(conversationId, []);
  return box;
}

export function disposeMailbox(conversationId: string): void {
  boxes.delete(conversationId);
}
