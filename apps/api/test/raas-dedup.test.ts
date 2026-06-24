import { describe, it, expect } from "vitest";
import {
  normPhone,
  normEmail,
  normName,
  selectDedup,
  type DedupLookups,
} from "../../../tenants/raas/src/tools/dedup-logic";

describe("dedup normalizers", () => {
  it("normPhone strips non-digits and country code (keeps last 11)", () => {
    expect(normPhone("138-1234-5678")).toBe("13812345678");
    expect(normPhone("+86 138 1234 5678")).toBe("13812345678");
    expect(normPhone(null)).toBe("");
  });
  it("normEmail lowercases + trims", () => {
    expect(normEmail("  Wei.Liu@ACME.com ")).toBe("wei.liu@acme.com");
  });
  it("normName removes spaces + lowercases", () => {
    expect(normName(" 刘 伟 ")).toBe("刘伟");
    expect(normName("Wei Liu")).toBe("weiliu");
  });
});

const INPUT = { phone: "13812345678", email: "wei@acme.com", name: "刘伟" };

describe("selectDedup (3-tier identity)", () => {
  it("returns isNew when nothing matches", () => {
    expect(selectDedup(INPUT, {})).toMatchObject({ isNew: true, tier: null });
  });

  it("matches on phone (tier 1)", () => {
    const v = selectDedup(INPUT, { byPhone: { candidateId: "cand-1" } });
    expect(v).toMatchObject({ sameAsCandidateId: "cand-1", tier: "phone", isNew: false, needsReview: false });
  });

  it("matches on email when phone misses (tier 2)", () => {
    const v = selectDedup(INPUT, { byEmail: { candidateId: "cand-2" } });
    expect(v).toMatchObject({ sameAsCandidateId: "cand-2", tier: "email", isNew: false });
  });

  it("matches on name only as a low-confidence tier → needsReview", () => {
    const v = selectDedup(INPUT, { byName: { candidateId: "cand-3" } });
    expect(v).toMatchObject({ sameAsCandidateId: "cand-3", tier: "name", needsReview: true });
  });

  it("phone match takes precedence over email + name", () => {
    const v = selectDedup(INPUT, {
      byPhone: { candidateId: "cand-phone" },
      byEmail: { candidateId: "cand-email" },
      byName: { candidateId: "cand-name" },
    });
    expect(v.sameAsCandidateId).toBe("cand-phone");
    expect(v.tier).toBe("phone");
  });

  it("does NOT match on an empty incoming field even if a lookup is supplied", () => {
    const v = selectDedup(
      { phone: "", email: "", name: "刘伟" },
      { byPhone: { candidateId: "x" }, byEmail: { candidateId: "y" }, byName: { candidateId: "cand-3" } },
    );
    expect(v.tier).toBe("name");
    expect(v.sameAsCandidateId).toBe("cand-3");
  });

  it("flags a lock conflict when the matched candidate has a different owner", () => {
    const v = selectDedup(
      { ...INPUT, owner: "recruiter-A" },
      { byPhone: { candidateId: "cand-1", owner: "recruiter-B" } },
    );
    expect(v.lockConflict).toBe(true);
  });

  it("no lock conflict when owners match (or none set)", () => {
    expect(
      selectDedup({ ...INPUT, owner: "recruiter-A" }, { byPhone: { candidateId: "c", owner: "recruiter-A" } })
        .lockConflict,
    ).toBe(false);
    expect(
      selectDedup(INPUT, { byPhone: { candidateId: "c" } }).lockConflict,
    ).toBe(false);
  });
});
