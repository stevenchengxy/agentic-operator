interface TestAgentRegistration<TAgent> {
  env?: Record<string, string | undefined>;
  create: () => TAgent;
  register: (agent: TAgent) => void;
}

/** Register a harness agent only in an explicit test process. */
export function registerTestAgentForEnvironment<TAgent>({
  env = process.env,
  create,
  register,
}: TestAgentRegistration<TAgent>): boolean {
  if (env.NODE_ENV !== "test") return false;
  register(create());
  return true;
}
