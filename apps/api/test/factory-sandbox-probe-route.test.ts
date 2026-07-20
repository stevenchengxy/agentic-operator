import { readFileSync } from "node:fs";
import path from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { factorySandboxProbeRoutes } from "../src/services/agent-factory/factory-sandbox-probe-route";

const token = "p".repeat(64);
const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function fixture(runProbe: Parameters<typeof factorySandboxProbeRoutes>[1]["runProbe"]) {
  const app = Fastify();
  apps.push(app);
  await factorySandboxProbeRoutes(app, {
    env: { FACTORY_PRODUCTION_PROBE_TOKEN: token },
    runProbe,
  });
  return app;
}

describe("supervised Factory sandbox probe route", () => {
  it("rejects callers without the dedicated service credential", async () => {
    const app = await fixture(async () => {
      throw new Error("must not run");
    });
    expect((await app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/probe",
      payload: {},
    })).statusCode).toBe(401);
  });

  it("runs the probe in the API process and returns its truthful verdict", async () => {
    const app = await fixture(async ({ tenantSlug }) => ({
      schema: "agent-factory-external-sandbox-probe/v1",
      passed: true,
      probeId: `probe-${tenantSlug}`,
      cleanupVerified: true,
      appAbsent: true,
    }));
    const response = await app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/probe",
      headers: { authorization: `Bearer ${token}` },
      payload: { tenantSlug: "agents-generation" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      passed: true,
      probeId: "probe-agents-generation",
      cleanupVerified: true,
      appAbsent: true,
    });
  });

  it("allows only one external App probe at a time", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const app = await fixture(async () => {
      await blocked;
      return {
        schema: "agent-factory-external-sandbox-probe/v1",
        passed: true,
        probeId: "probe-single-flight",
      };
    });
    const first = app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/probe",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await app.inject({
      method: "POST",
      url: "/internal/factory-sandbox/probe",
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    release();
    expect((await first).statusCode).toBe(200);
  });

  it("keeps the host CLI HTTP-only so it cannot become a second SQLite writer", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../scripts/probe-factory-sandbox.ts"),
      "utf8",
    );
    expect(source).toContain("/internal/factory-sandbox/probe");
    expect(source).not.toMatch(/@agentic\/db|\bgetDb\s*\(|\bgetRawSqlite\s*\(/);
  });
});
