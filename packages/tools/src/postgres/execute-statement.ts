/**
 * postgres.executeStatement — execute a named, server-owned PostgreSQL
 * statement. The tool call can supply only `{operation, values}`. SQL and the
 * connection URL are loaded from environment variables selected by trusted
 * manifest config; neither may be provided by an LLM.
 */

import { createHash } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import {
  defineTool,
  type ToolContext,
  type ToolWriteProbeExecutionContext,
  type ToolWriteProbeLifecycle,
  type ToolWriteProbeLifecycleInput,
} from "@agentic/agent-kit";
import type { WriteProbeSafetyContract } from "@agentic/shared";
import { readEnvironmentReference } from "../config/env-ref";

type JsonRecord = Record<string, unknown>;
export type StatementMode = "read" | "write";

export interface StatementDefinition {
  sql: string;
  params: string[];
  mode: StatementMode;
  max_rows?: number;
  /** Present only in the dedicated Agent Factory probe catalog. Ordinary
   * business statements must not claim one of these roles. */
  write_probe?: PostgresWriteProbeStatementMetadata;
}

export type PostgresWriteProbeRole = "create" | "readback" | "cleanup";

export interface PostgresWriteProbeStatementMetadata {
  schema: "agentic-postgres-write-probe-statement/v1";
  role: PostgresWriteProbeRole;
  namespace: string;
}

interface QueryResultLike {
  command?: string;
  rowCount?: number | null;
  rows?: unknown[];
}

interface PgClientLike {
  query(
    query:
      | string
      | {
          name?: string;
          text: string;
          values?: unknown[];
          query_timeout?: number;
        },
  ): Promise<QueryResultLike>;
  release(): void;
}

interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export interface PostgresExecuteOptions {
  env?: Record<string, string | undefined>;
  poolFactory?: (config: {
    connectionString: string;
    max: number;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    application_name: string;
  }) => PgPoolLike;
  /** Supplied only by the trusted Agent Factory integration-probe boundary.
   * Merely adding the reserved probe field to tool input never enables it. */
  writeProbeExecution?: ToolWriteProbeExecutionContext;
}

export class PostgresStatementError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostgresStatementError";
    this.code = code;
  }
}

const OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_CATALOG_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ROWS = 1_000;
const ABSOLUTE_MAX_ROWS = 10_000;
const DEFAULT_MAX_VALUES_BYTES = 1024 * 1024;
const WRITE_PROBE_FIELD = "_agent_factory_postgres_probe";
const WRITE_PROBE_SCHEMA_RE = /^(?:agent_factory_probe|agent_factory_probe_[a-z0-9_]{1,43})$/;
const WRITE_PROBE_TABLE = "agent_factory_write_probe_canaries";
const WRITE_PROBE_MARKER_PREFIX = "af-pg-marker-";
const WRITE_PROBE_NAMESPACE_PREFIX = "af-pg-namespace-";
const WRITE_PROBE_TARGET_PREFIX = "af-pg-target-";
const WRITE_PROBE_IDEMPOTENCY_PREFIX = "af-pg-idempotency-";
const WRITE_PROBE_PARAMS = [
  "namespace",
  "target",
  "marker",
  "idempotency_key",
] as const;

export const POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY = {
  testDataContract: {
    kind: "synthetic_canary",
    marker: {
      kind: "argument",
      path: `${WRITE_PROBE_FIELD}.marker`,
      valuePrefix: WRITE_PROBE_MARKER_PREFIX,
    },
  },
  idempotency: {
    kind: "argument",
    path: `${WRITE_PROBE_FIELD}.idempotency_key`,
    valuePrefix: WRITE_PROBE_IDEMPOTENCY_PREFIX,
  },
  isolation: {
    namespace: {
      kind: "argument",
      path: `${WRITE_PROBE_FIELD}.namespace`,
      valuePrefix: WRITE_PROBE_NAMESPACE_PREFIX,
    },
    target: {
      kind: "argument",
      path: `${WRITE_PROBE_FIELD}.target`,
      valuePrefix: WRITE_PROBE_TARGET_PREFIX,
    },
  },
  cleanup: {
    kind: "handler",
    handler: "postgres.executeStatement.canary.cleanup",
  },
  absenceProof: {
    kind: "handler",
    handler: "postgres.executeStatement.canary.readback",
  },
} as const satisfies WriteProbeSafetyContract;

type PostgresProbeEnvelope = {
  marker: string;
  namespace: string;
  target: string;
  idempotency_key: string;
};

type PostgresProbeOperations = Record<PostgresWriteProbeRole, string>;

