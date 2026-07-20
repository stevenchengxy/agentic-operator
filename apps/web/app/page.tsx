/**
 * `/` — root entry. Redirects to `/portal`.
 *
 * Keeping this redirect as an App Router page (rather than a next.config
 * rewrite) means tenant resolution happens server-side via the session
 * cookie inside `/portal/page.tsx` — the same code path as a direct
 * `/portal` visit, no double-redirect logic to maintain.
 */

import { redirect } from "next/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function RootIndex(): never {
  redirect("/portal");
}
