import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// Deep import: parseStatementCatalog is the contract validator the tool itself uses; it is not part
// of the package barrel and this test must not widen the public API just to assert against it.
import { parseStatementCatalog } from "../../../packages/tools/src/postgres/execute-statement";

/**
 * #DECISION-FREE-CATALOG — the reviewed named-statement catalog `facts.query` reads for the
 * ontology-driven agents-generation tenant.
 *
 * Why this file exists: the tenant is deliberately NOT granted the legacy RAAS pack, because those
 * tools embed ontology-owned business verdicts (credential validity, JD supersession, dedup
 * precedence, event routing). The sanctioned replacement is a decision-free transport over a
 * server-owned catalog — but a catalog is only trustworthy if its SQL is REAL. Every statement here
 * was extracted verbatim from the reviewed legacy tools and executed against the live RAAS Postgres.
 *
 * These tests pin the two properties that make it safe to grant:
 *   1. it satisfies the tool's own contract (parseStatementCatalog), and
 *   2. it stays a pure READ transport that returns evidence, never a verdict.
 */

const CATALOG_PATH = path.resolve(
  __dirname,
  "../../../packages/recruitment-capabilities/catalogs/agents-generation-raas-statements.json",
);
const raw = readFileSync(CATALOG_PATH, "utf8");
const WRITES_PATH = path.resolve(
  __dirname,
  "../../../packages/recruitment-capabilities/catalogs/agents-generation-raas-writes.json",
);
const writesRaw = readFileSync(WRITES_PATH, "utf8");

describe("#DECISION-FREE-CATALOG — agents-generation RAAS read catalog", () => {
  it("satisfies the factory's own statement-catalog contract", () => {
    const catalog = parseStatementCatalog(raw);
    expect(Object.keys(catalog).length).toBeGreaterThanOrEqual(11);
    // The catalog the ontology-driven tenant reads through must be READ-ONLY: a write statement
    // reaching facts.query is refused at runtime, so keep it impossible by construction.
    for (const [operation, def] of Object.entries(catalog)) {
      expect(def.mode, `${operation} must be a read statement`).toBe("read");
      expect(def.params.length, `${operation} must be parameterized`).toBeGreaterThan(0);
      expect(def.max_rows, `${operation} must bound its result set`).toBeGreaterThan(0);
    }
  });

  it("covers exactly the reads the ontology's Agent actions need", () => {
    const catalog = parseStatementCatalog(raw);
    // createJD → requirement facts; ruleCheckForMatchResume → rule context;
    // ruleCheckForCandidateIdentity → identity lookups.
    for (const operation of [
      "requirement.load",
      "requirement.clarifications",
      "requirement.resolveAnchor",
      "ruleContext.requirement",
      "ruleContext.candidate",
      "ruleContext.latestResume",
      "ruleContext.applicationHistory",
      "ruleContext.activeBlacklist",
      "ruleContext.interviews",
      "candidateIdentity.byMobileSuffix",
      "candidateIdentity.byEmail",
    ]) {
      expect(catalog[operation], `missing catalog operation ${operation}`).toBeDefined();
    }
  });

  it("is a transport, not a judge — no statement manufactures a verdict column", () => {
    const catalog = parseStatementCatalog(raw);
    for (const [operation, def] of Object.entries(catalog)) {
      const sql = def.sql.toLowerCase();
      // A derived boolean/verdict alias is exactly the anti-pattern that made the legacy loader
      // fail OPEN (`compliance_credential_verified` = "any non-empty string counts as verified").
      // Raw columns only; the ontology's rules adjudicate.
      expect(sql, `${operation} must not synthesize a *_verified verdict`).not.toMatch(/as\s+\w*_?verified/);
      expect(sql, `${operation} must not synthesize a pass/reject verdict`).not.toMatch(/as\s+\w*(passed|rejected|approved|blocked)\b/);
      expect(sql, `${operation} must not mutate`).not.toMatch(/\b(insert|update|delete|truncate|drop)\b/);
    }
  });

  it("keeps the raw compliance credential readable so the ontology can judge validity", () => {
    const catalog = parseStatementCatalog(raw);
    // The loader must hand over the credential VALUE; deciding whether "rejected"/"expired" counts
    // as verified is a rule decision (see #CREDENTIAL-VERDICT-FIX in raas-rule-context.ts).
    expect(catalog["ruleContext.applicationHistory"]!.sql).toContain("compliance_credential");
    // Blacklist lock facts likewise travel raw — no "is_locked" conclusion.
    expect(catalog["ruleContext.activeBlacklist"]!.sql).toContain("lock_reason");
  });
});

/**
 * The WRITE half. Design decisions the user delegated ("状态值我来定 / 合并两种都提供 / 动态SQL不要写死")
 * are pinned here so a later edit cannot quietly reintroduce a smuggled business verdict.
 *
 * Every statement was PREPARE-validated against the live RAAS Postgres, and the merge/overwrite
 * semantics were proven by executing them inside a rolled-back transaction — see the session log.
 */
