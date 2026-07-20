import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  listTenantVersions,
  loadTenant,
  TenantCodeIntegrityError,
} from "./tenant-loader";

let root = "";
let originalRoot: string | undefined;

async function writeManifest(
  slug: string,
  version: string,
  manifest: unknown,
): Promise<string> {
  const dir = path.join(root, slug, version);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "agentic.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
    "utf8",
  );
  return dir;
}

beforeEach(async () => {
  originalRoot = process.env.AGENTIC_TENANTS_DIR;
  root = await mkdtemp(path.join(tmpdir(), "tenant-loader-truth-"));
  process.env.AGENTIC_TENANTS_DIR = root;
});

afterEach(async () => {
  if (originalRoot === undefined) delete process.env.AGENTIC_TENANTS_DIR;
  else process.env.AGENTIC_TENANTS_DIR = originalRoot;
  await rm(root, { recursive: true, force: true });
});

describe("tenant loader truth", () => {
  it("orders disk versions numerically", async () => {
    for (const version of ["0.2.0", "0.10.0", "0.9.0"]) {
      await writeManifest("numeric", version, { slug: "numeric" });
    }
    const versions = (await listTenantVersions())
      .filter((entry) => entry.slug === "numeric")
      .map((entry) => entry.version);
    expect(versions).toEqual(["0.2.0", "0.9.0", "0.10.0"]);
  });

  it("returns null only for an absent manifest", async () => {
    await expect(loadTenant("missing", "1.0.0")).resolves.toBeNull();
  });

  it("rejects malformed JSON instead of translating it to an absent tenant", async () => {
    await writeManifest("broken", "1.0.0", "{not-json");
    await expect(loadTenant("broken", "1.0.0")).rejects.toBeInstanceOf(
      TenantCodeIntegrityError,
    );
  });

  it("rejects a manifest whose slug does not match its directory", async () => {
    await writeManifest("expected", "1.0.0", { slug: "different" });
    await expect(loadTenant("expected", "1.0.0")).rejects.toThrow(
      /slug=different mismatch/,
    );
  });

  it("rejects a declared registry that is missing or escapes the package", async () => {
    await writeManifest("missing-registry", "1.0.0", {
      slug: "missing-registry",
      code: { registry: "registry.mjs" },
    });
    await expect(loadTenant("missing-registry", "1.0.0")).rejects.toThrow(
      /registry file missing/,
    );

    await writeManifest("escape", "1.0.0", {
      slug: "escape",
      code: { registry: "../../../outside.mjs" },
    });
    await expect(loadTenant("escape", "1.0.0")).rejects.toThrow(
      /escapes the tenant package/,
    );
  });

  it("propagates non-ENOENT root scan errors", async () => {
    process.env.AGENTIC_TENANTS_DIR = "/dev/null";
    await expect(listTenantVersions()).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
