// Mirror of @agentic/agent-factory's isStopIntent (packages/agent-factory/src/intent.ts).
// Duplicated rather than imported because the web bundle must not pull in the
// server-side agent-factory package. It's a stable, pure heuristic — keep in sync.

/** A clear STOP command ("停止" / "停下" / "取消" / "stop" …). Conservative: only a SHORT
 *  message counts, and negations ("不要停" / "继续" / "don't stop") are excluded. Used to
 *  route a typed "停止" in the factory chat to the real /stop (hard abort) instead of the
 *  advisory inject mailbox, which the brain can ignore. */
export function isStopIntent(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t || t.length > 16) return false;
  if (/继续|不要停|别停|甭停|don'?t\s*stop|keep going/.test(t)) return false;
  return /停止|停下|停一下|停掉|暂停|取消|别跑|别生成|中止|halt|cancel|abort|^stop\b|\bstop$/.test(t);
}
