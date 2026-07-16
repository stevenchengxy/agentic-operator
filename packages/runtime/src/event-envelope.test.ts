import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCanonicalEventPayload,
  stripPrivateEventMetadata,
} from "./event-envelope";

describe("canonical manifest event envelope", () => {
  it("preserves authored domain data while runtime identity fields win", () => {
    const payload = buildCanonicalEventPayload({
      eventName: "AGENT_STARTED",
      eventId: "evt-real",
      correlationId: "cor-real",
      subject: "REQ-42",
      payload: {
        event_type: "SPOOFED",
        event_name: "SPOOFED",
        event_id: "evt-spoofed",
        subject: "spoofed-subject",
        request_id: " upstream-request ",
        domain_value: { answer: 42 },
        __triggerEventId: "evt-private",
        __correlationId: "cor-private",
      },
    });

    assert.deepEqual(payload, {
      request_id: " upstream-request ",
      domain_value: { answer: 42 },
      event_type: "AGENT_STARTED",
      event_name: "AGENT_STARTED",
      event_id: "evt-real",
      subject: "REQ-42",
    });
  });

  it("preserves the exact prompt and supplies its input/context aliases", () => {
    const exactPrompt = "  Keep every byte\nincluding whitespace.  ";
    const payload = buildCanonicalEventPayload({
      eventName: "CHAT_MESSAGE",
      eventId: "evt-chat",
      correlationId: "cor-chat",
      prompt: exactPrompt,
      payload: {
        prompt: "caller cannot replace the exact prompt",
        input: "caller cannot replace the input alias",
        request_id: "   ",
        extra: true,
      },
    });

    assert.equal(payload.request_id, "cor-chat");
    assert.equal(payload.prompt, exactPrompt);
    assert.equal(payload.input, exactPrompt);
    assert.equal(payload.context, exactPrompt);
    assert.equal(payload.extra, true);
  });

  it("keeps an authored context and falls back to event id without correlation", () => {
    const payload = buildCanonicalEventPayload({
      eventName: "CHAT_MESSAGE",
      eventId: "evt-only",
      subject: null,
      payload: {
        prompt: "hello",
        context: { conversation: "existing" },
        subject: "caller-owned-subject",
      },
    });

    assert.equal(payload.request_id, "evt-only");
    assert.equal(payload.prompt, "hello");
    assert.equal(payload.input, "hello");
    assert.deepEqual(payload.context, { conversation: "existing" });
    assert.equal(Object.hasOwn(payload, "subject"), false);
  });

  it("removes only top-level private transport metadata", () => {
    assert.deepEqual(
      stripPrivateEventMetadata({
        visible: true,
        __test: true,
        nested: { __domain_key: "preserved" },
      }),
      {
        visible: true,
        nested: { __domain_key: "preserved" },
      },
    );
  });
});
