import { describe, it, expect } from "vitest";
import { makeDeclarativeTool, buildDeclarativeOverlay, DeclarativeToolExecutionError, type DeclarativeObservedExchange } from "./http-tool";
import { isPrivateHost, assertPublicUrl } from "./ssrf";
import type { ToolContext } from "@agentic/agent-kit";

// Phase 2 Tier A — the MISSING executor: turn a brain-authored declarative HTTP tool
// (factory_tools row) into a runtime-invocable, SSRF-guarded ToolDescriptor. This is what makes
// "the brain declared a tool" actually callable by a deployed agent.

function ctx(data: Record<string, unknown>, config?: Record<string, unknown>): ToolContext {
  return { agentName: "a", actionName: "t", correlationId: "c", tenantSlug: "sb", event: { name: "E", data }, config } as ToolContext;
}

const EXTERNAL_READ_POLICY = {
  sideEffect: "read",
  operation: "read",
  effectScope: "external",
  sandboxPolicy: "live_external",
} as const;

function externalReadDef<T extends { name: string; method: string; urlTemplate: string }>(def: T): T & typeof EXTERNAL_READ_POLICY {
  return { ...def, ...EXTERNAL_READ_POLICY };
}

// A fake fetch that records the request and returns a canned JSON response.
function fakeFetch(captured: { url?: string; init?: RequestInit }, body: unknown, status = 200) {
  return (async (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("ssrf guard", () => {
  it("blocks loopback / private / metadata hosts", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("169.254.169.254")).toBe(true);
    expect(isPrivateHost("10.0.0.5")).toBe(true);
    expect(isPrivateHost("api.example.com")).toBe(false);
  });
  it("assertPublicUrl throws on internal + non-http", () => {
    expect(() => assertPublicUrl("http://localhost/x")).toThrow();
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow();
    expect(assertPublicUrl("https://api.example.com/v1").hostname).toBe("api.example.com");
  });
});

describe("makeDeclarativeTool", () => {
  it("fills the URL template from event.data (url-encoded) and returns parsed JSON", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const tool = makeDeclarativeTool(
      externalReadDef({ name: "acme.getJob", method: "GET", urlTemplate: "https://api.example.com/jobs/{job_id}?q={q}" }),
      { fetchFn: fakeFetch(cap, { title: "Engineer" }) },
    );
    const r = await tool.handler(ctx({ job_id: "J/1", q: "a b" }));
    expect(cap.url).toBe("https://api.example.com/jobs/J%2F1?q=a%20b");
    expect(r.data).toEqual({ title: "Engineer" });
  });

  it("fills headers + body templates from data and config (POST)", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const tool = makeDeclarativeTool(
      externalReadDef({ name: "acme.create", method: "POST", urlTemplate: "https://api.example.com/x", headers: { Authorization: "Bearer {token}" }, bodyTemplate: '{"name":"{name}"}' }),
      { fetchFn: fakeFetch(cap, { ok: true }) },
    );
    await tool.handler(ctx({ name: "Bob" }, { token: "SECRET" }));
    expect((cap.init!.headers as Record<string, string>).Authorization).toBe("Bearer SECRET");
    expect(cap.init!.body).toBe('{"name":"Bob"}');
    expect(cap.init!.method).toBe("POST");
  });

  it("builds multipart requests from canonical base64 without exposing file bytes to observations", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    let observed: DeclarativeObservedExchange | undefined;
    const encoded = Buffer.from("resume contents", "utf8").toString("base64");
    const tool = makeDeclarativeTool(
      externalReadDef({
        name: "acme.parseResume",
        method: "POST",
        urlTemplate: "https://api.example.com/resumes",
        requestSpec: {
          encoding: "multipart",
          fields: { candidate_id: "{candidateId}" },
          files: [{ field: "file", base64Path: "resume.base64", filenamePath: "resume.name", mime: "text/plain", required: true }],
          maxBytes: 1_024,
        },
      }),
      { fetchFn: fakeFetch(cap, { ok: true }), onExchange: (exchange) => { observed = exchange; } },
    );
    await tool.handler(ctx({ candidateId: "cand-1", resume: { base64: encoded, name: "resume.txt" } }));
    const form = cap.init!.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get("candidate_id")).toBe("cand-1");
    const file = form.get("file") as File;
    expect(file.name).toBe("resume.txt");
    expect(file.type).toBe("text/plain");
    expect(await file.text()).toBe("resume contents");
    expect(cap.init!.headers).not.toHaveProperty("content-type");
    expect(JSON.stringify(observed)).not.toContain(encoded);
    expect(observed?.request.body).toEqual({
      fields: { candidate_id: "cand-1" },
      files: [{ field: "file", filename: "resume.txt", mime: "text/plain", bytes: 15 }],
    });
  });

  it("asserts the raw envelope and maps vendor paths into the declared return shape", async () => {
    const tool = makeDeclarativeTool(
      externalReadDef({
        name: "acme.match",
        method: "POST",
        urlTemplate: "https://api.example.com/match",
        requestSpec: { encoding: "json" },
        responseSpec: {
          assertions: [{ path: "success", op: "eq", value: true, failure: "terminal", code: "VENDOR_REJECTED" }],
          mappings: { candidateId: "data.candidate.id", score: "data.score" },
        },
        returnsSchema: { candidateId: { type: "string", required: true }, score: { type: "number", required: true } },
      }),
      { fetchFn: fakeFetch({}, { success: true, data: { candidate: { id: "cand-1" }, score: 0.93 } }) },
    );
    const result = await tool.handler(ctx({ jobId: "job-1" }));
    expect(result.data).toEqual({ candidateId: "cand-1", score: 0.93 });
  });

  it("surfaces response assertion code and retry semantics before normalization", async () => {
    const tool = makeDeclarativeTool(
      externalReadDef({
        name: "acme.pending",
        method: "GET",
        urlTemplate: "https://api.example.com/result",
        responseSpec: {
          unwrapPath: "data",
          assertions: [{ path: "status", op: "eq", value: "ready", failure: "retryable", code: "RESULT_PENDING", message: "result is not ready" }],
        },
      }),
      { fetchFn: fakeFetch({}, { status: "pending", data: { id: "r1" } }) },
    );
    const error = await tool.handler(ctx({})).then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(DeclarativeToolExecutionError);
    expect(error).toMatchObject({ kind: "response_assertion", code: "RESULT_PENDING", retryable: true, terminal: false, status: 502 });
  });

  it("resolves *_env credential references without persisting the secret in config", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    process.env.TEST_DECLARATIVE_TOKEN = "ENV_SECRET";
    try {
      const tool = makeDeclarativeTool(
        externalReadDef({ name: "acme.secure", method: "GET", urlTemplate: "https://api.example.com/x", headers: { Authorization: "Bearer {api_key}" } }),
        { fetchFn: fakeFetch(cap, { ok: true }) },
      );
      await tool.handler(ctx({}, { api_key_env: "TEST_DECLARATIVE_TOKEN" }));
      expect((cap.init!.headers as Record<string, string>).Authorization).toBe("Bearer ENV_SECRET");
    } finally {
      delete process.env.TEST_DECLARATIVE_TOKEN;
    }
  });

  it("fails before network when a referenced credential env is absent", async () => {
    let called = false;
    const tool = makeDeclarativeTool(
      externalReadDef({ name: "acme.secure", method: "GET", urlTemplate: "https://api.example.com/x", headers: { Authorization: "Bearer {api_key}" } }),
      { fetchFn: (async () => { called = true; return new Response("{}"); }) as typeof fetch },
    );
    await expect(tool.handler(ctx({}, { api_key_env: "MISSING_DECLARATIVE_TOKEN" }))).rejects.toThrow(/schema_mismatch.*MISSING_DECLARATIVE_TOKEN/);
    expect(called).toBe(false);
  });

  it("throws (→ is_error) on a non-2xx response", async () => {
    const tool = makeDeclarativeTool(
      externalReadDef({ name: "acme.fail", method: "GET", urlTemplate: "https://api.example.com/x" }),
      { fetchFn: fakeFetch({}, "nope", 500) },
    );
    await expect(tool.handler(ctx({}))).rejects.toThrow(/500/);
  });

  it("refuses to call an internal host (SSRF), even if the brain authored it", async () => {
    const tool = makeDeclarativeTool(externalReadDef({ name: "evil", method: "GET", urlTemplate: "http://169.254.169.254/latest/meta-data/" }));
    await expect(tool.handler(ctx({}))).rejects.toThrow(/SSRF|内网|metadata|拒绝/i);
  });

  it("validates required return fields when returnsSchema declares them", async () => {
    const tool = makeDeclarativeTool(
      externalReadDef({ name: "acme.match", method: "GET", urlTemplate: "https://api.example.com/m", returnsSchema: { required: ["score"] } }),
      { fetchFn: fakeFetch({}, { somethingElse: 1 }) },
    );
    await expect(tool.handler(ctx({}))).rejects.toThrow(/score/);
  });

  it("validates field-map request schemas before making a network call", async () => {
    let called = false;
    const tool = makeDeclarativeTool(
      externalReadDef({ name: "acme.create", method: "POST", urlTemplate: "https://api.example.com/x", paramsSchema: { candidate_id: { type: "string", required: true }, score: { type: "number", required: true } } }),
      { fetchFn: (async () => { called = true; return new Response("{}"); }) as typeof fetch },
    );
    await expect(tool.handler(ctx({ candidate_id: "c1", score: "high" }))).rejects.toThrow(/schema_mismatch.*score/i);
    expect(called).toBe(false);
  });

  it("validates nested response types and arrays", async () => {
    const tool = makeDeclarativeTool(
      externalReadDef({ name: "acme.nested", method: "GET", urlTemplate: "https://api.example.com/x", returnsSchema: { type: "object", required: ["data"], properties: { data: { type: "object", required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["score"], properties: { score: { type: "number" } } } } } } } } }),
      { fetchFn: fakeFetch({}, { data: { items: [{ score: "bad" }] } }) },
    );
    await expect(tool.handler(ctx({}))).rejects.toThrow(/schema_mismatch.*items\[0\]\.score/i);
  });

  it("classifies rate limits and empty successful responses", async () => {
    const limited = makeDeclarativeTool(
      externalReadDef({ name: "acme.limited", method: "GET", urlTemplate: "https://api.example.com/x" }),
      { fetchFn: fakeFetch({}, { error: "slow down", token: "should-not-leak" }, 429) },
    );
    await expect(limited.handler(ctx({}))).rejects.toThrow(/rate_limit/);
    const empty = makeDeclarativeTool(
      externalReadDef({ name: "acme.empty", method: "GET", urlTemplate: "https://api.example.com/x", returnsSchema: { ok: { type: "boolean", required: true } } }),
      { fetchFn: fakeFetch({}, "") },
    );
    await expect(empty.handler(ctx({}))).rejects.toThrow(/empty_200/);
  });
});

describe("buildDeclarativeOverlay", () => {
  it("rejects historical definitions that have no reviewed execution policy", () => {
    expect(() => makeDeclarativeTool({
      name: "legacy.missing-policy",
      method: "GET",
      urlTemplate: "https://api.example.com/legacy",
      sideEffect: "read",
    })).toThrow(/operation.*effectScope.*sandboxPolicy/i);
  });

  it("indexes tools by name for the runtime resolution chain", () => {
    const overlay = buildDeclarativeOverlay([
      externalReadDef({ name: "acme.a", method: "GET", urlTemplate: "https://api.example.com/a" }),
      externalReadDef({ name: "acme.b", method: "GET", urlTemplate: "https://api.example.com/b" }),
    ]);
    expect(Object.keys(overlay).sort()).toEqual(["acme.a", "acme.b"]);
    expect(overlay["acme.a"]!.kind).toBe("tool");
  });
});
