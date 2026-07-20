/**
 * document.convert — bounded, fail-closed document → PDF conversion.
 *
 * PDF is passed through only after magic-byte validation. DOCX is parsed in a
 * memory-bounded child Node process (mammoth raw-text extraction) and rendered
 * by a separate headless Chromium process. UTF-8 TXT/MD follows the same safe
 * renderer. The generated HTML contains escaped text plus a restrictive CSP,
 * so an untrusted document cannot make Chromium fetch remote resources.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  existsSync,
} from "node:fs";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { defineTool } from "@agentic/agent-kit";
import { readEnvironmentReference } from "../config/env-ref";

type JsonRecord = Record<string, unknown>;

export type DetectedDocumentFormat =
  | "pdf"
  | "docx"
  | "doc"
  | "text"
  | "markdown"
  | "unknown";

export interface DocumentConversionResult {
  filename: string;
  mime: "application/pdf";
  base64: string;
  sha256: string;
  input_sha256: string;
  bytes: number;
  input_bytes: number;
  source_format: Exclude<DetectedDocumentFormat, "unknown" | "doc">;
  converted: boolean;
}

export class DocumentConversionError extends Error {
  readonly kind = "document_conversion";
  readonly terminal: boolean;
  readonly retryable: boolean;

  constructor(
    readonly code: string,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(`${code}: ${message}`, { cause: options.cause });
    this.name = "DocumentConversionError";
    this.retryable = options.retryable === true;
    this.terminal = !this.retryable;
  }
}

interface ConversionWorkContext {
  tempDir: string;
  timeoutMs: number;
  maxTextBytes: number;
  maxOutputBytes: number;
  workerMemoryMb: number;
  config: JsonRecord;
  env: Record<string, string | undefined>;
}

export interface DocumentConvertOptions {
  env?: Record<string, string | undefined>;
  extractDocxText?: (
    input: Buffer,
    context: ConversionWorkContext,
  ) => Promise<string>;
  renderTextToPdf?: (
    text: string,
    context: ConversionWorkContext,
  ) => Promise<Buffer>;
  resolveChromium?: (
    config: JsonRecord,
    env: Record<string, string | undefined>,
  ) => string | null;
}

const DEFAULT_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const ABSOLUTE_MAX_INPUT_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const ABSOLUTE_MAX_OUTPUT_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_TEXT_BYTES = 5 * 1024 * 1024;
const ABSOLUTE_MAX_TEXT_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 120_000;
const DEFAULT_WORKER_MEMORY_MB = 192;
const execFileAsync = promisify(execFile);
const PDF_EOF = Buffer.from("%%EOF", "ascii");

const CHROMIUM_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
] as const;

function asRecord(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new DocumentConversionError(
      "invalid_document_config",
      `${field} must be an integer between 1 and ${maximum}.`,
    );
  }
  return value as number;
}

function strictBase64(value: string): Buffer {
  if (
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new DocumentConversionError(
      "invalid_document_input",
      "base64 must be canonical padded standard base64.",
    );
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new DocumentConversionError(
      "invalid_document_input",
      "base64 did not round-trip canonically.",
    );
  }
  return decoded;
}

function safeFilename(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const leaf = (raw.split(/[\\/]/).at(-1) ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const bounded = leaf.slice(0, 240);
  return bounded && bounded !== "." && bounded !== ".." ? bounded : "document";
}

function decodeUtf8Text(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  text = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!text.trim()) return null;
  let unsafeControls = 0;
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(code)) unsafeControls++;
  }
  return unsafeControls / Math.max(1, text.length) > 0.001 ? null : text;
}

/** Format identity comes from bytes. Filename is used only to distinguish a
 * validated UTF-8 markdown document from ordinary text. */
