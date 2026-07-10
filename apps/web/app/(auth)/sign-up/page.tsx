import { AuthForm } from "../auth-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Sign-up page (P6-AUTH) — open self-service registration. Creates an account
 * via /v1/auth/register with no tenant memberships; an admin grants access
 * afterwards from the Access tab. On success the user lands on the portal,
 * which shows a "waiting for access" state until a role is granted.
 */
export default function SignUpPage() {
  return <AuthForm initialMode="signup" />;
}
