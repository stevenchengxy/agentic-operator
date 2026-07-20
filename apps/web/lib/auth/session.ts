/**
 * Server-side session lookup.
 *
 * The API is the only component that signs and verifies `agentic_session`.
 * Next forwards the opaque cookie to `/v1/me` and maps the authenticated
 * identity into the small shape needed by the portal shell. Keeping JWT
 * verification in one process prevents a stale Web secret from turning a
 * successful login into a silent redirect loop.
 */

import { cookies } from "next/headers";
import { serverApiUrl } from "@/lib/server-api-url";

export const COOKIE_NAME = "agentic_session";

export interface Session {
  sub: string;
  name: string;
  initials: string;
  tenant: string;
}

interface MeEnvelope {
  ok: true;
  data: {
    user: {
      id: string;
      name: string;
    };
    activeTenant: {
      slug: string;
    } | null;
    memberships: Array<{
      tenantSlug: string;
    }>;
  };
}

function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();
  const first = parts[0]?.[0] ?? "";
  const last = parts[parts.length - 1]?.[0] ?? "";
  return (first + last).toUpperCase();
}

function isMeEnvelope(value: unknown): value is MeEnvelope {
  if (!value || typeof value !== "object") return false;
  const envelope = value as Partial<MeEnvelope>;
  const data = envelope.data;
  return (
    envelope.ok === true &&
    Boolean(data && typeof data === "object") &&
    typeof data?.user?.id === "string" &&
    typeof data.user.name === "string" &&
    (data.activeTenant === null ||
      typeof data.activeTenant?.slug === "string") &&
    Array.isArray(data.memberships)
  );
}

/**
 * Resolve the current session through the API's canonical verifier.
 *
 * Missing/expired cookies return `null`. API outages and contract violations
 * throw so the portal shows a real service error instead of pretending the
 * user's credentials were rejected.
 */
export async function readSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  let response: Response;
  try {
    response = await fetch(`${serverApiUrl()}/v1/me`, {
      method: "GET",
      headers: {
        accept: "application/json",
        cookie: `${COOKIE_NAME}=${raw}`,
      },
      cache: "no-store",
    });
  } catch (cause) {
    throw new Error("Authentication service is unavailable", { cause });
  }

  if (response.status === 401) return null;
  if (!response.ok) {
    throw new Error(`Authentication service returned HTTP ${response.status}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new Error("Authentication service returned invalid JSON", { cause });
  }
  if (!isMeEnvelope(payload)) {
    throw new Error(
      "Authentication service returned an invalid session payload",
    );
  }

  const { user, activeTenant, memberships } = payload.data;
  return {
    sub: user.id,
    name: user.name,
    initials: initialsFor(user.name),
    tenant: activeTenant?.slug ?? memberships[0]?.tenantSlug ?? "",
  };
}