export interface PreparedPostgresWriteProbe {
  envelope: PostgresProbeEnvelope;
  operations: PostgresProbeOperations;
  config: JsonRecord;
  statementArgs(role: PostgresWriteProbeRole): JsonRecord;
  transactionArgs(role: PostgresWriteProbeRole): JsonRecord;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) <= 0 ||
    (value as number) > maximum
  ) {
    throw new Error(`${field} must be an integer between 1 and ${maximum}.`);
  }
  return value as number;
}

function statementTailIsTrivia(sql: string, start: number): boolean {
  let index = start;
  while (index < sql.length) {
    if (/\s/.test(sql[index]!)) {
      index += 1;
      continue;
    }
    if (sql.startsWith("--", index)) {
      const newline = sql.indexOf("\n", index + 2);
      if (newline < 0) return true;
      index = newline + 1;
      continue;
    }
    if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) return false;
      index = end + 2;
      continue;
    }
    return false;
  }
  return true;
}

/** Reject multiple PostgreSQL statements while respecting strings/comments/dollar quotes. */
export function assertSinglePostgresStatement(sql: string): void {
  if (!sql.trim() || sql.includes("\0")) {
    throw new Error(
      "postgres.executeStatement catalog SQL must be non-empty and contain no NUL bytes.",
    );
  }
  let index = 0;
  let semicolon = -1;
  let blockDepth = 0;
  let state: "normal" | "single" | "double" | "line" | "block" | "dollar" =
    "normal";
  let dollarTag = "";
  while (index < sql.length) {
    const char = sql[index]!;
    const next = sql[index + 1];
    if (state === "line") {
      if (char === "\n") state = "normal";
      index += 1;
      continue;
    }
    if (state === "block") {
      if (char === "/" && next === "*") {
        blockDepth += 1;
        index += 2;
      } else if (char === "*" && next === "/") {
        blockDepth -= 1;
        index += 2;
        if (blockDepth === 0) state = "normal";
      } else {
        index += 1;
      }
      continue;
    }
    if (state === "single") {
      if (char === "'" && next === "'") index += 2;
      else {
        if (char === "'") state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "double") {
      if (char === '"' && next === '"') index += 2;
      else {
        if (char === '"') state = "normal";
        index += 1;
      }
      continue;
    }
    if (state === "dollar") {
      if (sql.startsWith(dollarTag, index)) {
        index += dollarTag.length;
        state = "normal";
      } else index += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      state = "line";
      index += 2;
    } else if (char === "/" && next === "*") {
      state = "block";
      blockDepth = 1;
      index += 2;
    } else if (char === "'") {
      state = "single";
      index += 1;
    } else if (char === '"') {
      state = "double";
      index += 1;
    } else if (char === "$") {
      const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match) {
        dollarTag = match[0];
        state = "dollar";
        index += dollarTag.length;
      } else index += 1;
    } else if (char === ";") {
      if (semicolon >= 0 || !statementTailIsTrivia(sql, index + 1)) {
        throw new Error(
          "postgres.executeStatement catalog SQL must contain exactly one statement.",
        );
      }
      semicolon = index;
      index += 1;
    } else index += 1;
  }
  if (state !== "normal" && state !== "line") {
    throw new Error(
      "postgres.executeStatement catalog SQL contains an unterminated quote or comment.",
    );
  }
}

