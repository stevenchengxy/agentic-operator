import { readFromInbox as genericReadFromInbox } from "@agentic/tools/fs";
import { zhaopinLegacyRaasEventAdapter } from "../event-adapter";
import { materializeRemoteResume } from "./remote-resume";

/** zhaopin owns both the old RAAS envelope and its remote-resume transport.
 * The global fs tool receives only canonical, already materialized input. */
export const zhaopinReadFromInbox: typeof genericReadFromInbox = {
  ...genericReadFromInbox,
  async handler(ctx) {
    const eventName = ctx.event?.name ?? "";
    const raw = (ctx.event?.data ?? {}) as Record<string, unknown>;
    const canonical = zhaopinLegacyRaasEventAdapter.inbound({
      eventName,
      data: raw,
    });
    const args = eventName === "RESUME_DOWNLOADED" || eventName.endsWith("/RESUME_DOWNLOADED")
      ? await materializeRemoteResume(ctx.tenantSlug, canonical)
      : canonical;
    return genericReadFromInbox.handler({
      ...ctx,
      event: { name: eventName, data: args },
    });
  },
};
