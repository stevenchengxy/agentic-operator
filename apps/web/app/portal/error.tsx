"use client";

/**
 * Portal-level error boundary (Next 16 App Router `error.tsx`).
 *
 * Catches uncaught render / data-fetch errors inside `/portal/*` so the
 * whole app doesn't whitescreen. Mirrors the `Empty` aesthetic from
 * `apps/web/app/portal/components/atoms.tsx` — same panel chrome, same
 * typography — so it doesn't feel like a foreign-protocol page.
 *
 * Why this exists (audit `02-ui-audit.md` §A.2): without an error.tsx
 * boundary, an exception thrown during e.g. a hook destructure (a
 * TanStack Query in an error state that the consumer didn't guard)
 * propagates to Next's default error overlay in dev and a stack-trace-
 * free white screen in prod.
 *
 * `reset` is provided by Next; it re-renders the segment so an operator
 * can retry without a full page reload (e.g. transient api 502).
 */

import { useEffect } from "react";
import { useI18n } from "@/app/portal/lib/preferences-context";

function localizedErrorDetail(
  error: Error,
  t: ReturnType<typeof useI18n>["t"],
): string {
  if (error.message === "Authentication service is unavailable") {
    return t("portalError.authUnavailable");
  }
  const http = /^Authentication service returned HTTP (\d+)$/.exec(
    error.message,
  );
  if (http) return t("portalError.authHttpError", { status: http[1]! });
  if (error.message === "Authentication service returned invalid JSON") {
    return t("portalError.authInvalidJson");
  }
  if (
    error.message ===
    "Authentication service returned an invalid session payload"
  ) {
    return t("portalError.authInvalidSession");
  }
  return error.message;
}

export default function PortalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const { t } = useI18n();
  useEffect(() => {
    // Surface the error to the browser console so devs can debug. In
    // production the digest is the only identifier — server-side logs
    // attach the matching digest.
    // eslint-disable-next-line no-console
    console.error("[portal/error.tsx]", error);
  }, [error]);

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 320,
        padding: 24,
        textAlign: "center",
        background: "var(--bg)",
      }}
    >
      <div
        style={{
          maxWidth: 480,
          background: "var(--panel)",
          border: "1px solid var(--border-2)",
          borderRadius: 8,
          padding: "28px 32px",
          boxShadow: "0 12px 32px -16px rgba(0,0,0,0.5)",
        }}
      >
        <div
          style={{
            fontSize: 10.5,
            fontFamily: "var(--mono)",
            textTransform: "uppercase",
            letterSpacing: "0.1em",
            color: "var(--red)",
            marginBottom: 8,
          }}
        >
          {t("portalError.eyebrow")}
        </div>
        <h2
          style={{
            margin: "0 0 10px 0",
            fontFamily: "var(--display)",
            fontSize: 26,
            fontWeight: 400,
            color: "var(--text)",
            letterSpacing: "-0.01em",
          }}
        >
          {t("portalError.title")}
        </h2>
        <p
          style={{
            margin: "0 0 20px 0",
            fontSize: 12.5,
            color: "var(--text-2)",
            lineHeight: 1.6,
          }}
        >
          {t("portalError.description")}
        </p>
        {error.message && (
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 11,
              color: "var(--text-3)",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "8px 10px",
              marginBottom: 14,
              wordBreak: "break-word",
              textAlign: "left",
              lineHeight: 1.5,
              maxHeight: 120,
              overflow: "auto",
            }}
          >
            {localizedErrorDetail(error, t)}
            {error.digest && (
              <div style={{ marginTop: 6, color: "var(--text-4)" }}>
                digest: {error.digest}
              </div>
            )}
          </div>
        )}
        <button
          onClick={reset}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 14px",
            fontSize: 12.5,
            fontWeight: 500,
            color: "var(--on-signal)",
            background: "var(--signal)",
            border: "1px solid var(--signal)",
            borderRadius: 5,
            cursor: "pointer",
          }}
        >
          {t("portalError.retry")}
        </button>
      </div>
    </div>
  );
}
