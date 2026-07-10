// Shared, pure intent heuristic — STOP detection only. Used by the conductor (server)
// AND the factory chatbot (client), so a "stop" typed in chat is treated identically
// everywhere. No deps, no side effects, safe in both runtimes.
//
// NOTE: this file deliberately holds ONLY stop detection. The old greeting/menu
// classifiers (looksLikeGreetingTemplate / isTrivialGreeting) that drove a no-op
// "force a tool call" guard were removed — that was hardcoded routing deciding FOR the
// model. Whether a message needs a tool is now the model's call, steered by the
// empowering system prompt (see system-prompt.ts).

/** A clear STOP command ("停止" / "停下" / "取消" / "stop" …). Conservative: only a
 *  SHORT message counts (a long sentence isn't a bare stop), and explicit negations
 *  ("不要停" / "别停" / "继续" / "don't stop") are excluded so "不要停止生成" ≠ stop. */
export function isStopIntent(text: string): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t || t.length > 16) return false;
  if (/继续|不要停|别停|甭停|don'?t\s*stop|keep going/.test(t)) return false;
  return /停止|停下|停一下|停掉|暂停|取消|别跑|别生成|中止|halt|cancel|abort|^stop\b|\bstop$/.test(t);
}
