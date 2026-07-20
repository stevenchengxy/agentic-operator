/**
 * `agentic deploy [path]` — tenant code + manifest deploy (P1-CLI-02).
 *
 * Steps:
 *   1. Locate the tenant root: `[path]` arg (defaults to cwd) must contain
 *      `agentic.json`.
 *   2. Read `agentic.json` → `manifestPath` (relative to repo root).
 *   3. Read `models/<slug>-v1/workflow_v1.json` + `actions_v1.json`.
 *   4. Run `tsc --noEmit` on the tenant's TS code so a broken handler can't
 *      land in prod. Skipped with `--no-typecheck`.
 *   5. Package and upload the declared tenant registry to
 *      `/v1/tenants/:slug/code`, activating the real code before the manifest.
 *   6. POST the manifest to `/v1/agents`. Server returns
 *      `{ workflow_version_id, version, diff, note }`.
 *   7. Pretty-print the diff (added/modified/removed agents). If the manifest
 *      commit fails, compensate the code activation back to the exact prior
 *      deployment (or withdraw the first deployment).
 *
 * Flags:
 *   --no-typecheck       Skip step 4 (useful in CI where types ran separately)
 *   --note <text>        Deployment note (audit log + UI)
 */
import { readFile, access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import type { RunContext } from "../cli.js";
import { createTenantCodeArchive } from "../tenant-code-archive.js";

interface AgenticJson {
  slug: string;
  name?: string;
  version?: string;
  manifestPath?: string;
  code?: { registry?: string };
  description?: string;
}

interface DeployOptions {
  tenantRoot: string;
  noTypecheck: boolean;
  note?: string;
}

interface ApiOkPayload {
  workflow_version_id: string;
  version: string;
  diff: {
    added: string[];
    modified: string[];
    removed: string[];
    prior_version: string | null;
  };
  note: string;
}

interface ApiOk<T> {
  ok: true;
  data: T;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string; hint?: string };
}

interface DeploymentListPayload {
  list: Array<{
    id: string;
    versionString: string;
    status: "live" | "rolled_back" | "pending";
    workflowSlug: string;
  }>;
}

interface TenantCodeUploadPayload {
  deployment_id: string;
  slug: string;
  version: string;
  inngest_fns: number;
}

interface CodeActivation {
  changed: boolean;
  deploymentId: string | null;
  priorLiveId: string | null;
  version: string;
  fileCount: number;
  uncompressedBytes: number;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function parseDeployOptions(ctx: RunContext): DeployOptions {
  const arg = ctx.args.positional[0];
  return {
    tenantRoot: path.resolve(process.cwd(), arg ?? "."),
    noTypecheck: ctx.args.flags["no-typecheck"] === true,
    note:
      typeof ctx.args.flags["note"] === "string"
        ? (ctx.args.flags["note"] as string)
        : undefined,
  };
}

async function readTenantManifest(
  tenantRoot: string,
): Promise<AgenticJson> {
  const p = path.join(tenantRoot, "agentic.json");
  if (!(await exists(p))) {
    throw new Error(
      `deploy: no agentic.json at ${p}. Pass a tenant path or cd into one. Bootstrap with 'agentic init <slug>'.`,
    );
  }
  const raw = await readFile(p, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `deploy: ${p} is not valid JSON: ${err instanceof Error ? err.message : err}`,
    );
  }
  const m = parsed as AgenticJson;
  if (!m.slug) throw new Error(`deploy: ${p} missing required field "slug"`);
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(m.slug)) {
    throw new Error(`deploy: ${p} has invalid tenant slug "${m.slug}"`);
  }
  if (m.code?.registry) {
    const registry = path.resolve(tenantRoot, m.code.registry);
    const relative = path.relative(tenantRoot, registry);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error(
        `deploy: code.registry escapes the tenant package: ${m.code.registry}`,
      );
    }
    if (!(await exists(registry))) {
      throw new Error(`deploy: code.registry not found at ${registry}`);
    }
  }
  return m;
}

function resolveRepoRoot(tenantRoot: string): string {
  // tenantRoot is .../data/tenants/<slug>; repo root is ../../..
  const parts = tenantRoot.split(path.sep);
  for (let i = parts.length - 1; i >= 2; i--) {
    if (parts[i - 1] === "tenants" && parts[i - 2] === "data") {
      return parts.slice(0, i - 2).join(path.sep) || path.sep;
    }
  }
  // Fallback: caller is running from a non-standard location. Use cwd.
  return process.cwd();
}

