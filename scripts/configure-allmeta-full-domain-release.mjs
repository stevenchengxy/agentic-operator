#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const allmetaRoot = resolve(
  process.env.ALLMETA_ONTOLOGY_ROOT ?? join(homedir(), "allmetaOntology"),
);
const envPath = resolve(
  process.env.ALLMETA_ENV_FILE ??
    process.argv.find((arg) => arg.startsWith("--env="))?.slice("--env=".length) ??
    join(allmetaRoot, ".env.local"),
);

const stateDir = resolve(
  process.env.ONTOLOGY_RELEASE_STATE_DIR ??
    process.argv.find((arg) => arg.startsWith("--state-dir="))?.slice("--state-dir=".length) ??
    join(homedir(), ".allmeta-ontology", "release-state"),
);

function parseEnvValue(raw) {
  const value = raw.trim();
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function getEnvValue(contents, key) {
  for (const line of contents.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (match?.[1] === key) return parseEnvValue(match[2]);
  }
  return undefined;
}

function serializeEnvValue(value) {
  return JSON.stringify(value);
}

function setEnvValue(contents, key, value) {
  const rendered = `${key}=${serializeEnvValue(value)}`;
  const lines = contents.split(/\r?\n/u);
  let found = false;
  const updated = lines.map((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u);
    if (match?.[1] !== key) return line;
    if (found) return line;
    found = true;
    return rendered;
  });
  if (!found) {
    if (updated.length > 0 && updated.at(-1) !== "") updated.push("");
    updated.push(rendered);
  }
  return updated.join("\n");
}

const original = await readFile(envPath, "utf8");
const ordinaryToken =
  getEnvValue(original, "ONTOLOGY_API_TOKEN") ??
  getEnvValue(original, "ALLMETA_API_KEY");
let operatorToken = getEnvValue(original, "ONTOLOGY_RELEASE_OPERATOR_TOKEN");
const generatedOperatorToken = !operatorToken || operatorToken === ordinaryToken;
if (generatedOperatorToken) operatorToken = randomBytes(48).toString("base64url");

let next = original;
next = setEnvValue(next, "ONTOLOGY_ACTION_EVENT_RELEASE_ENABLED", "1");
next = setEnvValue(next, "ONTOLOGY_FULL_DOMAIN_RELEASE_ENABLED", "1");
next = setEnvValue(next, "ONTOLOGY_RELEASE_STATE_DIR", stateDir);
next = setEnvValue(next, "ONTOLOGY_RELEASE_OPERATOR_TOKEN", operatorToken);
if (!next.endsWith("\n")) next += "\n";

await mkdir(stateDir, { recursive: true, mode: 0o700 });
await chmod(stateDir, 0o700);
await mkdir(dirname(envPath), { recursive: true });
const temporaryPath = `${envPath}.tmp-${process.pid}`;
await writeFile(temporaryPath, next, { encoding: "utf8", mode: 0o600 });
await chmod(temporaryPath, 0o600);
await rename(temporaryPath, envPath);
await chmod(envPath, 0o600);

console.log(
  JSON.stringify(
    {
      configured: true,
      env_file: envPath,
      release_state_dir: stateDir,
      release_state_outside_models: !stateDir.startsWith(
        resolve(dirname(envPath), "models") + "/",
      ),
      separate_operator_token: Boolean(operatorToken && operatorToken !== ordinaryToken),
      operator_token_generated: generatedOperatorToken,
      allmeta_root: allmetaRoot,
      secrets_printed: false,
    },
    null,
    2,
  ),
);
