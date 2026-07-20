/**
 * API adapter around the zhaopin tenant-owned materializer.
 *
 * A legacy bare event delivered directly by shared Inngest bypasses
 * `/v1/events`; the zhaopin registry override provides the same fallback.
 */

import {
  materializeRemoteResume,
  type RemoteResumeOptions,
} from "@tenants/zhaopin";
import { RAAS_TENANT_SLUG } from "./raas-ingress";

export type RaasResumeFetchOptions = RemoteResumeOptions;

export async function materializeRaasResume(
  eventName: string,
  payload: Record<string, unknown>,
  options: RaasResumeFetchOptions = {},
): Promise<Record<string, unknown>> {
  if (eventName !== "RESUME_DOWNLOADED") return payload;
  return materializeRemoteResume(RAAS_TENANT_SLUG, payload, options);
}
