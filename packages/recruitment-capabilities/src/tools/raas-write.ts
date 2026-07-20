/**
 * Decision-free statement-catalog write transport for ontology-driven agents.
 *
 * This is the write counterpart of `facts.query`. It deliberately knows
 * nothing about candidate precedence, recruiter ownership, match thresholds,
 * rule enforcement, routing or workflow events. A reviewed integration profile
 * selects a bounded set of named WRITE statements from a server-owned catalog;
 * the caller supplies only the operation name and parameter values. The tool
 * exists so a named ontology database integration has a real,
 * capability-declaring binding without baking that platform's name into the
 * executable tool identity.
 *
 * Business meaning (which entity, which columns, idempotency key) lives in the
 * server-owned statement catalog and the approved Ontology rules, never here.
 */

import { defineTool, type ToolContext } from "@agentic/agent-kit";
import {
  executePostgresStatement,
  type PostgresExecuteOptions,
} from "@agentic/tools/postgres";
import { z } from "zod";

type JsonRecord = Record<string, unknown>;

const OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const ALLOWED_CONFIG_KEYS = new Set([
  "tenant_slug",
  "system_name",
  "connection_url_env",
  "statement_catalog_env",
  "allowed_operations",
  "max_rows",
  "max_values_bytes",
  "timeout_ms",
]);

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`entities.write: ${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(
  value: JsonRecord,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (
    actual.length !== allowed.length ||
    actual.some((key, index) => key !== allowed[index])
  ) {
    throw new Error(
      `entities.write: ${label} must contain exactly ${expected.join(", ")}`,
    );
  }
}

function reviewedConfig(value: unknown): JsonRecord {
  const config = record(value, "config");
  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new Error(
        `entities.write: unknown or unsafe config '${key}' is rejected; use only reviewed environment references`,
      );
    }
  }
  const allowedOperations = config.allowed_operations;
  if (
    !Array.isArray(allowedOperations) ||
    allowedOperations.length === 0 ||
    !allowedOperations.every(
      (operation) =>
        typeof operation === "string" && OPERATION_RE.test(operation),
    ) ||
    new Set(allowedOperations).size !== allowedOperations.length
  ) {
    throw new Error(
      "entities.write: config.allowed_operations must be a non-empty unique list of safe server-catalog write operation names",
    );
  }
  return config;
}

export async function executeEntityWrite(
  argsValue: unknown,
  configValue: unknown,
  options: PostgresExecuteOptions = {},
) {
  const args = record(argsValue, "input");
  exactKeys(args, ["operation", "values"], "input");
  record(args.values, "input.values");
  const config = reviewedConfig(configValue);

  // The generic transport owns connection, catalog resolution, allow-list
  // gating and idempotent parameterised execution. Only the reviewed profile
  // may enable writes; no Action description can request `allow_write`.
  const result = await executePostgresStatement(
    args,
    {
      connection_url_env: config.connection_url_env,
      statement_catalog_env: config.statement_catalog_env,
      allowed_operations: config.allowed_operations,
      allow_write: true,
      ...(config.max_rows === undefined ? {} : { max_rows: config.max_rows }),
      ...(config.max_values_bytes === undefined
        ? {}
        : { max_values_bytes: config.max_values_bytes }),
      ...(config.timeout_ms === undefined
        ? {}
        : { timeout_ms: config.timeout_ms }),
    },
    options,
  );
  if (result.mode !== "write") {
    // A read-only catalog entry reached a write tool. Fail closed rather than
    // silently succeed with no persistence.
    throw new Error(
      `entities.write: server catalog operation '${result.operation}' is not a write statement`,
    );
  }
  return {
    operation: result.operation,
    row_count: result.row_count,
    rows: result.rows,
    source: "postgres-statement-catalog" as const,
  };
}

export const writeEntities = defineTool({
  name: "entities.write",
  description:
    "Persist an ontology-declared business result through a reviewed, server-owned PostgreSQL statement catalog. " +
    "Idempotent by the catalog statement's business key; it never chooses identity precedence, ownership, thresholds, verdicts, routes or events.",
  factory: {
    category: "entity-catalog",
    sideEffect: "write",
    operation: "write",
    effectScope: "external",
    sandboxPolicy: "requires_attempt_grant",
    argsSchema: {
      operation: {
        type: "string",
        required: true,
        description:
          "Exact named write operation allowed by the reviewed integration profile.",
      },
      values: {
        type: "Record<string, JSON value>",
        required: true,
        description:
          "Exact parameter map required by the server-owned statement catalog entry.",
      },
    },
    returnsSchema: {
      operation: { type: "string", required: true },
      row_count: { type: "integer", required: true },
      rows: {
        type: "unknown[]",
        required: true,
        description:
          "Bounded RETURNING rows (e.g. the persisted id). No verdict/route fields are synthesized.",
      },
      source: { type: "string", required: true },
    },
    configSchema: {
      tenant_slug: { type: "string", required: true },
      system_name: {
        type: "string",
        required: true,
        description:
          "Exact Ontology integration.systems[].name represented by this profile.",
      },
      connection_url_env: {
        type: "string",
        required: true,
        description: "Server env reference containing the profile-bound PostgreSQL URL.",
      },
      statement_catalog_env: {
        type: "string",
        required: true,
        description:
          "Server env reference containing the reviewed named-statement catalog.",
      },
      allowed_operations: {
        type: "string[]",
        required: true,
        description:
          "Non-empty action/profile-specific subset of write operations; prose cannot expand it.",
      },
      max_rows: { type: "integer", default: 1000 },
      max_values_bytes: { type: "integer", default: 1048576 },
      timeout_ms: { type: "integer", default: 30000 },
    },
    capabilities: [
      {
        // Explicit wildcard represents a named database only after exact
        // kind/role/profile/probe and operation allow-list validation.
        systems: ["*"],
        systemConfigKey: "system_name",
        kinds: ["database"],
        roles: ["write", "persist"],
        operations: [
          "entity.sync",
          "candidate.save",
          "candidate_match.sync",
          "job_posting.sync",
          "match_result.save",
          "invitation.mark_sent",
          "cmr.write_fail",
          "write",
          "persist",
          "upsert",
        ],
        objectTypes: ["*"],
        probeRequired: true,
      },
    ],
    profileScope: {
      exact: [{ configKey: "tenant_slug", source: "tenantSlug" }],
    },
    // No cleanup/absence adapter is registered here, so a live write probe
    // stays needs_config until a reviewed write-probe lifecycle is supplied.
    // That is the intended human boundary: a real partner-DB write must earn a
    // verified probe before the factory trusts it in a run.
    source: {
      modulePath: "packages/recruitment-capabilities/src/tools/raas-write.ts",
      exportName: "writeEntities",
    },
  },
  output: z.object({
    operation: z.string(),
    row_count: z.number().int().nonnegative(),
    rows: z.array(z.unknown()),
    source: z.literal("postgres-statement-catalog"),
  }),
  async handler(ctx: ToolContext) {
    return {
      data: await executeEntityWrite(ctx.event?.data, ctx.config),
      meta: {
        decision_free: true,
        statement_source: "server-environment-catalog",
      },
    };
  },
});

/** Backward-compatible code exports only. The registered descriptor identity
 * remains the domain-neutral `entities.write`. */
export const executeRaasEntityWrite = executeEntityWrite;
export const writeRaasEntities = writeEntities;
