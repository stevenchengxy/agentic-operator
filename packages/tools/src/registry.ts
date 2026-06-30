/**
 * @agentic/tools/registry — the GLOBAL tool registry.
 *
 * Any tool exported here is callable by any agent in any tenant — the
 * tenant's manifest just lists the tool name in `tool_use[]`. The runtime
 * resolves names in this order ([packages/runtime/src/step-engine.ts]):
 *
 *   1. tenantRegistry.tools[name]   — tenant-native override (wins)
 *   2. globalToolRegistry.get(name) — this map
 *   3. MCP server tools             — namespaced "<server>.<tool>"
 *
 * That ordering lets a tenant ship a custom implementation that shadows
 * a global tool, while keeping the global as a known-good default for
 * everyone else.
 *
 * Per-tenant CONFIGURATION (no code change required) flows through the
 * manifest's `tool_use[i].config` blob into `ctx.config` on the handler.
 * Each tool documents its own config shape; see each tool's source file.
 *
 * To add a new global tool:
 *   1. Implement it under packages/tools/src/<category>/<name>.ts using
 *      `defineTool` from @agentic/agent-kit.
 *   2. Export it from `packages/tools/src/<category>/index.ts`.
 *   3. Add an entry to TOOL_DESCRIPTORS below — supply at least the
 *      descriptor + category + a one-line summary for the catalog UI.
 *   4. (Optional) Add config + usage examples in TOOL_METADATA so
 *      manifest authors can copy/paste working config blocks.
 *
 * Listing for the operator UI:
 *   `listGlobalTools()` returns the full catalog as plain JSON, consumed
 *   by GET /v1/tools and the portal's Tools view.
 */

import type { ToolDescriptor } from "@agentic/agent-kit";

import {
  matchResumeApi,
  parseResumeApi,
  parseJdApi,
  inviteCandidateApi,
  robohireHealthApi,
} from "./robohire";
import {
  readFromInbox,
  writeMarkdownToArchive,
  writeHtmlToArchive,
  appendToLog,
} from "./fs";
import { httpFetchTool } from "./http";
import { ping } from "./meta";
import { fetchActionRules } from "./ontology";

/** Per-field metadata used to render args / returns tables. */
export interface ToolFieldSchema {
  type: string;
  required?: boolean;
  description?: string;
  default?: unknown;
}

/** Catalog metadata surfaced via GET /v1/tools and the Tools UI. */
export interface ToolCatalogEntry {
  /** Canonical name as used in workflow manifests. */
  name: string;
  /** Grouping label for the UI (e.g. "robohire", "fs", "http"). */
  category: string;
  /** One-line summary for the catalog index. */
  summary: string;
  /** Long-form description for the detail view. */
  description?: string;
  /**
   * Shape of the LLM-supplied arguments (what the model puts in tool_use.input,
   * or what a `type: "tool"` manifest action passes through ctx.event.data).
   * Empty when the tool takes no args (e.g. `meta.ping`, `robohireHealthApi`).
   */
  argsSchema?: Record<string, ToolFieldSchema>;
  /** A copy-paste-ready example of the args object. */
  argsExample?: Record<string, unknown>;
  /**
   * Per-tenant config keys the tool honours (manifest `tool_use[].config`).
   * These come from the MANIFEST, not from the LLM call.
   */
  configSchema?: Record<string, ToolFieldSchema>;
  /** Copy-paste example of the manifest config block. */
  configExample?: Record<string, unknown>;
  /** Shape of the success return value (what handler resolves with under .data). */
  returnsSchema?: Record<string, ToolFieldSchema>;
  /** A worked example of the return value. */
  returnsExample?: unknown;
  /**
   * Other tools this one chains with via ctx.lastResult (the runtime carries
   * the previous tool's output through automatically so the LLM doesn't have
   * to re-quote it). Surfaced in the docs as a "Pairs well with" hint.
   */
  chainsWith?: string[];
  /** Other names this tool answers to (back-compat aliases). */
  aliases?: string[];
  /** Where in the repo the implementation lives. */
  sourcePath: string;
}

