/**
 * P4-TEST-06 — E2E: CLI init + deploy round-trip.
 *
 * Spawns the compiled CLI as a child process against the live api:
 *
 *   1. `agentic init e2edemo` scaffolds a fresh tenant under a temp cwd.
 *   2. Create the real empty tenant through the production API.
 *   3. `agentic deploy <tenantDir> --no-typecheck` uploads the source registry
 *      and then commits the manifest under that tenant.
 *   4. Assert both deployment lanes are live and publish TENANT_START.
 *   5. Prove the dynamically uploaded `exampleTool` ran by waiting for the
 *      scaffolded intakeEvent run to reach a terminal state.
 *
 * We invoke the CLI source through `tsx` rather than the built `dist/`
 * shim so the test doesn't depend on `pnpm --filter @agentic/cli run
 * build` having run first. This matches the CI step ordering — build
 * happens after typecheck/test, so e2e shouldn't assume dist/ exists.
 */

import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { apiFetch, API_BASE, waitFor } from "./helpers";

const repoRoot = path.resolve(__dirname, "../../..");
const cliDir = path.join(repoRoot, "apps", "cli");
const cliEntry = path.join(cliDir, "src", "cli.ts");
// tsx lives under the cli workspace's node_modules in our pnpm layout
// (workspace-local deps), not the repo root.
const tsxBin = path.join(cliDir, "node_modules", ".bin", "tsx");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const proc = spawn(tsxBin, [cliEntry, ...args], {
      cwd,
      env: {
        ...process.env,
        AGENTIC_API_URL: API_BASE,
        AGENTIC_API_TOKEN: process.env.AGENTIC_API_TOKEN ?? "",
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    proc.stdout.on("data", (b: Buffer) => out.push(b.toString()));
    proc.stderr.on("data", (b: Buffer) => err.push(b.toString()));
    proc.on("close", (code) =>
      resolve({ code: code ?? -1, stdout: out.join(""), stderr: err.join("") }),
    );
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

test.describe("P4-TEST-06: CLI init + deploy round-trip E2E", () => {
  // Slug is shared across tests within this describe so the deploy
  // test reuses the directory the init test produced. Computed once at
  // module load — Playwright re-loads the module per worker process,
  // but the slug only needs to be unique per-suite run.
  const slug = `e2edemo${Date.now().toString(36).slice(-5)}`;
  let cwd: string;
  let deployedVersion = "";

  test.beforeAll(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "agentic-e2e-"));
    const created = await apiFetch("/v1/tenants", {
      method: "POST",
      body: JSON.stringify({
        slug,
        name: `CLI E2E ${slug}`,
        starter: "empty",
        mintToken: false,
      }),
    });
    expect(created.status).toBe(201);
    if (!created.body.ok) {
      throw new Error(
        `tenant create failed: ${created.body.error.code} — ${created.body.error.message}`,
      );
    }
  });

  test.afterAll(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true });
  });

  test("init scaffolds the expected file tree", async () => {
    const r = await runCli(["init", slug], cwd);
    expect(r.code, `stderr=${r.stderr}\nstdout=${r.stdout}`).toBe(0);
    const tenantDir = path.join(cwd, "data", "tenants", slug);
    const modelsDir = path.join(cwd, "models", `${slug}-v1`);
    expect(await exists(path.join(tenantDir, "agentic.json"))).toBe(true);
    expect(await exists(path.join(tenantDir, "package.json"))).toBe(true);
    expect(await exists(path.join(modelsDir, "workflow_v1.json"))).toBe(true);
    expect(await exists(path.join(modelsDir, "actions_v1.json"))).toBe(true);
    expect(await exists(path.join(modelsDir, "events_v1.json"))).toBe(true);
  });

  test("deploy POSTs the manifest and surfaces version + diff", async () => {
    const tenantDir = path.join(cwd, "data", "tenants", slug);

    const r = await runCli(
      [
        "deploy",
        tenantDir,
        "--no-typecheck",
        "--api",
        API_BASE,
        "--note",
        "P4-TEST-06 e2e",
      ],
      cwd,
    );
    expect(r.code, `stderr=${r.stderr}\nstdout=${r.stdout}`).toBe(0);
    const version = r.stdout.match(/Deployed (auto-[a-f0-9]{8})/)?.[1];
    expect(version).toBeTruthy();
    deployedVersion = version ?? "";
  });

  test("post-deploy: the new workflow_version is queryable via /v1/deployments", async () => {
    // The scaffolded agent's slug is in `models/${slug}-v1/workflow_v1.json`.
    // The default workflowSlug used by `agentic deploy` is `${tenantSlug}-default`.
    const deps = await apiFetch<{
      list: Array<{
        versionId: string;
        versionString: string;
        workflowSlug: string;
        status: string;
      }>;
      live: { id: string; versionString: string } | null;
    }>("/v1/deployments", { tenantSlug: slug });
    expect(deps.status).toBe(200);
    if (!deps.body.ok) throw new Error("deployments fetch failed");
    const deployed = deps.body.data.list.find(
      (entry) => entry.versionString === deployedVersion && entry.status === "live",
    );
    expect(deployed).toBeDefined();
    const codeDeployment = deps.body.data.list.find(
      (entry) =>
        entry.workflowSlug === "__tenant_code__" && entry.status === "live",
    );
    expect(codeDeployment).toBeDefined();
    expect(codeDeployment?.versionString).toMatch(/^v1-[a-f0-9]{12}$/);
  });

  test("post-deploy: uploaded registry executes through the real event runtime", async () => {
    const agents = await apiFetch<Array<{ name: string; enabled: boolean }>>(
      "/v1/agents?kind=manifest",
      { tenantSlug: slug },
    );
    expect(agents.status).toBe(200);
    if (!agents.body.ok) throw new Error("agents fetch failed");
    expect(agents.body.data.some((agent) => agent.name === "intakeEvent" && agent.enabled)).toBe(
      true,
    );

    const subject = `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const ingest = await apiFetch<{ event_id: string }>("/v1/events", {
      method: "POST",
      tenantSlug: slug,
      body: JSON.stringify({
        name: "TENANT_START",
        subject,
        payload: { source: "cli-e2e" },
      }),
    });
    expect(ingest.status).toBe(200);
    if (!ingest.body.ok) {
      throw new Error(
        `event ingest failed: ${ingest.body.error.code} — ${ingest.body.error.message}`,
      );
    }

    const run = await waitFor(
      async () => {
        const runs = await apiFetch<Array<{
          id: string;
          agentName: string;
          subject: string | null;
          status: string;
        }>>("/v1/runs?agent=intakeEvent&limit=20", { tenantSlug: slug });
        if (!runs.body.ok) return null;
        return (
          runs.body.data.find(
            (candidate) =>
              candidate.subject === subject &&
              (candidate.status === "ok" || candidate.status === "failed"),
          ) ?? null
        );
      },
      { timeoutMs: 30_000, intervalMs: 500, label: "CLI tenant registry run" },
    );
    expect(run.agentName).toBe("intakeEvent");
    expect(run.status).toBe("ok");
  });

  test("agentic --version reports a semver string", async () => {
    const r = await runCli(["--version"], cwd);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^agentic \d+\.\d+\.\d+/);
  });

  test("agentic --help lists the four primary commands", async () => {
    const r = await runCli(["--help"], cwd);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("init");
    expect(r.stdout).toContain("deploy");
    expect(r.stdout).toContain("logs");
    expect(r.stdout).toContain("events");
  });
});
