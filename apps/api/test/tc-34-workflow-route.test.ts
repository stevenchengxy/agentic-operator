/**
 * TC-34 — workflow route tests.
 *
 * Covers `apps/api/src/routes/v1/workflow.ts`:
 *   GET  /v1/workflow/schema           returns the JSON Schema
 *   GET  /v1/tenants/:slug/workflow    returns manifest + version metadata
 *   PUT  /v1/tenants/:slug/workflow    saves the manifest, two modes:
 *     - mode: "new_version" (default) writes the next _vN+1 file
 *     - mode: "overwrite" rewrites an existing file in place
 *     - rejects path traversal / unknown filename in overwrite mode
 *     - rejects bad manifest with Zod issue hint
 *
 * Strategy: copy `models/RAAS-v1` into a temp dir, point
 * `AGENTIC_MODELS_DIR` there, and let the route write into the temp dir
 * so no test pollutes the repo. The api process bootstrapped with the
 * real models dir at startup; the route reads env per-request, so the
 * tmp override takes effect immediately.
 *
 * Slug pinning: `setup.ts` sets `AGENTIC_DEV_TENANT=__system`. We override
 * here to `raas` so the auth plugin resolves to a tenant whose slug
 * matches the route param.
 */

import path from "node:path";
import { mkdir, cp, rm, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

// REG-S2-02: vitest singleFork shares one process across files, so mutating
// `process.env.AGENTIC_MODELS_DIR` at module-top-level poisoned every test
// that ran after this one (tc-7, tc-11, tc-33 cascade-failed). Use vi.stubEnv
// inside beforeAll + vi.unstubAllEnvs in afterAll so the override is scoped to
// this file's lifecycle. The workflow route reads env per-request, so the
// stub takes effect before the first fetch — no need to set it before
// `import()` of the server module.
const TMP_ROOT = path.join(tmpdir(), `tc34-workflow-${process.pid}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let env: any;

beforeAll(async () => {
  vi.stubEnv("AGENTIC_MODELS_DIR", TMP_ROOT);
  vi.stubEnv("AGENTIC_DEV_TENANT", "raas");

  // Copy the real RAAS-v1 folder into the temp models dir so the route's
  // findTenantDirs() finds something to read/write.
  const REAL_RAAS = path.resolve(
    __dirname,
    "..",
    "..",
    "..",
    "models",
    "RAAS-v1",
  );
  await mkdir(TMP_ROOT, { recursive: true });
  await cp(REAL_RAAS, path.join(TMP_ROOT, "RAAS-v1"), { recursive: true });

  const { buildTestEnv } = await import("./harness");
  env = await buildTestEnv();
});

afterAll(async () => {
  await rm(TMP_ROOT, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("TC-34: workflow route", () => {
  it("GET /v1/workflow/schema returns the editor-facing JSON Schema", async () => {
    const res = await env.fetch("/v1/workflow/schema");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.schema_version).toBeTypeOf("number");
    expect(body.data.schema.title).toContain("Workflow Manifest");
    // The schema must declare `actions` as a required key on each agent.
    expect(body.data.schema.items.required).toContain("actions");
  });

  it("GET /v1/tenants/raas/workflow returns manifest + version metadata", async () => {
    const res = await env.fetch("/v1/tenants/raas/workflow");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.folder).toBe("RAAS-v1");
    const versions = (await readdir(path.join(TMP_ROOT, "RAAS-v1")))
      .map((file) => file.match(/^workflow_v(\d+)\.json$/)?.[1])
      .filter((version): version is string => Boolean(version))
      .map(Number);
    const latestVersion = Math.max(...versions);
    expect(body.data.file).toBe(`workflow_v${latestVersion}.json`);
    expect(body.data.file_version).toBe(latestVersion);
    expect(body.data.schema_version).toBeTypeOf("number");
    expect(Array.isArray(body.data.manifest)).toBe(true);
    expect(body.data.manifest.length).toBeGreaterThan(0);
  });

  it("GET /v1/tenants/raas/workflow rejects cross-tenant access", async () => {
    const res = await env.fetch("/v1/tenants/some-other-tenant/workflow");
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("forbidden");
  });

  it("PUT new_version writes the next _vN file and returns mode echo", async () => {
    const get = await env.fetch("/v1/tenants/raas/workflow");
    const manifest = (await get.json()).data.manifest;

    const res = await env.fetch("/v1/tenants/raas/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, comment: "tc-34 new_version" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.mode).toBe("new_version");
    expect(body.data.file).toMatch(/^workflow_v\d+\.json$/);
    expect(body.data.file_version).toBeGreaterThan(1);
    expect(body.data.agent_count).toBe(manifest.length);

    // File on disk should exist.
    const files = await readdir(path.join(TMP_ROOT, "RAAS-v1"));
    expect(files).toContain(body.data.file);
  });

  it("PUT overwrite replaces an existing file in place and preserves the version number", async () => {
    const get = await env.fetch("/v1/tenants/raas/workflow");
    const data = (await get.json()).data;
    const manifest = data.manifest;
    const beforePath = path.join(TMP_ROOT, "RAAS-v1", data.file);
    const before = await readFile(beforePath, "utf8");

    // Make a benign edit so we can confirm the file actually changed.
    const edited = manifest.map((a: Record<string, unknown>, i: number) =>
      i === 0 ? { ...a, description: "tc-34 overwrite marker" } : a,
    );

    const res = await env.fetch("/v1/tenants/raas/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest: edited,
        mode: "overwrite",
        target_file: data.file,
        comment: "tc-34 overwrite",
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.mode).toBe("overwrite");
    expect(body.data.file).toBe(data.file);
    expect(body.data.file_version).toBe(data.file_version);

    const after = await readFile(beforePath, "utf8");
    expect(after).not.toBe(before);
    expect(after).toContain("tc-34 overwrite marker");
  });

  it("PUT overwrite rejects a nonexistent target_file (404)", async () => {
    const manifest = (await (await env.fetch("/v1/tenants/raas/workflow")).json())
      .data.manifest;
    const res = await env.fetch("/v1/tenants/raas/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest,
        mode: "overwrite",
        target_file: "workflow_v999.json",
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("not_found");
  });

  it("PUT overwrite rejects a path-traversal target_file (400)", async () => {
    const manifest = (await (await env.fetch("/v1/tenants/raas/workflow")).json())
      .data.manifest;
    const res = await env.fetch("/v1/tenants/raas/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        manifest,
        mode: "overwrite",
        target_file: "../../etc/passwd",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
  });

  it("PUT overwrite requires target_file", async () => {
    const manifest = (await (await env.fetch("/v1/tenants/raas/workflow")).json())
      .data.manifest;
    const res = await env.fetch("/v1/tenants/raas/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, mode: "overwrite" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("bad_request");
  });

  it("PUT rejects a manifest that fails Zod validation", async () => {
    // Missing required `actor`/`trigger`/etc on the only agent.
    const badManifest = [{ id: "x", name: "bad" }];
    const res = await env.fetch("/v1/tenants/raas/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest: badManifest }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_manifest");
    expect(body.error.hint).toBeDefined();
  });

  it("PUT rejects cross-tenant writes (403)", async () => {
    const manifest = (await (await env.fetch("/v1/tenants/raas/workflow")).json())
      .data.manifest;
    const res = await env.fetch("/v1/tenants/wrong-tenant/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest }),
    });
    expect(res.status).toBe(403);
  });

  it("PUT new_version a second time picks the *next* available version", async () => {
    const manifest = (await (await env.fetch("/v1/tenants/raas/workflow")).json())
      .data.manifest;
    // Plant a workflow_v50.json so we can assert the picker chooses v51.
    await writeFile(
      path.join(TMP_ROOT, "RAAS-v1", "workflow_v50.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    const res = await env.fetch("/v1/tenants/raas/workflow", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, mode: "new_version" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.file).toBe("workflow_v51.json");
    expect(body.data.file_version).toBe(51);
  });
});
