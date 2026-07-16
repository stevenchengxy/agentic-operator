import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import {
  installSupervisorSignalHandlers,
  terminateProcessGroups,
} from "./dev-stack.mjs";

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && error.code === "ESRCH");
  }
}

test(
  "process-group cleanup force-kills a child that ignores SIGTERM",
  { skip: process.platform === "win32", timeout: 5_000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'process.on("SIGTERM", () => {});',
          'process.stdout.write("ready\\n");',
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      {
        detached: true,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const exit = once(child, "exit");
    t.after(() => {
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    });

    await once(child.stdout, "data");
    const startedAt = Date.now();
    const lingering = await terminateProcessGroups(
      [{ name: "fixture", child }],
      {
        graceMs: 100,
        forceWaitMs: 1_000,
        pollIntervalMs: 10,
      },
    );
    const [code, signal] = await exit;

    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
    assert.deepEqual(lingering, []);
    assert(Date.now() - startedAt >= 100);
  },
);

test("signal handling drains on first signal and force-kills on a repeat", () => {
  const source = new EventEmitter();
  let shuttingDown = false;
  let clock = 0;
  const shutdownSignals = [];
  const forcedSignals = [];
  const dispose = installSupervisorSignalHandlers({
    source,
    now: () => clock,
    isShuttingDown: () => shuttingDown,
    shutdown: (signal) => {
      shutdownSignals.push(signal);
      shuttingDown = true;
    },
    forceShutdown: (exitCode, signal) => {
      forcedSignals.push({ exitCode, signal });
    },
  });

  source.emit("SIGHUP");
  clock = 100;
  source.emit("SIGINT");
  clock = 600;
  source.emit("SIGTERM");
  dispose();
  source.emit("SIGINT");

  assert.deepEqual(shutdownSignals, ["SIGHUP"]);
  assert.deepEqual(forcedSignals, [{ exitCode: 143, signal: "SIGTERM" }]);
});

test(
  "cleanup kills descendants after their process-group leader exits",
  { skip: process.platform === "win32", timeout: 5_000 },
  async (t) => {
    const descendantScript =
      'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const leaderScript = [
      'const { spawn } = require("node:child_process");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore" });`,
      "child.unref();",
      "process.stdout.write(String(child.pid));",
    ].join("");
    const leader = spawn(process.execPath, ["-e", leaderScript], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    leader.stdout.setEncoding("utf8");
    leader.stdout.on("data", (chunk) => {
      output += chunk;
    });
    await once(leader, "exit");
    const descendantPid = Number(output);
    assert(Number.isInteger(descendantPid) && descendantPid > 0);

    t.after(() => {
      if (processExists(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {}
      }
    });

    const lingering = await terminateProcessGroups(
      [{ name: "leader", child: leader }],
      {
        graceMs: 100,
        forceWaitMs: 1_000,
        pollIntervalMs: 10,
      },
    );

    assert.deepEqual(lingering, []);
    assert.equal(processExists(descendantPid), false);
  },
);