export function parseStatementCatalog(
  raw: string,
): Record<string, StatementDefinition> {
  if (Buffer.byteLength(raw, "utf8") > MAX_CATALOG_BYTES) {
    throw new Error(
      "postgres.executeStatement statement catalog exceeds the 1 MiB limit.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "postgres.executeStatement statement catalog is not valid JSON.",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(
      "postgres.executeStatement statement catalog must be a JSON object.",
    );
  }
  const catalog: Record<string, StatementDefinition> = {};
  for (const [operation, candidate] of Object.entries(parsed as JsonRecord)) {
    if (!OPERATION_RE.test(operation)) {
      throw new Error(
        "postgres.executeStatement catalog contains an invalid operation name.",
      );
    }
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error(
        `postgres.executeStatement catalog operation '${operation}' must be an object.`,
      );
    }
    const row = candidate as JsonRecord;
    if (typeof row.sql !== "string") {
      throw new Error(
        `postgres.executeStatement catalog operation '${operation}' requires sql.`,
      );
    }
    assertSinglePostgresStatement(row.sql);
    if (row.mode !== "read" && row.mode !== "write") {
      throw new Error(
        `postgres.executeStatement catalog operation '${operation}' mode must be read or write.`,
      );
    }
    if (
      !Array.isArray(row.params) ||
      !row.params.every(
        (item) => typeof item === "string" && PARAM_RE.test(item),
      )
    ) {
      throw new Error(
        `postgres.executeStatement catalog operation '${operation}' params must be valid unique names.`,
      );
    }
    const params = row.params as string[];
    if (new Set(params).size !== params.length) {
      throw new Error(
        `postgres.executeStatement catalog operation '${operation}' params must be unique.`,
      );
    }
    const placeholders = Array.from(row.sql.matchAll(/\$(\d+)/g), (match) =>
      Number(match[1]),
    );
    const actual = Array.from(new Set(placeholders)).sort((a, b) => a - b);
    const expected = params.map((_, parameterIndex) => parameterIndex + 1);
    if (
      actual.length !== expected.length ||
      actual.some(
        (value, placeholderIndex) => value !== expected[placeholderIndex],
      )
    ) {
      throw new Error(
        `postgres.executeStatement catalog operation '${operation}' placeholders must be exactly $1..$${params.length}.`,
      );
    }
    const maxRows =
      row.max_rows === undefined
        ? undefined
        : positiveInteger(
            row.max_rows,
            DEFAULT_MAX_ROWS,
            ABSOLUTE_MAX_ROWS,
            `catalog.${operation}.max_rows`,
          );
    let writeProbe: PostgresWriteProbeStatementMetadata | undefined;
    if (row.write_probe !== undefined) {
      const metadata = row.write_probe;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error(
          `postgres.executeStatement catalog operation '${operation}' write_probe must be an object.`,
        );
      }
      const probe = metadata as JsonRecord;
      const metadataKeys = Object.keys(probe).sort();
      if (
        metadataKeys.length !== 3
        || metadataKeys[0] !== "namespace"
        || metadataKeys[1] !== "role"
        || metadataKeys[2] !== "schema"
        || probe.schema !== "agentic-postgres-write-probe-statement/v1"
        || !["create", "readback", "cleanup"].includes(String(probe.role))
        || typeof probe.namespace !== "string"
        || !WRITE_PROBE_SCHEMA_RE.test(probe.namespace)
      ) {
        throw new Error(
          `postgres.executeStatement catalog operation '${operation}' has an invalid write_probe declaration.`,
        );
      }
      const definitionKeys = Object.keys(row).sort();
      if (
        definitionKeys.length !== 5
        || definitionKeys[0] !== "max_rows"
        || definitionKeys[1] !== "mode"
        || definitionKeys[2] !== "params"
        || definitionKeys[3] !== "sql"
        || definitionKeys[4] !== "write_probe"
        || maxRows === undefined
      ) {
        throw new Error(
          `postgres.executeStatement catalog operation '${operation}' write_probe definitions must contain exactly sql, params, mode, max_rows, and write_probe.`,
        );
      }
      writeProbe = {
        schema: "agentic-postgres-write-probe-statement/v1",
        role: probe.role as PostgresWriteProbeRole,
        namespace: probe.namespace,
      };
    }
    catalog[operation] = {
      sql: row.sql,
      params: [...params],
      mode: row.mode,
      ...(maxRows === undefined ? {} : { max_rows: maxRows }),
      ...(writeProbe === undefined ? {} : { write_probe: writeProbe }),
    };
  }
  if (Object.keys(catalog).length === 0) {
    throw new Error("postgres.executeStatement statement catalog is empty.");
  }
  return catalog;
}

function exactKeys(value: JsonRecord, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function requiredProbeConfigString(
  config: JsonRecord,
  key: string,
): string {
  const value = config[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      `postgres write probe requires trusted config.${key}.`,
    );
  }
  return value.trim();
}

function probeOperations(config: JsonRecord): PostgresProbeOperations {
  const operations = {
    create: requiredProbeConfigString(config, "write_probe_create_operation"),
    readback: requiredProbeConfigString(config, "write_probe_readback_operation"),
    cleanup: requiredProbeConfigString(config, "write_probe_cleanup_operation"),
  };
  if (
    !Object.values(operations).every((operation) => OPERATION_RE.test(operation))
    || new Set(Object.values(operations)).size !== 3
  ) {
    throw new Error(
      "postgres write probe operation names must be three distinct valid statement-catalog operations.",
    );
  }
  return operations;
}

function writeProbeSql(
  namespace: string,
): Record<PostgresWriteProbeRole, string> {
  const table = `"${namespace}"."${WRITE_PROBE_TABLE}"`;
  const columns = '"namespace", "target", "marker", "idempotency_key"';
  const predicate = '"namespace" = $1 AND "target" = $2 AND "marker" = $3 AND "idempotency_key" = $4';
  return {
    create:
      `INSERT INTO ${table} (${columns}) VALUES ($1, $2, $3, $4) `
      + 'ON CONFLICT ("namespace", "target") DO UPDATE SET '
      + '"marker" = EXCLUDED."marker", "idempotency_key" = EXCLUDED."idempotency_key" '
      + `RETURNING ${columns}`,
    readback:
      `SELECT ${columns} FROM ${table} WHERE ${predicate} LIMIT 2`,
    cleanup:
      `DELETE FROM ${table} WHERE ${predicate} RETURNING ${columns}`,
  };
}

