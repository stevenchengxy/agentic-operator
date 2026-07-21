import { describe, expect, it, vi } from "vitest";
import {
  ApiResponseError,
  fetchApiResponse,
  formatApiError,
  readApiData,
} from "./api-response";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("readApiData", () => {
  it("returns data only for a 2xx success envelope", async () => {
    await expect(
      readApiData<{ id: string }>(
        json({ ok: true, data: { id: "real" } }),
        "/v1/x",
      ),
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
        {
          ok: false,
          error: { code: "tenant_conflict", message: "already exists" },
        },
        409,
      ),
      "/v1/tenants",
    );
    await expect(promise).rejects.toBeInstanceOf(ApiResponseError);
    await expect(promise).rejects.toMatchObject({
      code: "tenant_conflict",
      status: 409,
    });
  });

  it("preserves API-authored messages and hints verbatim", async () => {
    const promise = readApiData(
      json(
        {
          ok: false,
          error: {
            code: "tenant_conflict",
            message: "already exists",
            hint: "choose another slug",
          },
        },
        409,
      ),
      "/v1/tenants",
    );
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiResponseError);
    expect(error).toMatchObject({
      serverMessage: true,
      hint: "choose another slug",
    });
    expect(
      formatApiError(error, (key, vars) =>
        key === "apiError.withContext"
          ? `${vars?.message} [${vars?.path} · ${vars?.code} · HTTP ${vars?.status}]`
          : key,
      ),
    ).toBe(
      "already exists choose another slug [/v1/tenants · tenant_conflict · HTTP 409]",
    );
  });

  it("rejects malformed and incomplete success payloads", async () => {
    await expect(
      readApiData(
        new Response("<html>bad gateway</html>", { status: 200 }),
        "/v1/x",
      ),
    ).rejects.toMatchObject({ code: "http_200" });
    await expect(
      readApiData(json({ ok: true }), "/v1/x"),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("translates client-owned fallback copy while retaining diagnostics", async () => {
    const error = await readApiData(json({ ok: true }), "/v1/x").catch(
      (caught: unknown) => caught,
    );
    const translated = formatApiError(error, (key, vars) => {
      if (key === "apiError.invalidEnvelope") return "缺少成功数据。";
      if (key === "apiError.withContext") {
        return `${vars?.message} [${vars?.path} · ${vars?.code} · HTTP ${vars?.status}]`;
      }
      return key;
    });
    expect(translated).toBe(
      "缺少成功数据。 [/v1/x · invalid_response · HTTP 200]",
    );
  });

  it("replaces browser-authored network prose with a translatable code", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const error = await fetchApiResponse("/health").catch(
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({
      name: "ApiResponseError",
      code: "network_error",
      clientKind: "networkFailure",
      status: 0,
    });
    if (!(error instanceof ApiResponseError)) {
      throw new TypeError("expected ApiResponseError");
    }
    expect(error.message).not.toContain("Failed to fetch");
    fetchSpy.mockRestore();
  });
});
