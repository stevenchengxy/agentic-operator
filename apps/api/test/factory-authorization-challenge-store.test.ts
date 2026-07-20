import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { factoryAuthorizationChallenges, getDb, tenants } from "@agentic/db";
import {
  FACTORY_AUTHORIZATION_PROTOCOL_VERSION,
  INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION,
  SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PROTOCOL_VERSION,
  type FactoryAuthorizationChallenge,
} from "@agentic/agent-factory";
import {
  DrizzleFactoryAuthorizationChallengeStore,
  factoryAuthorizationChallengeTtlMs,
  verifyConsumedFactoryAuthorization,
} from "../src/services/agent-factory/authorization-challenge-store";

const suffix = randomUUID();
const tenantId = `ten-factory-auth-${suffix}`;
const tenantSlug = `factory-auth-${suffix}`;
const domain = "RAAS-v1";
const subjectDigest = "a".repeat(64);

describe("durable factory authorization challenges", () => {
  beforeAll(() => {
    getDb().insert(tenants).values({ id: tenantId, slug: tenantSlug, name: "Factory authorization test" }).run();
  });

  afterAll(() => {
    getDb().delete(factoryAuthorizationChallenges).where(eq(factoryAuthorizationChallenges.tenantId, tenantId)).run();
    getDb().delete(tenants).where(eq(tenants.id, tenantId)).run();
  });

  it("issues a canonical non-recommended confirm option and atomically consumes it once", async () => {
    const store = new DrizzleFactoryAuthorizationChallengeStore(tenantId, domain);
    const challenge = await store.issue(domain, {
      kind: "probe",
      subjectDigest,
      // The current Factory runtime deliberately uses one durable execution
      // id as both the run and conversation checkpoint coordinate.
      runId: "execution-1",
      conversationId: "execution-1",
      question: "是否只执行这一次真实写 probe？",
      declineLabel: "先不执行",
      confirmLabel: "确认只执行这一次",
    });

    expect(challenge.protocolVersion).toBe(FACTORY_AUTHORIZATION_PROTOCOL_VERSION);
    expect(challenge.options).toEqual([
      expect.objectContaining({ recommended: true }),
      expect.objectContaining({ value: challenge.token, recommended: false }),
    ]);
    const row = getDb().select().from(factoryAuthorizationChallenges)
      .where(eq(factoryAuthorizationChallenges.id, challenge.id)).all()[0]!;
    expect(row.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(row.tokenDigest).not.toBe(challenge.token);
    expect(JSON.stringify(row.optionsJson)).not.toContain(challenge.token);

    await expect(store.consume(domain, {
      challenge,
      answer: challenge.token,
      actor: "",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    })).rejects.toThrow(/actor/);
    await expect(store.consume(domain, {
      challenge,
      answer: challenge.token,
      actor: "usr-responder",
      question: challenge.question,
      context: `${challenge.context}-tampered`,
      options: challenge.options,
    })).rejects.toThrow(/exact server challenge/);

    const receipt = await store.consume(domain, {
      challenge,
      answer: challenge.token,
      actor: "usr-responder",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    });
    expect(receipt).toMatchObject({
      actor: "usr-responder",
      runId: "execution-1",
      conversationId: "execution-1",
      subjectDigest,
    });
    expect(verifyConsumedFactoryAuthorization({
      tenantId,
      domain,
      receipt,
      kind: "probe",
      subjectDigest,
    })).toBe(true);
    expect(verifyConsumedFactoryAuthorization({
      tenantId,
      domain,
      receipt: { ...receipt, actor: "usr-impersonator" },
      kind: "probe",
      subjectDigest,
    })).toBe(false);

    await expect(store.consume(domain, {
      challenge,
      answer: challenge.token,
      actor: "usr-responder",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    })).rejects.toThrow(/already consumed/);
  });

  it("uses a strict configured TTL and never consumes an expired challenge", async () => {
    expect(factoryAuthorizationChallengeTtlMs({})).toBe(15 * 60_000);
    expect(factoryAuthorizationChallengeTtlMs({ FACTORY_AUTHORIZATION_CHALLENGE_TTL_MS: "30000" })).toBe(30_000);
    expect(() => factoryAuthorizationChallengeTtlMs({ FACTORY_AUTHORIZATION_CHALLENGE_TTL_MS: "unbounded" })).toThrow(/integer/);
    expect(() => factoryAuthorizationChallengeTtlMs({ FACTORY_AUTHORIZATION_CHALLENGE_TTL_MS: "999999999" })).toThrow(/between/);

    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
      const store = new DrizzleFactoryAuthorizationChallengeStore(tenantId, domain);
      const challenge = await store.issue(domain, {
        kind: "probe",
        subjectDigest: "c".repeat(64),
        runId: "execution-expiry",
        conversationId: "execution-expiry",
        question: "是否执行？",
        declineLabel: "不执行",
        confirmLabel: "确认执行",
      });
      vi.setSystemTime(new Date(Date.parse(challenge.expiresAt) + 1));
      await expect(store.consume(domain, {
        challenge,
        answer: challenge.token,
        actor: "usr-responder",
        question: challenge.question,
        context: challenge.context,
        options: challenge.options,
      })).rejects.toThrow(/expired/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a challenge copied into another domain before state changes", async () => {
    const store = new DrizzleFactoryAuthorizationChallengeStore(tenantId, domain);
    const challenge: FactoryAuthorizationChallenge = await store.issue(domain, {
      kind: "integration_profile",
      subjectDigest: "b".repeat(64),
      runId: "execution-domain",
      conversationId: "execution-domain",
      question: "确认保存？",
      declineLabel: "不保存",
      confirmLabel: "确认保存",
    });
    expect(challenge.protocolVersion).toBe(INTEGRATION_PROFILE_AUTHORIZATION_PROTOCOL_VERSION);
    expect(challenge.token).toMatch(/^authorize_integration_profile:v3:[a-f0-9]{64}$/);
    expect(challenge.context).toMatch(/^integration_profile_authorization:v3:[a-f0-9]{64}$/);
    expect(challenge.options[0]?.value).toMatch(/^decline_integration_profile:v3:/);
    await expect(store.consume(domain, {
      challenge: { ...challenge, protocolVersion: FACTORY_AUTHORIZATION_PROTOCOL_VERSION },
      answer: challenge.token,
      actor: "usr-responder",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    })).rejects.toThrow(/exact server challenge/);
    await expect(store.restore(domain, {
      ...challenge,
      protocolVersion: FACTORY_AUTHORIZATION_PROTOCOL_VERSION,
    })).resolves.toBeNull();
    await expect(store.consume("RAAS-v2", {
      challenge,
      answer: challenge.token,
      actor: "usr-responder",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    })).rejects.toThrow(/domain mismatch/);
  });

  it("issues and verifies a sandbox design review receipt with a non-recommended approval", async () => {
    const store = new DrizzleFactoryAuthorizationChallengeStore(tenantId, domain);
    const digest = "d".repeat(64);
    const challenge = await store.issue(domain, {
      kind: "sandbox_design_review",
      subjectDigest: digest,
      runId: "execution-review",
      conversationId: "execution-review",
      question: "是否批准当前不可变设计进入隔离沙箱？",
      declineLabel: "需要修改",
      confirmLabel: "批准进入沙箱",
    });
    expect(challenge.protocolVersion).toBe(SANDBOX_DESIGN_REVIEW_AUTHORIZATION_PROTOCOL_VERSION);
    expect(challenge.token).toMatch(/^authorize_sandbox_design_review:v1:[a-f0-9]{64}$/);
    expect(challenge.context).toMatch(/^sandbox_design_review_authorization:v1:[a-f0-9]{64}$/);
    expect(challenge.options).toEqual([
      expect.objectContaining({ value: expect.stringMatching(/^decline_sandbox_design_review:v1:/), recommended: true }),
      expect.objectContaining({ value: challenge.token, recommended: false }),
    ]);

    const receipt = await store.consume(domain, {
      challenge,
      answer: challenge.token,
      actor: "usr-reviewer",
      question: challenge.question,
      context: challenge.context,
      options: challenge.options,
    });
    expect(verifyConsumedFactoryAuthorization({
      tenantId,
      domain,
      receipt,
      kind: "sandbox_design_review",
      subjectDigest: digest,
    })).toBe(true);
  });
});