/** Build the only accepted dedicated write-probe catalog. Operators may use
 * this helper when provisioning the environment reference instead of
 * hand-authoring security-sensitive SQL. The schema/table must be provisioned
 * separately with UNIQUE(namespace,target); the Factory never creates schema
 * or tables and never points these statements at a business relation. */
export function postgresWriteProbeStatementCatalog(input: {
  namespace: string;
  createOperation: string;
  readbackOperation: string;
  cleanupOperation: string;
}): Record<string, StatementDefinition> {
  if (!WRITE_PROBE_SCHEMA_RE.test(input.namespace)) {
    throw new Error(
      "postgres write probe namespace must be agent_factory_probe or use the agent_factory_probe_ prefix.",
    );
  }
  const operations: PostgresProbeOperations = {
    create: input.createOperation,
    readback: input.readbackOperation,
    cleanup: input.cleanupOperation,
  };
  if (
    !Object.values(operations).every((operation) => OPERATION_RE.test(operation))
    || new Set(Object.values(operations)).size !== 3
  ) {
    throw new Error(
      "postgres write probe operation names must be three distinct valid statement-catalog operations.",
    );
  }
  const sql = writeProbeSql(input.namespace);
  return Object.fromEntries(
    (Object.keys(operations) as PostgresWriteProbeRole[]).map((role) => [
      operations[role],
      {
        sql: sql[role],
        params: [...WRITE_PROBE_PARAMS],
        mode: role === "readback" ? "read" : "write",
        max_rows: role === "readback" ? 2 : 1,
        write_probe: {
          schema: "agentic-postgres-write-probe-statement/v1",
          role,
          namespace: input.namespace,
        },
      } satisfies StatementDefinition,
    ]),
  );
}

function assertDedicatedProbeCatalog(
  catalog: Record<string, StatementDefinition>,
  namespace: string,
  operations: PostgresProbeOperations,
): void {
  const expected = postgresWriteProbeStatementCatalog({
    namespace,
    createOperation: operations.create,
    readbackOperation: operations.readback,
    cleanupOperation: operations.cleanup,
  });
  const actualNames = Object.keys(catalog).sort();
  const expectedNames = Object.keys(expected).sort();
  if (
    actualNames.length !== expectedNames.length
    || actualNames.some((name, index) => name !== expectedNames[index])
  ) {
    throw new Error(
      "postgres write probe statement catalog must contain exactly the configured create, readback, and cleanup operations.",
    );
  }
  for (const name of expectedNames) {
    if (JSON.stringify(catalog[name]) !== JSON.stringify(expected[name])) {
      throw new Error(
        `postgres write probe catalog operation '${name}' does not match the code-owned disposable-canary SQL contract.`,
      );
    }
  }
}

function exactProbeExecution(
  toolName: string,
  value: ToolWriteProbeExecutionContext,
): ToolWriteProbeExecutionContext {
  if (
    value.agentName !== "agent-factory-probe"
    || value.actionName !== toolName
    || value.eventName !== `probe:${toolName}`
    || !/^probe:[a-f0-9]{12}$/.test(value.correlationId)
    || typeof value.tenantSlug !== "string"
    || !value.tenantSlug.trim()
    || value.tenantSlug.length > 200
  ) {
    throw new Error(
      `${toolName}: untrusted Agent Factory write-probe execution context.`,
    );
  }
  return {
    agentName: value.agentName,
    actionName: value.actionName,
    correlationId: value.correlationId,
    tenantSlug: value.tenantSlug,
    eventName: value.eventName,
  };
}

