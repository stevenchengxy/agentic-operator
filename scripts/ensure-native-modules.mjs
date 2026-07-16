#!/usr/bin/env node
// Guards against the ERR_DLOPEN_FAILED / NODE_MODULE_VERSION crash that
// happens when a native addon (better-sqlite3 here) was prebuilt for a
// different Node ABI than the one currently running — typically after a
// `nvm use` to a new major or a pnpm install on a different machine.
//
// Detection: locate each native addon's `.node` file (hoisted or pnpm
// layout) and try `process.dlopen` on it. That's exactly what fails at
// runtime, so this is the most accurate possible test — and it works
// without the addon being resolvable from the repo root (under pnpm it
// isn't).
//
// Rebuild: `pnpm rebuild <pkg>` is a silent no-op under pnpm 11 once a
// package is already "built" in the store. Instead we run the package's
// own install script — `prebuild-install -r node || node-gyp rebuild
// --release` — inside the package dir. That's the same chain better-
// sqlite3's package.json declares for `install`.
//
// Verify: dlopen caches within a process — the first successful load
// sticks for the lifetime of the process and a re-dlopen of the same
// path returns the cached handle. So we re-verify in a child process.
//
// Runs after the exact Node 26.5.0 guard as part of postinstall and every
// runtime-sensitive pre-script, so the next command always sees a correctly
// versioned runtime and natively-loadable modules. Idempotent and ~50ms when
// everything is healthy.

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Module → relative `.node` path under its package root.
const NATIVE_MODULES = {
  "better-sqlite3": "build/Release/better_sqlite3.node",
};

const ABI_MISMATCH_RX =
  /NODE_MODULE_VERSION|was compiled against a different Node\.js version/i;

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function findPackageDir(modName) {
  let dir = REPO_ROOT;
  while (true) {
    const nm = path.join(dir, "node_modules");
    if (fs.existsSync(nm)) {
      const hoisted = path.join(nm, modName);
      if (fs.existsSync(path.join(hoisted, "package.json"))) return hoisted;

      const pnpmDir = path.join(nm, ".pnpm");
      if (fs.existsSync(pnpmDir)) {
        const candidates = fs
          .readdirSync(pnpmDir)
          .filter((d) => d.startsWith(`${modName}@`))
          .sort()
          .reverse();
        for (const c of candidates) {
          const p = path.join(pnpmDir, c, "node_modules", modName);
          if (fs.existsSync(path.join(p, "package.json"))) return p;
        }
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function tryDlopen(nodePath) {
  try {
    process.dlopen({ exports: {} }, nodePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

function classify(err) {
  const msg = (err && (err.message || String(err))) || "";
  if (err?.code === "ERR_DLOPEN_FAILED" || ABI_MISMATCH_RX.test(msg)) {
    return "abi-mismatch";
  }
  return "unknown";
}

function verifyInSubprocess(nodePath) {
  // dlopen is per-process — once a .node loads in our process it stays
  // cached. Spawn a fresh node to actually re-test the binary.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `process.dlopen({exports:{}}, ${JSON.stringify(nodePath)})`,
    ],
    { encoding: "utf8" },
  );
  if (result.status === 0) return { ok: true };
  return {
    ok: false,
    err: new Error(result.stderr || `exit ${result.status}`),
  };
}

function rebuildPackage(pkgDir) {
  // Mirror the package's own `install` script: prebuild first, source
  // build as fallback. Both binaries live in the package's bundled
  // node_modules so `pnpm exec` resolves them without a network round-trip.
  const prebuild = spawnSync(
    "pnpm",
    ["exec", "prebuild-install", "-r", "node"],
    { cwd: pkgDir, stdio: "inherit", env: process.env },
  );
  if (prebuild.status === 0) return { ok: true, via: "prebuild-install" };

  console.warn(
    "[ensure-native] prebuild-install failed, falling back to node-gyp…",
  );
  const gyp = spawnSync(
    "pnpm",
    ["exec", "node-gyp", "rebuild", "--release"],
    { cwd: pkgDir, stdio: "inherit", env: process.env },
  );
  if (gyp.status === 0) return { ok: true, via: "node-gyp" };
  return { ok: false };
}

// ── main ──────────────────────────────────────────────────────────────

const toRebuild = [];
const fatal = [];

for (const [mod, rel] of Object.entries(NATIVE_MODULES)) {
  const pkgDir = findPackageDir(mod);
  if (!pkgDir) {
    fatal.push({
      mod,
      hint: "package not installed — run `pnpm install`",
    });
    continue;
  }
  const nodePath = path.join(pkgDir, rel);
  if (!fs.existsSync(nodePath)) {
    toRebuild.push({ mod, pkgDir, nodePath });
    console.warn(
      `[ensure-native] ${mod}: binary missing at ${rel}, will build`,
    );
    continue;
  }
  const probe = tryDlopen(nodePath);
  if (probe.ok) continue;

  if (classify(probe.err) === "abi-mismatch") {
    toRebuild.push({ mod, pkgDir, nodePath });
    console.warn(
      `[ensure-native] ${mod}: ABI mismatch for Node ${process.version}, will rebuild`,
    );
  } else {
    fatal.push({
      mod,
      hint: "unexpected dlopen failure",
      err: probe.err,
    });
  }
}

if (fatal.length > 0) {
  for (const { mod, hint, err } of fatal) {
    console.error(`[ensure-native] ${mod}: ${hint}`);
    if (err) console.error(err);
  }
  process.exit(1);
}

if (toRebuild.length === 0) {
  process.exit(0);
}

for (const { mod, pkgDir, nodePath } of toRebuild) {
  // Remove the stale binary so prebuild-install / node-gyp produce a
  // genuinely new file (and a failure surfaces as a missing binary
  // instead of looking like success).
  try {
    fs.rmSync(nodePath, { force: true });
  } catch {
    // ignore — the next step will report any real problem
  }

  console.log(
    `[ensure-native] rebuilding ${mod} against Node ${process.version}…`,
  );
  const built = rebuildPackage(pkgDir);
  if (!built.ok) {
    console.error(
      `[ensure-native] rebuild failed for ${mod}. Run \`nvm install 26.5.0 && nvm use 26.5.0\` and retry.`,
    );
    process.exit(1);
  }

  if (!fs.existsSync(nodePath)) {
    console.error(
      `[ensure-native] ${mod}: rebuild reported success but ${nodePath} is missing.`,
    );
    process.exit(1);
  }

  const verify = verifyInSubprocess(nodePath);
  if (!verify.ok) {
    console.error(
      `[ensure-native] ${mod} still fails to load after rebuild (via ${built.via}):`,
      verify.err,
    );
    process.exit(1);
  }
  console.log(
    `[ensure-native] ${mod} rebuilt via ${built.via} and verified for Node ${process.version}`,
  );
}