interface ToolRegistration {
  descriptor: ToolDescriptor;
  catalog: ToolCatalogEntry;
}

// Shared config block for every RoboHire wrapper — all five honour the
// same auth + base-url + timeout knobs via rest-helper.ts.
const ROBOHIRE_CONFIG_SCHEMA: Record<string, ToolFieldSchema> = {
  api_key_env: {
    type: "string",
    description:
      "Name of the env var holding the per-tenant API key. Overrides global ROBOHIRE_API_KEY.",
  },
  api_key: {
    type: "string",
    description: "Literal API key — prefer api_key_env for tenant isolation.",
  },
  base_url: {
    type: "string",
    default: "https://api.gohire.top/api/v1",
    description: "Override the RoboHire API base URL (default: the gohire.top RoboHire-compatible host).",
  },
  timeout_ms: { type: "number", default: 30000 },
};

const REGISTRATIONS: ToolRegistration[] = [
  // ── robohire.* ──────────────────────────────────────────────────────────
  {
    descriptor: robohireHealthApi,
    catalog: {
      name: "robohireHealthApi",
      category: "robohire",
      summary:
        "GET https://api.robohire.io/api/v1/health — smoke-test reachability + credentials.",
      description:
        "Cheap canary call to confirm the API is reachable and the configured key is accepted before invoking write endpoints. Returns the upstream response under .data so the LLM can branch on `status === 'ok'`.",
      argsSchema: {},
      argsExample: {},
      configSchema: ROBOHIRE_CONFIG_SCHEMA,
      configExample: { api_key_env: "TENANT_X_ROBOHIRE_KEY" },
      returnsSchema: {
        data: { type: "object", description: "Upstream JSON, e.g. { status: 'ok' }" },
      },
      returnsExample: { data: { status: "ok", uptime_s: 482931 } },
      sourcePath: "packages/tools/src/robohire/health.ts",
    },
  },
  {
    descriptor: parseJdApi,
    catalog: {
      name: "parseJdApi",
      category: "robohire",
      summary:
        "POST /api/v1/parse-jd — structures a job description (text, URL, or base64 PDF).",
      description:
        "Forwards the request body to the upstream verbatim, so the LLM can pass any of the three documented shapes. Upstream validation errors surface as `tool_result: is_error` so the model can self-correct.",
      argsSchema: {
        jd_text: {
          type: "string",
          description: "Plain-text JD body. Provide this OR jd_url OR jd_base64.",
        },
        jd_url: {
          type: "string",
          description: "Fetchable URL to a PDF. Upstream downloads it.",
        },
        jd_base64: {
          type: "string",
          description: "Base64-encoded PDF bytes.",
        },
      },
      argsExample: {
        jd_text:
          "Senior Backend Engineer\n\nResponsibilities: design and own production services in Go/TypeScript ...",
      },
      configSchema: ROBOHIRE_CONFIG_SCHEMA,
      returnsSchema: {
        data: {
          type: "object",
          description:
            "Upstream JSON — structured requirements, skills, must-haves, etc.",
        },
      },
      returnsExample: {
        data: {
          title: "Senior Backend Engineer",
          must_have: ["Postgres", "Distributed systems"],
          nice_to_have: ["Go", "Kubernetes"],
        },
      },
      sourcePath: "packages/tools/src/robohire/parse-jd.ts",
    },
  },
  {
    descriptor: parseResumeApi,
    catalog: {
      name: "parseResumeApi",
      category: "robohire",
      summary:
        "POST /api/v1/parse-resume — multipart PDF upload. Chains automatically from fs.readFromInbox.",
      description:
        "Wraps the multipart-only upstream endpoint. Pass `{resume_base64, filename, mime}`, `{resume_url}`, OR call with no args after `fs.readFromInbox` — the tool picks up the bytes from `ctx.lastResult` server-side and avoids round-tripping the base64 through the LLM (which corrupts it).",
      argsSchema: {
        resume_base64: {
          type: "string",
          description:
            "Base64-encoded PDF bytes. Omit to chain from ctx.lastResult.",
        },
        filename: {
          type: "string",
          default: "resume.pdf",
          description: "Surfaced in multipart Content-Disposition.",
        },
        mime: {
          type: "string",
          default: "application/pdf",
        },
        resume_url: {
          type: "string",
          description: "Alternative to resume_base64 — wrapper fetches the URL first.",
        },
      },
      argsExample: {},
      configSchema: ROBOHIRE_CONFIG_SCHEMA,
      returnsSchema: {
        data: {
          type: "object",
          description:
            "Upstream `{ name, email, skills, experience[], education[], rawText, ... }`",
        },
      },
      returnsExample: {
        data: {
          name: "Wei Zhang",
          email: "wei.zhang@example.com",
          skills: { languages: ["TypeScript", "Go"], tools: ["React"] },
          experience: [
            { role: "Staff Engineer", company: "AgentForge.ai", startDate: "2023" },
          ],
        },
      },
      chainsWith: ["fs.readFromInbox"],
      sourcePath: "packages/tools/src/robohire/parse-resume.ts",
    },
  },
  {
    descriptor: matchResumeApi,
    catalog: {
      name: "matchResumeApi",
      category: "robohire",
      summary:
        "POST /api/v1/match-resume — score a resume vs. a JD. REQUIRES {resume, jd} as plain-text strings.",
      description:
        "Returns a normalised envelope `{matchScore, verdict, hiringRecommendation, summary, raw}` so downstream agents don't need to spelunk the upstream nested shape. The wrapper also coerces common LLM-emitted variants (`resume_text`, `jd_text`, `candidate_resume`, `job_description`) into the canonical names before sending — saves a tool-use turn on a schema-fix retry.",
      argsSchema: {
        resume: {
          type: "string",
          required: true,
          description:
            "Full plain-text resume body (NOT a URL, NOT a field reference).",
        },
        jd: {
          type: "string",
          required: true,
          description: "Full plain-text JD body.",
        },
      },
      argsExample: {
        resume: "Wei Zhang — Staff Engineer with 8 years backend experience ...",
        jd: "Senior Backend Engineer — Must have Postgres OLTP expertise ...",
      },
      configSchema: ROBOHIRE_CONFIG_SCHEMA,
      returnsSchema: {
        matchScore: {
          type: "number | null",
          description: "0-100 or null if the upstream omitted a score.",
        },
        verdict: {
          type: "string | null",
          description: '"Strong Match" / "Moderate Match" / "Weak Match" / "Not Qualified".',
        },
        hiringRecommendation: {
          type: "string | null",
          description: '"Strongly Recommend" / "Recommend" / "Do Not Recommend".',
        },
        summary: { type: "string | null", description: "One-line verdict rationale." },
        raw: { type: "object", description: "Full upstream body for detailed breakdowns." },
      },
      returnsExample: {
        matchScore: 96,
        verdict: "Strong Match",
        hiringRecommendation: "Strongly Recommend",
        summary: "Direct expertise in the platform's full tech stack.",
        raw: { overallMatchScore: { score: 96 } },
      },
      sourcePath: "packages/tools/src/robohire/match-resume.ts",
    },
  },
  {
    descriptor: inviteCandidateApi,
    catalog: {
      name: "inviteCandidateApi",
      category: "robohire",
      summary:
        "POST /api/v1/invite-candidate — generate an interview-invitation email body.",
      description:
        "Pass-through payload. Accepts `{candidate_name, job_title, ...}` or whatever the upstream expects; the wrapper forwards verbatim.",
      argsSchema: {
        candidate_name: { type: "string", required: true },
        job_title: { type: "string", required: true },
        resume: { type: "string", description: "Optional resume context for personalisation." },
        jd: { type: "string", description: "Optional JD context." },
      },
      argsExample: {
        candidate_name: "Wei Zhang",
        job_title: "Senior Backend Engineer",
      },
      configSchema: ROBOHIRE_CONFIG_SCHEMA,
      returnsSchema: {
        data: {
          type: "object",
          description: "Upstream `{ subject, body, html, ... }` — exact shape varies.",
        },
      },
      returnsExample: {
        data: {
          subject: "Interview invitation — Senior Backend Engineer @ Northwind AI",
          body: "Hi Wei,\n\nWe'd love to invite you to our 60-minute systems design ...",
        },
      },
      sourcePath: "packages/tools/src/robohire/invite-candidate.ts",
    },
  },

  // ── fs.* ────────────────────────────────────────────────────────────────
  {
    descriptor: readFromInbox,
    catalog: {
      name: "fs.readFromInbox",
      category: "fs",
      summary:
        "Read a file from data/<subdir>/<tenant>/inbox/<filename> and return it as base64 + sha256.",
      description:
        "Use this as the first tool in any 'pick up a file → upload to an API' chain. Tenant-scoped path. Flat filenames only (rejects '..' / leading dots / path separators). Size + extension allow-list enforced before the file is read.",
      argsSchema: {
        filename: {
          type: "string",
          required: true,
          description: "Flat filename (no slashes, no '..', no leading dot).",
        },
      },
      argsExample: { filename: "wei-zhang.pdf" },
      configSchema: {
        subdir: {
          type: "string",
          default: "resumes",
          description:
            "Sub-directory under data/. The tenant slug + 'inbox' are appended.",
        },
        max_bytes: { type: "number", default: 10485760 },
        allowed_exts: {
          type: "string[]",
          default: [".pdf", ".txt", ".md", ".doc", ".docx"],
        },
      },
      configExample: { subdir: "resumes", max_bytes: 5242880 },
      returnsSchema: {
        filename: { type: "string" },
        mime: { type: "string" },
        base64: { type: "string", description: "Base64-encoded file body." },
        sha256: { type: "string", description: "Hex-encoded SHA-256 of the raw bytes." },
        bytes: { type: "number" },
        path: { type: "string", description: "Absolute path the file was read from." },
      },
      returnsExample: {
        filename: "wei-zhang.pdf",
        mime: "application/pdf",
        base64: "JVBERi0xLjQK...",
        sha256: "424ed41387578546f86a4774ce597cc06dd859a1cdf17a353a016120a727b9b9",
        bytes: 3057,
        path: "/abs/data/resumes/northwind/inbox/wei-zhang.pdf",
      },
      chainsWith: ["parseResumeApi"],
      aliases: ["readResumeFromDisk"],
      sourcePath: "packages/tools/src/fs/read-from-inbox.ts",
    },
  },
  {
    descriptor: writeMarkdownToArchive,
    catalog: {
      name: "fs.writeMarkdownToArchive",
      category: "fs",
      summary:
        "Persist a markdown body to data/<subdir>/<tenant>/<id>.md. Returns the path + a stable id.",
      description:
        "Writes a header comment with the synthetic id + tenant + ISO timestamp, then a `# <title>` line, then the body. Also appends one line to `_archive.log` for tail-following.",
      argsSchema: {
        text: {
          type: "string",
          required: true,
          description: "Markdown body. Aliases: `jd_text`, `body`.",
        },
        title: {
          type: "string",
          description: "Rendered as `# <title>` at the top. Aliases: `jd_title`.",
        },
      },
      argsExample: { text: "## Job description\n\nResponsibilities:\n- ...", title: "Senior Backend Engineer" },
      configSchema: {
        subdir: { type: "string", default: "archive" },
        id_prefix: { type: "string", default: "doc" },
        default_title: { type: "string" },
      },
      configExample: { subdir: "jd-archive", id_prefix: "jd" },
      returnsSchema: {
        id: {
          type: "string",
          description: "`{id_prefix}-{yyyymmddHHMMSS}-{6hex}`.",
        },
        path: { type: "string", description: "Absolute path on disk." },
        bytesWritten: { type: "number" },
      },
      returnsExample: {
        id: "jd-20260526193743-599dda",
        path: "/abs/data/jd-archive/northwind/jd-20260526193743-599dda.md",
        bytesWritten: 1247,
      },
      aliases: ["writeJdToDisk"],
      sourcePath: "packages/tools/src/fs/write-markdown-to-archive.ts",
    },
  },
  {
    descriptor: writeHtmlToArchive,
    catalog: {
      name: "fs.writeHtmlToArchive",
      category: "fs",
      summary:
        "Persist an HTML document to data/<subdir>/<tenant>/<id>.html. Auto-wraps if no DOCTYPE.",
      description:
        "If the supplied html doesn't start with `<!DOCTYPE`, the tool wraps it in a minimal document shell so the file still renders in a browser. The wrap is skipped when the LLM sends a complete doctyped document.",
      argsSchema: {
        html: {
          type: "string",
          required: true,
          description: "HTML body or full document. Aliases: `body`, `report`.",
        },
        title: {
          type: "string",
          description: "Used in the auto-wrapped <title>. Aliases: `report_title`.",
        },
      },
      argsExample: {
        html: "<h1>Match report</h1>\n<table>...</table>",
        title: "Hiring report — JR-NW-2026-007",
      },
      configSchema: {
        subdir: { type: "string", default: "reports" },
        id_prefix: { type: "string", default: "report" },
        lang: { type: "string", default: "zh-CN" },
      },
      configExample: { subdir: "reports", id_prefix: "report", lang: "zh-CN" },
      returnsSchema: {
        id: { type: "string" },
        path: { type: "string" },
        bytesWritten: { type: "number" },
      },
      returnsExample: {
        id: "report-20260527094643-a23868",
        path: "/abs/data/reports/northwind/report-20260527094643-a23868.html",
        bytesWritten: 2762,
      },
      aliases: ["writeReportToDisk", "writeBriefToDisk"],
      sourcePath: "packages/tools/src/fs/write-html-to-archive.ts",
    },
  },
  {
    descriptor: appendToLog,
    catalog: {
      name: "fs.appendToLog",
      category: "fs",
      summary:
        "Append a line to data/<subdir>/<tenant>/<filename>. Pass { line } verbatim or { data } for auto-formatted k=v.",
      description:
        "Use as a `type: \"tool\"` step at the end of a workflow leg to drop a grep-friendly trace of the upstream event. The auto-format mode (any non-empty arg object becomes `key=value  key=value`) means an agent can pipe a payload straight in without quoting.",
      argsSchema: {
        line: {
          type: "string",
          description: "Literal line to append (no formatting).",
        },
        data: {
          type: "object",
          description:
            "Auto-formatted as `key=value  key=value`. Any non-empty arg object also triggers auto-format.",
        },
      },
      argsExample: { data: { event: "AGENT_TEST1_DONE", agent: "agent-test2", subject: "REQ-123" } },
      configSchema: {
        subdir: { type: "string", default: "logs" },
        filename: { type: "string", default: "workflow.log" },
        prefix_ts: {
          type: "boolean",
          default: true,
          description: "Prepend ISO timestamp + 2 spaces to each line.",
        },
      },
      configExample: { subdir: "logs", filename: "workflow-test1.log" },
      returnsSchema: {
        logFile: { type: "string", description: "Absolute path of the log file." },
        bytesAppended: { type: "number" },
        line: { type: "string", description: "The line that was written (trimmed)." },
      },
      returnsExample: {
        logFile: "/abs/data/logs/tenant-test1/workflow-test1.log",
        bytesAppended: 132,
        line: "2026-05-27T17:46:48.591Z  event=AGENT_TEST1_DONE  agent=agent-test2  subject=REQ-123",
      },
      aliases: ["writeWorkflowLog"],
      sourcePath: "packages/tools/src/fs/append-to-log.ts",
    },
  },

  // ── http.* ──────────────────────────────────────────────────────────────
  {
    descriptor: httpFetchTool,
    catalog: {
      name: "http.fetch",
      category: "http",
      summary:
        "Generic JSON HTTP client. Per-tenant base_url + auth + allow-lists via config; per-call { method, path, body, query, headers }.",
      description:
        "Returns `{ status, ok, headers, body }`. 4xx/5xx return with `ok:false` (does NOT throw) so the LLM can self-correct from the error body. Auth schemes: bearer (default), header (X-API-Key-style), query (?api_key=), none. Optional `allow_methods` and `allow_host` give the operator a tenant-scoped safety perimeter — useful when you want an agent to talk to one specific vendor and nothing else.",
      argsSchema: {
        method: {
          type: "'GET'|'POST'|'PUT'|'PATCH'|'DELETE'",
          default: "GET",
        },
        path: {
          type: "string",
          required: true,
          description:
            "Joined to config.base_url. Absolute URLs (http://…) are used verbatim.",
        },
        query: {
          type: "Record<string,string|number|boolean>",
          description: "Appended as URL search params.",
        },
        body: {
          type: "unknown",
          description:
            "JSON-encoded automatically. Pass a string to send a raw body.",
        },
        headers: {
          type: "Record<string,string>",
          description: "Merged on top of config.default_headers.",
        },
      },
      argsExample: {
        method: "POST",
        path: "/repos/{owner}/{repo}/issues",
        body: { title: "Bug: ...", labels: ["triage"] },
      },
      configSchema: {
        base_url: {
          type: "string",
          description: "Prepended to per-call `path` when not absolute.",
        },
        timeout_ms: { type: "number", default: 30000 },
        default_headers: { type: "Record<string,string>" },
        api_key: {
          type: "string",
          description: "Literal key — prefer api_key_env for tenant isolation.",
        },
        api_key_env: { type: "string" },
        auth_scheme: {
          type: "'bearer'|'header'|'query'|'none'",
          default: "bearer",
        },
        auth_header_name: { type: "string", default: "X-API-Key" },
        auth_query_name: { type: "string", default: "api_key" },
        allow_methods: {
          type: "HttpMethod[]",
          description: "Safety allow-list. Default: any method.",
        },
        allow_host: {
          type: "string|string[]",
          description: "Safety allow-list. Default: any host.",
        },
      },
      configExample: {
        base_url: "https://api.example.com/v1",
        api_key_env: "TENANT_X_EXAMPLE_KEY",
        auth_scheme: "bearer",
        allow_host: "api.example.com",
        allow_methods: ["GET", "POST"],
      },
      returnsSchema: {
        status: { type: "number" },
        ok: {
          type: "boolean",
          description: "True for 2xx. 4xx/5xx return false here (no throw).",
        },
        headers: { type: "Record<string,string>" },
        body: {
          type: "unknown",
          description: "Parsed JSON when Content-Type indicates json; else raw text.",
        },
      },
      returnsExample: {
        status: 201,
        ok: true,
        headers: { "content-type": "application/json" },
        body: { id: 4892, url: "https://api.example.com/v1/issues/4892" },
      },
      sourcePath: "packages/tools/src/http/fetch.ts",
    },
  },

  // ── meta.* ──────────────────────────────────────────────────────────────
  {
    descriptor: ping,
    catalog: {
      name: "meta.ping",
      category: "meta",
      summary:
        "Context-introspection smoke test. Returns the ToolContext snapshot so the operator can verify manifest wiring.",
      description:
        "Drop `{ \"name\": \"meta.ping\" }` into a new tenant's first agent to confirm Inngest dispatch → tenant resolver → tool handler is wired. Also useful for debugging ctx.subject / ctx.lastResult propagation when a downstream tool isn't seeing what you expect.",
      argsSchema: {},
      argsExample: {},
      configSchema: {},
      returnsSchema: {
        pong: { type: "true" },
        agentName: { type: "string" },
        actionName: { type: "string" },
        tenantSlug: { type: "string" },
        subject: { type: "string | null" },
        seenEvent: { type: "string | null" },
        hasLastResult: { type: "boolean" },
        hasConfig: { type: "boolean" },
        ts: { type: "string", description: "ISO timestamp the ping fired." },
      },
      returnsExample: {
        pong: true,
        agentName: "agentTest1",
        actionName: "meta.ping",
        tenantSlug: "northwind",
        subject: "JR-NW-2026-007",
        seenEvent: "HIRING_REQUIREMENT_SUBMITTED",
        hasLastResult: false,
        hasConfig: false,
        ts: "2026-05-27T17:46:48.591Z",
      },
      aliases: ["monitorAndFetchRequirement", "pingProbe"],
      sourcePath: "packages/tools/src/meta/ping.ts",
    },
  },
  {
    descriptor: fetchActionRules,
    catalog: {
      name: "ontology.fetchActionRules",
      category: "ontology",
      summary: "Runtime: fetch the executor=Agent rules governing this action from the live ontology, so a rule-check agent folds against real, current rules.",
      description:
        "Bound automatically onto rule-check agents by the Agent Factory. At run time it pulls the rules for ctx.actionName from Allmeta (domain via config.domain or the tenant slug), filters to executor=Agent, flags the mandatory subset, and returns { rules, mandatory, count } so the agent folds fail-closed. Never bake rules into a prompt — call this instead.",
      argsSchema: {},
      argsExample: {},
      configSchema: {
        domain: { type: "string", description: "Ontology domain id (the factory attaches this; defaults to the tenant slug minus a -sb suffix)." },
        action: { type: "string", description: "Override the action whose rules to fetch (defaults to ctx.actionName)." },
      },
      configExample: { domain: "Agents-generation" },
      returnsSchema: {
        rules: { type: "object[]", description: "executor=Agent rules for this action." },
        mandatory: { type: "object[]", description: "the mandatory subset — fail-close on any of these." },
        count: { type: "number" },
        source: { type: "string", description: "allmeta | unconfigured | error:…" },
      },
      returnsExample: { rules: [], mandatory: [], count: 0, source: "allmeta" },
      sourcePath: "packages/tools/src/ontology/fetch-action-rules.ts",
    },
  },
];

