/**
 * P3-RT-01/02 — Scheduled triggers.
 *
 * Walks a tenant's manifest looking for agents that declare a `cron`
 * expression, and registers ONE Inngest scheduled function per
 * (tenant, agent) that emits the agent's normal trigger event whenever
 * the cron fires.
 *
 * DESIGN §7.2 specifies the canonical on-fire event
 * `__schedule.${agentName}`. Scheduler and consumer project it through the
 * same tenant adapter (normally `${tenantSlug}/__schedule.${agentName}`), and
 * the agent's main function listens for that synthetic event in addition to its declared
 * `trigger[]`. To keep the integration with `register.ts` simple — which
 * already accepts an arbitrary list of trigger event names — the scheduler
 * sends the scheduled event under the agent's first declared
 * `trigger` entry when one is present, OR under a synthetic
 * `__schedule.${agentName}` event that registerAgent automatically consumes.
 *
 * Implementation choice: for the lowest-friction path with the current
 * `registerAgent`, we tee the cron into the agent's existing event by
 * calling `inngest.send` from the cron function. That means an
 * already-bootstrapped agent picks up cron fires for free, without
 * touching `trigger[]` or `register.ts`.
 *
 * For agents with NO `trigger[]` (pure-schedule entries), we emit canonical
 * `__schedule.${agentName}` through the tenant wire adapter. registerAgent
 * subscribes to the exact same projected name automatically.
 */

import { getTenantInngest } from "./client";
import { scheduledAgentTriggerName, tenantEventName } from "./event-name";
import type { AgentSpec } from "./manifest";
import type { TenantEventAdapter } from "@agentic/agent-kit";
import type { InngestFunction } from "inngest";

export interface CronTriggerResult {
  /** Inngest functions newly registered for this tenant's cron-enabled agents. */
  functions: InngestFunction.Any[];
  /** Number of agents that declared a `cron` expression. */
  cronAgents: number;
  /** Number of agents whose cron expression was rejected as malformed. */
  invalidCron: number;
  /** Agents that explicitly declare either `cron` or `cron_env`. */
  declaredAgents: number;
  /** Env-backed schedules whose required env value is absent. */
  unconfiguredAgents: string[];
  /** Env-backed schedules explicitly disabled with `off` or `disabled`. */
  disabledAgents: string[];
}

export interface RuntimeScheduleHealth {
  ok: boolean;
  configured: number;
  disabled: number;
  unconfigured: number;
  configuredAgents: string[];
  disabledAgents: string[];
  unconfiguredAgents: string[];
}

type ResolvedSchedule =
  | {
      state: "configured";
      cron: string;
      timezone?: string;
      cronEnv?: string;
      timezoneEnv?: string;
    }
  | {
      state: "disabled";
      cronEnv?: string;
      timezoneEnv?: string;
    }
  | {
      state: "unconfigured";
      cronEnv?: string;
      timezoneEnv?: string;
    };

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DISABLED_SCHEDULE = /^(?:off|disabled)$/i;
const runtimeScheduleStates = new Map<
  string,
  { tenantSlug: string; agentName: string; state: ResolvedSchedule["state"] }
>();

function scheduleStatusKey(tenantSlug: string, agentName: string): string {
  return `${tenantSlug}\u0000${agentName}`;
}

export function clearRuntimeScheduleStatusForTenant(tenantSlug: string): void {
  for (const [key, status] of runtimeScheduleStates) {
    if (status.tenantSlug === tenantSlug) runtimeScheduleStates.delete(key);
  }
}

/** Process-local readiness evidence populated by manifest bootstrap. */
export function runtimeScheduleHealth(): RuntimeScheduleHealth {
  const entries = [...runtimeScheduleStates.values()].sort((a, b) =>
    `${a.tenantSlug}.${a.agentName}`.localeCompare(
      `${b.tenantSlug}.${b.agentName}`,
    ),
  );
  const names = (state: ResolvedSchedule["state"]) =>
    entries
      .filter((entry) => entry.state === state)
      .map((entry) => `${entry.tenantSlug}.${entry.agentName}`);
  const configuredAgents = names("configured");
  const disabledAgents = names("disabled");
  const unconfiguredAgents = names("unconfigured");
  return {
    ok: unconfiguredAgents.length === 0,
    configured: configuredAgents.length,
    disabled: disabledAgents.length,
    unconfigured: unconfiguredAgents.length,
    configuredAgents,
    disabledAgents,
    unconfiguredAgents,
  };
}

/** Test isolation only. */
export function __resetRuntimeScheduleHealthForTests(): void {
  runtimeScheduleStates.clear();
}

/** A schedule declared by a live manifest is runtime configuration, not an
 * optional enhancement.  If it cannot be registered, boot must fail instead
 * of leaving the API healthy while that agent silently never fires. */
export class InvalidCronExpressionError extends Error {
  readonly tenantSlug: string;
  readonly agentName: string;
  readonly expression: string;

