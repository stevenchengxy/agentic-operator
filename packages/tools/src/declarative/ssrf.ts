// SSRF / egress guard for AI-authored declarative HTTP tools (Phase 2 Tier A). Self-contained
// (no cross-package import) so packages/tools stays low-level. Mirrors the conservative,
// fail-closed rules of agent-factory/egress-guard: private/loopback/metadata/link-local hosts and
// non-http(s) schemes are refused unless explicitly allowlisted via EGRESS_ALLOW_HOSTS.

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.EGRESS_ALLOW_HOSTS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True for loopback / private / link-local / metadata / numeric-encoded addresses. */
export function isPrivateHost(host: string): boolean {
  let h = host.toLowerCase().trim();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (h === "::1" || h === "::" || h.startsWith("fe80:") || h.startsWith("fc") || h.startsWith("fd")) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return true;
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/.test(h)) return true; // decimal/hex IP encodings
  return false;
}

/** Validate a URL for AI-reachable egress. Throws (fail-closed) on a non-http(s) scheme or an
 *  internal host not explicitly allowlisted. */
export function assertPublicUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`非法 URL：${raw}（SSRF 防护拒绝）`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`只允许 http/https，拒绝 ${u.protocol}//（SSRF 防护）`);
  }
  const host = u.hostname.toLowerCase();
  if (allowedHosts().has(host)) return u;
  if (isPrivateHost(host)) {
    throw new Error(`拒绝访问内网/本机/元数据地址 ${u.hostname}（SSRF 防护）。如确需,加入 EGRESS_ALLOW_HOSTS。`);
  }
  return u;
}

/** SSRF-safe fetch: validates the URL, then follows redirects MANUALLY, re-checking every hop. */
export async function safeFetch(
  raw: string,
  init: RequestInit = {},
  fetchFn: typeof fetch = fetch,
  maxHops = 3,
): Promise<Response> {
  let url = assertPublicUrl(raw).toString();
  for (let hop = 0; hop <= maxHops; hop++) {
    const res = await fetchFn(url, { ...init, redirect: "manual" });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      url = assertPublicUrl(new URL(loc, url).toString()).toString();
      continue;
    }
    return res;
  }
  throw new Error(`重定向次数过多（>${maxHops}）（SSRF 防护）`);
}
