/**
 * Session cookie utilities (P2-FE-19).
 *
 * We sign session payloads using `jose`'s HS256 — the API server reads the
 * same cookie via its own HMAC check, so the secret is shared via env.
 *
 * Token shape:
 *   { sub: <userId>, name, tenant, exp }
 *
 * In dev (`AUTH_MODE=dev` or `NODE_ENV !== "production"`) any visitor with
 * no cookie is auto-resolved to a synthetic "kenny.chien" session. Production
 * uses real magic-link sign-in (post-v1 — `/sign-in` is the stub today).
 */

import { cookies } from "next/headers";
import { jwtVerify, SignJWT } from "jose";

export const COOKIE_NAME = "agentic_session";
const ALGORITHM = "HS256";

export interface Session {
  sub: string;
  name: string;
  initials: string;
  tenant: string;
}

/**
 * Dev auto-login is gated on AUTH_MODE === "dev" ONLY (matching the api's
 * `authenticate()`), NOT on `NODE_ENV !== production`. Otherwise local dev
 * would always synthesize a session — the sign-in page, logout, and
 * change-password could never actually take effect (P6-AUTH fix).
 */
function isDev(): boolean {
  return process.env.AUTH_MODE === "dev";
}

/**
 * Must match the api's secret resolution (apps/api/src/plugins/auth.ts) so a
 * cookie the api signs on login verifies here. The api prefers
 * AUTH_SESSION_SECRET; accept SESSION_SECRET as a fallback.
 */
function getSecret(): Uint8Array {
  const raw =
    process.env.AUTH_SESSION_SECRET ??
    process.env.SESSION_SECRET ??
    "dev-only-do-not-use-in-prod";
  return new TextEncoder().encode(raw);
}

const DEV_SESSION: Session = {
  sub: "dev-user",
  name: "Liu Wei",
  initials: "LW",
  tenant: "raas",
};

/**
 * Read the current session (or null if none).
 *
 * In dev, falls back to a synthetic session so the portal works without a
 * sign-in dance.
 */
export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) {
    return isDev() ? DEV_SESSION : null;
  }
  try {
    const { payload } = await jwtVerify(raw, getSecret(), {
      algorithms: [ALGORITHM],
    });
    const claims = payload as unknown as Partial<Session> & { exp?: number };
    if (
      typeof claims.sub === "string" &&
      typeof claims.name === "string" &&
      typeof claims.initials === "string" &&
      typeof claims.tenant === "string"
    ) {
      return {
        sub: claims.sub,
        name: claims.name,
        initials: claims.initials,
        tenant: claims.tenant,
      };
    }
    return null;
  } catch {
    return isDev() ? DEV_SESSION : null;
  }
}

export async function signSession(session: Session): Promise<string> {
  const jwt = await new SignJWT({
    sub: session.sub,
    name: session.name,
    initials: session.initials,
    tenant: session.tenant,
  })
    .setProtectedHeader({ alg: ALGORITHM })
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(getSecret());
  return jwt;
}

export async function writeSession(session: Session): Promise<void> {
  const store = await cookies();
  const jwt = await signSession(session);
  store.set(COOKIE_NAME, jwt, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
