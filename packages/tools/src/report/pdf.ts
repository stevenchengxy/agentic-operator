/**
 * report.htmlToPdf — HTML → PDF via a locally installed headless Chrome.
 *
 * Zero new dependencies by design: instead of pulling puppeteer (which
 * downloads its own Chromium), we discover an installed Chrome/Chromium/Edge
 * binary and drive `--headless --print-to-pdf`. On a dev Mac this is nearly
 * always present; when it isn't, the error says exactly how to fix it
 * (install Chrome or set CHROME_PATH) — and the HTML artifact still exists,
 * so a missing Chrome degrades to "HTML only", never to data loss.
 *
 * Exports the pure helpers (findChrome / htmlFileToPdf / htmlToPdf /
 * reportArchiveDir) for the API-side report pipeline, plus the global tool
 * descriptor `report.htmlToPdf` for manifest agents.
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";

import { defineTool } from "@agentic/agent-kit";
import { z } from "zod";

import { tenantSubdir, escapeHtml } from "../fs/_shared";

const CHROME_CANDIDATES = [
  // macOS
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  // Linux
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/microsoft-edge",
];

/** Locate a Chrome-family binary: CHROME_PATH env wins, then well-known install paths. */
export function findChrome(): string | null {
  const env = process.env.CHROME_PATH?.trim();
  if (env) return fs.existsSync(env) ? env : null;
  for (const p of CHROME_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function runChrome(chrome: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(chrome, args, { timeout: timeoutMs }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ` — ${String(stderr).slice(0, 400)}` : ""}`));
      else resolve();
    });
  });
}

/** Print an on-disk HTML file to PDF. Throws with an actionable message when no Chrome exists. */
export async function htmlFileToPdf(
  htmlPath: string,
  outPath: string,
  opts?: { timeoutMs?: number; chromePath?: string },
): Promise<{ path: string; bytes: number; engine: string }> {
  const chrome = opts?.chromePath ?? findChrome();
  if (!chrome) {
    throw new Error(
      "未找到可用的 Chrome/Chromium —— PDF 需要本机浏览器内核。请安装 Google Chrome，或用环境变量 CHROME_PATH 指向浏览器可执行文件。（HTML 版本不受影响）",
    );
  }
  const timeoutMs = opts?.timeoutMs ?? 60_000;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const base = [
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    // NETWORK ISOLATION: the printed HTML is LLM/tenant-authored. Route every http(s)
    // request (including localhost — `<-loopback>` removes the implicit bypass) into a
    // dead proxy so a hostile <img>/<iframe>/fetch cannot SSRF internal endpoints or
    // exfiltrate; reports are self-contained by contract, so zero egress is safe.
    "--proxy-server=http://127.0.0.1:9",
    "--proxy-bypass-list=<-loopback>",
    `--print-to-pdf=${outPath}`,
    "--no-pdf-header-footer",
    `file://${htmlPath}`,
  ];
  try {
    await runChrome(chrome, ["--headless=new", ...base], timeoutMs);
  } catch (e) {
    // Retry with the legacy flag ONLY when the failure looks like "flag not understood"
    // (pre-112 Chrome). Blanket retry would double the timeout on a hung render and
    // mask the real first-attempt error.
    const msg = String((e as Error).message ?? e);
    const timedOut = /killed|SIGTERM|timed?\s?out/i.test(msg);
    const flagIssue = /headless/i.test(msg) && /unknown|unrecognized|invalid/i.test(msg);
    if (timedOut || !flagIssue) throw e;
    await runChrome(chrome, ["--headless", ...base], timeoutMs);
  }
  const st = fs.statSync(outPath);
  if (!st.size) throw new Error("Chrome 输出了空的 PDF 文件。");
  return { path: outPath, bytes: st.size, engine: chrome };
}

/** Print an HTML string to PDF: persists the HTML alongside the PDF (both paths returned). */
export async function htmlToPdf(
  html: string,
  outPath: string,
  opts?: { timeoutMs?: number; chromePath?: string },
): Promise<{ path: string; htmlPath: string; bytes: number; engine: string }> {
  const htmlPath = outPath.replace(/\.pdf$/i, "") + ".html";
  fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
  fs.writeFileSync(htmlPath, html);
  const res = await htmlFileToPdf(htmlPath, outPath, opts);
  return { ...res, htmlPath };
}

/** `data/<subdir>/<tenant>/` for report outputs — same data-root resolution as every fs.* tool. */
export function reportArchiveDir(tenantSlug: string, subdir = "reports"): string {
  return tenantSubdir(tenantSlug, subdir);
}

function timestamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

export const htmlToPdfTool = defineTool({
  name: "report.htmlToPdf",
  description:
    "Render an HTML document to BOTH data/<subdir>/<tenant>/<id>.html and <id>.pdf (via local headless Chrome). " +
    "REQUIRED: { html: string }. Optional: { title: string }. " +
    "Returns { id, htmlPath, pdfPath, bytes }. Throws with guidance when no Chrome/Chromium is installed. " +
    "Configure via tool_use[].config: { subdir?, id_prefix?, lang?, timeout_ms? }.",
  output: z.object({
    id: z.string(),
    htmlPath: z.string(),
    pdfPath: z.string(),
    bytes: z.number(),
  }),
  async handler(ctx) {
    const args = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const cfg = (ctx.config ?? {}) as Record<string, unknown>;
    const html =
      (typeof args.html === "string" && args.html) ||
      (typeof args.body === "string" && args.body) ||
      (typeof args.report === "string" && args.report) ||
      "";
    if (!html) throw new Error("report.htmlToPdf: required string arg `html` missing or empty.");
    const title = (typeof args.title === "string" && args.title) || "Report";
    const lang = typeof cfg.lang === "string" && cfg.lang ? cfg.lang : "zh-CN";
    const subdir = typeof cfg.subdir === "string" && cfg.subdir ? cfg.subdir : "reports";
    const idPrefix = typeof cfg.id_prefix === "string" && cfg.id_prefix ? cfg.id_prefix : "report";
    const timeoutMs = typeof cfg.timeout_ms === "number" ? cfg.timeout_ms : undefined;

    // Case-insensitive sniff (`<!doctype html>` is valid HTML5 and common LLM output),
    // plus bare `<html>` docs — double-wrapping a complete document nests html/head/body.
    const trimmed = html.trimStart();
    const isCompleteDoc = /^<!doctype\s+html/i.test(trimmed) || /^<html[\s>]/i.test(trimmed);
    const wrapped = isCompleteDoc
      ? html
      : `<!DOCTYPE html>\n<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>\n${html}\n</body></html>\n`;

    const id = `${idPrefix}-${timestamp()}-${randomBytes(3).toString("hex")}`;
    const outPath = path.join(reportArchiveDir(ctx.tenantSlug, subdir), `${id}.pdf`);
    const res = await htmlToPdf(wrapped, outPath, { timeoutMs });
    return {
      data: { id, htmlPath: res.htmlPath, pdfPath: res.path, bytes: res.bytes },
      meta: { tenant: ctx.tenantSlug, engine: res.engine, subdir },
    };
  },
});
