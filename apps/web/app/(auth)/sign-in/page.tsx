import { AuthForm } from "../auth-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign-in page (P6-AUTH). The form posts to /v1/auth/login (the api owns
 * password verification + the session cookie). In dev (AUTH_MODE=dev) the
 * portal also works without signing in — every request resolves to the seeded
 * dev user — but this page stays reachable so the real login flow is testable.
 */
export default function SignInPage() {
  return <AuthForm initialMode="signin" />;
}
