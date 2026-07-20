import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __resetRateLimitForTest,
  registerSecurity,
} from "../src/plugins/security";

describe("portal-safe rate limiting", () => {
  afterEach(() => {
    __resetRateLimitForTest();
    vi.unstubAllEnvs();
  });

  it("keeps read fan-out separate from the stricter mutation budget", async () => {
    vi.stubEnv("AGENTIC_RATE_LIMIT_DISABLED", "0");
    vi.stubEnv("AGENTIC_RATE_LIMIT_PER_MIN", "2");
    vi.stubEnv("AGENTIC_RATE_LIMIT_READS_PER_MIN", "3");

    const app = Fastify({ logger: false });
    await registerSecurity(app);
    app.get("/resource", async () => ({ ok: true }));
    app.post("/resource", async () => ({ ok: true }));

    for (let index = 0; index < 3; index += 1) {
      const response = await app.inject({ method: "GET", url: "/resource" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-limit"]).toBe("3");
    }
    expect(
      (await app.inject({ method: "GET", url: "/resource" })).statusCode,
    ).toBe(429);

    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({ method: "POST", url: "/resource" });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-ratelimit-limit"]).toBe("2");
    }
    const blocked = await app.inject({ method: "POST", url: "/resource" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });

    await app.close();
  });

  it("does not let an untrusted X-Forwarded-For header mint new buckets", async () => {
    vi.stubEnv("AGENTIC_RATE_LIMIT_DISABLED", "0");
    vi.stubEnv("AGENTIC_RATE_LIMIT_PER_MIN", "1");

    const app = Fastify({ logger: false });
    await registerSecurity(app);
    app.post("/resource", async () => ({ ok: true }));

    const first = await app.inject({
      method: "POST",
      url: "/resource",
      headers: { "x-forwarded-for": "198.51.100.10" },
    });
    expect(first.statusCode).toBe(200);

    const spoofed = await app.inject({
      method: "POST",
      url: "/resource",
      headers: { "x-forwarded-for": "203.0.113.99" },
    });
    expect(spoofed.statusCode).toBe(429);

    await app.close();
  });

  it("exempts only exact ledger-bound internal routes", async () => {
    vi.stubEnv("AGENTIC_RATE_LIMIT_DISABLED", "0");
    vi.stubEnv("AGENTIC_RATE_LIMIT_PER_MIN", "1");
    const app = Fastify({ logger: false });
    await registerSecurity(app);
    app.post("/internal/factory-sandbox/model/chat", async () => ({ ok: true }));
    app.post("/internal/production-codeact/rpc", async () => ({ ok: true }));
    app.post("/internal/factory-sandbox/model/admin", async () => ({ ok: true }));

    for (let index = 0; index < 3; index += 1) {
      expect((await app.inject({ method: "POST", url: "/internal/factory-sandbox/model/chat" })).statusCode).toBe(200);
    }
    for (let index = 0; index < 3; index += 1) {
      expect((await app.inject({ method: "POST", url: "/internal/production-codeact/rpc" })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: "POST", url: "/internal/factory-sandbox/model/admin" })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: "/internal/factory-sandbox/model/admin" })).statusCode).toBe(429);
    await app.close();
  });
});
