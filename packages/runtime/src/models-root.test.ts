import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveModelsRoot, shouldDiscoverModelFolder } from "./models-root";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), "agentic-model-root-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resolveModelsRoot", () => {
  it("gives an explicit configured directory priority and resolves relative values from cwd", () => {
    const cwd = tempRoot();
    expect(resolveModelsRoot({ AGENTIC_MODELS_DIR: "custom-models" }, cwd)).toBe(
      path.join(cwd, "custom-models"),
    );
  });

  it("walks upward to the nearest pnpm workspace containing models", () => {
    const root = tempRoot();
    writeFileSync(path.join(root, "pnpm-workspace.yaml"), "packages: []\n");
    mkdirSync(path.join(root, "models"));
    const nested = path.join(root, "packages", "runtime", "src");
    mkdirSync(nested, { recursive: true });
    expect(resolveModelsRoot({}, nested)).toBe(path.join(root, "models"));
  });

  it("returns null rather than falling back to a developer's absolute path", () => {
    const root = tempRoot();
    const nested = path.join(root, "unrelated", "cwd");
    mkdirSync(nested, { recursive: true });
    expect(resolveModelsRoot({}, nested)).toBeNull();
  });
});

describe("shouldDiscoverModelFolder", () => {
  it("filters sandbox and system-generated manifests outside tests", () => {
    expect(shouldDiscoverModelFolder("RAAS-v1", { NODE_ENV: "production" })).toBe(true);
    expect(shouldDiscoverModelFolder("RAAS-sb-v172", { NODE_ENV: "production" })).toBe(false);
    expect(shouldDiscoverModelFolder("__system-v1", { NODE_ENV: "development" })).toBe(false);
    expect(shouldDiscoverModelFolder("__system-v1", { NODE_ENV: "production" })).toBe(false);
    expect(shouldDiscoverModelFolder("tenant-test1-v99", { NODE_ENV: "production" })).toBe(false);
  });

  it("allows named test fixtures but requires explicit opt-in for sandbox outputs", () => {
    expect(shouldDiscoverModelFolder("RAAS-sb-v172", { NODE_ENV: "test" })).toBe(false);
    expect(shouldDiscoverModelFolder("RAAS-sb-v172", { NODE_ENV: "test", AGENTIC_INCLUDE_SANDBOX_MODELS: "1" })).toBe(true);
    expect(shouldDiscoverModelFolder("__system-v1", { NODE_ENV: "test" })).toBe(true);
    expect(shouldDiscoverModelFolder(".cache", { NODE_ENV: "test" })).toBe(false);
  });
});
