import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createTenantCodeArchive } from "../src/tenant-code-archive.js";

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "agentic-cli-archive-"));
});

afterEach(async () => {
  if (cwd) await rm(cwd, { recursive: true, force: true });
});

function tarPaths(raw: Buffer): string[] {
  const paths: string[] = [];
  let offset = 0;
  while (offset + 512 <= raw.length) {
    const header = raw.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const read = (at: number, length: number) => {
      const field = header.subarray(at, at + length);
      const nul = field.indexOf(0);
      return field.subarray(0, nul < 0 ? field.length : nul).toString("utf8");
    };
    const name = read(0, 100);
    const prefix = read(345, 155);
    paths.push(prefix ? `${prefix}/${name}` : name);
    const size = Number.parseInt(read(124, 12).trim() || "0", 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return paths;
}

describe("tenant code archive", () => {
  it("creates a deterministic gzip ustar and excludes credentials/build caches", async () => {
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await mkdir(path.join(cwd, "node_modules", "ignored"), { recursive: true });
    await writeFile(path.join(cwd, "agentic.json"), '{"slug":"demo"}\n');
    await writeFile(path.join(cwd, "src", "index.ts"), "export default {};\n");
    await writeFile(path.join(cwd, ".env"), "SECRET=must-not-ship\n");
    await writeFile(path.join(cwd, "node_modules", "ignored", "index.js"), "bad\n");

    const first = await createTenantCodeArchive(cwd);
    const second = await createTenantCodeArchive(cwd);
    expect(first.sha256).toBe(second.sha256);
    expect(first.tarball.subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b]));
    expect(tarPaths(gunzipSync(first.tarball))).toEqual([
      "agentic.json",
      "src/index.ts",
    ]);
    expect(first.fileCount).toBe(2);
  });

  it("rejects symbolic links instead of dereferencing files outside the package", async () => {
    await writeFile(path.join(cwd, "agentic.json"), '{"slug":"demo"}\n');
    const outside = path.join(tmpdir(), `agentic-secret-${Date.now()}`);
    await writeFile(outside, "secret\n");
    await symlink(outside, path.join(cwd, "linked-secret"));
    try {
      await expect(createTenantCodeArchive(cwd)).rejects.toThrow(/symbolic link/);
    } finally {
      await rm(outside, { force: true });
    }
  });
});
