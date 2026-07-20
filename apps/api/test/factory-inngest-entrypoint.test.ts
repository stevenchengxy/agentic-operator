import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(process.cwd(), "../..");
const entrypoint = path.join(root, "apps/inngest-worker/docker-entrypoint.sh");
const roots: string[] = [];

afterEach(() => {
  for (const directory of roots.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function secretFile(name: string, value: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "inngest-entrypoint-"));
  roots.push(directory);
  const filename = path.join(directory, name);
  writeFileSync(filename, `${value}\n`, { mode: 0o600 });
  return filename;
}

function run(env: NodeJS.ProcessEnv, command: string[] = ["/usr/bin/true"]) {
  return spawnSync("/bin/sh", [entrypoint, ...command], {
    env: { PATH: process.env.PATH, ...env },
    encoding: "utf8",
  });
}

describe("Inngest broker entrypoint", () => {
  it("resolves every production credential from files without printing values", () => {
    const event = "e".repeat(40);
    const signing = "ab".repeat(32);
    const postgres = "postgres://inngest:private@postgres:5432/inngest";
    const redis = "redis://:private@redis:6379/0";
    const result = run({
      AGENTIC_INNGEST_REQUIRE_DURABLE: "1",
      INNGEST_EVENT_KEY_FILE: secretFile("event", event),
      INNGEST_SIGNING_KEY_FILE: secretFile("signing", signing),
      INNGEST_POSTGRES_URI_FILE: secretFile("postgres", postgres),
      INNGEST_REDIS_URI_FILE: secretFile("redis", redis),
    }, ["/usr/bin/env"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`INNGEST_EVENT_KEY=${event}`);
    expect(result.stdout).toContain(`INNGEST_SIGNING_KEY=${signing}`);
    expect(result.stderr).toBe("");
  });

  it("refuses ambiguous values and never echoes either credential", () => {
    const direct = "direct-value-that-must-not-be-logged";
    const fileValue = "file-value-that-must-not-be-logged";
    const result = run({
      INNGEST_EVENT_KEY: direct,
      INNGEST_EVENT_KEY_FILE: secretFile("event", fileValue),
    });
    expect(result.status).toBe(78);
    expect(result.stderr).toMatch(/cannot both be configured/);
    expect(`${result.stdout}${result.stderr}`).not.toContain(direct);
    expect(`${result.stdout}${result.stderr}`).not.toContain(fileValue);
  });

  it("refuses dev or incomplete persistence when durable mode is required", () => {
    const common = {
      AGENTIC_INNGEST_REQUIRE_DURABLE: "1",
      INNGEST_EVENT_KEY: "e".repeat(40),
      INNGEST_SIGNING_KEY: "ab".repeat(32),
      INNGEST_POSTGRES_URI: "postgres://db/inngest",
      INNGEST_REDIS_URI: "redis://redis/0",
    };
    expect(run(common, ["inngest", "dev"]).status).toBe(78);
    expect(run({ ...common, INNGEST_REDIS_URI: "" }, ["inngest", "start"]).status)
      .toBe(78);
    expect(run(common, ["/usr/bin/true"]).status).toBe(0);
  });
});
