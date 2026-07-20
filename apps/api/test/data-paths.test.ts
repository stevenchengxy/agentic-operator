import { describe, expect, it } from "vitest";
import path from "node:path";
import { ensureCanonicalDataPaths } from "../src/config/data-paths";

describe("canonical API data paths", () => {
  it("derives every durable store from a relative SQLite DATABASE_URL", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "file:../../data/agentic.db",
    };
    const cwd = "/workspace/apps/api";

    const result = ensureCanonicalDataPaths(env, cwd);

    expect(result.dataRoot).toBe("/workspace/data");
    expect(result.source).toBe("DATABASE_URL");
    expect(env.AGENTIC_DATA_ROOT).toBe("/workspace/data");
    expect(env.AGENTIC_DATA_DIR).toBe("/workspace/data");
    expect(env.AGENTIC_TENANTS_DIR).toBe("/workspace/data/tenants");
  });

  it("preserves an explicit operator-owned data root", () => {
    const env: NodeJS.ProcessEnv = {
      DATABASE_URL: "file:../../data/agentic.db",
      AGENTIC_DATA_ROOT: "./durable",
      AGENTIC_DATA_DIR: "/staging/imports-root",
      AGENTIC_TENANTS_DIR: "/tenant-code",
    };
    const cwd = "/srv/operator";

    const result = ensureCanonicalDataPaths(env, cwd);

    expect(result.dataRoot).toBe(path.resolve(cwd, "durable"));
    expect(result.source).toBe("AGENTIC_DATA_ROOT");
    expect(env.AGENTIC_DATA_DIR).toBe("/staging/imports-root");
    expect(env.AGENTIC_TENANTS_DIR).toBe("/tenant-code");
  });

  it("uses the nearest workspace data directory when SQLite is not configured", () => {
    const env: NodeJS.ProcessEnv = {};
    const cwd = path.resolve(process.cwd());
    const result = ensureCanonicalDataPaths(env, cwd);
    const workspace = path.resolve(cwd, "../..");

    expect(result.dataRoot).toBe(path.join(workspace, "data"));
    expect(result.source).toBe("workspace");
  });
});
