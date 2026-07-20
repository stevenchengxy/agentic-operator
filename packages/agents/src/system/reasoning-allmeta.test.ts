import { describe, expect, it, vi } from "vitest";
import {
  listReasoningActions,
  reasoningAllmetaConfigFromEnv,
} from "./reasoning-allmeta";

describe("standalone Reasoning Allmeta client", () => {
  it("normalizes, de-duplicates, and sorts real Action summaries", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          items: [
            {
              id: "2",
              name: "zAction",
              actor_json: '["Agent"]',
              description: "z",
            },
            {
              id: "1",
              name: "aAction",
              actor: ["Human"],
            },
            { id: "duplicate", name: "zAction" },
            { id: "invalid" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const actions = await listReasoningActions("rules-test", {
      fetchImpl,
      config: {
        baseUrl: "https://allmeta.invalid",
        apiKey: "secret",
        timeoutMs: 1_000,
      },
    });

    expect(actions).toEqual([
      {
        id: "1",
        name: "aAction",
        description: null,
        actor: ["Human"],
      },
      {
        id: "2",
        name: "zAction",
        description: "z",
        actor: ["Agent"],
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("fails closed when standalone Allmeta credentials are incomplete", () => {
    expect(() =>
      reasoningAllmetaConfigFromEnv({
        ALLMETA_BASE_URL: "https://allmeta.invalid",
      }),
    ).toThrow(/ALLMETA_API_KEY/);
  });
});
