// In-process HITL mailbox: messages a human injects into a running brain via
// POST /v1/agent-factory/inject are queued by conversationId and drained by the
// conductor at the next turn boundary (ConversationStore.drainHumanMessages).
// In-process is correct for the single-API-process dev model; a multi-process
// deployment would back this with Redis/PG NOTIFY (same push/drain contract).
//
// Hardened for the ops-sidebar HITL surface: entries carry timestamps, each
// conversation's queue is capped (oldest dropped first — the user's LATEST
// intervention is the authoritative one), and `peekHumanMessages` lets the UI
// show "N 条介入待大脑读取" without consuming the queue.

interface QueuedMsg {
  text: string;
  ts: number;
}

interface Box {
  msgs: QueuedMsg[];
  /** Tenant that owns this conversation (recorded at push). Peek is refused across tenants. */
  tenantId?: string;
}

const boxes = new Map<string, Box>();

/** Per-conversation queue cap — far above real usage; guards inject spam. */
const MAX_QUEUE = 200;

export function pushHumanMessage(conversationId: string, text: string, tenantId?: string): void {
  if (!conversationId || !text.trim()) return;
  const box = boxes.get(conversationId) ?? { msgs: [] };
  box.msgs.push({ text: text.trim(), ts: Date.now() });
  while (box.msgs.length > MAX_QUEUE) box.msgs.shift();
  if (tenantId && !box.tenantId) box.tenantId = tenantId;
  boxes.set(conversationId, box);
}

export function drainHumanMessages(conversationId: string): string[] {
  const box = boxes.get(conversationId);
  if (!box || !box.msgs.length) return [];
  const texts = box.msgs.map((m) => m.text);
  box.msgs = [];
  return texts;
}

/** Non-consuming look at the queue — drives the sidebar's "待大脑读取" hint. A caller
 *  with a tenant context only sees its OWN conversations (guessed foreign ids read as empty). */
export function peekHumanMessages(conversationId: string, tenantId?: string): { pending: number; oldestTs: number | null } {
  const box = boxes.get(conversationId);
  if (!box || !box.msgs.length) return { pending: 0, oldestTs: null };
  if (tenantId && box.tenantId && box.tenantId !== tenantId) return { pending: 0, oldestTs: null };
  return { pending: box.msgs.length, oldestTs: box.msgs[0]!.ts };
}

export function disposeMailbox(conversationId: string): void {
  boxes.delete(conversationId);
}
