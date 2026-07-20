import { describe, expect, it } from "vitest";
import type { TenantEventAdapter } from "@agentic/agent-kit";
import {
  identityTenantEventAdapter,
  resolveTenantEventAdapter,
} from "./event-adapter";

describe("tenant event adapter resolution", () => {
  it("uses identity semantics for ordinary tenants", () => {
    const inbound = { subject: "candidate-1" };
    const outbound = { ok: true };
    const adapter = resolveTenantEventAdapter({});

    expect(adapter).toBe(identityTenantEventAdapter);
    expect(
      adapter.inbound({ eventName: "acme/READY", data: inbound }),
    ).toBe(inbound);
    expect(
      adapter.outbound({
        eventId: "evt-1",
        eventName: "DONE",
        payload: outbound,
      }),
    ).toBe(outbound);
  });

  it("prefers an explicit RegisterContext override to the tenant registry", () => {
    const registryAdapter: TenantEventAdapter = {
      inbound: ({ data }) => ({ ...data, owner: "registry" }),
      outbound: ({ payload }) => ({ ...payload, owner: "registry" }),
    };
    const directAdapter: TenantEventAdapter = {
      inbound: ({ data }) => ({ ...data, owner: "direct" }),
      outbound: ({ payload }) => ({ ...payload, owner: "direct" }),
    };

    expect(
      resolveTenantEventAdapter({
        eventAdapter: directAdapter,
        tenantRegistry: { eventAdapter: registryAdapter },
      }),
    ).toBe(directAdapter);
    expect(
      resolveTenantEventAdapter({
        tenantRegistry: { eventAdapter: registryAdapter },
      }),
    ).toBe(registryAdapter);
  });

  it("keeps raw broker subject expressions tenant-owned", () => {
    const adapter: TenantEventAdapter = {
      name: "legacy",
      subjectExpressions: {
        trigger: "event.data.entity_id",
        cancel: "async.data.entity_id",
      },
      inbound: (input) => input.data,
      outbound: (input) => input.payload,
    };
    expect(resolveTenantEventAdapter({ eventAdapter: adapter }).subjectExpressions)
      .toEqual(adapter.subjectExpressions);
    expect(identityTenantEventAdapter.subjectExpressions).toBeUndefined();
  });
});
