/**
 * Tests for `agentic deploy [path]` (P1-CLI-02).
 *
 * Stubs `fetch` so we don't need apps/api running. The real `tsc` invocation
 * is skipped via `--no-typecheck` flag in tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runDeploy } from "../src/commands/deploy.js";
import { parseArgs } from "../src/cli.js";

let cwd: string;
let originalFetch: typeof fetch;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "agentic-deploy-test-"));
  originalFetch = globalThis.fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

async function setupTenant(slug: string, opts: { withCode?: boolean } = {}) {
  const repoRoot = path.join(cwd, "repo");
  const tenantDir = path.join(repoRoot, "data", "tenants", slug);
  const modelsDir = path.join(repoRoot, "models", `${slug}-v1`);
  await mkdir(tenantDir, { recursive: true });
  await mkdir(modelsDir, { recursive: true });
  await writeFile(
    path.join(tenantDir, "agentic.json"),
    JSON.stringify(
      {
        slug,
        version: "v1",
        manifestPath: `models/${slug}-v1`,
        ...(opts.withCode ? { code: { registry: "src/index.ts" } } : {}),
      },
      null,
      2,
    ),
  );
  if (opts.withCode) {
    await mkdir(path.join(tenantDir, "src"), { recursive: true });
    await writeFile(
      path.join(tenantDir, "src", "index.ts"),
      "export default { tools: {}, prompts: {} };\n",
    );
  }
  // Do NOT write tsconfig.json so tsc step is skipped naturally.
  await writeFile(
    path.join(modelsDir, "workflow_v1.json"),
    JSON.stringify(
      [
        {
          id: "1",
          name: "a1",
          actor: ["Agent"],
          trigger: ["X_HAPPENED"],
          actions: [{ order: "1", name: "tool1", type: "tool" }],
          triggered_event: ["A1_DONE"],
        },
      ],
      null,
      2,
    ),
  );
  await writeFile(
    path.join(modelsDir, "actions_v1.json"),
    JSON.stringify({ metadata: { version: "v1" }, actions: [] }, null, 2),
  );
  return { tenantDir };
}

function captureStream() {
  const chunks: string[] = [];
  return {
    write(s: string): boolean {
      chunks.push(s);
      return true;
    },
    get text(): string {
      return chunks.join("");
    },
  };
}

describe("agentic deploy", () => {
  it("POSTs the manifest to /v1/agents and prints the diff", async () => {
    const { tenantDir } = await setupTenant("delta");

    const calls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(
        JSON.stringify({
          ok: true,
          data: {
            workflow_version_id: "wfv-test",
            version: "upload-deadbeef",
            diff: {
              added: ["a1"],
              modified: [],
              removed: [],
              prior_version: null,
            },
            note: "deployed",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const stdout = captureStream();
    const stderr = captureStream();
    const code = await runDeploy({
      args: parseArgs(["deploy", tenantDir, "--no-typecheck", "--note", "first deploy"]),
      apiUrl: "http://api.test",
      apiToken: "tok",
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: stderr as unknown as NodeJS.WritableStream,
    });

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://api.test/v1/agents");
    const body = calls[0]!.body as {
      manifest: unknown[];
      note?: string;
    };
    expect(Array.isArray(body.manifest)).toBe(true);
    expect(body.manifest).toHaveLength(1);
    expect(body.note).toBe("first deploy");
    expect(stdout.text).toContain("Deployed upload-deadbeef");
    expect(stdout.text).toContain("+ added");
    expect(stdout.text).toContain("a1");
  });

  it("returns non-zero and surfaces server error", async () => {
    const { tenantDir } = await setupTenant("epsilon");
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "validation_failed", message: "missing required field" },
        }),
        { status: 400 },
      ),
    ) as unknown as typeof fetch;

    const stdout = captureStream();
    const stderr = captureStream();
    await expect(
      runDeploy({
        args: parseArgs(["deploy", tenantDir, "--no-typecheck"]),
        apiUrl: "http://api.test",
        apiToken: "",
        stdout: stdout as unknown as NodeJS.WritableStream,
        stderr: stderr as unknown as NodeJS.WritableStream,
      }),
    ).rejects.toThrow(/validation_failed/);
  });

  it("uploads declared tenant code before committing the manifest", async () => {
    const { tenantDir } = await setupTenant("coded", { withCode: true });
    const calls: Array<{ url: string; method: string; body: unknown; tenant: string | null }> = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const headers = new Headers(init?.headers);
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
        tenant: headers.get("x-agentic-tenant"),
      });
      if (url.endsWith("/v1/deployments")) {
        return Response.json({ ok: true, data: { list: [], live: null } });
      }
      if (url.endsWith("/v1/tenants/coded/code")) {
        const body = calls.at(-1)!.body as { version: string; tarballBase64: string };
        expect(body.version).toMatch(/^v1-[a-f0-9]{12}$/);
        expect(Buffer.from(body.tarballBase64, "base64").subarray(0, 2)).toEqual(
          Buffer.from([0x1f, 0x8b]),
        );
        return Response.json(
          {
            ok: true,
            data: {
              deployment_id: "dpl-code",
              slug: "coded",
              version: body.version,
              inngest_fns: 0,
            },
          },
          { status: 201 },
        );
      }
      if (url.endsWith("/v1/agents")) {
        return Response.json({
          ok: true,
          data: {
            workflow_version_id: "wfv-coded",
            version: "auto-deadbeef",
            diff: { added: ["a1"], modified: [], removed: [], prior_version: null },
            note: "live",
          },
        });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    const stdout = captureStream();
    const code = await runDeploy({
      args: parseArgs(["deploy", tenantDir, "--no-typecheck"]),
      apiUrl: "http://api.test",
      apiToken: "tok",
      stdout: stdout as unknown as NodeJS.WritableStream,
      stderr: captureStream() as unknown as NodeJS.WritableStream,
    });

    expect(code).toBe(0);
    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /v1/deployments",
      "POST /v1/tenants/coded/code",
      "POST /v1/agents",
    ]);
    expect(calls.every((call) => call.tenant === "coded")).toBe(true);
    expect(stdout.text).toContain("tenant_code_deployment_id: dpl-code");
  });

  it("withdraws a first code activation when manifest commit fails", async () => {
    const { tenantDir } = await setupTenant("undoable", { withCode: true });
    let uploadedVersion = "";
    const paths: string[] = [];
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const pathname = new URL(url).pathname;
      paths.push(`${init?.method ?? "GET"} ${pathname}`);
      if (pathname === "/v1/deployments") {
        return Response.json({ ok: true, data: { list: [], live: null } });
      }
      if (pathname === "/v1/tenants/undoable/code" && init?.method === "POST") {
        uploadedVersion = (JSON.parse(String(init.body)) as { version: string }).version;
        return Response.json(
          {
            ok: true,
            data: {
              deployment_id: "dpl-new",
              slug: "undoable",
              version: uploadedVersion,
              inngest_fns: 0,
            },
          },
          { status: 201 },
        );
      }
      if (pathname === "/v1/agents") {
        return Response.json(
          { ok: false, error: { code: "blocking_issues", message: "invalid manifest" } },
          { status: 400 },
        );
      }
      if (pathname === "/v1/tenants/undoable/code/dpl-new" && init?.method === "DELETE") {
        expect(JSON.parse(String(init.body))).toEqual({ confirmVersion: uploadedVersion });
        return Response.json({ ok: true, data: { deployment_id: "dpl-new", withdrawn: true } });
      }
      throw new Error(`unexpected URL ${url}`);
    }) as unknown as typeof fetch;

    await expect(
      runDeploy({
        args: parseArgs(["deploy", tenantDir, "--no-typecheck"]),
        apiUrl: "http://api.test",
        apiToken: "tok",
        stdout: captureStream() as unknown as NodeJS.WritableStream,
        stderr: captureStream() as unknown as NodeJS.WritableStream,
      }),
    ).rejects.toThrow(/blocking_issues/);
    expect(paths).toEqual([
      "GET /v1/deployments",
      "POST /v1/tenants/undoable/code",
      "POST /v1/agents",
      "DELETE /v1/tenants/undoable/code/dpl-new",
    ]);
  });

  it("errors out when no agentic.json is present", async () => {
    const orphanDir = path.join(cwd, "orphan");
    await mkdir(orphanDir, { recursive: true });
    const stdout = captureStream();
    const stderr = captureStream();
    await expect(
      runDeploy({
        args: parseArgs(["deploy", orphanDir]),
        apiUrl: "http://api.test",
        apiToken: "",
        stdout: stdout as unknown as NodeJS.WritableStream,
        stderr: stderr as unknown as NodeJS.WritableStream,
      }),
    ).rejects.toThrow(/no agentic\.json/);
  });
});
