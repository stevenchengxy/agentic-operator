import { redirect } from "next/navigation";
import { readSession } from "@/lib/auth/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * `/portal` — redirect to `/portal/<active-tenant>/dashboard`. The active
 * tenant comes only from the verified session.
 */
export default async function PortalIndex() {
  const session = await readSession();
  if (!session) redirect("/sign-in?return=/portal");
  redirect(`/portal/${session.tenant}/dashboard`);
}
