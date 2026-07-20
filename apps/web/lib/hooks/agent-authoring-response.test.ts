import { describe, expect, it } from "vitest";
import { readAgentAuthoringResponse } from "./agent-authoring-response";

describe("agent authoring API response decoding", () => {
  it("returns data from a valid success envelope", async () => {
    const response = new Response(
      JSON.stringify({ ok: true, data: { systemPrompt: "ready" } }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );

    await expect(
      readAgentAuthoringResponse<{ systemPrompt: string }>(
        response,
        "/v1/agents/system-prompt",
      ),
    ).resolves.toEqual({ systemPrompt: "ready" });
  });

  it("preserves a structured API error message", async () => {
    const response = new Response(
      JSON.stringify({
        ok: false,
        error: {
          code: "rate_limit",
          message: "The selected model is temporarily rate limited.",
        },
      }),
      {
        status: 429,
        headers: { "content-type": "application/json" },
      },
    );

    await expect(
      readAgentAuthoringResponse(response, "/v1/agents/system-prompt"),
    ).rejects.toThrow("The selected model is temporarily rate limited.");
  });

  it("turns a plain-text proxy 500 into a friendly retry message", async () => {
    const response = new Response("Internal Server Error", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });

    const promise = readAgentAuthoringResponse(
      response,
      "/v1/agents/system-prompt",
    );
    await expect(promise).rejects.toThrow(
      "Prompt generation is temporarily unavailable (HTTP 500). Please retry.",
    );
    await expect(promise).rejects.not.toThrow("Unexpected token");
  });

  it("reports an invalid successful response without exposing a JSON parser error", async () => {
    const response = new Response("<html>unexpected</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    });

    await expect(
      readAgentAuthoringResponse(response, "/v1/agents/system-prompt"),
    ).rejects.toThrow(
      "Prompt generation returned an invalid response (HTTP 200). Please retry.",
    );
  });

  it("rejects a malformed JSON success envelope at runtime", async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

    await expect(
      readAgentAuthoringResponse(response, "/v1/agents/system-prompt"),
    ).rejects.toThrow(
      "Prompt generation returned an invalid response (HTTP 200). Please retry.",
    );
  });
});
