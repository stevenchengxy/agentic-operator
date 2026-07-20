import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { walkAndRotate } from "./log-rotate";

const gunzipAsync = promisify(gunzip);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentic-log-rotate-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("walkAndRotate", () => {
  it("treats an explicitly missing log root as a valid empty sweep", async () => {
    const parent = await tempRoot();
    await expect(walkAndRotate(path.join(parent, "missing"))).resolves.toEqual({ rotated: 0, skipped: 0 });
  });

  it("compresses an old run log and only reports it after the I/O succeeds", async () => {
    const root = await tempRoot();
    const dateDir = path.join(root, "tenant-a", "runs", "2026-01-01");
    const source = path.join(dateDir, "run-1.log");
    await mkdir(dateDir, { recursive: true });
    await writeFile(source, "durable log line\n", "utf8");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(source, old, old);

    await expect(walkAndRotate(root)).resolves.toEqual({ rotated: 1, skipped: 0 });
    await expect(readFile(source)).rejects.toMatchObject({ code: "ENOENT" });
    const compressed = await readFile(`${source}.gz`);
    expect((await gunzipAsync(compressed)).toString("utf8")).toBe("durable log line\n");
  });

  it("propagates non-ENOENT directory traversal failures", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "tenant-is-a-file"), "not a directory", "utf8");

    await expect(walkAndRotate(root)).rejects.toMatchObject({ code: "ENOTDIR" });
  });

  it("propagates stat and gzip failures instead of counting/skipping them as success", async () => {
    const statRoot = await tempRoot();
    const runsRoot = path.join(statRoot, "tenant-a", "runs");
    await mkdir(runsRoot, { recursive: true });
    await symlink("loop", path.join(runsRoot, "loop"));
    await expect(walkAndRotate(statRoot)).rejects.toMatchObject({ code: "ELOOP" });

    const gzipRoot = await tempRoot();
    const dateDir = path.join(gzipRoot, "tenant-a", "runs", "2026-01-01");
    const source = path.join(dateDir, "run-1.log");
    await mkdir(dateDir, { recursive: true });
    await writeFile(source, "cannot compress", "utf8");
    await mkdir(`${source}.gz`);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(source, old, old);

    await expect(walkAndRotate(gzipRoot)).rejects.toMatchObject({ code: "EISDIR" });
    await expect(readFile(source, "utf8")).resolves.toBe("cannot compress");
    expect((await readdir(dateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});