export function detectDocumentFormat(
  bytes: Buffer,
  filename?: string,
): DetectedDocumentFormat {
  if (bytes.length >= 8 && bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))
  ) return "doc";
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 && bytes[1] === 0x4b &&
    ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
      (bytes[2] === 0x05 && bytes[3] === 0x06) ||
      (bytes[2] === 0x07 && bytes[3] === 0x08))
  ) return "docx";
  if (decodeUtf8Text(bytes) !== null) {
    return /\.(?:md|markdown)$/i.test(filename ?? "") ? "markdown" : "text";
  }
  return "unknown";
}

function resolveInput(
  args: JsonRecord,
  lastResult: unknown,
): { bytes: Buffer; filename: string; mimeHint?: string } {
  const explicit = ["document_base64", "base64"].filter(
    (key) => Object.prototype.hasOwnProperty.call(args, key),
  );
  if (explicit.length > 1) {
    throw new DocumentConversionError(
      "invalid_document_input",
      "provide only one of document_base64 or base64.",
    );
  }
  let source: JsonRecord | null = null;
  let base64: unknown;
  if (explicit.length === 1) {
    source = args;
    base64 = args[explicit[0]!];
  } else {
    const outer = asRecord(lastResult);
    source = outer && typeof outer.base64 === "string"
      ? outer
      : asRecord(outer?.data);
    base64 = source?.base64;
  }
  if (!source || typeof base64 !== "string") {
    throw new DocumentConversionError(
      "invalid_document_input",
      "no document bytes found. Pass base64/document_base64 or chain from objectStore.getObject/fs.readFromInbox.",
    );
  }
  return {
    bytes: strictBase64(base64),
    filename: safeFilename(source.filename ?? args.filename),
    ...(typeof source.mime === "string" ? { mimeHint: source.mime } : {}),
  };
}

function allowedFormats(config: JsonRecord): Set<string> | null {
  if (config.allowed_formats === undefined) return null;
  if (
    !Array.isArray(config.allowed_formats) ||
    !config.allowed_formats.length ||
    !config.allowed_formats.every((value) => typeof value === "string")
  ) {
    throw new DocumentConversionError(
      "invalid_document_config",
      "allowed_formats must be a non-empty string array.",
    );
  }
  const allowed = new Set(config.allowed_formats as string[]);
  const known = new Set(["pdf", "docx", "text", "markdown"]);
  if ([...allowed].some((value) => !known.has(value))) {
    throw new DocumentConversionError(
      "invalid_document_config",
      "allowed_formats may contain only pdf, docx, text, markdown.",
    );
  }
  return allowed;
}

