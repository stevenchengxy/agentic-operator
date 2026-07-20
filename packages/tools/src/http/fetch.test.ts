import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";
import { httpFetchTool } from "./fetch";

function ctx(url: string, config: Record<string, unknown>): ToolContext {
  return {
    agentName: "agent",
    actionName: "fetch",
    correlationId: "cor-1",
    tenantSlug: "tenant",
    event: { name: "HTTP", data: { method: "GET", path: url } },
    config,
  } as ToolContext;
}

afterEach(() => vi.unstubAllGlobals());

describe("http.fetch egress boundaries", () => {
  it("defaults to the configured base_url host", async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchFn);
    await httpFetchTool.handler(ctx("/v1/jobs", { base_url: "https://api.example.com" }));
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(String(fetchFn.mock.calls[0]![0])).toBe("https://api.example.com/v1/jobs");
  });

  it("rejects an LLM-supplied absolute host unless config explicitly allows it", async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal("fetch", fetchFn);
    await expect(
      httpFetchTool.handler(ctx("https://evil.example/steal", { base_url: "https://api.example.com", api_key: "secret" })),
    ).rejects.toThrow(/not allowed/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("still blocks private/metadata targets even when used as base_url", async () => {
    await expect(
      httpFetchTool.handler(ctx("/latest/meta-data", { base_url: "http://169.254.169.254" })),
    ).rejects.toThrow(/SSRF|内网|元数据|拒绝/i);
  });

  it("revalidates redirect hosts before forwarding configured credentials", async () => {
    const fetchFn = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } }));
    vi.stubGlobal("fetch", fetchFn);
    await expect(
      httpFetchTool.handler(ctx("/redirect", { base_url: "https://api.example.com", api_key: "secret" })),
    ).rejects.toThrow(/not allowed/);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("fails a direct workflow tool call on non-2xx instead of returning a false-success payload", async () => {
    const fetchFn = vi.fn(async () =>
      new Response('{"error":"vendor rejected request"}', {
        status: 422,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchFn);

    await expect(
      httpFetchTool.handler(ctx("/v1/jobs", { base_url: "https://api.example.com" })),
    ).rejects.toThrow(/HTTP 422.*vendor rejected request/);
  });
});
