/** SSRF guard for operator-configured OpenAI-compatible/NewAPI endpoints. */
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

const NON_PUBLIC_IPS = new BlockList();

for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
] as const) {
  NON_PUBLIC_IPS.addSubnet(network, prefix, "ipv4");
}

for (const [network, prefix] of [
  ["::", 96],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  NON_PUBLIC_IPS.addSubnet(network, prefix, "ipv6");
}

function withoutIpv6Brackets(address: string): string {
  return address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;
}

function isNonPublicIp(address: string): boolean {
  const normalized = withoutIpv6Brackets(address).toLowerCase();
  const family = isIP(normalized);
  if (family === 4) return NON_PUBLIC_IPS.check(normalized, "ipv4");
  if (family === 6) return NON_PUBLIC_IPS.check(normalized, "ipv6");
  return true;
}

function allowedPrivateHost(hostname: string, host: string): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  const allow = new Set(
    (process.env.LLM_GATEWAY_ALLOWED_HOSTS ?? "")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  return allow.has(hostname.toLowerCase()) || allow.has(host.toLowerCase());
}

export async function assertSafeGatewayBaseUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("gateway base URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("gateway base URL must use http or https");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error(
      "gateway base URL must not contain credentials, fragments, or query parameters",
    );
  }
  if (
    url.protocol === "http:" &&
    process.env.NODE_ENV === "production" &&
    process.env.LLM_ALLOW_INSECURE_GATEWAYS !== "true"
  ) {
    throw new Error("production gateway endpoints must use https");
  }

  const hostname = withoutIpv6Brackets(url.hostname).toLowerCase();
  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error("gateway host did not resolve");
  if (
    addresses.some((entry) => isNonPublicIp(entry.address)) &&
    !allowedPrivateHost(hostname, url.host)
  ) {
    throw new Error(
      "private gateway hosts require an explicit LLM_GATEWAY_ALLOWED_HOSTS entry",
    );
  }
  return url;
}

export function gatewayApiUrl(
  baseUrl: string,
  path: "/models" | "/chat/completions" | "/responses",
  ensureV1 = false,
): string {
  const url = new URL(baseUrl);
  let basePath = url.pathname.replace(/\/+$/, "");
  if (ensureV1 && !basePath.endsWith("/v1")) basePath = `${basePath}/v1`;
  url.pathname = `${basePath}${path}`.replace(/\/{2,}/g, "/");
  return url.toString();
}
