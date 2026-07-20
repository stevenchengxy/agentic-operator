import { describe, expect, it } from "vitest";
import { ApiResponseError, readApiData } from "./api-response";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readApiData", () => {
  it("returns data only for a 2xx success envelope", async () => {
    await expect(
      readApiData<{ id: string }>(json({ ok: true, data: { id: "real" } }), "/v1/x"),
    ).resolves.toEqual({ id: "real" });
  });

  it("rejects an ok-looking payload carried by a non-2xx response", async () => {
    await expect(
      readApiData(json({ ok: true, data: { id: "fake" } }, 502), "/v1/x"),
    ).rejects.toMatchObject({
      name: "ApiResponseError",
      code: "http_502",
      status: 502,
    });
  });

  it("preserves the server error code for callers that branch on it", async () => {
    const promise = readApiData(
      json(
        { ok: false, error: { code: "tenant_conflict", message: "already exists" } },
        409,
      ),
      "/v1/tenants",
    );
    await expect(promise).rejects.toBeInstanceOf(ApiResponseError);
    await expect(promise).rejects.toMatchObject({ code: "tenant_conflict", status: 409 });
  });

  it("rejects malformed and incomplete success payloads", async () => {
    await expect(
      readApiData(new Response("<html>bad gateway</html>", { status: 200 }), "/v1/x"),
    ).rejects.toMatchObject({ code: "http_200" });
    await expect(
      readApiData(json({ ok: true }), "/v1/x"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });
});
