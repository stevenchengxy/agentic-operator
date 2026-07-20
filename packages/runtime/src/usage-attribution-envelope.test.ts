import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripPrivateEventMetadata } from "./event-envelope";
import { buildManifestEventDeliveryData } from "./register";
import {
  PRIVATE_USAGE_ATTRIBUTION_FIELD,
  privateUsageAttributionMetadata,
  usageAttributionFromDeliveryData,
} from "./usage-attribution-envelope";

describe("private manifest usage attribution", () => {
  it("keeps attribution private while propagating it to downstream delivery", () => {
    const delivered = buildManifestEventDeliveryData({
      logicalPayload: { result: "done", __callerPrivate: "drop" },
      eventId: "evt-child",
      correlationId: "cor-chain",
      usageAttribution: {
        billingAccountId: "ten-a",
        actorType: "api_token",
        credentialId: "tok-1",
        requestId: "req-1",
        interactionId: "int-1",
        productSurface: "agent-runtime",
        productAction: "POST /v1/events",
      },
    });

    assert.deepEqual(delivered[PRIVATE_USAGE_ATTRIBUTION_FIELD], {
      billingAccountId: "ten-a",
      actorType: "api_token",
      credentialId: "tok-1",
      productSurface: "agent-runtime",
      productAction: "POST /v1/events",
      interactionId: "int-1",
      requestId: "req-1",
    });
    assert.equal(delivered.__callerPrivate, undefined);
    assert.deepEqual(stripPrivateEventMetadata(delivered), { result: "done" });
  });

  it("repins billing to the registered tenant and rejects malformed fields", () => {
    const decoded = usageAttributionFromDeliveryData(
      {
        [PRIVATE_USAGE_ATTRIBUTION_FIELD]: {
          billingAccountId: "ten-attacker",
          actorType: "owner",
          actorId: "contains whitespace",
          credentialId: "tok-safe",
          productSurface: "agent-runtime\nforged",
          unknownDimension: "must-not-survive",
        },
      },
      "ten-trusted",
    );

    assert.deepEqual(decoded, {
      billingAccountId: "ten-trusted",
      credentialId: "tok-safe",
      productSurface: "agent-runtime forged",
    });
  });

  it("omits empty metadata and ignores non-object queue values", () => {
    assert.deepEqual(privateUsageAttributionMetadata(undefined), {});
    assert.deepEqual(
      usageAttributionFromDeliveryData(
        { [PRIVATE_USAGE_ATTRIBUTION_FIELD]: "forged" },
        "ten-trusted",
      ),
      { billingAccountId: "ten-trusted" },
    );
  });
});

