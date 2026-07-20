import { afterEach, describe, expect, it } from "vitest";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  __resetForTest as __broadcastResetForTest,
  subscribe as subscribeStreamEvents,
} from "./broadcast";
import { logPathFor, writeRunLog } from "./log-writer";

const roots: string[] = [];
const originalLogRoot = process.env.AGENTIC_LOGS_DIR;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agentic-log-writer-"));
  roots.push(root);
  process.env.AGENTIC_LOGS_DIR = root;
  return root;
}

afterEach(async () => {
  __broadcastResetForTest();
  if (originalLogRoot == null) delete process.env.AGENTIC_LOGS_DIR;
  else process.env.AGENTIC_LOGS_DIR = originalLogRoot;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("writeRunLog production evidence", () => {
  it("durably writes the exact broadcast line and recursively redacts secrets", async () => {
    await tempRoot();
    const ctx = {
      tenantSlug: "tenant-a",
      tenantId: "ten-a",
      runId: "run-a",
      correlationId: "cor-a",
      agentName: "agent-a",
    };
    const received: unknown[] = [];
    const unsubscribe = subscribeStreamEvents("ten-a", (event) =>
      received.push(event),
    );

    await writeRunLog(ctx, "INFO", "tool.call", {
      tool: "records.upsert",
      ok: true,
      nested: { apiKey: "do-not-log", safe: "visible" },
    });
    unsubscribe();

    const filePath = logPathFor(ctx);
    expect(path.isAbsolute(filePath)).toBe(true);
    const persisted = await readFile(filePath, "utf8");
    expect(persisted).not.toContain("do-not-log");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).toContain("visible");

    const logEvent = received.find(
      (event) =>
        typeof event === "object" &&
        event !== null &&
        (event as { type?: string }).type === "log.line",
    ) as { message: string } | undefined;
    expect(logEvent?.message).toBe(persisted.trimEnd());
  });

  it("rejects a persisted path outside the tenant root without creating it", async () => {
    const root = await tempRoot();
    const outside = path.join(root, "outside.log");
    await expect(
      writeRunLog(
        {
          tenantSlug: "tenant-a",
          runId: "run-a",
          correlationId: "cor-a",
          logPath: outside,
        },
        "INFO",
        "run.start",
      ),
    ).rejects.toThrow(/outside/i);
    await expect(access(outside)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a symlinked directory that resolves outside the tenant root", async () => {
    const root = await tempRoot();
    const runsRoot = path.join(root, "tenant-a", "runs");
    const outside = path.join(root, "outside");
    await mkdir(runsRoot, { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(runsRoot, "2026-07-13"));

    await expect(
      writeRunLog(
        {
          tenantSlug: "tenant-a",
          runId: "run-a",
          correlationId: "cor-a",
          logPath: path.join(runsRoot, "2026-07-13", "run-a.log"),
        },
        "INFO",
        "run.start",
      ),
    ).rejects.toThrow(/outside tenant root/i);
    await expect(access(path.join(outside, "run-a.log"))).rejects.toMatchObject(
      {
        code: "ENOENT",
      },
    );
  });
});
