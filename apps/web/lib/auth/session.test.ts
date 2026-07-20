import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cookieGet: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: mocks.cookieGet }),
}));

import { COOKIE_NAME, readSession } from "./session";

const ORIGINAL_ENV = { ...process.env };

function meResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: {
        user: { id: "usr-alice", name: "Alice Operator" },
        activeTenant: { slug: "zhaopin" },
        memberships: [{ tenantSlug: "zhaopin" }],
        ...overrides,
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  process.env.AGENTIC_API_URL = "http://api.internal:3540";
  mocks.cookieGet.mockReset();
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIGINAL_ENV };
});

describe("readSession", () => {
  it("returns null without a session cookie and does not call the API", async () => {
    mocks.cookieGet.mockReturnValue(undefined);

    await expect(readSession()).resolves.toBeNull();
    expect(mocks.cookieGet).toHaveBeenCalledWith(COOKIE_NAME);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("forwards the opaque cookie to the API and maps /v1/me", async () => {
    mocks.cookieGet.mockReturnValue({ value: "signed.jwt.value" });
    mocks.fetch.mockResolvedValue(meResponse());

    await expect(readSession()).resolves.toEqual({
      sub: "usr-alice",
      name: "Alice Operator",
      initials: "AO",
      tenant: "zhaopin",
    });
    expect(mocks.fetch).toHaveBeenCalledWith(
      "http://api.internal:3540/v1/me",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        headers: {
          accept: "application/json",
          cookie: `${COOKIE_NAME}=signed.jwt.value`,
        },
      }),
    );
  });

  it("returns null when the API rejects an expired or invalid cookie", async () => {
    mocks.cookieGet.mockReturnValue({ value: "expired.jwt" });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 401 }));

    await expect(readSession()).resolves.toBeNull();
  });

  it("uses the first membership when the API has no active tenant", async () => {
    mocks.cookieGet.mockReturnValue({ value: "signed.jwt" });
    mocks.fetch.mockResolvedValue(
      meResponse({
        activeTenant: null,
        memberships: [{ tenantSlug: "raas" }],
      }),
    );

    await expect(readSession()).resolves.toMatchObject({ tenant: "raas" });
  });

  it("surfaces API failures instead of redirecting back to sign-in", async () => {
    mocks.cookieGet.mockReturnValue({ value: "signed.jwt" });
    mocks.fetch.mockResolvedValue(new Response(null, { status: 503 }));

    await expect(readSession()).rejects.toThrow("HTTP 503");
  });

  it("rejects a malformed successful response", async () => {
    mocks.cookieGet.mockReturnValue({ value: "signed.jwt" });
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true, data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(readSession()).rejects.toThrow("invalid session payload");
  });
});
