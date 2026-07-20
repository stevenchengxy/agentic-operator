/**
 * `agentic init <slug>` — scaffold a tenant project (P1-CLI-01).
 *
 * Creates `data/tenants/<slug>/` (and `models/<slug>-v1/` if missing) with:
 *
 *   data/tenants/<slug>/
 *     agentic.json            tenant manifest (DESIGN §11.2)
 *     package.json            workspace package
 *     tsconfig.json
 *     src/
 *       index.ts              TenantRegistry export
 *       tools/example.ts      defineTool sample
 *       prompts/example.ts    definePrompt sample
 *   models/<slug>-v1/
 *     workflow_v1.json        2-agent demo workflow
 *     events_v1.json          declared event types
 *     actions_v1.json         action metadata (DESIGN §10.2)
 *
 * After scaffolding, `pnpm install` picks the new workspace up via the
 * `tenants/*` glob in `pnpm-workspace.yaml`.
 *
 * The `data/tenants/<slug>/` path is required by DESIGN §11.1 — Phase 3 will
 * move this from `tenants/` (workspace) into `data/tenants/<slug>` as part of
 * the per-tenant shipping work. The CLI plants the file tree in the canonical
 * v1 location.
 */
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import type { RunContext } from "../cli.js";

const SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;

interface InitOptions {
  slug: string;
  cwd: string;
  force: boolean;
}

