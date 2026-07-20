import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@agentic/agent-kit";
import raasRegistry from "@tenants/raas";

const publicationTool = raasRegistry.tools?.executeAutomatedPublication;
if (!publicationTool) {
  throw new Error("RAAS executeAutomatedPublication tool is not registered");
}

const context: ToolContext = {
  tenantSlug: "raas",
  agentName: "publishJob",
  actionName: "executeAutomatedPublication",
  correlationId: "cor-publication-truth",
  subject: "job-1",
  event: {
    name: "PUBLISH_JOB",
    data: { api_channels: ["partner-api"], title: "Backend Engineer" },
  },
  results: {},
};

describe("RAAS publication receipt truth", () => {
  beforeEach(() => {
    vi.stubEnv(
      "RAAS_PUBLICATION_API_URL",
      "https://publication.invalid/v1/jobs",
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects an empty 2xx object instead of reporting a fake success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(publicationTool.handler(context)).rejects.toThrow(
      /ambiguous 2xx receipt.*success:true or ok:true/i,
    );
  });

  it("returns success only when the real endpoint explicitly acknowledges it", async () => {
    const receipt = { success: true, publication_id: "pub-real-1" };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(receipt), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await publicationTool.handler(context);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result.data).toMatchObject({
      automated_attempted: true,
      success: true,
      api_publish_result: receipt,
    });
  });
});