function probeEnvelope(
  toolName: string,
  args: JsonRecord,
  expected?: ToolWriteProbeLifecycleInput["canary"],
): PostgresProbeEnvelope {
  const raw = args[WRITE_PROBE_FIELD];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${toolName}: isolated postgres write-probe envelope is missing.`);
  }
  const row = raw as JsonRecord;
  if (!exactKeys(row, ["marker", "namespace", "target", "idempotency_key"])) {
    throw new Error(`${toolName}: postgres write-probe envelope has unexpected fields.`);
  }
  const marker = typeof row.marker === "string" ? row.marker : "";
  const namespace = typeof row.namespace === "string" ? row.namespace : "";
  const target = typeof row.target === "string" ? row.target : "";
  const idempotencyKey = typeof row.idempotency_key === "string"
    ? row.idempotency_key
    : "";
  const suffix = marker.startsWith(WRITE_PROBE_MARKER_PREFIX)
    ? marker.slice(WRITE_PROBE_MARKER_PREFIX.length)
    : "";
  const idempotencySuffix = idempotencyKey.startsWith(WRITE_PROBE_IDEMPOTENCY_PREFIX)
    ? idempotencyKey.slice(WRITE_PROBE_IDEMPOTENCY_PREFIX.length)
    : "";
  if (
    !/^[a-f0-9]{24}$/.test(suffix)
    || namespace !== `${WRITE_PROBE_NAMESPACE_PREFIX}${suffix}`
    || target !== `${WRITE_PROBE_TARGET_PREFIX}${suffix}`
    || !/^[a-f0-9]{64}$/.test(idempotencySuffix)
    || !idempotencySuffix.startsWith(suffix)
    || (expected !== undefined && (
      expected.marker !== marker
      || expected.namespace !== namespace
      || expected.target !== target
      || expected.idempotencyKey !== idempotencyKey
    ))
  ) {
    throw new Error(`${toolName}: invalid or non-isolated postgres write-probe canary.`);
  }
  return { marker, namespace, target, idempotency_key: idempotencyKey };
}

function assertProbeToolArgs(
  toolName: "postgres.executeStatement" | "postgres.executeTransaction",
  args: JsonRecord,
  createOperation: string,
): void {
  if (toolName === "postgres.executeStatement") {
    if (
      !exactKeys(args, ["operation", "values", WRITE_PROBE_FIELD])
      || args.operation !== createOperation
      || !args.values
      || typeof args.values !== "object"
      || Array.isArray(args.values)
      || Object.keys(args.values as JsonRecord).length !== 0
    ) {
      throw new Error(
        "postgres.executeStatement write probe accepts only its configured create operation with an empty values object; all canary values are server-injected.",
      );
    }
    return;
  }
  if (
    !exactKeys(args, ["operations", WRITE_PROBE_FIELD])
    || !Array.isArray(args.operations)
    || args.operations.length !== 1
  ) {
    throw new Error(
      "postgres.executeTransaction write probe accepts exactly one configured create operation.",
    );
  }
  const item = args.operations[0];
  if (
    !item
    || typeof item !== "object"
    || Array.isArray(item)
    || !exactKeys(item as JsonRecord, ["operation", "values"])
    || (item as JsonRecord).operation !== createOperation
    || !(item as JsonRecord).values
    || typeof (item as JsonRecord).values !== "object"
    || Array.isArray((item as JsonRecord).values)
    || Object.keys((item as JsonRecord).values as JsonRecord).length !== 0
  ) {
    throw new Error(
      "postgres.executeTransaction write probe accepts only its configured create operation with an empty values object; all canary values are server-injected.",
    );
  }
}

function exactSafetyContract(
  toolName: "postgres.executeStatement" | "postgres.executeTransaction",
  contract: WriteProbeSafetyContract,
): void {
  const expected = toolName === "postgres.executeStatement"
    ? POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY
    : {
        ...POSTGRES_EXECUTE_STATEMENT_PROBE_SAFETY,
        cleanup: { kind: "handler", handler: "postgres.executeTransaction.canary.cleanup" },
        absenceProof: { kind: "handler", handler: "postgres.executeTransaction.canary.readback" },
      };
  if (JSON.stringify(contract) !== JSON.stringify(expected)) {
    throw new Error(`${toolName}: lifecycle refused a different write-probe safety contract.`);
  }
}

export function preparePostgresWriteProbe(input: {
  toolName: "postgres.executeStatement" | "postgres.executeTransaction";
  args: JsonRecord;
  config: JsonRecord;
  execution: ToolWriteProbeExecutionContext;
  env?: Record<string, string | undefined>;
  contract?: WriteProbeSafetyContract;
  expectedCanary?: ToolWriteProbeLifecycleInput["canary"];
}): PreparedPostgresWriteProbe {
  exactProbeExecution(input.toolName, input.execution);
  if (input.contract) exactSafetyContract(input.toolName, input.contract);
  const envelope = probeEnvelope(input.toolName, input.args, input.expectedCanary);
  const operations = probeOperations(input.config);
  assertProbeToolArgs(input.toolName, input.args, operations.create);
  const namespace = requiredProbeConfigString(input.config, "write_probe_namespace");
  if (!WRITE_PROBE_SCHEMA_RE.test(namespace)) {
    throw new Error(
      "postgres write probe namespace must be agent_factory_probe or use the agent_factory_probe_ prefix.",
    );
  }
  const connectionUrlEnv = requiredProbeConfigString(
    input.config,
    "write_probe_connection_url_env",
  );
  const statementCatalogEnv = requiredProbeConfigString(
    input.config,
    "write_probe_statement_catalog_env",
  );
  if (
    connectionUrlEnv === input.config.connection_url_env
    || statementCatalogEnv === input.config.statement_catalog_env
  ) {
    throw new Error(
      "postgres write probe requires dedicated connection and statement-catalog environment references distinct from business runtime references.",
    );
  }
  const env = input.env ?? process.env;
  const probeConnectionUrl = postgresUrl(readEnvironmentReference(
    env,
    connectionUrlEnv,
    "postgres write probe config.write_probe_connection_url_env",
  ));
  const businessConnectionUrl = postgresUrl(readEnvironmentReference(
    env,
    input.config.connection_url_env,
    "postgres write probe config.connection_url_env",
  ));
  const connectionIdentity = (raw: string): string => {
    const url = new URL(raw);
    return JSON.stringify({
      protocol: url.protocol,
      username: decodeURIComponent(url.username),
      hostname: url.hostname.toLowerCase(),
      port: url.port || "5432",
      database: url.pathname.replace(/^\/+/, ""),
    });
  };
  if (
    probeConnectionUrl === businessConnectionUrl
    || connectionIdentity(probeConnectionUrl) === connectionIdentity(businessConnectionUrl)
  ) {
    throw new Error(
      "postgres write probe connection must use a database or role identity distinct from the business runtime connection.",
    );
  }
  const rawCatalog = readEnvironmentReference(
    env,
    statementCatalogEnv,
    "postgres write probe config.write_probe_statement_catalog_env",
  );
  assertDedicatedProbeCatalog(parseStatementCatalog(rawCatalog), namespace, operations);
  const businessCatalog = parseStatementCatalog(readEnvironmentReference(
    env,
    input.config.statement_catalog_env,
    "postgres write probe config.statement_catalog_env",
  ));
  const reusedOperation = Object.values(operations).find(
    (operation) => businessCatalog[operation] !== undefined,
  );
  if (reusedOperation) {
    throw new Error(
      `postgres write probe operation '${reusedOperation}' must not exist in the business statement catalog.`,
    );
  }
  const config: JsonRecord = {
    connection_url_env: connectionUrlEnv,
    statement_catalog_env: statementCatalogEnv,
    allowed_operations: Object.values(operations),
    allow_write: true,
    max_rows: 2,
    max_values_bytes: input.config.max_values_bytes,
    max_operations: 1,
    max_batch_bytes: input.config.max_batch_bytes,
    timeout_ms: input.config.timeout_ms,
  };
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined) delete config[key];
  }
  const values = {
    namespace: envelope.namespace,
    target: envelope.target,
    marker: envelope.marker,
    idempotency_key: envelope.idempotency_key,
  };
  return {
    envelope,
    operations,
    config,
    statementArgs(role) {
      return { operation: operations[role], values: { ...values } };
    },
    transactionArgs(role) {
      return {
        operations: [{ operation: operations[role], values: { ...values } }],
      };
    },
  };
}

function exactProbeRow(value: unknown, envelope: PostgresProbeEnvelope): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as JsonRecord;
  return exactKeys(row, ["namespace", "target", "marker", "idempotency_key"])
    && row.namespace === envelope.namespace
    && row.target === envelope.target
    && row.marker === envelope.marker
    && row.idempotency_key === envelope.idempotency_key;
}

export function assertPostgresProbeRows(
  rows: unknown[],
  envelope: PostgresProbeEnvelope,
  expectedCount: 0 | 1,
  phase: string,
): void {
  if (
    rows.length !== expectedCount
    || (expectedCount === 1 && !exactProbeRow(rows[0], envelope))
  ) {
    throw new Error(
      `postgres write probe ${phase} did not return exactly ${expectedCount} matching disposable canary row${expectedCount === 1 ? "" : "s"}.`,
    );
  }
}

export function postgresProbeExecutionFromContext(
  ctx: ToolContext,
): ToolWriteProbeExecutionContext | undefined {
  if (ctx.agentName !== "agent-factory-probe") return undefined;
  return {
    agentName: ctx.agentName,
    actionName: ctx.actionName,
    correlationId: ctx.correlationId,
    tenantSlug: ctx.tenantSlug,
    eventName: ctx.event?.name ?? "",
  };
}

export function postgresUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "postgres.executeStatement connection URL environment variable is invalid.",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  ) {
    throw new Error(
      "postgres.executeStatement connection URL must be a PostgreSQL URL with host and database.",
    );
  }
  return raw;
}

export function valuesFor(
  definition: StatementDefinition,
  values: unknown,
): unknown[] {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    if (definition.params.length === 0 && values === undefined) return [];
    throw new Error(
      "postgres.executeStatement values must be an object keyed by catalog params.",
    );
  }
  const record = values as JsonRecord;
  const received = Object.keys(record).sort();
  const expected = [...definition.params].sort();
  if (
    received.length !== expected.length ||
    received.some((key, index) => key !== expected[index])
  ) {
    throw new Error(
      `postgres.executeStatement values must contain exactly: ${definition.params.join(", ") || "(none)"}.`,
    );
  }
  return definition.params.map((name) => record[name]);
}

export async function executePostgresStatement(
  args: JsonRecord,
  config: JsonRecord,
  options: PostgresExecuteOptions = {},
): Promise<{
  operation: string;
  mode: StatementMode;
  command: string;
  row_count: number;
  rows: unknown[];
}> {
  let preparedProbe: PreparedPostgresWriteProbe | undefined;
  if (options.writeProbeExecution) {
    preparedProbe = preparePostgresWriteProbe({
      toolName: "postgres.executeStatement",
      args,
      config,
      execution: options.writeProbeExecution,
      env: options.env,
    });
    args = preparedProbe.statementArgs("create");
    config = preparedProbe.config;
  } else if (WRITE_PROBE_FIELD in args) {
    throw new Error(
      "postgres.executeStatement reserved write-probe input is accepted only from the trusted Agent Factory probe boundary.",
    );
  }
  for (const forbidden of [
    "sql",
    "query",
    "statement",
    "connection_url",
    "connectionString",
    "url",
  ]) {
    if (forbidden in args) {
      throw new Error(
        `postgres.executeStatement does not accept '${forbidden}' from tool-call input.`,
      );
    }
  }
  if (!exactKeys(args, ["operation", "values"])) {
    throw new Error(
      "postgres.executeStatement input must contain exactly: operation, values.",
    );
  }
  if (
    "connection_url" in config ||
    "statement_catalog" in config ||
    "sql" in config
  ) {
    throw new Error(
      "postgres.executeStatement accepts only connection_url_env and statement_catalog_env; literal SQL/URLs are forbidden.",
    );
  }
  const operation =
    typeof args.operation === "string" ? args.operation.trim() : "";
  if (!OPERATION_RE.test(operation)) {
    throw new Error(
      "postgres.executeStatement operation is missing or invalid.",
    );
  }
  const env = options.env ?? process.env;
  const catalogRaw = readEnvironmentReference(
    env,
    config.statement_catalog_env,
    "postgres.executeStatement config.statement_catalog_env",
  );
  const catalog = parseStatementCatalog(catalogRaw);
  const definition = catalog[operation];
  if (!definition) {
    throw new Error(
      `postgres.executeStatement operation '${operation}' is not in the server statement catalog.`,
    );
  }
  const allowed = Array.isArray(config.allowed_operations)
    ? config.allowed_operations.filter(
        (value): value is string => typeof value === "string",
      )
    : [];
  if (allowed.length > 0 && !allowed.includes(operation)) {
    throw new Error(
      `postgres.executeStatement operation '${operation}' is outside config.allowed_operations.`,
    );
  }
  if (definition.mode === "write" && config.allow_write !== true) {
    throw new Error(
      `postgres.executeStatement write operation '${operation}' requires trusted config.allow_write=true.`,
    );
  }
  const orderedValues = valuesFor(definition, args.values);
  const maxValueBytes = positiveInteger(
    config.max_values_bytes,
    DEFAULT_MAX_VALUES_BYTES,
    10 * 1024 * 1024,
    "postgres.executeStatement config.max_values_bytes",
  );
  let serializedValues: string;
  try {
    serializedValues = JSON.stringify(orderedValues);
  } catch {
    throw new Error(
      "postgres.executeStatement values must be JSON-serializable.",
    );
  }
  if (Buffer.byteLength(serializedValues, "utf8") > maxValueBytes) {
    throw new Error(
      "postgres.executeStatement values exceed the configured byte limit.",
    );
  }
  const connectionString = postgresUrl(
    readEnvironmentReference(
      env,
      config.connection_url_env,
      "postgres.executeStatement config.connection_url_env",
    ),
  );
  const timeoutMs = positiveInteger(
    config.timeout_ms,
    DEFAULT_TIMEOUT_MS,
    120_000,
    "postgres.executeStatement config.timeout_ms",
  );
  const maxRows = Math.min(
    definition.max_rows ??
      positiveInteger(
        config.max_rows,
        DEFAULT_MAX_ROWS,
        ABSOLUTE_MAX_ROWS,
        "postgres.executeStatement config.max_rows",
      ),
    ABSOLUTE_MAX_ROWS,
  );
  const poolFactory =
    options.poolFactory ??
    ((poolConfig) => new Pool(poolConfig) as unknown as PgPoolLike);
  const pool = poolFactory({
    connectionString,
    max: 1,
    connectionTimeoutMillis: timeoutMs,
    idleTimeoutMillis: 1_000,
    application_name: "agentic_postgres_execute_statement",
  });
  let client: PgClientLike | undefined;
  try {
    client = await pool.connect();
    await client.query(
      definition.mode === "read" ? "BEGIN READ ONLY" : "BEGIN",
    );
    const statementHash = createHash("sha256")
      .update(definition.sql)
      .digest("hex")
      .slice(0, 16);
    const result = await client.query({
      name: `agentic_${operation.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 40)}_${statementHash}`,
      text: definition.sql,
      values: orderedValues,
      query_timeout: timeoutMs,
    });
    const rows = Array.isArray(result.rows) ? result.rows : [];
    if (rows.length > maxRows) {
      throw new PostgresStatementError(
        "result_row_limit_exceeded",
        `postgres.executeStatement operation '${operation}' returned more than ${maxRows} rows. Add a LIMIT to the server catalog statement.`,
      );
    }
    await client.query("COMMIT");
    if (preparedProbe) {
      assertPostgresProbeRows(
        rows,
        preparedProbe.envelope,
        1,
        "create",
      );
    }
    return {
      operation,
      mode: definition.mode,
      command: typeof result.command === "string" ? result.command : "UNKNOWN",
      row_count:
        typeof result.rowCount === "number" ? result.rowCount : rows.length,
      rows,
    };
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the original failure and never expose connection details.
      }
    }
    if (error instanceof PostgresStatementError) throw error;
    const pgCode =
      error &&
      typeof error === "object" &&
      typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
            .replace(/[^A-Za-z0-9_-]/g, "")
            .slice(0, 32)
        : "unknown";
    throw new PostgresStatementError(
      "database_execution_failed",
      `postgres.executeStatement database execution failed for operation '${operation}' (code: ${pgCode}).`,
    );
  } finally {
    client?.release();
    await pool.end();
  }
}

function probeLifecycleInput(
  input: ToolWriteProbeLifecycleInput,
  env?: Record<string, string | undefined>,
): PreparedPostgresWriteProbe {
  if (input.toolName !== "postgres.executeStatement") {
    throw new Error("postgres.executeStatement lifecycle received a different tool.");
  }
  return preparePostgresWriteProbe({
    toolName: "postgres.executeStatement",
    args: input.args,
    config: input.config,
    execution: input.execution,
    env,
    contract: input.contract,
    expectedCanary: input.canary,
  });
}

export function createPostgresExecuteStatementWriteProbeLifecycle(
  options: PostgresExecuteOptions = {},
): ToolWriteProbeLifecycle {
  const lifecycleOptions: PostgresExecuteOptions = {
    ...(options.env ? { env: options.env } : {}),
    ...(options.poolFactory ? { poolFactory: options.poolFactory } : {}),
  };
  return {
    identity: { id: "postgres.executeStatement/write-probe", revision: "1" },
    async cleanup(input) {
      const probe = probeLifecycleInput(input, options.env);
      let verificationError: unknown;
      try {
        const retry = await executePostgresStatement(
          probe.statementArgs("create"),
          probe.config,
          lifecycleOptions,
        );
        assertPostgresProbeRows(retry.rows, probe.envelope, 1, "idempotency retry");
        const readback = await executePostgresStatement(
          probe.statementArgs("readback"),
          probe.config,
          lifecycleOptions,
        );
        assertPostgresProbeRows(readback.rows, probe.envelope, 1, "pre-cleanup readback");
      } catch (error) {
        verificationError = error;
      }
      const cleanup = await executePostgresStatement(
        probe.statementArgs("cleanup"),
        probe.config,
        lifecycleOptions,
      );
      assertPostgresProbeRows(cleanup.rows, probe.envelope, 1, "cleanup");
      if (verificationError) throw verificationError;
      return {
        completed: true,
        evidence: {
          idempotencyRetryVerified: true,
          preCleanupReadbackVerified: true,
          deletedRows: 1,
        },
      };
    },
    async readback(input) {
      const probe = probeLifecycleInput(input, options.env);
      const readback = await executePostgresStatement(
        probe.statementArgs("readback"),
        probe.config,
        lifecycleOptions,
      );
      assertPostgresProbeRows(readback.rows, probe.envelope, 0, "absence readback");
      return {
        absent: true,
        evidence: { exactCanaryRows: 0 },
      };
    },
  };
}

export const postgresExecuteStatementWriteProbeLifecycle =
  createPostgresExecuteStatementWriteProbeLifecycle();

export const postgresExecuteStatement = defineTool({
  name: "postgres.executeStatement",
  description:
    "Execute one named parameterized PostgreSQL statement from a server environment catalog. " +
    "Input is only {operation, values}; raw SQL and connection URLs are rejected. Read operations run in a READ ONLY transaction.",
  output: z.object({
    operation: z.string(),
    mode: z.enum(["read", "write"]),
    command: z.string(),
    row_count: z.number().int().nonnegative(),
    rows: z.array(z.unknown()),
  }),
  factoryWriteProbeLifecycle: postgresExecuteStatementWriteProbeLifecycle,
  async handler(ctx) {
    return {
      data: await executePostgresStatement(
        (ctx.event?.data ?? {}) as JsonRecord,
        (ctx.config ?? {}) as JsonRecord,
        { writeProbeExecution: postgresProbeExecutionFromContext(ctx) },
      ),
      meta: {
        statement_source: "server-environment-catalog",
        parameterized: true,
      },
    };
  },
});
