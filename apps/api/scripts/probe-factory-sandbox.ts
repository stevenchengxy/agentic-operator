/**
 * Host-side external sandbox probe client.
 *
 * This process deliberately has no database imports. Tenant lookup, model
 * grants, sandbox execution and cleanup run inside the supervised API writer
 * process through a dedicated service-authenticated endpoint.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseProductionEnvText } from "./production-env-file";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const MAX_RESPONSE_BYTES = 1024 * 1024;

function productionEnvironment(): Record<string, string> {
  const filename = path.resolve(
    root,
    process.env.FACTORY_PRODUCTION_ENV_FILE?.trim() || ".env.production",
  );
  if (!existsSync(filename)) throw new Error(`${path.basename(filename)} does not exist`);
  return parseProductionEnvText(readFileSync(filename, "utf8"));
}

function hostToken(env: Record<string, string>): string {
  const filename = env.FACTORY_PRODUCTION_PROBE_TOKEN_HOST_FILE?.trim();
  if (!filename || !path.isAbsolute(filename)) {
    throw new Error("FACTORY_PRODUCTION_PROBE_TOKEN_HOST_FILE must be an absolute path");
  }
  const stat = statSync(filename);
  if (!stat.isFile() || stat.size < 32 || stat.size > 4096) {
    throw new Error("Factory production probe token file is invalid");
  }
  const token = readFileSync(filename, "utf8").trim();
  if (Buffer.byteLength(token, "utf8") < 32) {
    throw new Error("Factory production probe token is too short");
  }
  return token;
}

async function boundedJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    throw new Error("Factory sandbox probe response is too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error("Factory sandbox probe response is too large");
  }
  return JSON.parse(text) as unknown;
}

async function main(): Promise<void> {
  const env = productionEnvironment();
  const origin = new URL(env.AGENTIC_API_URL || `http://127.0.0.1:${env.API_PORT || "3501"}`);
  if (origin.protocol !== "http:" && origin.protocol !== "https:") {
    throw new Error("AGENTIC_API_URL must be an absolute http(s) URL");
  }
  const tenantSlug = process.env.FACTORY_SANDBOX_PROBE_TENANT_SLUG?.trim()
    || env.FACTORY_SANDBOX_PROBE_TENANT_SLUG?.trim();
  const response = await fetch(new URL("/internal/factory-sandbox/probe", origin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${hostToken(env)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(tenantSlug ? { tenantSlug } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const report = await boundedJson(response) as { passed?: unknown };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!response.ok || report?.passed !== true) process.exitCode = 1;
}

await main().catch((error) => {
  process.stderr.write(`[factory-sandbox-probe] ${String((error as Error)?.message ?? error).slice(0, 500)}\n`);
  process.exitCode = 1;
});