/**
 * Build the runtime map. Each tool is registered under its canonical name
 * AND every alias declared in its catalog entry. Aliases all resolve to
 * the same descriptor, so an older manifest that still says
 * `writeJdToDisk` keeps working without code changes.
 */
function buildRegistry(regs: ToolRegistration[]): Map<string, ToolDescriptor> {
  const map = new Map<string, ToolDescriptor>();
  for (const { descriptor, catalog } of regs) {
    map.set(catalog.name, descriptor);
    for (const alias of catalog.aliases ?? []) {
      if (map.has(alias)) {
        throw new Error(
          `globalToolRegistry: alias collision on '${alias}' (already registered).`,
        );
      }
      map.set(alias, descriptor);
    }
  }
  return map;
}

export const globalToolRegistry: ReadonlyMap<string, ToolDescriptor> =
  buildRegistry(REGISTRATIONS);

/**
 * Catalog snapshot consumed by GET /v1/tools and the Tools view in the
 * portal. Stable across boots; no I/O. Each entry includes the canonical
 * name, category, summary, and (where authored) a config example operators
 * can paste straight into a manifest's `tool_use[]`.
 */
export function listGlobalTools(): ToolCatalogEntry[] {
  return REGISTRATIONS.map(({ catalog }) => ({ ...catalog })).sort((a, b) => {
    if (a.category !== b.category) return a.category.localeCompare(b.category);
    return a.name.localeCompare(b.name);
  });
}
