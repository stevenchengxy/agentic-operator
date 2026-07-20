import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";

const TAR_BLOCK = 512;
const MAX_FILES = 512;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  "artifacts",
  "coverage",
  "logs",
  "node_modules",
]);

function isSecretFile(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower === ".env" ||
    lower.startsWith(".env.") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".key") ||
    lower === "credentials.json"
  );
}

interface ArchiveFile {
  absolutePath: string;
  archivePath: string;
  mode: number;
  size: number;
}

export interface TenantCodeArchive {
  tarball: Buffer;
  sha256: string;
  fileCount: number;
  uncompressedBytes: number;
}

async function collectFiles(root: string): Promise<ArchiveFile[]> {
  const files: ArchiveFile[] = [];
  let totalBytes = 0;

  async function visit(dir: string, relativeDir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") {
        throw new Error(`deploy: invalid package entry ${entry.name}`);
      }
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      if (isSecretFile(entry.name)) continue;

      const absolutePath = path.join(dir, entry.name);
      const archivePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;
      const stat = await lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(
          `deploy: refusing symbolic link in tenant package: ${archivePath}`,
        );
      }
      if (stat.isDirectory()) {
        await visit(absolutePath, archivePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          `deploy: refusing non-regular package entry: ${archivePath}`,
        );
      }
      if (stat.size > MAX_FILE_BYTES) {
        throw new Error(
          `deploy: package file ${archivePath} exceeds ${MAX_FILE_BYTES} bytes`,
        );
      }
      totalBytes += stat.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        throw new Error(
          `deploy: tenant package exceeds ${MAX_TOTAL_BYTES} uncompressed bytes`,
        );
      }
      files.push({
        absolutePath,
        archivePath,
        mode: stat.mode & 0o777,
        size: stat.size,
      });
      if (files.length > MAX_FILES) {
        throw new Error(`deploy: tenant package exceeds ${MAX_FILES} files`);
      }
    }
  }

  await visit(root, "");
  return files;
}

function splitUstarPath(archivePath: string): { name: string; prefix: string } {
  if (Buffer.byteLength(archivePath, "utf8") <= 100) {
    return { name: archivePath, prefix: "" };
  }
  const separators: number[] = [];
  for (let i = 0; i < archivePath.length; i += 1) {
    if (archivePath[i] === "/") separators.push(i);
  }
  for (let i = separators.length - 1; i >= 0; i -= 1) {
    const at = separators[i]!;
    const prefix = archivePath.slice(0, at);
    const name = archivePath.slice(at + 1);
    if (
      Buffer.byteLength(prefix, "utf8") <= 155 &&
      Buffer.byteLength(name, "utf8") <= 100
    ) {
      return { name, prefix };
    }
  }
  throw new Error(
    `deploy: package path cannot be represented by ustar: ${archivePath}`,
  );
}

function writeText(
  header: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) {
    throw new Error(`deploy: tar header field is too long: ${value}`);
  }
  bytes.copy(header, offset);
}

function writeOctal(
  header: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`deploy: invalid tar numeric field: ${value}`);
  }
  const octal = value.toString(8);
  if (octal.length > length - 1) {
    throw new Error(`deploy: tar numeric field overflows: ${value}`);
  }
  writeText(header, offset, length, `${octal.padStart(length - 1, "0")}\0`);
}

function buildHeader(file: ArchiveFile): Buffer {
  const header = Buffer.alloc(TAR_BLOCK, 0);
  const { name, prefix } = splitUstarPath(file.archivePath);
  writeText(header, 0, 100, name);
  writeOctal(header, 100, 8, file.mode || 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file.size);
  // Normalize mtime/ownership so identical source produces an identical
  // content-addressed deployment version on every machine.
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  writeText(header, 345, 155, prefix);

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  writeText(header, 148, 8, `${checksumText}\0 `);
  return header;
}

export async function createTenantCodeArchive(
  tenantRoot: string,
): Promise<TenantCodeArchive> {
  const files = await collectFiles(tenantRoot);
  if (!files.some((file) => file.archivePath === "agentic.json")) {
    throw new Error("deploy: tenant package is missing root agentic.json");
  }

  const chunks: Buffer[] = [];
  let uncompressedBytes = 0;
  for (const file of files) {
    const content = await readFile(file.absolutePath);
    if (content.length !== file.size) {
      throw new Error(
        `deploy: package file changed while archiving: ${file.archivePath}`,
      );
    }
    chunks.push(buildHeader(file), content);
    const padding = (TAR_BLOCK - (content.length % TAR_BLOCK)) % TAR_BLOCK;
    if (padding > 0) chunks.push(Buffer.alloc(padding, 0));
    uncompressedBytes += content.length;
  }
  chunks.push(Buffer.alloc(TAR_BLOCK * 2, 0));
  const raw = Buffer.concat(chunks);
  return {
    tarball: gzipSync(raw, { level: 9 }),
    sha256: createHash("sha256").update(raw).digest("hex"),
    fileCount: files.length,
    uncompressedBytes,
  };
}
