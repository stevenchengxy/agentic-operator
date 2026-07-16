import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { waitForHttp } from "./wait-for-http.mjs";

test("returns as soon as the listener produces an HTTP response", async () => {
  const result = await waitForHttp("http://127.0.0.1:3501/health", {
    fetchImpl: async () => new Response("ok", { status: 200 }),
  });

  assert.equal(result.attempts, 1);
  assert.equal(result.status, 200);
});

test("treats a degraded HTTP response as listener readiness", async () => {
  const result = await waitForHttp("http://127.0.0.1:3501/health", {
    fetchImpl: async () => new Response("degraded", { status: 503 }),
  });

  assert.equal(result.status, 503);
});

test("releases the readiness response body after headers arrive", async () => {
  let cancelled = 0;
  await waitForHttp("http://127.0.0.1:3501/health", {
    fetchImpl: async () => ({
      status: 200,
      body: {
        cancel: async () => {
          cancelled += 1;
        },
      },
    }),
  });

  assert.equal(cancelled, 1);
});

test("retries transport failures until the listener accepts requests", async () => {
  let calls = 0;
  let clock = 0;
  const result = await waitForHttp("http://127.0.0.1:3501/health", {
    timeoutMs: 1_000,
    intervalMs: 100,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    fetchImpl: async () => {
      calls += 1;
      if (calls < 3) throw new Error("connect ECONNREFUSED 127.0.0.1:3501");
      return new Response("ok", { status: 200 });
    },
  });

  assert.equal(result.attempts, 3);
  assert.equal(result.elapsedMs, 200);
});

test("reports the last transport failure when readiness times out", async () => {
  let clock = 0;
  await assert.rejects(
    waitForHttp("http://127.0.0.1:3501/health", {
      timeoutMs: 250,
      intervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3501");
      },
    }),
    /timed out after 250 ms.*ECONNREFUSED/,
  );
});

test(
  "watch mode exits nonzero when a ready API listener dies",
  { timeout: 10_000 },
  async (t) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    assert(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}/health`;
    const script = fileURLToPath(
      new URL("./wait-for-http.mjs", import.meta.url),
    );
    const child = spawn(process.execPath, [script, "--watch", url, "API"], {
      env: {
        ...process.env,
        AGENTIC_DEV_READY_TIMEOUT_MS: "2000",
        AGENTIC_DEV_READY_INTERVAL_MS: "25",
        AGENTIC_DEV_OUTAGE_TIMEOUT_MS: "250",
        AGENTIC_DEV_WATCH_INTERVAL_MS: "50",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exitPromise = once(child, "exit");
    let stdout = "";
    let stderr = "";
    let resolveMonitoring;
    const monitoring = new Promise((resolve) => {
      resolveMonitoring = resolve;
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("[startup] monitoring API")) resolveMonitoring();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    t.after(() => {
      if (server.listening) server.close();
      if (child.exitCode === null) child.kill("SIGKILL");
    });

    await Promise.race([
      monitoring,
      new Promise((_, reject) => {
        setTimeout(
          () =>
            reject(new Error(`watchdog did not start:\n${stdout}${stderr}`)),
          5_000,
        ).unref();
      }),
    ]);
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });

    const [code, signal] = await exitPromise;
    assert.equal(signal, null);
    assert.equal(code, 1);
    assert.match(stderr, /remained unavailable for 250 ms/);
  },
);
