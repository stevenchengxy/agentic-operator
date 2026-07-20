import path from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { constants, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import type {
  WorkflowDocumentDiagnostic,
  WorkflowDocumentExtraction,
  WorkflowDocumentFolder,
  WorkflowDocumentFoldersResponse,
} from "@agentic/contracts";

const execFile = promisify(execFileCallback);

export const WORKFLOW_DOCUMENT_LIMITS = Object.freeze({
  maxFiles: 100,
  maxDepth: 8,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
  maxTotalCharacters: 200_000,
  maxEntries: 1_000,
  maxDirectories: 100,
  maxDiagnostics: 250,
});

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".html",
  ".htm",
  ".xml",
]);
const BINARY_EXTENSIONS = new Set([".pdf", ".docx"]);
const SUPPORTED_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...BINARY_EXTENSIONS,
]);

export class WorkflowDocumentPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowDocumentPathError";
  }
}

export class WorkflowDocumentFolderNotFoundError extends Error {
  constructor(public readonly folder: string) {
    super(`workflow document folder not found: ${folder || "(root)"}`);
    this.name = "WorkflowDocumentFolderNotFoundError";
  }
}

function configuredRoot(): string {
  const configured =
    process.env.AGENTIC_WORKFLOW_DOCUMENTS_DIR ??
    path.join(process.env.AGENTIC_DATA_ROOT ?? "./data", "workflow-documents");
  return path.isAbsolute(configured)
    ? path.normalize(configured)
    : path.resolve(process.cwd(), configured);
}

function assertTenantSlug(tenantSlug: string): void {
  if (!/^[a-z_][a-z0-9_-]{1,63}$/i.test(tenantSlug)) {
    throw new WorkflowDocumentPathError("invalid tenant document namespace");
  }
}

export function normalizeDocumentFolder(folder: string | undefined): string {
  const value = (folder ?? "").trim();
  if (!value || value === ".") return "";
  if (
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value)
  ) {
    throw new WorkflowDocumentPathError(
      "document folder must be a relative POSIX path",
    );
  }
  const parts = value.split("/");
  if (
    parts.some(
      (part) => !part || part === "." || part === ".." || part.startsWith("."),
    )
  ) {
    throw new WorkflowDocumentPathError(
      "document folder contains an unsafe path component",
    );
  }
  return parts.join("/");
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