describe("#DECISION-FREE-CATALOG — agents-generation RAAS write catalog", () => {
  it("satisfies the contract and is write-only, bounded and parameterized", () => {
    const catalog = parseStatementCatalog(writesRaw);
    expect(Object.keys(catalog).length).toBe(16);
    for (const [operation, def] of Object.entries(catalog)) {
      expect(def.mode, `${operation} belongs in the write catalog`).toBe("write");
      expect(def.params.length, `${operation} must be parameterized`).toBeGreaterThan(0);
      // A write must address an exact row and report what it touched.
      expect(def.sql, `${operation} must RETURN the affected identity`).toMatch(/returning/i);
      // param arity: the SQL must bind exactly $1..$n for n declared params.
      const highest = Math.max(0, ...[...def.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
      expect(highest, `${operation}: sql binds $${highest} but declares ${def.params.length} params`).toBe(def.params.length);
    }
  });

  it("keeps a state literal ONLY where the operation name IS the decision", () => {
    const catalog = parseStatementCatalog(writesRaw);
    // The ontology's decision is WHICH operation to call; markSent meaning 'sent' is the contract,
    // not a hidden ruling.
    expect(catalog["invitation.markSent"]!.sql).toContain("status = 'sent'");
    expect(catalog["invitation.markFailed"]!.sql).toContain("status = 'failed'");
    expect(catalog["resumeUpload.markCompleted"]!.sql).toContain("status = 'completed'");
    expect(catalog["resumeUpload.markFailed"]!.sql).toContain("status = 'failed'");

    // …and NOWHERE else. These previously smuggled a status the caller never asked for:
    // jobPosting.insert forced status='draft'/publish_status='pending', jobPosting.update reset
    // publish_status='pending', resume.* concluded parse_status='completed'. Now the ontology sets them.
    for (const operation of ["jobPosting.insert", "jobPosting.update", "resume.insert", "resume.updateMerge", "resume.updateOverwrite", "candidate.insert", "requirementSpec.transitionStatus"]) {
      const sql = catalog[operation]!.sql;
      expect(sql, `${operation} must not hardcode a business status`).not.toMatch(/(status|publish_status|parse_status)\s*=\s*'/);
    }
    expect(catalog["jobPosting.insert"]!.params).toEqual(expect.arrayContaining(["status", "publish_status"]));
    expect(catalog["resume.insert"]!.params).toContain("parse_status");
  });

  it("offers BOTH merge and overwrite write semantics for the ontology to choose", () => {
    const catalog = parseStatementCatalog(writesRaw);
    for (const entity of ["candidate", "resume"]) {
      // merge: '' means UNKNOWN → keep the stored value (the resume parser may extract nothing).
      expect(catalog[`${entity}.updateMerge`]!.sql).toMatch(/COALESCE\(NULLIF\(\$\d+, ''\)/);
      // overwrite: '' means CLEAR → the caller is authoritative.
      expect(catalog[`${entity}.updateOverwrite`]!.sql).not.toMatch(/COALESCE\(NULLIF/);
      // both address the same row and take the same inputs, so switching is a pure policy choice.
      expect(catalog[`${entity}.updateOverwrite`]!.params).toEqual(catalog[`${entity}.updateMerge`]!.params);
    }
  });

  it("replaces the runtime-built SET clause with one static, fully-addressable patch", () => {
    const catalog = parseStatementCatalog(writesRaw);
    const patch = catalog["requirement.patchFields"]!;
    // The legacy `UPDATE job_requisition SET ${setClause}` was assembled at runtime and could never
    // be reviewed. This covers all 17 patchable columns; an unset param COALESCEs to the stored
    // value, so it is semantically identical to "only patch the fields that carry a value".
    expect(patch.params).toHaveLength(18); // 17 columns + the id
    expect(patch.params[0]).toBe("job_requisition_id");
    for (const column of ["must_have_skills", "nice_to_have_skills", "headcount", "work_years", "qualifications", "benefits"]) {
      expect(patch.params, `patch must address ${column}`).toContain(column);
      expect(patch.sql).toContain(`${column} = COALESCE(`);
    }
    expect(patch.sql).not.toContain("${"); // no interpolation survived
  });

  it("never lets a write statement leak into the read catalog (or vice versa)", () => {
    const reads = parseStatementCatalog(raw);
    const writes = parseStatementCatalog(writesRaw);
    expect(Object.keys(reads).some((o) => o in writes)).toBe(false);
    expect(Object.values(reads).every((d) => d.mode === "read")).toBe(true);
    expect(Object.values(writes).every((d) => d.mode === "write")).toBe(true);
  });
});
