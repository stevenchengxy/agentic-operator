/**
 * Shared filesystem helpers for the fs.* tool family.
 *
 * Data root resolution:
 *   1. `AGENTIC_DATA_ROOT` env var (absolute OR relative to cwd).
 *   2. Walk up from cwd until a `pnpm-workspace.yaml` neighbour appears —
 *      that's the repo root; `<root>/data` is the canonical location.
 *   3. `<cwd>/data` as a last resort. The api dev script runs with
 *      `cwd=apps/api`, so the resolved path matches `<repo>/data` only
 *      when the env var is set; the walk-up branch handles the dev case.
 */

import fs from "node:fs";
import path from "node:path";

export function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export function resolveDataRoot(
  environment: Record<string, string | undefined> = process.env,
): string {
  const env = environment.AGENTIC_DATA_ROOT;
  if (env && env.length > 0) {
    return path.isAbsolute(env) ? env : path.resolve(process.cwd(), env);
  }
  return path.resolve(findRepoRoot(), "data");
}

/**
 * `tenantSubdir(ctx, "resumes", "inbox")` → `<repo>/data/resumes/<tenant>/inbox`.
 * Mid-segments come from positional args; the tenant slug is always wedged
 * between the first and the rest so every fs tool ends up tenant-scoped.
 */
export function tenantSubdir(
  tenantSlug: string,
  topSegment: string,
  ...rest: string[]
): string {
  return path.join(resolveDataRoot(), topSegment, tenantSlug, ...rest);
}

/** Reject any filename that contains path separators, leading dots, or `..`. */
export function assertFlatFilename(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("filename: must be a non-empty string");
  }
  if (
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".") ||
    name.includes("..")
  ) {
    throw new Error(
      `filename: invalid '${name}'. Use a flat name with no path components and no leading dot.`,
    );
  }
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
