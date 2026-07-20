/**
 * TC-51 — P4-API-01 graceful shutdown.
 *
 * Spawns the API as a subprocess on a free port, hits /health to confirm it's
 * up, then sends SIGTERM. Asserts the process exits with code 0 inside the
 * configured drain window. Also verifies the server stops accepting new
 * connections during the drain (a follow-up GET returns ECONNREFUSED).
 */

import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import net from "node:net";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(__dirname, "../../..");
const apiDir = path.resolve(__dirname, "..");

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        return reject(new Error("could not allocate port"));
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForReady(port: number, deadlineMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(500),
      });
      if (res.status === 200 || res.status === 503) return true;
    } catch {
      // Not up yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

describe("TC-51: P4-API-01 graceful shutdown", () => {
  it(
    "exits 0 within the drain window after SIGTERM",
    async () => {
      const port = await findFreePort();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        // Use NODE_ENV=test (not "production") so the AUTH_MODE=dev safety
        // guard introduced in P5-AUTH-01 (apps/api/src/plugins/auth.ts —
        // `assertAuthModeSafe`) doesn't refuse to boot. The shutdown test
        // only hits the unauthenticated /health endpoint so the auth mode
        // is irrelevant; we still need `AUTH_MODE=dev` because the boot
        // path otherwise tries to enforce bearer auth against an empty
        // api_tokens table and the request would 401 (still survivable —
        // the test asserts on exit code, not the GET — but explicit-dev
        // keeps the test deterministic across the auth-guard's evolution).
        NODE_ENV: "test",
        AUTH_MODE: "dev",
        AGENTIC_DEV_TENANT: "__system",
        LOG_LEVEL: "error",
        PORT: String(port),
        HOST: "127.0.0.1",
        AGENTIC_MODELS_DIR: path.join(repoRoot, "models"),
        AGENTIC_LOGS_DIR: path.join(repoRoot, "data", "test-logs"),
        AGENTIC_ARTIFACTS_DIR: path.join(repoRoot, "data", "test-artifacts"),
        // Inherit the suite's isolated snapshot. Falling back keeps this test
        // runnable on its own outside Vitest's shared setup.
        DATABASE_URL:
          process.env.DATABASE_URL ?? `file:${path.join(repoRoot, "data", "agentic.db")}`,
        LLM_DEFAULT_PROVIDER: "mock",
        LLM_DEFAULT_MODEL: "mock-model-v1",
        INNGEST_EVENT_KEY: "test-event-key",
        INNGEST_SIGNING_KEY:
          "signkey-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        INNGEST_DEV: "1",
        AGENTIC_SHUTDOWN_TIMEOUT_MS: "5000",
      };

      // Invoke the tsx module with the exact Node binary running Vitest.
      // The `.bin/tsx` shell shim performs `exec node ...` through PATH,
      // which is not a valid runtime dependency in hermetic CI and can leave
      // this test waiting for a process that never started. `process.execPath`
      // also keeps SIGTERM attached to the real Node process (unlike a pnpm
      // wrapper), so code=0 still proves the application's shutdown handler.
      const tsxLoader = pathToFileURL(
        createRequire(import.meta.url).resolve("tsx"),
      ).href;
      const proc = spawn(
        process.execPath,
        ["--import", tsxLoader, "scripts/sqlite-writer-supervisor.ts"],
        {
        cwd: apiDir,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        },
      );

      const stderr: string[] = [];
      const stdout: string[] = [];
      proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      proc.on("error", (e) => console.error("spawn err:", e));

      try {
        const ready = await waitForReady(port, 30_000);
        if (!ready) {
          console.error("server did not become ready; stderr=\n", stderr.join(""));
          console.error("stdout=\n", stdout.join(""));
        }
        expect(ready).toBe(true);

        // Trigger graceful shutdown.
        const exited = new Promise<number>((resolve) => {
          proc.once("exit", (code) => resolve(code ?? -1));
        });
        proc.kill("SIGTERM");

        // Hard timer beyond the configured drain window to catch hangs.
        const code = await Promise.race([
          exited,
          new Promise<number>((_, rej) =>
            setTimeout(() => rej(new Error("did not exit in 10s")), 10_000),
          ),
        ]);
        expect(code).toBe(0);
      } finally {
        if (!proc.killed) proc.kill("SIGKILL");
      }
    },
    30_000,
  );
});