  constructor(tenantSlug: string, agentName: string, expression: string, reason: string) {
    super(
      `[scheduler] ${tenantSlug}.${agentName}: invalid cron ${JSON.stringify(expression)} — ${reason}`,
    );
    this.name = "InvalidCronExpressionError";
    this.tenantSlug = tenantSlug;
    this.agentName = agentName;
    this.expression = expression;
  }
}

function resolveSchedule(
  tenantSlug: string,
  agent: AgentSpec,
  env: Record<string, string | undefined>,
): ResolvedSchedule | null {
  const raw = agent as unknown as Record<string, unknown>;
  const literalCron = readStringField(raw, "cron");
  const cronEnv = readStringField(raw, "cron_env");
  const literalTimezone = readStringField(raw, "cron_timezone");
  const timezoneEnv = readStringField(raw, "cron_timezone_env");
  if (!literalCron && !cronEnv) {
    if (literalTimezone || timezoneEnv) {
      throw new InvalidCronExpressionError(
        tenantSlug,
        agent.name,
        literalTimezone ?? `$${timezoneEnv}`,
        "cron timezone requires cron or cron_env",
      );
    }
    return null;
  }
  if (literalCron && cronEnv) {
    throw new InvalidCronExpressionError(
      tenantSlug,
      agent.name,
      literalCron,
      "declare exactly one of cron or cron_env",
    );
  }
  if (literalTimezone && timezoneEnv) {
    throw new InvalidCronExpressionError(
      tenantSlug,
      agent.name,
      literalCron ?? `$${cronEnv}`,
      "declare exactly one of cron_timezone or cron_timezone_env",
    );
  }
  if (cronEnv && !ENV_NAME.test(cronEnv)) {
    throw new InvalidCronExpressionError(
      tenantSlug,
      agent.name,
      `$${cronEnv}`,
      "cron_env must name an environment variable",
    );
  }
  if (timezoneEnv && !ENV_NAME.test(timezoneEnv)) {
    throw new InvalidCronExpressionError(
      tenantSlug,
      agent.name,
      literalCron ?? `$${cronEnv}`,
      "cron_timezone_env must name an environment variable",
    );
  }

  const configuredCron = cronEnv ? env[cronEnv]?.trim() : literalCron;
  if (!configuredCron) {
    return { state: "unconfigured", ...(cronEnv ? { cronEnv } : {}) };
  }
  if (cronEnv && DISABLED_SCHEDULE.test(configuredCron)) {
    return {
      state: "disabled",
      ...(cronEnv ? { cronEnv } : {}),
      ...(timezoneEnv ? { timezoneEnv } : {}),
    };
  }
  const configuredTimezone = timezoneEnv
    ? env[timezoneEnv]?.trim()
    : literalTimezone;
  if (timezoneEnv && !configuredTimezone) {
    return { state: "unconfigured", cronEnv, timezoneEnv };
  }
  return {
    state: "configured",
    cron: configuredCron,
    ...(configuredTimezone ? { timezone: configuredTimezone } : {}),
    ...(cronEnv ? { cronEnv } : {}),
    ...(timezoneEnv ? { timezoneEnv } : {}),
  };
}

/**
 * Strict syntactic sanity check on a 5- or 6-field cron expression. Named
 * aliases supported by standard cron are accepted; non-standard prose such
 * as `@every 5m` is rejected rather than being registered as a dead schedule.
 * Inngest remains the source of truth for advanced cron semantics.
 */
