/**
 * Resolve the autonomous Factory brain's whole-session token backstop.
 *
 * 默认【不限】(null)。用户 2026-07-02 就此明确拍过板：「token 预算取消」「别再加回 token cap
 * 当护栏」——老仓库据此把 conductor.MAX_TOKENS 600k→null、stream-gateway 的 max_tokens 也去掉了。
 * 新 monorepo 迁移时又带回了一个 500k 生产默认，等于把那次决定悄悄推翻。
 *
 * 为什么它比"到点停机"更有害：这个数不只是熔断，它还【在逼近时静默降智】——
 *   · context-budget.planProviderCall 按 remaining 压 completionTokenCap → 越接近上限每轮输出越短，
 *     AI 恰在最需要长推理时被截；
 *   · select_strategy 在 remaining 低时把 maxLlmCalls 从 10 砍到 2 → AI 自己声明的
 *     tot→debate→reflection 组合跑不完，而它无从知道为什么。
 * 也就是说这个 cap 会让"真能自我推理"这件事在长会话里悄悄退化，且不可观测。
 *
 * 现在：默认 null（与 test 一致）。要熔断的部署【显式】设 FACTORY_BRAIN_MAX_SESSION_TOKENS。
 * 无人值守的失控由 MAX_TURNS(FACTORY_MAX_TURNS，默认 200) 与 maxSpawns 这类【纯循环闸】兜底——
 * 它们限制的是"跑多少轮"，不会篡改单轮的推理深度。
 */
type FactorySessionBudgetEnv = Partial<
  Pick<NodeJS.ProcessEnv, "FACTORY_BRAIN_MAX_SESSION_TOKENS" | "NODE_ENV">
>;

export function resolveFactorySessionTokenLimit(
  env: FactorySessionBudgetEnv = process.env,
): number | null {
  const raw = env.FACTORY_BRAIN_MAX_SESSION_TOKENS?.trim();
  if (!raw) return null; // 不限——要限就显式配 env（见上方注释）
  void env.NODE_ENV;
  if (raw === "0") return null;
  if (!/^\d+$/.test(raw)) {
    throw new Error("FACTORY_BRAIN_MAX_SESSION_TOKENS must be a positive integer or 0");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("FACTORY_BRAIN_MAX_SESSION_TOKENS must be a positive safe integer or 0");
  }
  return parsed;
}
