/**
 * TC-25 — P3-RT-08 tenant-loader.
 *
 * Pure-unit: writes a fake `data/tenants/<slug>/<version>/` fixture to a
 * temp dir, points AGENTIC_TENANTS_DIR at it, and asserts:
 *   - `listTenantVersions()` discovers it.
 *   - `loadTenant()` resolves the registry's default export.
 *   - `resolveLiveVersion()` falls back to the highest-sorted dir when no
 *     `deployments` row is set.
 *
 * No api server boot; no DB writes. Keeps the test fast + isolated.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

let tmpRoot: string;
const ORIGINAL_TENANTS_DIR = process.env.AGENTIC_TENANTS_DIR;

beforeAll(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-tenants-"));
  process.env.AGENTIC_TENANTS_DIR = tmpRoot;
});

afterAll(async () => {
  if (ORIGINAL_TENANTS_DIR === undefined) {
    delete process.env.AGENTIC_TENANTS_DIR;
  } else {
    process.env.AGENTIC_TENANTS_DIR = ORIGINAL_TENANTS_DIR;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe("TC-25: P3-RT-08 tenant-loader", () => {
  it("listTenantVersions discovers <slug>/<version>/agentic.json fixtures", async () => {
    const slug = "fixture-a";
    const version = "0.1.0";
    const dir = path.join(tmpRoot, slug, version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "agentic.json"),
      JSON.stringify({ slug, name: "Fixture A", schemaVersion: 1 }),
    );

    const { listTenantVersions } = await import("@agentic/runtime");
    const all = await listTenantVersions();
    const match = all.find((x) => x.slug === slug && x.version === version);
    expect(match).toBeDefined();
    expect(match?.dir).toBe(dir);
  });

  it("loadTenant reads agentic.json and imports the registry entrypoint", async () => {
    const slug = "fixture-b";
    const version = "1.2.3";
    const dir = path.join(tmpRoot, slug, version);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "agentic.json"),
      JSON.stringify({
        slug,
        name: "Fixture B",
        schemaVersion: 1,
        code: { registry: "registry.mjs" },
      }),
    );
    // Plain ESM JS so we don't need TS transformation in the test path.
    await fs.writeFile(
      path.join(dir, "registry.mjs"),
      `export default { tools: { hello: { kind: "tool", name: "hello", async handler() { return { data: "hi" }; } } } };`,
    );

    const { loadTenant } = await import("@agentic/runtime");
    const loaded = await loadTenant(slug, version);
    expect(loaded).toBeTruthy();
    expect(loaded?.manifest.slug).toBe(slug);
    expect(loaded?.registry).toBeTruthy();
    expect(loaded?.registry?.tools?.hello).toBeDefined();
    expect(loaded?.registry?.tools?.hello?.name).toBe("hello");
  });

  it("loadTenant returns null when agentic.json is missing", async () => {
    const { loadTenant } = await import("@agentic/runtime");
    const missing = await loadTenant("does-not-exist", "9.9.9");
    expect(missing).toBeNull();
  });

  it("resolveLiveVersion falls back to the highest semantic version when no deployment row", async () => {
    const slug = "fixture-c";
    for (const v of ["0.1.0", "0.2.0", "0.10.0"]) {
      const dir = path.join(tmpRoot, slug, v);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "agentic.json"),
        JSON.stringify({ slug, schemaVersion: 1 }),
      );
    }
    const { resolveLiveVersion } = await import("@agentic/runtime");
    // The filesystem fallback follows semantic-version precedence as well as
    // the deployment path, so 0.10.0 correctly wins over 0.2.0.
    const v = await resolveLiveVersion(slug);
    expect(v).toBe("0.10.0");
  });

  it("dataTenantsRoot honors AGENTIC_TENANTS_DIR", async () => {
    const { dataTenantsRoot } = await import("@agentic/runtime");
    expect(dataTenantsRoot()).toBe(tmpRoot);
  });
});