export function validateCronExpression(s: string): { valid: true } | { valid: false; reason: string } {
  const v = s.trim();
  if (v.length === 0) return { valid: false, reason: "expression is empty" };
  if (/^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/i.test(v)) {
    return { valid: true };
  }
  if (v.startsWith("@")) {
    return { valid: false, reason: "unsupported named schedule alias" };
  }
  const tokens = v.split(/\s+/);
  // Inngest accepts 5- and 6-token cron (latter with seconds).
  if (tokens.length !== 5 && tokens.length !== 6) {
    return { valid: false, reason: `expected 5 or 6 fields, received ${tokens.length}` };
  }

  // Reject prose and other values which merely happen to contain five words.
  // Full schedule semantics remain Inngest's responsibility, but every field
  // must at least be composed of cron operators, numbers, or month/day names.
  const field = /^(?:[0-9*?/,#LW-]+|(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT)(?:[-,/](?:[A-Z]{3}|\d+))*)$/i;
  const invalidAt = tokens.findIndex((token) => !field.test(token));
  if (invalidAt >= 0) {
    return { valid: false, reason: `field ${invalidAt + 1} contains unsupported cron syntax` };
  }
  return { valid: true };
}

function validateTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Build one Inngest scheduled function for an agent with `cron`. The
 * function fires on the cron and emits the agent's first declared event
 * (so register.ts wakes up via its existing trigger), OR a canonical
 * `__schedule.${agentName}` event for agents that have no other triggers.
 *
 * `cron_timezone` (per DESIGN §7.2) is passed through to Inngest's cron
 * field as a TZ-prefixed cron — Inngest v4 accepts `TZ=America/New_York 0 9 * * *`.
 */
function buildCronFn(
  tenantSlug: string,
  agent: AgentSpec,
  cron: string,
  tz: string | undefined,
  eventAdapter: TenantEventAdapter | undefined,
): InngestFunction.Any {
  const id = `${tenantSlug}.${agent.name}.__cron`;
  const cronExpr =
    tz && tz.trim() !== "" ? `TZ=${tz.trim()} ${cron.trim()}` : cron.trim();

  // Pick the emit target: first declared trigger, else synthetic schedule event.
  const triggerName =
    (agent.trigger?.[0] ?? "").trim() !== ""
      ? agent.trigger[0]!
      : scheduledAgentTriggerName(agent.name);

  // Per-tenant app: the cron producer and consumer use the exact same explicit
  // tenant adapter, so default namespaced and tenant-owned legacy wire names
  // cannot drift apart during bootstrap.
  return getTenantInngest(tenantSlug).createFunction(
    {
      id,
      name: `Cron: ${agent.title ?? agent.name}`,
      triggers: [{ cron: cronExpr }],
    },
    async ({ step }) => {
      // Inngest replays this handler; wrap the send so the event id is
      // memoized per-tick. The downstream agent function will pick up
      // exactly-once via Inngest's idempotency.
      await step.sendEvent("emit", {
        name: tenantEventName(
          tenantSlug,
          triggerName,
          eventAdapter,
        ) as `${string}/${string}`,
        data: {
          __scheduledAt: Date.now(),
          __scheduledAgent: agent.name,
          __scheduledCron: cronExpr,
        },
      });
      return { ok: true, emitted: triggerName, at: Date.now() };
    },
  );
}

/**
 * For each agent in `manifest` that declares `cron`, return a registered
 * Inngest function. Agents WITHOUT `cron` are ignored — caller still
 * registers them via `registerAgent()`.
 *
 * Validation is fail-fast. A malformed schedule means the declared runtime
 * behaviour cannot exist, so returning a partial function set would be a
 * false-healthy boot.
 */
export function registerCronTriggers(spec: {
  tenantSlug: string;
  manifest: readonly AgentSpec[];
  env?: Record<string, string | undefined>;
  eventAdapter?: TenantEventAdapter;
}): CronTriggerResult {
  const env = spec.env ?? process.env;
  assertCronManifestValid({ ...spec, env });
  const fns: InngestFunction.Any[] = [];
  let cronAgents = 0;
  let invalidCron = 0;
  let declaredAgents = 0;
  const unconfiguredAgents: string[] = [];
  const disabledAgents: string[] = [];
  clearRuntimeScheduleStatusForTenant(spec.tenantSlug);
  for (const a of spec.manifest) {
    const schedule = resolveSchedule(spec.tenantSlug, a, env);
    if (!schedule) continue;
    declaredAgents++;
    runtimeScheduleStates.set(scheduleStatusKey(spec.tenantSlug, a.name), {
      tenantSlug: spec.tenantSlug,
      agentName: a.name,
      state: schedule.state,
    });
    if (schedule.state === "unconfigured") {
      unconfiguredAgents.push(a.name);
      continue;
    }
    if (schedule.state === "disabled") {
      disabledAgents.push(a.name);
      continue;
    }
    cronAgents++;
    fns.push(
      buildCronFn(
        spec.tenantSlug,
        a,
        schedule.cron,
        schedule.timezone,
        spec.eventAdapter,
      ),
    );
  }
  return {
    functions: fns,
    cronAgents,
    invalidCron,
    declaredAgents,
    unconfiguredAgents,
    disabledAgents,
  };
}

/** Validate schedules without registering functions. Bootstrap calls this
 * before any workflow/deployment writes, then registers only the agents that
 * are currently enabled. */
export function assertCronManifestValid(spec: {
  tenantSlug: string;
  manifest: readonly AgentSpec[];
  env?: Record<string, string | undefined>;
}): void {
  const env = spec.env ?? process.env;
  for (const a of spec.manifest) {
    const schedule = resolveSchedule(spec.tenantSlug, a, env);
    if (!schedule || schedule.state !== "configured") continue;
    const cronValidation = validateCronExpression(schedule.cron);
    if (!cronValidation.valid) {
      throw new InvalidCronExpressionError(
        spec.tenantSlug,
        a.name,
        schedule.cron,
        cronValidation.reason,
      );
    }
    if (schedule.timezone !== undefined && !validateTimeZone(schedule.timezone)) {
      throw new InvalidCronExpressionError(
        spec.tenantSlug,
        a.name,
        schedule.cron,
        `unknown cron timezone ${JSON.stringify(schedule.timezone)}`,
      );
    }
  }
}

function readStringField(
  obj: Record<string, unknown>,
  field: string,
): string | undefined {
  const v = obj[field];
  if (typeof v !== "string") return undefined;
  if (v.trim() === "") return undefined;
  return v;
}
