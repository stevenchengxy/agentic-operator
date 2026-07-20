#!/usr/bin/env node
/**
 * `agentic` — Agentic Operator CLI entry point.
 *
 * Minimal arg parser (no commander/yargs dep). The CLI ships 4 commands in
 * Phase 1:
 *
 *   agentic init <slug>            — scaffold data/tenants/<slug>/ (P1-CLI-01)
 *   agentic deploy [path]          — typecheck + deploy code and manifest (P1-CLI-02)
 *   agentic logs <run-id> [--tail] — fetch /v1/runs/:id/logs (P1-CLI-03)
 *   agentic events tail            — SSE subscribe /v1/stream  (P1-CLI-04)
 *
 * Global options:
 *
 *   --api <url>      override AGENTIC_API_URL
 *   --token <token>  override AGENTIC_API_TOKEN
 *   -h, --help       print this help
 *   -v, --version    print package version
 */
import { runInit } from "./commands/init.js";
import { runDeploy } from "./commands/deploy.js";
import { runLogs } from "./commands/logs.js";
import { runEventsTail } from "./commands/events.js";

export const VERSION = "0.1.0";

interface Globals {
  api?: string;
  token?: string;
}

interface ParsedArgs {
  command: string | null;
  subcommand: string | null;
  positional: string[];
  flags: Record<string, string | boolean>;
  globals: Globals;
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = {
    command: null,
    subcommand: null,
    positional: [],
    flags: {},
    globals: {},
    help: false,
    version: false,
  };
  const tokens = argv.slice();
  while (tokens.length > 0) {
    const t = tokens.shift()!;
    if (t === "-h" || t === "--help") {
      out.help = true;
      continue;
    }
    if (t === "-v" || t === "--version") {
      out.version = true;
      continue;
    }
    if (t.startsWith("--")) {
      const eq = t.indexOf("=");
      const key = eq === -1 ? t.slice(2) : t.slice(2, eq);
      const val =
        eq === -1
          ? tokens.length > 0 && !tokens[0]!.startsWith("-")
            ? tokens.shift()!
            : true
          : t.slice(eq + 1);
      if (key === "api" && typeof val === "string") out.globals.api = val;
      else if (key === "token" && typeof val === "string") out.globals.token = val;
      else out.flags[key] = val;
      continue;
    }
    if (out.command === null) {
      out.command = t;
      continue;
    }
    if (out.subcommand === null && out.command === "events") {
      out.subcommand = t;
      continue;
    }
    out.positional.push(t);
  }
  return out;
}

const HELP = `agentic — Agentic Operator CLI (v${VERSION})

Usage:
  agentic <command> [options]

Commands:
  init <slug>                 Scaffold a tenant project at data/tenants/<slug>/
  deploy [path]               Typecheck + deploy tenant code and manifest
  logs <run-id> [--tail]      Stream /v1/runs/:id/logs to stdout
  events tail                 Subscribe to /v1/stream and pretty-print

Global options:
  --api <url>                 Override AGENTIC_API_URL (default http://localhost:3540)
  --token <token>             Override AGENTIC_API_TOKEN
  -h, --help                  Show this help and exit
  -v, --version               Show CLI version and exit

Examples:
  agentic init demo
  agentic deploy data/tenants/demo
  agentic logs run-abc123 --tail
  agentic events tail
`;

export interface RunContext {
  args: ParsedArgs;
  apiUrl: string;
  apiToken: string;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export function buildContext(args: ParsedArgs): RunContext {
  return {
    args,
    apiUrl:
      args.globals.api ?? process.env.AGENTIC_API_URL ?? "http://localhost:3540",
    apiToken: args.globals.token ?? process.env.AGENTIC_API_TOKEN ?? "",
    stdout: process.stdout,
    stderr: process.stderr,
  };
}

export async function run(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.version) {
    process.stdout.write(`agentic ${VERSION}\n`);
    return 0;
  }
  if (args.help || args.command === null) {
    process.stdout.write(HELP);
    return args.command === null && !args.help ? 1 : 0;
  }

  const ctx = buildContext(args);

  try {
    switch (args.command) {
      case "init":
        return await runInit(ctx);
      case "deploy":
        return await runDeploy(ctx);
      case "logs":
        return await runLogs(ctx);
      case "events":
        if (args.subcommand !== "tail") {
          ctx.stderr.write(
            `agentic: unknown 'events' subcommand "${args.subcommand ?? ""}" — try 'agentic events tail'\n`,
          );
          return 2;
        }
        return await runEventsTail(ctx);
      default:
        ctx.stderr.write(`agentic: unknown command "${args.command}"\n\n`);
        ctx.stderr.write(HELP);
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.stderr.write(`agentic: ${msg}\n`);
    return 1;
  }
}

// Run only when invoked as the main script — tests import the module without
// triggering the CLI shell exit.
const isMain = (() => {
  // ESM-safe: import.meta.url is a file: URL, process.argv[1] is a path.
  if (typeof process.argv[1] !== "string") return false;
  // tsx wraps the original entry path in argv[1] directly.
  const entry = process.argv[1].replace(/\\/g, "/");
  return import.meta.url.endsWith(entry);
})();

if (isMain) {
  run(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