function parseInitOptions(ctx: RunContext): InitOptions {
  const slug = ctx.args.positional[0];
  if (!slug) {
    throw new Error(
      "init: missing tenant slug. Usage: agentic init <slug>",
    );
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(
      `init: invalid slug "${slug}". Must match ${SLUG_RE.source} (lowercase, start with a letter, 2-40 chars).`,
    );
  }
  return {
    slug,
    cwd: (ctx.args.flags["cwd"] as string) ?? process.cwd(),
    force: ctx.args.flags["force"] === true,
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function writeIfAbsent(
  filePath: string,
  body: string,
  opts: { force: boolean },
): Promise<"created" | "skipped"> {
  if (!opts.force && (await exists(filePath))) return "skipped";
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, body, "utf-8");
  return "created";
}

export interface InitResult {
  tenantDir: string;
  modelsDir: string;
  filesCreated: string[];
  filesSkipped: string[];
}

export async function scaffoldTenant(opts: InitOptions): Promise<InitResult> {
  const tenantDir = path.join(opts.cwd, "data", "tenants", opts.slug);
  const modelsDir = path.join(opts.cwd, "models", `${opts.slug}-v1`);

  const files: Array<{ path: string; body: string }> = [
    {
      path: path.join(tenantDir, "agentic.json"),
      body: agenticJson(opts.slug),
    },
    {
      path: path.join(tenantDir, "package.json"),
      body: tenantPackageJson(opts.slug),
    },
    {
      path: path.join(tenantDir, "tsconfig.json"),
      body: tenantTsConfig(),
    },
    {
      path: path.join(tenantDir, "src", "index.ts"),
      body: tenantIndexTs(opts.slug),
    },
    {
      path: path.join(tenantDir, "src", "tools", "example.ts"),
      body: tenantExampleTool(),
    },
    {
      path: path.join(tenantDir, "src", "prompts", "example.ts"),
      body: tenantExamplePrompt(),
    },
    {
      path: path.join(modelsDir, "workflow_v1.json"),
      body: workflowV1(),
    },
    {
      path: path.join(modelsDir, "events_v1.json"),
      body: eventsV1(),
    },
    {
      path: path.join(modelsDir, "actions_v1.json"),
      body: actionsV1(),
    },
  ];

  const created: string[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    const r = await writeIfAbsent(f.path, f.body, { force: opts.force });
    if (r === "created") created.push(f.path);
    else skipped.push(f.path);
  }
  return { tenantDir, modelsDir, filesCreated: created, filesSkipped: skipped };
}

export async function runInit(ctx: RunContext): Promise<number> {
  const opts = parseInitOptions(ctx);
  const result = await scaffoldTenant(opts);

  ctx.stdout.write(`Scaffolded tenant "${opts.slug}"\n`);
  ctx.stdout.write(`  tenant: ${path.relative(opts.cwd, result.tenantDir)}\n`);
  ctx.stdout.write(`  models: ${path.relative(opts.cwd, result.modelsDir)}\n`);
  ctx.stdout.write(`  ${result.filesCreated.length} file(s) created`);
  if (result.filesSkipped.length > 0) {
    ctx.stdout.write(
      `, ${result.filesSkipped.length} already existed (use --force to overwrite)`,
    );
  }
  ctx.stdout.write("\n\nNext steps:\n");
  ctx.stdout.write(`  1. pnpm install            # picks up the new workspace\n`);
  ctx.stdout.write(`  2. pnpm dev                # boot api + web + inngest\n`);
  ctx.stdout.write(
    `  3. agentic deploy ${path.relative(opts.cwd, result.tenantDir)}\n`,
  );
  return 0;
}

// ─── Templates ───────────────────────────────────────────────────────────────

function agenticJson(slug: string): string {
  return (
    JSON.stringify(
      {
        slug,
        name: slug.charAt(0).toUpperCase() + slug.slice(1),
        version: "v1",
        manifestPath: `models/${slug}-v1`,
        schemaVersion: 1,
        code: {
          registry: "src/index.ts",
        },
        description: `Tenant package scaffolded by 'agentic init ${slug}'.`,
      },
      null,
      2,
    ) + "\n"
  );
}

function tenantPackageJson(slug: string): string {
  return (
    JSON.stringify(
      {
        name: `@tenants/${slug}`,
        version: "0.1.0",
        private: true,
        type: "module",
        main: "./src/index.ts",
        types: "./src/index.ts",
        exports: { ".": "./src/index.ts" },
        scripts: {
          typecheck: "tsc --noEmit",
          clean: "rm -rf dist .turbo",
        },
        dependencies: {
          "@agentic/agent-sdk": "workspace:*",
          "@agentic/shared": "workspace:*",
          zod: "^4.4.3",
        },
        devDependencies: { typescript: "^6.0.3" },
      },
      null,
      2,
    ) + "\n"
  );
}

function tenantTsConfig(): string {
  return (
    JSON.stringify(
      {
        extends: "../../../tsconfig.base.json",
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ) + "\n"
  );
}

function tenantIndexTs(slug: string): string {
  return `/**
 * @tenants/${slug} — tenant code package.
 *
 * Bootstrap auto-discovers this package because the slug "${slug}" matches
 * a \`models/${slug}-v1/\` folder. Anything exported here becomes available
 * to the step engine when running this tenant's agents.
 */

import type { TenantRegistry } from "@agentic/agent-sdk";
import { exampleTool } from "./tools/example";
import { examplePrompt } from "./prompts/example";

const tools: TenantRegistry["tools"] = {
  exampleTool,
};

const prompts: TenantRegistry["prompts"] = {
  examplePrompt,
};

const registry: TenantRegistry = { tools, prompts };
export default registry;
`;
}

function tenantExampleTool(): string {
  return `import { defineTool } from "@agentic/agent-sdk";
import { z } from "zod";

/**
 * Example tool — replace with your real implementation.
 *
 * A manifest action with \`{ "type": "tool", "name": "exampleTool" }\`
 * resolves here first, falling back to generic @agentic/tools.
 */
export const exampleTool = defineTool({
  name: "exampleTool",
  description: "Smoke-test tool created by 'agentic init'.",
  output: z.object({
    ok: z.literal(true),
    seenSubject: z.string().nullable(),
  }),
  async handler(ctx) {
    return {
      data: { ok: true, seenSubject: ctx.subject ?? null },
      meta: { tool: "example.tool" },
    };
  },
});
`;
}

function tenantExamplePrompt(): string {
  return `import { definePrompt } from "@agentic/agent-sdk";

/**
 * Example prompt — replace with your real implementation.
 *
 * A manifest action with \`{ "type": "logic", "name": "examplePrompt" }\`
 * resolves here first, falling back to the auto-built system+user prompt.
 */
export const examplePrompt = definePrompt({
  name: "examplePrompt",
  description: "Pass-through prompt created by 'agentic init'.",
  async build() {
    return {
      system:
        "You are a helpful assistant. Echo the user's input as JSON of shape { echoed: string }.",
      user: "Hello from the example prompt.",
    };
  },
});
`;
}

function workflowV1(): string {
  const workflow = [
    {
      id: "1",
      name: "intakeEvent",
      description: "Pure declarative agent. Listens on TENANT_START and emits INTAKE_DONE.",
      actor: ["Agent"],
      trigger: ["TENANT_START"],
      input_data: {},
      ontology_instructions: "",
      actions: [
        {
          order: "1",
          name: "exampleTool",
          description: "Invoke the smoke-test tool.",
          type: "tool",
        },
      ],
      typescript_code: "",
      tool_use: [],
      triggered_event: ["INTAKE_DONE"],
    },
    {
      id: "2",
      name: "summarize",
      description: "LLM-backed agent. Generates a short summary on INTAKE_DONE.",
      actor: ["Agent"],
      trigger: ["INTAKE_DONE"],
      input_data: {},
      ontology_instructions: "",
      actions: [
        {
          order: "1",
          name: "examplePrompt",
          description: "Build the system+user prompt and call the LLM.",
          type: "logic",
        },
      ],
      typescript_code: "",
      tool_use: [],
      triggered_event: ["SUMMARY_GENERATED"],
    },
  ];
  return JSON.stringify(workflow, null, 2) + "\n";
}

function eventsV1(): string {
  return (
    JSON.stringify(
      {
        metadata: { version: "v1" },
        events: [
          {
            name: "TENANT_START",
            description: "Sentinel — emit manually via POST /v1/events to trigger intakeEvent.",
            payload: { subject: "string" },
          },
          {
            name: "INTAKE_DONE",
            description: "Emitted by intakeEvent on success.",
            payload: { subject: "string", ok: "boolean" },
          },
          {
            name: "SUMMARY_GENERATED",
            description: "Emitted by summarize on success.",
            payload: { subject: "string", summary: "string" },
          },
        ],
      },
      null,
      2,
    ) + "\n"
  );
}

function actionsV1(): string {
  // UC-V11-19 / AR-GAP-03 — ActionsManifestSchema in
  // packages/runtime/src/manifest.ts is
  // `z.array(z.record(z.string(), z.unknown()))` — an ARRAY of action
  // objects, NOT an object keyed by action id. Canonical reference:
  // `models/RAAS-v1/actions_v1.json`. The legacy shape made the
  // server-side validation on `agentic deploy` blow up with a confusing
  // schema error; tenants worked around it by hand-replacing the file
  // with the RAAS sample.
  const actions = [
    {
      id: "1-1",
      name: "exampleTool",
      owner: "intakeEvent",
      type: "tool",
      description: "Smoke-test tool — proves the tenant resolver path is live.",
    },
    {
      id: "2-1",
      name: "examplePrompt",
      owner: "summarize",
      type: "logic",
      description: "Pass-through prompt that invokes the LLM gateway.",
    },
  ];
  return JSON.stringify(actions, null, 2) + "\n";
}
