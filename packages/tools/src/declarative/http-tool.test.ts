import { describe, it, expect } from "vitest";
import { makeDeclarativeTool, buildDeclarativeOverlay } from "./http-tool";
import { isPrivateHost, assertPublicUrl } from "./ssrf";
import type { ToolContext } from "@agentic/agent-kit";

// Phase 2 Tier A — the MISSING executor: turn a brain-authored declarative HTTP tool
// (factory_tools row) into a runtime-invocable, SSRF-guarded ToolDescriptor. This is what makes
// "the brain declared a tool" actually callable by a deployed agent.

function ctx(data: Record<string, unknown>, config?: Record<string, unknown>): ToolContext {
  return { agentName: "a", actionName: "t", correlationId: "c", tenantSlug: "sb", event: { name: "E", data }, config } as ToolContext;
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
      { name: "acme.getJob", method: "GET", urlTemplate: "https://api.example.com/jobs/{job_id}?q={q}" },
      { fetchFn: fakeFetch(cap, { title: "Engineer" }) },
    );
    const r = await tool.handler(ctx({ job_id: "J/1", q: "a b" }));
    expect(cap.url).toBe("https://api.example.com/jobs/J%2F1?q=a%20b");
    expect(r.data).toEqual({ title: "Engineer" });
  });

  it("fills headers + body templates from data and config (POST)", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const tool = makeDeclarativeTool(
      { name: "acme.create", method: "POST", urlTemplate: "https://api.example.com/x", headers: { Authorization: "Bearer {token}" }, bodyTemplate: '{"name":"{name}"}' },
      { fetchFn: fakeFetch(cap, { ok: true }) },
    );
    await tool.handler(ctx({ name: "Bob" }, { token: "SECRET" }));
    expect((cap.init!.headers as Record<string, string>).Authorization).toBe("Bearer SECRET");
    expect(cap.init!.body).toBe('{"name":"Bob"}');
    expect(cap.init!.method).toBe("POST");
  });

  it("throws (→ is_error) on a non-2xx response", async () => {
    const tool = makeDeclarativeTool(
      { name: "acme.fail", method: "GET", urlTemplate: "https://api.example.com/x" },
      { fetchFn: fakeFetch({}, "nope", 500) },
    );
    await expect(tool.handler(ctx({}))).rejects.toThrow(/500/);
  });

  it("refuses to call an internal host (SSRF), even if the brain authored it", async () => {
    const tool = makeDeclarativeTool({ name: "evil", method: "GET", urlTemplate: "http://169.254.169.254/latest/meta-data/" });
    await expect(tool.handler(ctx({}))).rejects.toThrow(/SSRF|内网|metadata|拒绝/i);
  });

  it("validates required return fields when returnsSchema declares them", async () => {
    const tool = makeDeclarativeTool(
      { name: "acme.match", method: "GET", urlTemplate: "https://api.example.com/m", returnsSchema: { required: ["score"] } },
      { fetchFn: fakeFetch({}, { somethingElse: 1 }) },
    );
    await expect(tool.handler(ctx({}))).rejects.toThrow(/score/);
  });
});

describe("buildDeclarativeOverlay", () => {
  it("indexes tools by name for the runtime resolution chain", () => {
    const overlay = buildDeclarativeOverlay([
      { name: "acme.a", method: "GET", urlTemplate: "https://api.example.com/a" },
      { name: "acme.b", method: "GET", urlTemplate: "https://api.example.com/b" },
    ]);
    expect(Object.keys(overlay).sort()).toEqual(["acme.a", "acme.b"]);
    expect(overlay["acme.a"]!.kind).toBe("tool");
  });
});