function executable(pathname: string): boolean {
  if (!path.isAbsolute(pathname) || !existsSync(pathname)) return false;
  try {
    accessSync(pathname, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function findDocumentChromium(
  config: JsonRecord = {},
  env: Record<string, string | undefined> = process.env,
): string | null {
  let configured: string | undefined;
  if (config.chromium_path_env !== undefined) {
    try {
      configured = readEnvironmentReference(
        env,
        config.chromium_path_env,
        "document.convert config.chromium_path_env",
      );
    } catch (error) {
      throw new DocumentConversionError(
        "document_dependency_missing",
        "chromium_path_env is invalid or does not resolve to a configured executable path.",
        { cause: error },
      );
    }
    if (!executable(configured)) {
      throw new DocumentConversionError(
        "document_dependency_missing",
        "chromium_path_env does not resolve to an executable absolute path.",
      );
    }
    return configured;
  }
  for (const candidate of [
    env.DOCUMENT_CHROMIUM_PATH,
    env.CHROME_PATH,
    env.CHROME_BIN,
    ...CHROMIUM_CANDIDATES,
  ]) {
    if (candidate && executable(candidate)) return candidate;
  }
  return null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasCompletePdfEnvelope(bytes: Buffer): boolean {
  if (detectDocumentFormat(bytes) !== "pdf") return false;
  return bytes.subarray(Math.max(0, bytes.length - 4_096)).includes(PDF_EOF);
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DocumentConversionError(
          "document_conversion_timeout",
          message,
          { retryable: true },
        )), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function defaultExtractDocxText(
  input: Buffer,
  context: ConversionWorkContext,
): Promise<string> {
  const inputPath = path.join(context.tempDir, "input.docx");
  const outputPath = path.join(context.tempDir, "document.txt");
  await writeFile(inputPath, input, { mode: 0o600 });
  const workerPath = fileURLToPath(new URL("./docx-text-worker.mjs", import.meta.url));
  try {
    await execFileAsync(
      process.execPath,
      [
        `--max-old-space-size=${context.workerMemoryMb}`,
        workerPath,
        inputPath,
        outputPath,
        String(context.maxTextBytes),
      ],
      {
        timeout: context.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: { PATH: process.env.PATH, NODE_ENV: "production" },
      },
    );
    const text = await readFile(outputPath, "utf8");
    if (!text.trim()) {
      throw new DocumentConversionError("invalid_docx", "DOCX contains no extractable text.");
    }
    return text;
  } catch (error) {
    if (error instanceof DocumentConversionError) throw error;
    const row = error as Error & { killed?: boolean; stderr?: string };
    if (row.killed) {
      throw new DocumentConversionError(
        "document_conversion_timeout",
        `DOCX extraction exceeded ${context.timeoutMs}ms.`,
        { retryable: true, cause: error },
      );
    }
    if (/ERR_MODULE_NOT_FOUND|Cannot find package ['"]mammoth/i.test(row.stderr ?? row.message)) {
      throw new DocumentConversionError(
        "document_dependency_missing",
        "the mammoth DOCX extractor is not installed in the runtime image.",
        { cause: error },
      );
    }
    throw new DocumentConversionError(
      "invalid_docx",
      "DOCX extraction failed; the ZIP/Word container may be malformed or unsupported.",
      { cause: error },
    );
  }
}

async function defaultRenderTextToPdf(
  text: string,
  context: ConversionWorkContext,
  resolveChromium: NonNullable<DocumentConvertOptions["resolveChromium"]>,
): Promise<Buffer> {
  if (Buffer.byteLength(text, "utf8") > context.maxTextBytes) {
    throw new DocumentConversionError(
      "document_text_too_large",
      `extracted text exceeds the configured ${context.maxTextBytes}-byte limit.`,
    );
  }
  const chromium = resolveChromium(context.config, context.env);
  if (!chromium) {
    throw new DocumentConversionError(
      "document_dependency_missing",
      "Chromium is required for DOCX/TXT/MD → PDF conversion; install it or set DOCUMENT_CHROMIUM_PATH.",
    );
  }
  const html = [
    "<!doctype html><html><head><meta charset=\"utf-8\">",
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\">",
    "<style>@page{size:A4;margin:16mm}body{font-family:'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif;color:#111}pre{font:11pt/1.55 inherit;white-space:pre-wrap;overflow-wrap:anywhere}</style>",
    "</head><body><pre>",
    escapeHtml(text),
    "</pre></body></html>",
  ].join("");
  let playwright: typeof import("playwright-core");
  try {
    playwright = await import("playwright-core");
  } catch (error) {
    throw new DocumentConversionError(
      "document_dependency_missing",
      "playwright-core is required to drive the isolated system Chromium renderer.",
      { cause: error },
    );
  }
  const deadline = Date.now() + context.timeoutMs;
  const remaining = (): number => {
    const value = deadline - Date.now();
    if (value <= 0) {
      throw new DocumentConversionError(
        "document_conversion_timeout",
        `Chromium rendering exceeded ${context.timeoutMs}ms.`,
        { retryable: true },
      );
    }
    return value;
  };
  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | null = null;
  try {
    browser = await playwright.chromium.launch({
      executablePath: chromium,
      headless: true,
      timeout: remaining(),
      args: [
        "--disable-gpu",
        "--disable-dev-shm-usage",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--hide-scrollbars",
        "--metrics-recording-only",
        "--no-default-browser-check",
        "--no-first-run",
        "--no-sandbox",
        // Keep both document content and browser-owned services off the
        // network. CSP protects the page; this dead proxy also covers browser
        // startup components that otherwise make CLI rendering flaky.
        "--proxy-server=http://127.0.0.1:9",
        "--proxy-bypass-list=<-loopback>",
      ],
    });
    const browserContext = await browser.newContext({
      javaScriptEnabled: false,
      serviceWorkers: "block",
    });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(remaining());
    await page.route("**/*", async (route) => {
      await route.abort("blockedbyclient");
    });
    await page.setContent(html, { waitUntil: "load", timeout: remaining() });
    const pdf = Buffer.from(await withinDeadline(
      page.pdf({
        format: "A4",
        margin: { top: "16mm", right: "16mm", bottom: "16mm", left: "16mm" },
        printBackground: true,
      }),
      remaining(),
      `Chromium PDF generation exceeded ${context.timeoutMs}ms.`,
    ));
    if (!hasCompletePdfEnvelope(pdf)) {
      throw new DocumentConversionError(
        "document_renderer_failed",
        "Chromium output is not a complete PDF envelope.",
      );
    }
    if (pdf.length > context.maxOutputBytes) {
      throw new DocumentConversionError(
        "document_output_too_large",
        `rendered PDF exceeds the configured ${context.maxOutputBytes}-byte limit.`,
      );
    }
    return pdf;
  } catch (error) {
    if (error instanceof DocumentConversionError) throw error;
    const row = error as Error;
    const timedOut = /timeout|timed out/i.test(row.message);
    throw new DocumentConversionError(
      timedOut ? "document_conversion_timeout" : "document_renderer_failed",
      timedOut
        ? `Chromium rendering exceeded ${context.timeoutMs}ms.`
        : "Chromium could not start or complete PDF rendering.",
      { retryable: timedOut, cause: row },
    );
  } finally {
    if (browser) {
      await Promise.race([browser.close().catch(() => undefined), delay(2_000)]);
    }
  }
}

export async function convertDocumentToPdf(
  args: JsonRecord,
  lastResult: unknown,
  config: JsonRecord = {},
  options: DocumentConvertOptions = {},
): Promise<DocumentConversionResult> {
  const env = options.env ?? process.env;
  const maxInputBytes = positiveInteger(
    config.max_input_bytes,
    DEFAULT_MAX_INPUT_BYTES,
    ABSOLUTE_MAX_INPUT_BYTES,
    "max_input_bytes",
  );
  const maxOutputBytes = positiveInteger(
    config.max_output_bytes,
    DEFAULT_MAX_OUTPUT_BYTES,
    ABSOLUTE_MAX_OUTPUT_BYTES,
    "max_output_bytes",
  );
  const maxTextBytes = positiveInteger(
    config.max_text_bytes,
    DEFAULT_MAX_TEXT_BYTES,
    ABSOLUTE_MAX_TEXT_BYTES,
    "max_text_bytes",
  );
  const timeoutMs = positiveInteger(
    config.timeout_ms,
    DEFAULT_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    "timeout_ms",
  );
  const workerMemoryMb = positiveInteger(
    config.worker_memory_mb,
    DEFAULT_WORKER_MEMORY_MB,
    512,
    "worker_memory_mb",
  );
  const input = resolveInput(args, lastResult);
  if (input.bytes.length > maxInputBytes) {
    throw new DocumentConversionError(
      "document_input_too_large",
      `input is ${input.bytes.length} bytes; configured limit is ${maxInputBytes}.`,
    );
  }
  const format = detectDocumentFormat(input.bytes, input.filename);
  if (format === "doc") {
    throw new DocumentConversionError(
      "legacy_doc_unsupported",
      "OLE2 .doc is not converted because this runtime has no reliable legacy Word parser. Convert it to DOCX or PDF before retrying.",
    );
  }
  if (format === "unknown") {
    throw new DocumentConversionError(
      "unsupported_document_format",
      "bytes are neither PDF, DOCX/ZIP, nor valid UTF-8 TXT/MD.",
    );
  }
  const allowed = allowedFormats(config);
  if (allowed && !allowed.has(format)) {
    throw new DocumentConversionError(
      "document_format_not_allowed",
      `detected format '${format}' is outside config.allowed_formats.`,
    );
  }

  const inputSha = createHash("sha256").update(input.bytes).digest("hex");
  let pdf = input.bytes;
  if (format !== "pdf") {
    const started = Date.now();
    const deadline = started + timeoutMs;
    const tempDir = await mkdtemp(path.join(tmpdir(), "agentic-document-"));
    await chmod(tempDir, 0o700);
    try {
      const remaining = (): number => {
        const value = deadline - Date.now();
        if (value <= 0) {
          throw new DocumentConversionError(
            "document_conversion_timeout",
            `document conversion exceeded ${timeoutMs}ms.`,
            { retryable: true },
          );
        }
        return value;
      };
      const baseContext: ConversionWorkContext = {
        tempDir,
        timeoutMs: remaining(),
        maxTextBytes,
        maxOutputBytes,
        workerMemoryMb,
        config,
        env,
      };
      const text = format === "docx"
        ? await (options.extractDocxText ?? defaultExtractDocxText)(input.bytes, baseContext)
        : decodeUtf8Text(input.bytes);
      if (!text?.trim()) {
        throw new DocumentConversionError(
          format === "docx" ? "invalid_docx" : "invalid_text_document",
          "document contains no safe extractable UTF-8 text.",
        );
      }
      const renderContext = { ...baseContext, timeoutMs: remaining() };
      pdf = options.renderTextToPdf
        ? await options.renderTextToPdf(text, renderContext)
        : await defaultRenderTextToPdf(
            text,
            renderContext,
            options.resolveChromium ?? findDocumentChromium,
          );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
  if (detectDocumentFormat(pdf) !== "pdf") {
    throw new DocumentConversionError(
      "document_renderer_failed",
      "conversion result is not a PDF by magic bytes.",
    );
  }
  if (pdf.length > maxOutputBytes) {
    throw new DocumentConversionError(
      "document_output_too_large",
      `PDF is ${pdf.length} bytes; configured limit is ${maxOutputBytes}.`,
    );
  }
  const stem = input.filename.replace(/\.[^.]+$/, "") || "document";
  return {
    filename: `${stem}.pdf`,
    mime: "application/pdf",
    base64: pdf.toString("base64"),
    sha256: createHash("sha256").update(pdf).digest("hex"),
    input_sha256: inputSha,
    bytes: pdf.length,
    input_bytes: input.bytes.length,
    source_format: format,
    converted: format !== "pdf",
  };
}

export const documentConvert = defineTool({
  name: "document.convert",
  description:
    "Convert a bounded PDF, DOCX, or UTF-8 TXT/MD document into real PDF bytes. " +
    "Input can be direct base64, but the preferred path is no args after objectStore.getObject/fs.readFromInbox; " +
    "the tool consumes {base64,filename,mime} from ctx.lastResult. Magic bytes are authoritative. " +
    "Legacy OLE2 .doc and missing conversion dependencies fail closed with typed errors.",
  output: z.object({
    filename: z.string(),
    mime: z.literal("application/pdf"),
    base64: z.string(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().positive(),
    input_bytes: z.number().int().positive(),
    source_format: z.enum(["pdf", "docx", "text", "markdown"]),
    converted: z.boolean(),
  }),
  async handler(ctx) {
    return {
      data: await convertDocumentToPdf(
        (ctx.event?.data ?? {}) as JsonRecord,
        ctx.lastResult,
        (ctx.config ?? {}) as JsonRecord,
      ),
      meta: { isolation: "node-child+chromium-child", magicByteDetection: true },
    };
  },
});
