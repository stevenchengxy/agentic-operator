#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function readRequiredVersion() {
  const nvmrcPath = path.join(REPO_ROOT, ".nvmrc");
  const required = fs.readFileSync(nvmrcPath, "utf8").trim().replace(/^v/, "");

  if (!/^\d+\.\d+\.\d+$/.test(required)) {
    throw new Error(`invalid exact Node version in ${nvmrcPath}: ${required}`);
  }

  return required;
}

function readPackageEngine() {
  const packagePath = path.join(REPO_ROOT, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  return packageJson.engines?.node;
}

try {
  const required = readRequiredVersion();
  const packageEngine = readPackageEngine();

  if (packageEngine !== required) {
    console.error(
      `[ensure-node] version pins disagree: .nvmrc=${required}, package.json#engines.node=${packageEngine ?? "missing"}`,
    );
    process.exit(1);
  }

  if (process.versions.node !== required) {
    console.error(
      `[ensure-node] Node v${required} is required; current runtime is ${process.version}.`,
    );
    console.error(
      `[ensure-node] Run: nvm install ${required} && nvm use ${required}`,
    );
    process.exit(1);
  }

  console.log(
    `[ensure-node] Node ${process.version} matches the repository pin.`,
  );
} catch (error) {
  console.error(
    `[ensure-node] unable to validate the Node runtime: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
