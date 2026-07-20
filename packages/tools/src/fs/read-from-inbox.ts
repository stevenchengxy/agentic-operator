/**
 * fs.readFromInbox — read a file from `data/<subdir>/<tenant>/inbox/<filename>`
 * and return it as base64 ready to forward to an upload-style API
 * (e.g. parseResumeApi).
 *
 * Per-tenant configuration (manifest `tool_use[].config`):
 *   {
 *     subdir?:        string,     // default "resumes" → data/resumes/<tenant>/inbox/
 *     max_bytes?:     number,     // default 10 MiB
 *     allowed_exts?:  string[],   // default [.pdf, .txt, .md, .doc, .docx]
 *   }
 *
 * LLM-provided args (this tool's input):
 *   { filename: string }
 *
 * Security:
 *   - filename must be flat (no /, \, .., or leading .)
 *   - resolved path is re-checked to stay within the inbox dir (defends
 *     against symlinks / mount-shenanigans).
 *
 * Pairs with `parseResumeApi` (or any upload-style endpoint) via the
 * `ctx.lastResult` chain — the upload tool reads `base64` directly without
 * the LLM having to echo it.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { tenantSubdir, assertFlatFilename } from "./_shared";

const DEFAULT_SUBDIR = "resumes";
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_ALLOWED_EXTS = [".pdf", ".txt", ".md", ".doc", ".docx"] as const;

function mimeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".md":
      return "text/plain";
    case ".doc":
      return "application/msword";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}

export const readFromInbox = defineTool({
  name: "fs.readFromInbox",
  description:
    "Read a file from the tenant's inbox folder (data/<subdir>/<tenant>/inbox/<filename>) " +
    "and return it as base64 ready to forward to an upload-style API. " +
    "Filename must be a flat name — no subdirectories, no '..', no leading '.'. " +
    "Configure via manifest tool_use[].config: { subdir?, max_bytes?, allowed_exts? }.",
  output: z.object({
    filename: z.string(),
    mime: z.string(),
    base64: z.string(),
    sha256: z.string(),
    bytes: z.number().int().nonnegative(),
    path: z.string(),
  }),
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const cfg = (ctx.config ?? {}) as Record<string, unknown>;

    const filename =
      typeof args.filename === "string" && args.filename.trim()
        ? args.filename.trim()
        : "";
    if (!filename) {
      throw new Error(
        "fs.readFromInbox: missing 'filename' arg. Pass a flat filename from the inbox (e.g. 'wei-zhang.pdf').",
      );
    }
    assertFlatFilename(filename);

    const subdir =
      typeof cfg.subdir === "string" && cfg.subdir.length > 0
        ? cfg.subdir
        : DEFAULT_SUBDIR;
    const maxBytes =
      typeof cfg.max_bytes === "number" && cfg.max_bytes > 0
        ? cfg.max_bytes
        : DEFAULT_MAX_BYTES;
    const allowedExts = new Set(
      Array.isArray(cfg.allowed_exts) && cfg.allowed_exts.length > 0
        ? (cfg.allowed_exts as string[]).map((e) => e.toLowerCase())
        : DEFAULT_ALLOWED_EXTS,
    );

    const ext = path.extname(filename).toLowerCase();
    if (!allowedExts.has(ext)) {
      throw new Error(
        `fs.readFromInbox: extension '${ext || "(none)"}' not allowed. Allowed: ${Array.from(allowedExts).join(", ")}.`,
      );
    }

    const root = tenantSubdir(ctx.tenantSlug, subdir, "inbox");
    const resolved = path.resolve(root, filename);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      throw new Error(`fs.readFromInbox: resolved path escaped inbox dir (${root}).`);
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved);
    } catch {
      let available: string[] = [];
      try {
        available = fs.readdirSync(root).filter((f) => !f.startsWith("."));
      } catch {
        /* dir may not exist yet */
      }
      throw new Error(
        `fs.readFromInbox: file not found at ${resolved}. ` +
          `Available in inbox: ${available.length === 0 ? "(empty)" : available.join(", ")}`,
      );
    }
    if (!stat.isFile()) {
      throw new Error(`fs.readFromInbox: ${resolved} is not a regular file.`);
    }
    if (stat.size > maxBytes) {
      throw new Error(
        `fs.readFromInbox: ${filename} is ${stat.size} bytes; max ${maxBytes}.`,
      );
    }

    const buf = fs.readFileSync(resolved);
    const sha = crypto.createHash("sha256").update(buf).digest("hex");

    return {
      data: {
        filename,
        mime: mimeFor(ext),
        base64: buf.toString("base64"),
        sha256: sha,
        bytes: stat.size,
        path: resolved,
      },
      meta: { tenantSlug: ctx.tenantSlug, ext, subdir },
    };
  },
});
