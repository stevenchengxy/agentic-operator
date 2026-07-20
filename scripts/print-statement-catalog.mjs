#!/usr/bin/env node
/**
 * Print a reviewed named-statement catalog as the single-line env value the tools expect.
 *
 * `facts.query` / `entities.write` resolve their catalog from a SERVER environment variable
 * (readEnvironmentReference — a tool call can never choose it). That contract is deliberate, but a
 * 4 KB JSON pasted into .env is unreviewable and drifts. So the catalog lives as a version-controlled
 * JSON file and this script renders the env line from it.
 *
 *   node scripts/print-statement-catalog.mjs                 # pretty summary
 *   node scripts/print-statement-catalog.mjs --env           # AGENTS_GENERATION_RAAS_STATEMENTS=<json>
 *
 * The catalog is validated before printing, so a malformed edit fails here rather than at runtime.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATALOGS = {
  "agents-generation-raas": {
    file: "packages/recruitment-capabilities/catalogs/agents-generation-raas-statements.json",
    env: "AGENTS_GENERATION_RAAS_STATEMENTS",
  },
  "agents-generation-raas-writes": {
    file: "packages/recruitment-capabilities/catalogs/agents-generation-raas-writes.json",
    env: "AGENTS_GENERATION_RAAS_WRITES",
  },
};

const OPERATION_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Mirror of the tool's own contract checks so a bad edit is caught before it reaches an env. */
function validate(catalog) {
  const entries = Object.entries(catalog);
  if (!entries.length) throw new Error("catalog is empty");
  for (const [operation, def] of entries) {
    if (!OPERATION_RE.test(operation)) throw new Error(`invalid operation name: ${operation}`);
    if (typeof def?.sql !== "string" || !def.sql.trim()) throw new Error(`${operation}: missing sql`);
    if (def.mode !== "read" && def.mode !== "write") throw new Error(`${operation}: mode must be read|write`);
    if (!Array.isArray(def.params)) throw new Error(`${operation}: params must be an array`);
    for (const p of def.params) {
      if (!PARAM_RE.test(p)) throw new Error(`${operation}: invalid param name ${p}`);
    }
    const highest = def.params.length;
    for (let i = 1; i <= highest; i++) {
      if (!def.sql.includes(`$${i}`)) throw new Error(`${operation}: sql never binds $${i} (params declares ${highest})`);
    }
  }
  return entries.length;
}

const name = process.argv.find((a) => !a.startsWith("--") && CATALOGS[a]) ?? "agents-generation-raas";
const spec = CATALOGS[name];
const raw = readFileSync(path.join(root, spec.file), "utf8");
const catalog = JSON.parse(raw);
const count = validate(catalog);
const oneLine = JSON.stringify(catalog);

if (process.argv.includes("--env")) {
  process.stdout.write(`${spec.env}=${oneLine}\n`);
} else {
  console.log(`catalog : ${spec.file}`);
  console.log(`env var : ${spec.env}`);
  console.log(`ops     : ${count} (${Object.keys(catalog).filter((o) => catalog[o].mode === "read").length} read / ${Object.keys(catalog).filter((o) => catalog[o].mode === "write").length} write)`);
  console.log(`bytes   : ${Buffer.byteLength(oneLine, "utf8")} (1 MiB limit)`);
  console.log(`\nRun with --env to emit the env line.`);
}
