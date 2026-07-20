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

  // Major-version match (not exact): every Node 26.x shares the same native
  // ABI (MODULE_VERSION 147) that better-sqlite3 is compiled against, and our
  // ground truth (.nvmrc, CLAUDE.md) is "Node 26". `required` (e.g. 26.5.0) is
  // the documented target; any installed 26.x runs the workspace correctly, so
  // pinning to an exact patch would fail-closed on ABI-compatible runtimes
  // (e.g. a dev box on 26.3.0) for no benefit.
  const requiredMajor = required.split(".")[0];
  const runtimeMajor = String(process.versions.node).split(".")[0];
  if (runtimeMajor !== requiredMajor) {
    console.error(
      `[ensure-node] Node ${requiredMajor}.x is required (repository pin ${required}); current runtime is ${process.version}.`,
    );
    console.error(
      `[ensure-node] Run: nvm install ${required} && nvm use ${required}`,
    );
    process.exit(1);
  }

  console.log(
    `[ensure-node] Node ${process.version} satisfies the repository pin (${required}, major ${requiredMajor}).`,
  );
} catch (error) {
  console.error(
    `[ensure-node] unable to validate the Node runtime: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
