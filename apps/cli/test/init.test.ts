/**
 * Tests for `agentic init <slug>` (P1-CLI-01).
 *
 * Drives the scaffolder function directly with a tmp cwd so we don't touch
 * the real workspace.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { scaffoldTenant, runInit } from "../src/commands/init.js";
import { parseArgs } from "../src/cli.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "agentic-init-test-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

describe("agentic init", () => {
  it("creates the expected file tree", async () => {
    const result = await scaffoldTenant({ slug: "demo", cwd, force: false });
    expect(result.tenantDir).toBe(path.join(cwd, "data", "tenants", "demo"));
    expect(result.modelsDir).toBe(path.join(cwd, "models", "demo-v1"));

    expect(await exists(path.join(result.tenantDir, "agentic.json"))).toBe(true);
    expect(await exists(path.join(result.tenantDir, "package.json"))).toBe(true);
    expect(await exists(path.join(result.tenantDir, "tsconfig.json"))).toBe(true);
    expect(await exists(path.join(result.tenantDir, "src", "index.ts"))).toBe(true);
    expect(
      await exists(path.join(result.tenantDir, "src", "tools", "example.ts")),
    ).toBe(true);
    expect(
      await exists(path.join(result.tenantDir, "src", "prompts", "example.ts")),
    ).toBe(true);
    expect(await exists(path.join(result.modelsDir, "workflow_v1.json"))).toBe(true);
    expect(await exists(path.join(result.modelsDir, "events_v1.json"))).toBe(true);
    expect(await exists(path.join(result.modelsDir, "actions_v1.json"))).toBe(true);

    // 9 files first run, 0 skipped
    expect(result.filesCreated).toHaveLength(9);
    expect(result.filesSkipped).toHaveLength(0);
  });

  it("emits valid JSON for agentic.json, package.json, and workflow_v1.json", async () => {
    const result = await scaffoldTenant({ slug: "alpha", cwd, force: false });
    const tenantManifest = JSON.parse(
      await readFile(path.join(result.tenantDir, "agentic.json"), "utf-8"),
    );
    expect(tenantManifest.slug).toBe("alpha");
    expect(tenantManifest.version).toBe("v1");
    expect(tenantManifest.manifestPath).toBe("models/alpha-v1");

    const pkg = JSON.parse(
      await readFile(path.join(result.tenantDir, "package.json"), "utf-8"),
    );
    expect(pkg.name).toBe("@tenants/alpha");
    expect(pkg.dependencies["@agentic/agent-sdk"]).toBe("workspace:*");

    const wf = JSON.parse(
      await readFile(path.join(result.modelsDir, "workflow_v1.json"), "utf-8"),
    );
    expect(Array.isArray(wf)).toBe(true);
    expect(wf.length).toBeGreaterThanOrEqual(2);
    expect(wf[0].trigger).toEqual(["TENANT_START"]);
    expect(wf[0].actions[0].type).toBe("tool");
    expect(wf[1].actions[0].type).toBe("logic");
  });

  it("is idempotent: second run reports skipped files", async () => {
    await scaffoldTenant({ slug: "again", cwd, force: false });
    const r2 = await scaffoldTenant({ slug: "again", cwd, force: false });
    expect(r2.filesCreated).toHaveLength(0);
    expect(r2.filesSkipped.length).toBeGreaterThan(0);
  });

  it("--force overwrites existing files", async () => {
    await scaffoldTenant({ slug: "force-me", cwd, force: false });
    const r2 = await scaffoldTenant({ slug: "force-me", cwd, force: true });
    expect(r2.filesCreated.length).toBeGreaterThan(0);
    expect(r2.filesSkipped).toHaveLength(0);
  });

  it("rejects invalid slugs", async () => {
    // Drive the CLI-style command through runInit with mocked context.
    const ctx = {
      args: parseArgs(["init", "BAD-SLUG"]),
      apiUrl: "http://localhost:3540",
      apiToken: "",
      stdout: {
        write: () => true,
      } as unknown as NodeJS.WritableStream,
      stderr: {
        write: () => true,
      } as unknown as NodeJS.WritableStream,
    };
    await expect(runInit(ctx)).rejects.toThrow(/invalid slug/);
  });
});
