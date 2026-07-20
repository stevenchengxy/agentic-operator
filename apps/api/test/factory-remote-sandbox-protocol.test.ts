import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalSandboxSha256,
  findRemoteSandboxSensitiveValue,
  signRemoteSandboxMessage,
  verifyRemoteSandboxMessage,
} from "../src/services/agent-factory/sandbox-remote-protocol";

const secret = "test-only-remote-sandbox-hmac-key-32-bytes";
const now = new Date("2026-07-15T08:00:00.000Z");

describe("remote sandbox signed protocol", () => {
  afterEach(() => vi.unstubAllEnvs());
  it("uses a deterministic canonical digest and detects payload tampering", () => {
    expect(canonicalSandboxSha256({ b: 2, a: { y: 2, x: 1 } })).toBe(
      canonicalSandboxSha256({ a: { x: 1, y: 2 }, b: 2 }),
    );
    const envelope = signRemoteSandboxMessage({
      purpose: "submit",
      keyId: "sandbox-key-v1",
      secret,
      payload: { bundleHash: "sandbox-bundle:v1:test", attemptId: "attempt-1" },
      now,
      nonce: "nonce-one",
      ttlMs: 60_000,
    });
    expect(
      verifyRemoteSandboxMessage(envelope, {
        expectedPurpose: "submit",
        expectedKeyId: "sandbox-key-v1",
        secret,
        now: new Date(now.getTime() + 1_000),
      }),
    ).toEqual(envelope.payload);

    const tampered = {
      ...envelope,
      payload: { ...envelope.payload, attemptId: "attempt-2" },
    };
    expect(() =>
      verifyRemoteSandboxMessage(tampered, {
        expectedPurpose: "submit",
        expectedKeyId: "sandbox-key-v1",
        secret,
        now: new Date(now.getTime() + 1_000),
      }),
    ).toThrow(/payload hash mismatch/i);
  });

  it("rejects expired and replayed envelopes", () => {
    const envelope = signRemoteSandboxMessage({
      purpose: "status",
      keyId: "sandbox-key-v1",
      secret,
      payload: { attemptId: "attempt-1" },
      now,
      nonce: "nonce-two",
      ttlMs: 1_000,
    });
    expect(() =>
      verifyRemoteSandboxMessage(envelope, {
        expectedPurpose: "status",
        expectedKeyId: "sandbox-key-v1",
        secret,
        now: new Date(now.getTime() + 7_000),
        clockSkewMs: 0,
      }),
    ).toThrow(/expired/i);

    const consumedNonces = new Set<string>();
    verifyRemoteSandboxMessage(envelope, {
      expectedPurpose: "status",
      expectedKeyId: "sandbox-key-v1",
      secret,
      now,
      consumedNonces,
    });
    expect(() =>
      verifyRemoteSandboxMessage(envelope, {
        expectedPurpose: "status",
        expectedKeyId: "sandbox-key-v1",
        secret,
        now,
        consumedNonces,
      }),
    ).toThrow(/already consumed/i);
  });

  it("permits credential references but rejects resolved credential values", () => {
    expect(
      findRemoteSandboxSensitiveValue({
        api_key_env: "SANDBOX_VENDOR_API_KEY",
        headers: {
          Authorization: "Bearer ${SANDBOX_VENDOR_API_KEY}",
          "X-Secret": "{env.SANDBOX_VENDOR_SECRET}",
        },
      }),
    ).toBeUndefined();
    expect(
      findRemoteSandboxSensitiveValue({
        headers: { Authorization: "Bearer resolved-token-value" },
      }),
    ).toMatch(/literal/i);
    expect(
      findRemoteSandboxSensitiveValue({ password: "not-a-reference" }),
    ).toMatch(/literal credential/i);
    expect(
      findRemoteSandboxSensitiveValue({ password: "ACTUALSECRETUPPERCASE" }),
    ).toMatch(/literal credential/i);
    expect(
      findRemoteSandboxSensitiveValue({
        typescript_code: 'const apiKey = "resolved-secret-value";',
      }),
    ).toMatch(/literal credential assignment/i);
    expect(
      findRemoteSandboxSensitiveValue({
        typescript_code: 'const apiKey = "${SANDBOX_VENDOR_API_KEY}";',
      }),
    ).toBeUndefined();
  });

  it("detects configured and common credentials inside ordinary code fields", () => {
    vi.stubEnv("DLP_TEST_SECRET", "opaque-real-secret-value-123456789");
    expect(findRemoteSandboxSensitiveValue({
      generatedCode: 'const value = "opaque-real-secret-value-123456789";',
    })).toMatch(/recognized credential literal/i);
    expect(findRemoteSandboxSensitiveValue({
      generatedCode: 'const value = "sk-proj-abcdefghijklmnopqrstuvwxyz";',
    })).toMatch(/recognized credential literal/i);
  });
});