async function resolveTenantRoot(
  tenantSlug: string,
): Promise<{ root: string; tenantRoot: string } | null> {
  assertTenantSlug(tenantSlug);
  let root: string;
  try {
    root = await realpath(configuredRoot());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const unresolvedTenantRoot = path.resolve(root, tenantSlug);
  if (!isWithin(root, unresolvedTenantRoot)) {
    throw new WorkflowDocumentPathError(
      "tenant document root escaped base root",
    );
  }
  try {
    const tenantStat = await lstat(unresolvedTenantRoot);
    if (tenantStat.isSymbolicLink()) {
      throw new WorkflowDocumentPathError(
        "tenant document root cannot be a symbolic link",
      );
    }
    if (!tenantStat.isDirectory()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const tenantRoot = await realpath(unresolvedTenantRoot);
  if (!isWithin(root, tenantRoot)) {
    throw new WorkflowDocumentPathError(
      "tenant document root escaped base root",
    );
  }
  return { root, tenantRoot };
}

async function resolveFolder(
  tenantSlug: string,
  folder: string | undefined,
): Promise<{
  tenantRoot: string;
  folderPath: string;
  relative: string;
} | null> {
  const roots = await resolveTenantRoot(tenantSlug);
  if (!roots) return null;
  const relative = normalizeDocumentFolder(folder);
  const unresolved = path.resolve(
    roots.tenantRoot,
    ...relative.split("/").filter(Boolean),
  );
  if (!isWithin(roots.tenantRoot, unresolved)) {
    throw new WorkflowDocumentPathError("document folder escaped tenant root");
  }
  let folderStat;
  try {
    folderStat = await lstat(unresolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (folderStat.isSymbolicLink()) {
    throw new WorkflowDocumentPathError(
      "document folder cannot be a symbolic link",
    );
  }
  if (!folderStat.isDirectory()) return null;
  const folderPath = await realpath(unresolved);
  if (!isWithin(roots.tenantRoot, folderPath)) {
    throw new WorkflowDocumentPathError("document folder escaped tenant root");
  }
  return { tenantRoot: roots.tenantRoot, folderPath, relative };
}

interface FolderAccumulator {
  files: number;
  bytes: number;
  modifiedAt: number;
}

interface FolderScanState {
  entries: number;
  directories: number;
  truncated: boolean;
}

async function scanFolderOnce(
  folderPath: string,
  tenantRoot: string,
  relative: string,
  depth: number,
  state: FolderScanState,
  folders: WorkflowDocumentFolder[],
): Promise<FolderAccumulator> {
  const aggregate: FolderAccumulator = { files: 0, bytes: 0, modifiedAt: 0 };
  if (
    depth > WORKFLOW_DOCUMENT_LIMITS.maxDepth ||
    state.directories >= WORKFLOW_DOCUMENT_LIMITS.maxDirectories
  ) {
    state.truncated = true;
    return aggregate;
  }
  state.directories += 1;
  const ownStat = await stat(folderPath);
  aggregate.modifiedAt = ownStat.mtimeMs;
  const directory = await opendir(folderPath);
  for await (const entry of directory) {
    // Folder discovery and extraction intentionally expose the same visible
    // tree. Dot entries can contain editor metadata or credentials and are
    // never workflow inputs.
    if (entry.name.startsWith(".")) continue;
    if (state.entries >= WORKFLOW_DOCUMENT_LIMITS.maxEntries) {
      state.truncated = true;
      break;
    }
    state.entries += 1;
    const absolute = path.join(folderPath, entry.name);
    const item = await lstat(absolute);
    aggregate.modifiedAt = Math.max(aggregate.modifiedAt, item.mtimeMs);
    if (item.isSymbolicLink()) continue;
    if (item.isDirectory()) {
      const resolved = await realpath(absolute);
      if (!isWithin(tenantRoot, resolved)) continue;
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const child = await scanFolderOnce(
        resolved,
        tenantRoot,
        childRelative,
        depth + 1,
        state,
        folders,
      );
      aggregate.files += child.files;
      aggregate.bytes += child.bytes;
      aggregate.modifiedAt = Math.max(aggregate.modifiedAt, child.modifiedAt);
    } else if (
      item.isFile() &&
      SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    ) {
      aggregate.files += 1;
      aggregate.bytes += item.size;
    }
  }
  if (aggregate.files > 0 || relative === "") {
    folders.push({
      path: relative,
      name: relative ? path.posix.basename(relative) : "Workflow documents",
      fileCount: aggregate.files,
      totalBytes: aggregate.bytes,
      modifiedAt: Math.floor(aggregate.modifiedAt),
    });
  }
  return aggregate;
}

export async function listWorkflowDocumentFolders(
  tenantSlug: string,
): Promise<WorkflowDocumentFoldersResponse> {
  const roots = await resolveTenantRoot(tenantSlug);
  if (!roots) return { rootAvailable: false, truncated: false, folders: [] };
  const folders: WorkflowDocumentFolder[] = [];
  const state: FolderScanState = {
    entries: 0,
    directories: 0,
    truncated: false,
  };
  await scanFolderOnce(
    roots.tenantRoot,
    roots.tenantRoot,
    "",
    0,
    state,
    folders,
  );
  folders.sort((left, right) => left.path.localeCompare(right.path));
  return { rootAvailable: true, truncated: state.truncated, folders };
}

async function readBounded(
  filePath: string,
  maxBytes: number,
): Promise<Buffer> {
  const handle = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const verified = await handle.stat();
    if (!verified.isFile())
      throw new Error("document is no longer a regular file");
    const buffer = Buffer.allocUnsafe(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function decodeUtf8(buffer: Buffer, allowIncompleteTail = false): string {
  return new TextDecoder("utf-8", { fatal: !allowIncompleteTail }).decode(
    buffer,
  );
}

function stripMarkup(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[\t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractBinary(
  filePath: string,
  extension: string,
  maxBytes: number,
): Promise<string> {
  const source = await open(
    filePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  let scratch = "";
  try {
    const verified = await source.stat();
    if (!verified.isFile())
      throw new Error("document is no longer a regular file");
    if (verified.size > maxBytes) {
      throw new Error(
        "binary document exceeded the verified extraction allowance",
      );
    }
    // External extractors must never reopen the user-controlled pathname.
    // Copy from the already verified, no-follow descriptor into a private
    // temporary directory, then run the extractor against that stable copy.
    scratch = await mkdtemp(path.join(tmpdir(), "agentic-workflow-doc-"));
    const stablePath = path.join(scratch, `document${extension}`);
    await pipeline(
      source.createReadStream({ autoClose: false }),
      createWriteStream(stablePath, { flags: "wx", mode: 0o600 }),
    );
    if (extension === ".pdf") {
      const { stdout } = await execFile("pdftotext", [stablePath, "-"], {
        encoding: "utf8",
        maxBuffer: WORKFLOW_DOCUMENT_LIMITS.maxFileBytes,
        timeout: 15_000,
      });
      return stdout.trim();
    }
    const { stdout } = await execFile(
      "unzip",
      ["-p", stablePath, "word/document.xml"],
      {
        encoding: "utf8",
        maxBuffer: WORKFLOW_DOCUMENT_LIMITS.maxFileBytes,
        timeout: 15_000,
      },
    );
    return stripMarkup(stdout);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new Error(
        `extractor_unavailable: ${extension === ".pdf" ? "pdftotext" : "unzip"} is not installed`,
      );
    }
    throw error;
  } finally {
    await source.close().catch(() => undefined);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  }
}

function extractionFailureReason(error: unknown, extension: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith("extractor_unavailable:")) return message;
  if (
    error instanceof TypeError ||
    /encoded data was not valid|utf-?8/i.test(message)
  ) {
    return "invalid_utf8";
  }
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ETIMEDOUT" || /timed? ?out/i.test(message)) {
    return `${extension.slice(1) || "text"}_extractor_timeout`;
  }
  return `${extension.slice(1) || "text"}_extraction_failed`;
}

interface CandidateFile {
  absolute: string;
  relative: string;
  bytes: number;
}

interface CandidateCollection {
  files: CandidateFile[];
  filesSeen: number;
  truncated: boolean;
}

async function collectCandidates(
  folderPath: string,
  tenantRoot: string,
  baseRelative: string,
  diagnostics: WorkflowDocumentDiagnostic[],
): Promise<CandidateCollection> {
  const files: CandidateFile[] = [];
  const state = {
    entries: 0,
    directories: 0,
    filesSeen: 0,
    truncated: false,
    stopped: false,
  };
  const addDiagnostic = (diagnostic: WorkflowDocumentDiagnostic): void => {
    if (diagnostics.length < WORKFLOW_DOCUMENT_LIMITS.maxDiagnostics) {
      diagnostics.push(diagnostic);
    } else {
      state.truncated = true;
    }
  };
  const visit = async (absolute: string, relative: string, depth: number) => {
    if (state.stopped) return;
    if (
      depth > WORKFLOW_DOCUMENT_LIMITS.maxDepth ||
      state.directories >= WORKFLOW_DOCUMENT_LIMITS.maxDirectories
    ) {
      state.truncated = true;
      return;
    }
    state.directories += 1;
    const directory = await opendir(absolute);
    for await (const entry of directory) {
      if (entry.name.startsWith(".")) continue;
      if (state.entries >= WORKFLOW_DOCUMENT_LIMITS.maxEntries) {
        state.truncated = true;
        state.stopped = true;
        break;
      }
      state.entries += 1;
      const candidate = path.join(absolute, entry.name);
      const candidateRelative = relative
        ? `${relative}/${entry.name}`
        : entry.name;
      const displayPath = baseRelative
        ? `${baseRelative}/${candidateRelative}`
        : candidateRelative;
      const item = await lstat(candidate);
      if (item.isSymbolicLink()) {
        state.filesSeen += 1;
        addDiagnostic({
          path: displayPath,
          status: "skipped",
          bytes: item.size,
          characters: 0,
          reason: "symbolic links are not allowed",
        });
        continue;
      }
      if (item.isDirectory()) {
        const resolved = await realpath(candidate);
        if (!isWithin(tenantRoot, resolved)) {
          addDiagnostic({
            path: displayPath,
            status: "skipped",
            bytes: 0,
            characters: 0,
            reason: "directory escaped the tenant document root",
          });
          continue;
        }
        await visit(resolved, candidateRelative, depth + 1);
        if (state.stopped) break;
        continue;
      }
      if (!item.isFile()) continue;
      state.filesSeen += 1;
      const extension = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        addDiagnostic({
          path: displayPath,
          status: "skipped",
          bytes: item.size,
          characters: 0,
          reason: `unsupported extension ${extension || "(none)"}`,
        });
        continue;
      }
      if (files.length >= WORKFLOW_DOCUMENT_LIMITS.maxFiles) {
        addDiagnostic({
          path: displayPath,
          status: "skipped",
          bytes: item.size,
          characters: 0,
          reason: `file count limit ${WORKFLOW_DOCUMENT_LIMITS.maxFiles} reached`,
        });
        state.truncated = true;
        state.stopped = true;
        break;
      }
      const resolved = await realpath(candidate);
      if (!isWithin(tenantRoot, resolved)) {
        addDiagnostic({
          path: displayPath,
          status: "skipped",
          bytes: item.size,
          characters: 0,
          reason: "file escaped the tenant document root",
        });
        continue;
      }
      files.push({
        absolute: resolved,
        relative: displayPath,
        bytes: item.size,
      });
    }
  };
  await visit(folderPath, "", 0);
  files.sort((left, right) => left.relative.localeCompare(right.relative));
  return {
    files,
    filesSeen: state.filesSeen,
    truncated: state.truncated,
  };
}

export interface ExtractedWorkflowDocuments {
  report: WorkflowDocumentExtraction;
  documents: Array<{ path: string; text: string }>;
}

export async function extractWorkflowDocuments(
  tenantSlug: string,
  folder: string,
): Promise<ExtractedWorkflowDocuments> {
  const resolved = await resolveFolder(tenantSlug, folder);
  if (!resolved) {
    throw new WorkflowDocumentFolderNotFoundError(
      normalizeDocumentFolder(folder),
    );
  }
  const diagnostics: WorkflowDocumentDiagnostic[] = [];
  const collection = await collectCandidates(
    resolved.folderPath,
    resolved.tenantRoot,
    resolved.relative,
    diagnostics,
  );
  const candidates = collection.files;
  const documents: Array<{ path: string; text: string }> = [];
  let totalBytes = 0;
  let totalCharacters = 0;
  let truncated =
    collection.truncated ||
    diagnostics.some((item) => /limit/i.test(item.reason ?? ""));

  for (const candidate of candidates) {
    if (totalCharacters >= WORKFLOW_DOCUMENT_LIMITS.maxTotalCharacters) {
      diagnostics.push({
        path: candidate.relative,
        status: "skipped",
        bytes: candidate.bytes,
        characters: 0,
        reason: "aggregate character limit reached",
      });
      truncated = true;
      continue;
    }
    if (totalBytes >= WORKFLOW_DOCUMENT_LIMITS.maxTotalBytes) {
      diagnostics.push({
        path: candidate.relative,
        status: "skipped",
        bytes: candidate.bytes,
        characters: 0,
        reason: "aggregate byte limit reached",
      });
      truncated = true;
      continue;
    }
    const extension = path.extname(candidate.relative).toLowerCase();
    const byteAllowance = Math.min(
      WORKFLOW_DOCUMENT_LIMITS.maxFileBytes,
      WORKFLOW_DOCUMENT_LIMITS.maxTotalBytes - totalBytes,
    );
    const fileWasTruncated = candidate.bytes > byteAllowance;
    if (BINARY_EXTENSIONS.has(extension) && fileWasTruncated) {
      diagnostics.push({
        path: candidate.relative,
        status: "skipped",
        bytes: candidate.bytes,
        characters: 0,
        reason: `binary file exceeds the safe extraction allowance of ${byteAllowance} bytes`,
      });
      truncated = true;
      continue;
    }
    try {
      let text: string;
      if (TEXT_EXTENSIONS.has(extension)) {
        text = decodeUtf8(
          await readBounded(candidate.absolute, byteAllowance),
          fileWasTruncated,
        );
        if (
          extension === ".html" ||
          extension === ".htm" ||
          extension === ".xml"
        ) {
          text = stripMarkup(text);
        }
      } else {
        text = await extractBinary(
          candidate.absolute,
          extension,
          byteAllowance,
        );
      }
      const remainingCharacters =
        WORKFLOW_DOCUMENT_LIMITS.maxTotalCharacters - totalCharacters;
      const textWasTruncated = text.length > remainingCharacters;
      const boundedText = text.slice(0, Math.max(0, remainingCharacters));
      if (boundedText.length > 0) {
        documents.push({ path: candidate.relative, text: boundedText });
      }
      const consumedBytes = Math.min(candidate.bytes, byteAllowance);
      totalBytes += consumedBytes;
      totalCharacters += boundedText.length;
      const wasTruncated = fileWasTruncated || textWasTruncated;
      truncated ||= wasTruncated;
      diagnostics.push({
        path: candidate.relative,
        status: wasTruncated ? "truncated" : "included",
        bytes: consumedBytes,
        characters: boundedText.length,
        ...(wasTruncated
          ? { reason: "configured extraction limit reached" }
          : {}),
      });
    } catch (error) {
      diagnostics.push({
        path: candidate.relative,
        status: "failed",
        bytes: candidate.bytes,
        characters: 0,
        reason: extractionFailureReason(error, extension),
      });
    }
  }

  const boundedDiagnostics = diagnostics.slice(
    0,
    WORKFLOW_DOCUMENT_LIMITS.maxDiagnostics,
  );

  return {
    report: {
      folder: resolved.relative,
      filesSeen: collection.filesSeen,
      filesIncluded: diagnostics.filter(
        (item) => item.status === "included" || item.status === "truncated",
      ).length,
      totalBytes,
      totalCharacters,
      truncated,
      diagnostics: boundedDiagnostics,
    },
    documents,
  };
}