async function readWorkflow(repoRoot: string, manifestPath: string): Promise<{
  workflow: unknown[];
  actions: unknown[] | null;
}> {
  const wfPath = path.join(repoRoot, manifestPath, "workflow_v1.json");
  const acPath = path.join(repoRoot, manifestPath, "actions_v1.json");
  if (!(await exists(wfPath))) {
    throw new Error(`deploy: workflow not found at ${wfPath}`);
  }
  const workflow = JSON.parse(await readFile(wfPath, "utf-8")) as unknown[];
  if (!Array.isArray(workflow)) {
    throw new Error(`deploy: ${wfPath} is not a JSON array of agents`);
  }
  let actions: unknown[] | null = null;
  if (await exists(acPath)) {
    const a = JSON.parse(await readFile(acPath, "utf-8")) as unknown;
    if (a && typeof a === "object" && "actions" in a) {
      const wrapped = (a as { actions?: unknown }).actions;
      if (!Array.isArray(wrapped)) {
        throw new Error(`deploy: ${acPath} field "actions" must be a JSON array`);
      }
      actions = wrapped;
    } else if (Array.isArray(a)) {
      actions = a;
    } else {
      throw new Error(`deploy: ${acPath} must be a JSON array or { "actions": [...] }`);
    }
  }
  return { workflow, actions };
}

async function runTsc(tenantRoot: string): Promise<{ ok: boolean; output: string }> {
  const tsconfig = path.join(tenantRoot, "tsconfig.json");
  if (!(await exists(tsconfig))) {
    return { ok: true, output: "(no tsconfig.json; skipping typecheck)" };
  }
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsc", "--noEmit", "-p", tsconfig], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: tenantRoot,
    });
    let buf = "";
    child.stdout?.on("data", (b) => {
      buf += b.toString();
    });
    child.stderr?.on("data", (b) => {
      buf += b.toString();
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, output: buf.trim() });
    });
    child.on("error", (err) => {
      resolve({ ok: false, output: `tsc failed to launch: ${err.message}` });
    });
  });
}

function requestHeaders(
  ctx: RunContext,
  tenantSlug: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "x-agentic-tenant": tenantSlug,
  };
  if (ctx.apiToken) headers.Authorization = `Bearer ${ctx.apiToken}`;
  return headers;
}

