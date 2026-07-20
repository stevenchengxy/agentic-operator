import path from "node:path";
import { statSync } from "node:fs";

type PathKind = "file" | "directory";

function hasKind(candidate: string, kind: PathKind): boolean {
  try {
    const st = statSync(candidate);
    return kind === "file" ? st.isFile() : st.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the ontology-model root without any machine-specific fallback.
 *
 * An explicit AGENTIC_MODELS_DIR always wins (relative values resolve from cwd). Otherwise walk
 * from cwd to the filesystem root and accept the first directory that contains both the pnpm
 * workspace marker and a models directory. null means the process is not inside an Agentic
 * Operator workspace and no root was configured.
 */
export function resolveModelsRoot(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): string | null {
  const configured = env.AGENTIC_MODELS_DIR?.trim();
  if (configured) return path.resolve(cwd, configured);

  let cursor = path.resolve(cwd);
  for (;;) {
    if (
      hasKind(path.join(cursor, "pnpm-workspace.yaml"), "file") &&
      hasKind(path.join(cursor, "models"), "directory")
    ) {
      return path.join(cursor, "models");
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

/** Runtime/test output model folders must never be rediscovered by a real server bootstrap. */
export function shouldDiscoverModelFolder(
  folder: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!folder || folder.startsWith(".")) return false;
  // Factory sandbox outputs are execution artifacts, not deployable tenants.
  // Tests may opt in for a focused bootstrap assertion, but the ordinary API
  // harness must not silently promote every stale `*-sb-v*` directory.
  if (/-sb-v[^/]*$/i.test(folder)) {
    return env.NODE_ENV === "test" && env.AGENTIC_INCLUDE_SANDBOX_MODELS === "1";
  }
  if (env.NODE_ENV === "test") return true;
  return (
    !/^__system-v[^/]*$/i.test(folder) &&
    !/^tenant-test1-v[^/]*$/i.test(folder)
  );
}
