import { beforeEach, describe, expect, it, vi } from "vitest";

const mcp = vi.hoisted(() => ({
  connectAll: vi.fn(),
  toolMap: vi.fn(),
  describe: vi.fn(),
}));

vi.mock("@agentic/mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agentic/mcp")>();
  return {
    ...actual,
    getMcpManager: () => mcp,
  };
});

import { buildSystemBaseFns, expandTenantRegistry } from "../src/bootstrap";

beforeEach(() => {
  mcp.connectAll.mockReset().mockResolvedValue(undefined);
  mcp.toolMap.mockReset().mockReturnValue({});
  mcp.describe.mockReset().mockReturnValue([]);
});

describe("bootstrap MCP and system schedule truth", () => {
  it("applies MCP schema defaults and requests only the current tenant scope", async () => {
    mcp.toolMap.mockReturnValue({
      "catalog.search": { name: "catalog.search" },
    });
    mcp.describe.mockReturnValue([
      {
        name: "catalog",
        scope: "acme",
        optional: false,
        connected: true,
        toolCount: 1,
      },
    ]);

    const expanded = await expandTenantRegistry("acme", {
      mcpServers: [
        {
          name: "catalog",
          transport: "http",
          url: "https://mcp.invalid/rpc",
        },
      ],
      tools: { native: { name: "native" } as never },
    });

    expect(mcp.connectAll).toHaveBeenCalledWith(
      [expect.objectContaining({ name: "catalog", optional: false })],
      "acme",
    );
    expect(mcp.toolMap).toHaveBeenCalledWith({ scope: "acme" });
    expect(expanded?.tools).toHaveProperty("catalog.search");
    expect(expanded?.tools).toHaveProperty("native");
  });

  it("fails boot for a required MCP without leaking the transport error", async () => {
    mcp.connectAll.mockRejectedValueOnce(
      new Error("Authorization secret-value rejected"),
    );
    const promise = expandTenantRegistry("acme", {
      mcpServers: [
        {
          name: "required-catalog",
          transport: "http",
          url: "https://mcp.invalid/rpc",
          optional: false,
        },
      ],
    });
    await expect(promise).rejects.toThrow(
      "required MCP bootstrap failed for tenant 'acme'",
    );
    await expect(promise).rejects.not.toThrow("secret-value");
  });

  it("fails closed on malformed MCP declarations without serializing headers", async () => {
    const promise = expandTenantRegistry("acme", {
      mcpServers: [
        {
          name: "broken",
          transport: "http",
          headers: { authorization: "private-header" },
        },
      ],
    });
    await expect(promise).rejects.toThrow(
      "invalid MCP declaration for tenant 'acme'",
    );
    await expect(promise).rejects.not.toThrow("private-header");
  });

  it("registers retention on __system with the configured cron and removes it only when disabled", () => {
    const enabled = buildSystemBaseFns({ AGENTIC_SYSTEM_CRON: "15 4 * * *" });
    expect(enabled).toHaveLength(2);
    expect(
      (
        enabled[1] as unknown as {
          opts: { id: string; triggers: Array<{ cron: string }> };
        }
      ).opts,
    ).toMatchObject({
      id: "agentic.retention.sweep",
      triggers: [{ cron: "15 4 * * *" }],
    });

    const disabled = buildSystemBaseFns({ AGENTIC_SYSTEM_CRON_DISABLED: "1" });
    expect(disabled).toHaveLength(1);
    expect(() =>
      buildSystemBaseFns({ AGENTIC_SYSTEM_CRON: "not a cron expression" }),
    ).toThrow(/AGENTIC_SYSTEM_CRON is invalid/);
    expect(() =>
      buildSystemBaseFns({ AGENTIC_SYSTEM_CRON_DISABLED: "yes" }),
    ).toThrow(/must be 0 or 1/);
  });
});