async function apiRequest<T>(
  ctx: RunContext,
  tenantSlug: string,
  apiPath: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(`${ctx.apiUrl}${apiPath}`, {
    method: init.method ?? "GET",
    headers: requestHeaders(ctx, tenantSlug),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  let parsed: ApiOk<T> | ApiErr;
  try {
    parsed = (await res.json()) as ApiOk<T> | ApiErr;
  } catch {
    throw new Error(`deploy: api returned ${res.status} with non-JSON body`);
  }
  if (!res.ok || !parsed.ok) {
    if (!parsed.ok) {
      throw new Error(`deploy: ${parsed.error.code} — ${parsed.error.message}`);
    }
    throw new Error(`deploy: api returned unexpected HTTP ${res.status}`);
  }
  return parsed.data;
}

async function postManifest(
  ctx: RunContext,
  tenantSlug: string,
  body: {
    manifest: unknown[];
    actions: unknown[] | null;
    note?: string;
  },
): Promise<ApiOkPayload> {
  return apiRequest<ApiOkPayload>(ctx, tenantSlug, "/v1/agents", {
    method: "POST",
    body: {
      manifest: body.manifest,
      actions: body.actions ?? [],
      note: body.note,
    },
  });
}

function tenantCodeVersion(manifest: AgenticJson, sha256: string): string {
  const base = manifest.version?.trim() || "v1";
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    throw new Error(
      `deploy: agentic.json version "${base}" must contain only alnum/./_/-`,
    );
  }
  if (base.length > 51) {
    throw new Error(
      "deploy: agentic.json version is too long for a content-addressed release (max 51 characters)",
    );
  }
  return `${base}-${sha256.slice(0, 12)}`;
}

async function activateTenantCode(
  ctx: RunContext,
  tenantRoot: string,
  manifest: AgenticJson,
  note?: string,
): Promise<CodeActivation | null> {
  if (!manifest.code?.registry) return null;

  const archive = await createTenantCodeArchive(tenantRoot);
  const version = tenantCodeVersion(manifest, archive.sha256);
  const deployments = await apiRequest<DeploymentListPayload>(
    ctx,
    manifest.slug,
    "/v1/deployments",
  );
  const codeLane = deployments.list.filter(
    (entry) => entry.workflowSlug === "__tenant_code__",
  );
  const priorLive = codeLane.find((entry) => entry.status === "live") ?? null;

  if (priorLive?.versionString === version) {
    return {
      changed: false,
      deploymentId: priorLive.id,
      priorLiveId: priorLive.id,
      version,
      fileCount: archive.fileCount,
      uncompressedBytes: archive.uncompressedBytes,
    };
  }

  const historical = codeLane.find(
    (entry) =>
      entry.versionString === version && entry.status === "rolled_back",
  );
  if (historical) {
    await apiRequest(ctx, manifest.slug, `/v1/deployments/${historical.id}/rollback`, {
      method: "POST",
      body: {},
    });
    return {
      changed: true,
      deploymentId: historical.id,
      priorLiveId: priorLive?.id ?? null,
      version,
      fileCount: archive.fileCount,
      uncompressedBytes: archive.uncompressedBytes,
    };
  }

  const uploaded = await apiRequest<TenantCodeUploadPayload>(
    ctx,
    manifest.slug,
    `/v1/tenants/${encodeURIComponent(manifest.slug)}/code`,
    {
      method: "POST",
      body: {
        version,
        tarballBase64: archive.tarball.toString("base64"),
        note,
      },
    },
  );
  if (uploaded.slug !== manifest.slug || uploaded.version !== version) {
    throw new Error(
      `deploy: tenant-code API returned mismatched activation ${uploaded.slug}@${uploaded.version}`,
    );
  }
  return {
    changed: true,
    deploymentId: uploaded.deployment_id,
    priorLiveId: priorLive?.id ?? null,
    version,
    fileCount: archive.fileCount,
    uncompressedBytes: archive.uncompressedBytes,
  };
}

async function compensateTenantCode(
  ctx: RunContext,
  tenantSlug: string,
  activation: CodeActivation,
): Promise<void> {
  if (!activation.changed || !activation.deploymentId) return;
  if (activation.priorLiveId) {
    await apiRequest(
      ctx,
      tenantSlug,
      `/v1/deployments/${activation.priorLiveId}/rollback`,
      { method: "POST", body: {} },
    );
    return;
  }
  await apiRequest(
    ctx,
    tenantSlug,
    `/v1/tenants/${encodeURIComponent(tenantSlug)}/code/${encodeURIComponent(activation.deploymentId)}`,
    {
      method: "DELETE",
      body: { confirmVersion: activation.version },
    },
  );
}

export async function runDeploy(ctx: RunContext): Promise<number> {
  const opts = parseDeployOptions(ctx);
  const manifest = await readTenantManifest(opts.tenantRoot);
  const repoRoot = resolveRepoRoot(opts.tenantRoot);
  const manifestPath = manifest.manifestPath ?? `models/${manifest.slug}-v1`;

  ctx.stdout.write(`Deploying tenant "${manifest.slug}"\n`);
  ctx.stdout.write(`  manifest:  ${manifestPath}\n`);

  if (!opts.noTypecheck) {
    ctx.stdout.write("  typecheck: ");
    const tsc = await runTsc(opts.tenantRoot);
    if (!tsc.ok) {
      ctx.stdout.write("FAILED\n\n");
      ctx.stderr.write(tsc.output + "\n");
      ctx.stderr.write(
        "\ndeploy: aborting due to typecheck failure. Re-run with --no-typecheck to bypass.\n",
      );
      return 1;
    }
    ctx.stdout.write("ok\n");
  } else {
    ctx.stdout.write("  typecheck: skipped (--no-typecheck)\n");
  }

  const { workflow, actions } = await readWorkflow(repoRoot, manifestPath);
  ctx.stdout.write(`  agents:    ${workflow.length}\n`);

  let codeActivation: CodeActivation | null = null;
  if (manifest.code?.registry) {
    ctx.stdout.write("  code:      packaging and activating… ");
    const activation = await activateTenantCode(
      ctx,
      opts.tenantRoot,
      manifest,
      opts.note,
    );
    if (!activation) {
      throw new Error("deploy: declared tenant registry was not packaged");
    }
    codeActivation = activation;
    ctx.stdout.write(
      `${activation.changed ? "live" : "unchanged"} (${activation.fileCount} files, ${activation.version})\n`,
    );
  } else {
    ctx.stdout.write("  code:      no registry declared (manifest-only deploy)\n");
  }

  ctx.stdout.write("  manifest:  committing… ");
  let result: ApiOkPayload;
  try {
    result = await postManifest(ctx, manifest.slug, {
      manifest: workflow,
      actions,
      note: opts.note,
    });
  } catch (error) {
    ctx.stdout.write("FAILED\n");
    if (codeActivation?.changed) {
      ctx.stderr.write(
        "deploy: manifest commit failed; restoring the prior tenant-code activation…\n",
      );
      try {
        await compensateTenantCode(ctx, manifest.slug, codeActivation);
      } catch (compensationError) {
        throw new AggregateError(
          [error, compensationError],
          `deploy: manifest commit failed and tenant-code compensation also failed (${String((compensationError as Error)?.message ?? compensationError)})`,
        );
      }
    }
    throw error;
  }
  ctx.stdout.write("done\n\n");

  ctx.stdout.write(`Deployed ${result.version}\n`);
  ctx.stdout.write(`  workflow_version_id: ${result.workflow_version_id}\n`);
  if (codeActivation?.deploymentId) {
    ctx.stdout.write(`  tenant_code_version: ${codeActivation.version}\n`);
    ctx.stdout.write(`  tenant_code_deployment_id: ${codeActivation.deploymentId}\n`);
  }
  if (result.diff.added.length > 0) {
    ctx.stdout.write(`  + added (${result.diff.added.length}):    ${result.diff.added.join(", ")}\n`);
  }
  if (result.diff.modified.length > 0) {
    ctx.stdout.write(`  ~ modified (${result.diff.modified.length}): ${result.diff.modified.join(", ")}\n`);
  }
  if (result.diff.removed.length > 0) {
    ctx.stdout.write(`  - removed (${result.diff.removed.length}):  ${result.diff.removed.join(", ")}\n`);
  }
  if (result.note) ctx.stdout.write(`\n${result.note}\n`);
  return 0;
}
