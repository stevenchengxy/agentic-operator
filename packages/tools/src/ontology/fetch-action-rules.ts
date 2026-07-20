/**
 * ontology.fetchActionRules — fail-closed runtime rule fetch.
 *
 * The integration is entirely profile-configured: config pins the exact
 * domain/action and names the server-owned environment variables containing
 * the trusted Allmeta origin and credential. No tenant/domain guessing and no
 * fixed ALLMETA_* process variables live in this adapter.
 */

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";
import { readEnvironmentReference } from "../config/env-ref";

type JsonRecord = Record<string, unknown>;

const IDENTIFIER_RE = /^[\p{L}_][\p{L}\p{N}_.:-]{0,127}$/u;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_TIMEOUT_MS = 60_000;
const ALLOWED_CONFIG_KEYS = new Set([
  "base_url_env",
  "api_key_env",
  "domain",
  "action",
  "timeout_ms",
]);
const FORBIDDEN_LITERAL_CONFIG_KEYS = new Set([
  "base_url",
  "url",
  "endpoint",
  "api_key",
  "token",
  "authorization",
]);

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function requiredIdentifier(config: JsonRecord, field: "domain" | "action"): string {
  const value = config[field];
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value.trim())) {
    throw new Error(
      `ontology.fetchActionRules: config.${field} must be an explicit safe identifier; rule gates fail closed`,
    );
  }
  return value.trim();
}

function timeoutMs(config: JsonRecord): number {
  const value = config.timeout_ms;
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_TIMEOUT_MS) {
    throw new Error(
      `ontology.fetchActionRules: config.timeout_ms must be an integer between 1 and ${MAX_TIMEOUT_MS}; rule gates fail closed`,
    );
  }
  return value as number;
}

function trustedOrigin(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "ontology.fetchActionRules: base_url_env does not resolve to a valid absolute URL; rule gates fail closed",
    );
  }
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username ||
    url.password ||
    !new Set(["", "/"]).has(url.pathname) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "ontology.fetchActionRules: Allmeta URL must be an http(s) origin without credentials, path, query, or fragment; rule gates fail closed",
    );
  }
  return new URL(url.origin);
}

function environmentValue(
  env: Record<string, string | undefined>,
  reference: unknown,
  field: string,
): string {
  try {
    return readEnvironmentReference(env, reference, field);
  } catch (error) {
    throw new Error(
      `ontology.fetchActionRules: ${field} is invalid, unset, or empty; rule gates fail closed`,
      { cause: error },
    );
  }
}

function ruleIdentity(rule: JsonRecord): string {
  const value = rule.id ?? rule.uid ?? rule.name;
  return typeof value === "string" && value.trim() ? value.trim() : "(unknown)";
}

/** Only the canonical structured enum is accepted. Unknown/missing values are
 * malformed ontology data and fail the entire gate closed; silently dropping
 * them could hide an Agent rule. */
export function ruleExecutor(rule: JsonRecord): "Agent" | "Human" {
  if (rule.executor === "Agent" || rule.executor === "Human") return rule.executor;
  throw new Error(
    `Allmeta rule '${ruleIdentity(rule)}' has invalid or missing executor; expected Agent or Human`,
  );
}

/** Mandatory is accepted only from an explicit canonical enforcement enum or
 * a schema-explicit boolean. Unknown/missing values fail closed instead of
 * being silently downgraded to optional. */
export function ruleIsMandatory(rule: JsonRecord): boolean {
  if (rule.enforcementLevel === "mandatory") return true;
  if (rule.enforcementLevel === "optional") return false;
  if (typeof rule.mandatory === "boolean") return rule.mandatory;
  throw new Error(
    `Allmeta rule '${ruleIdentity(rule)}' has invalid or missing enforcementLevel; expected mandatory or optional`,
  );
}

function errorDetail(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 240);
  return String(error).slice(0, 240);
}

export const fetchActionRules = defineTool({
  name: "ontology.fetchActionRules",
  description:
    "Fetch the explicitly profile-bound ontology action's canonical executor=Agent rules. Requires env-referenced Allmeta origin/key plus exact domain/action config; returns { rules, mandatory, count } and fails closed on any integration error.",
  output: z.object({
    rules: z.array(z.any()),
    mandatory: z.array(z.any()),
    count: z.number(),
    source: z.string(),
  }),
  async handler(ctx) {
    const config = asRecord(ctx.config) ?? {};
    for (const key of Object.keys(config)) {
      if (FORBIDDEN_LITERAL_CONFIG_KEYS.has(key)) {
        throw new Error(
          `ontology.fetchActionRules: literal config '${key}' is forbidden; use base_url_env/api_key_env; rule gates fail closed`,
        );
      }
      if (!ALLOWED_CONFIG_KEYS.has(key)) {
        throw new Error(
          `ontology.fetchActionRules: unknown config '${key}' is rejected; rule gates fail closed`,
        );
      }
    }

    const domain = requiredIdentifier(config, "domain");
    const action = requiredIdentifier(config, "action");
    const currentAction = ctx.ontologyActionName?.trim() ?? "";
    if (!currentAction || currentAction !== action) {
      throw new Error(
        `ontology.fetchActionRules: current ontology action '${currentAction || "(missing)"}' does not match profile action '${action}'; rule gates fail closed`,
      );
    }

    const base = trustedOrigin(environmentValue(
      process.env,
      config.base_url_env,
      "config.base_url_env",
    ));
    const key = environmentValue(
      process.env,
      config.api_key_env,
      "config.api_key_env",
    );
    const requestTimeoutMs = timeoutMs(config);
    const signal = AbortSignal.timeout(requestTimeoutMs);
    try {
      const url = new URL(
        `/api/v1/ontology/actions/${encodeURIComponent(action)}/rules`,
        base,
      );
      url.searchParams.set("domain", domain);
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          accept: "application/json",
        },
        cache: "no-store",
        redirect: "manual",
        signal,
      });
      if (!response.ok) {
        throw new Error(
          `规则抓取失败（Allmeta HTTP ${response.status}）——规则闸必须 fail-close，禁止按零规则放行`,
        );
      }
      const body = (await response.json().catch(() => null)) as { rules?: unknown[] } | null;
      if (!body || !Array.isArray(body.rules)) {
        throw new Error("Allmeta returned malformed JSON without a rules array");
      }
      const all = body.rules.map((value, index) => {
        const rule = asRecord(value);
        if (!rule) throw new Error(`Allmeta returned a non-object rule at rules[${index}]`);
        return rule;
      });
      // Validate every rule before filtering. A malformed Human row is still
      // an invalid ontology response and must not be hidden by executor order.
      const classified = all.map((rule) => ({
        rule,
        executor: ruleExecutor(rule),
        mandatory: ruleIsMandatory(rule),
      }));
      const agentRules = classified
        .filter((entry) => entry.executor === "Agent")
        .map((entry) => entry.rule);
      const mandatory = classified
        .filter((entry) => entry.executor === "Agent" && entry.mandatory)
        .map((entry) => entry.rule);
      return {
        data: {
          rules: agentRules,
          mandatory,
          count: agentRules.length,
          source: "allmeta",
        },
        meta: { action, domain, total: all.length },
      };
    } catch (error) {
      const detail = signal.aborted
        ? `Allmeta request timed out after ${requestTimeoutMs}ms`
        : errorDetail(error);
      throw new Error(
        `ontology.fetchActionRules failed (${detail}); rule gates fail closed and must not treat this as zero rules`,
        { cause: error },
      );
    }
  },
});
