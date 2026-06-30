/**
 * P3-RT-01/02 — Scheduled triggers.
 *
 * Walks a tenant's manifest looking for agents that declare a `cron`
 * expression, and registers ONE Inngest scheduled function per
 * (tenant, agent) that emits the agent's normal trigger event whenever
 * the cron fires.
 *
 * DESIGN §7.2 specifies the on-fire shape: the scheduler emits
 * `${tenantSlug}/__schedule.${agentName}` and the agent's main function
 * listens for that synthetic event in addition to its declared
 * `trigger[]`. To keep the integration with `register.ts` simple — which
 * already accepts an arbitrary list of trigger event names — the scheduler
 * sends the scheduled event under the agent's first declared
 * `trigger` entry when one is present, OR under a synthetic
 * `__schedule.${agentName}` event that the registrar (caller) is expected
 * to include in the agent's `trigger[]`.
 *
 * Implementation choice: for the lowest-friction path with the current
 * `registerAgent`, we tee the cron into the agent's existing event by
 * calling `inngest.send` from the cron function. That means an
 * already-bootstrapped agent picks up cron fires for free, without
 * touching `trigger[]` or `register.ts`.
 *
 * For agents with NO `trigger[]` (pure-schedule entries), we emit the
 * canonical `${tenantSlug}/__schedule.${agentName}` event and require the
 * agent's manifest to declare that event name in `trigger[]`.
 */

import { getTenantInngest } from "./client";
import type { AgentSpec } from "./manifest";
import type { InngestFunction } from "inngest";

export interface CronTriggerResult {
  /** Inngest functions newly registered for this tenant's cron-enabled agents. */
  functions: InngestFunction.Any[];
  /** Number of agents that declared a `cron` expression. */
  cronAgents: number;
  /** Number of agents whose cron expression was rejected as malformed. */
  invalidCron: number;
}

/**
 * Quick syntactic sanity check on a 5-field cron expression. We're not
 * trying to fully parse the cron — Inngest will reject malformed values
 * at registration time — but catching obvious typos here gives a clearer
 * error than an opaque Inngest failure.
 *
 * Accepts: `* * * * *`, `0 2 * * *`, `*\/5 * * * *`, names like `@every 5m`,
 * `@hourly`, `@daily`. Any 5-token field that survives the split is treated
 * as valid; Inngest is the source of truth.
 */
function looksLikeCron(s: string): boolean {
  const v = s.trim();
  if (v.length === 0) return false;
  if (v.startsWith("@")) return true; // @hourly / @daily / @every 5m
  const tokens = v.split(/\s+/);
  // Inngest accepts 5- and 6-token cron (latter with seconds). Be liberal.
  return tokens.length >= 5 && tokens.length <= 6;
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
): InngestFunction.Any {
  const id = `${tenantSlug}.${agent.name}.__cron`;
  const cronExpr =
    tz && tz.trim() !== "" ? `TZ=${tz.trim()} ${cron.trim()}` : cron.trim();

  // Pick the emit target: first declared trigger, else synthetic schedule event.
  const triggerName =
    (agent.trigger?.[0] ?? "").trim() !== ""
      ? agent.trigger[0]!
      : `__schedule.${agent.name}`;

  // Per-tenant app: the cron function lives on the tenant's own app and emits
  // `${slug}/${triggerName}` onto the tenant client below, so it reaches the
  // tenant's agent functions (same app + same namespaced event).
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
        name: `${tenantSlug}/${triggerName}` as `${string}/${string}`,
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
 * Validation: a malformed cron is logged + skipped (no throw) so a single
 * bad manifest entry doesn't take down the whole tenant's schedule fanout.
 */
export function registerCronTriggers(spec: {
  tenantSlug: string;
  manifest: readonly AgentSpec[];
}): CronTriggerResult {
  const fns: InngestFunction.Any[] = [];
  let cronAgents = 0;
  let invalidCron = 0;
  for (const a of spec.manifest) {
    // The manifest schema's `passthrough()` lets unknown fields survive,
    // so we read `cron` + `cron_timezone` off the agent without forcing
    // them through `AgentSchema` (which still parses fine when they're
    // absent).
    const cron = readStringField(a as unknown as Record<string, unknown>, "cron");
    const tz = readStringField(
      a as unknown as Record<string, unknown>,
      "cron_timezone",
    );
    if (cron === undefined) continue;
    cronAgents++;
    if (!looksLikeCron(cron)) {
      invalidCron++;
      console.warn(
        `[scheduler] ${spec.tenantSlug}.${a.name}: malformed cron "${cron}" — skipped`,
      );
      continue;
    }
    fns.push(buildCronFn(spec.tenantSlug, a, cron, tz));
  }
  return { functions: fns, cronAgents, invalidCron };
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
