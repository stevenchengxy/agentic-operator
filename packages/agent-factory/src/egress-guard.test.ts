import { describe, it, expect, vi } from "vitest";
import { isPrivateHost, assertPublicUrl, safeFetch } from "./egress-guard";

describe("isPrivateHost", () => {
  it("blocks loopback / private / link-local / metadata hosts", () => {
    for (const h of [
      "localhost", "foo.local", "svc.internal",
      "127.0.0.1", "127.1.2.3", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0", "::1", "::", "fe80::1", "fc00::1", "fd12::3",
      "2130706433", "0x7f000001", // decimal / hex encodings of 127.0.0.1
    ]) {
      expect(isPrivateHost(h), `${h} should be private`).toBe(true);
    }
  });

  it("allows routable public hosts", () => {
    for (const h of ["api.gohire.top", "example.com", "8.8.8.8", "93.184.216.34", "172.15.0.1", "172.32.0.1"]) {
      expect(isPrivateHost(h), `${h} should be public`).toBe(false);
    }
  });
});

describe("assertPublicUrl", () => {
  it("rejects non-http(s) schemes", () => {
    expect(() => assertPublicUrl("file:///etc/passwd")).toThrow(/http/);
    expect(() => assertPublicUrl("gopher://x")).toThrow();
  });
  it("rejects internal hosts (the SSRF hole)", () => {
    expect(() => assertPublicUrl("http://localhost:5433/")).toThrow(/SSRF/);
    expect(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/")).toThrow(/SSRF/);
  });
  it("passes a normal external API URL", () => {
    expect(assertPublicUrl("https://api.gohire.top/v1/x").hostname).toBe("api.gohire.top");
  });
  it("honors EGRESS_ALLOW_HOSTS override", () => {
    const prev = process.env.EGRESS_ALLOW_HOSTS;
    process.env.EGRESS_ALLOW_HOSTS = "localhost";
    try {
      expect(assertPublicUrl("http://localhost:3000/").hostname).toBe("localhost");
    } finally {
      process.env.EGRESS_ALLOW_HOSTS = prev;
    }
  });
});

describe("safeFetch", () => {
  const resp = (status: number, headers: Record<string, string> = {}) =>
    ({ status, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null } }) as unknown as Response;

  it("refuses an internal URL before any fetch happens", async () => {
    const fetchFn = vi.fn();
    await expect(safeFetch("http://localhost:5433/", {}, fetchFn as unknown as typeof fetch)).rejects.toThrow(/SSRF/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("blocks a public→internal redirect (re-checks each hop)", async () => {
    const fetchFn = vi.fn().mockResolvedValueOnce(resp(302, { location: "http://169.254.169.254/" }));
    await expect(safeFetch("https://api.example.com/", {}, fetchFn as unknown as typeof fetch)).rejects.toThrow(/SSRF/);
    expect(fetchFn).toHaveBeenCalledTimes(1); // followed manually, blocked on the redirect target
  });

  it("passes a normal public request through", async () => {
    const fetchFn = vi.fn().mockResolvedValue(resp(200));
    const r = await safeFetch("https://api.gohire.top/x", {}, fetchFn as unknown as typeof fetch);
    expect(r.status).toBe(200);
  });
});
