/**
 * candidateDedupLookup — RAAS tenant tool (migrated from the old
 * candidate-identity-agent / CandidateDedup production agent).
 *
 * Given the parsed resume (from the previous `parseResumeApi` step), it does
 * name+phone+email candidate de-duplication against a tenant-scoped registry
 * and a "one recruiter per candidate" ownership lock. The 3-tier identity
 * decision is the pure `selectDedup` (see dedup-logic.ts); this wrapper is the
 * I/O: extract identity → look up → decide → register a new candidate.
 *
 * Storage: the existing tenant-scoped `agent_memory_long` KV table (no schema
 * migration). Index rows `phone:<x>` / `email:<y>` / `name:<z>` all point at the
 * same candidate record under (agentName="candidateDedupLookup", subject="registry").
 *
 * Load-bearing old semantics: SOFT-FAIL. Any error (DB down, malformed input)
 * returns a brand-new candidate with `dedup_degraded:true` and NEVER throws — a
 * dedup outage must not block resume processing.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { defineTool, type ToolContext } from "@agentic/agent-kit";
import { getDb, agentMemoryLong, tenants, eq, and } from "@agentic/db";
import {
  normPhone,
  normEmail,
  normName,
  selectDedup,
  type DedupMatch,
} from "./dedup-logic";

const AGENT_KEY = "candidateDedupLookup";
const SUBJECT = "registry";

const NAME_KEYS = ["name", "full_name", "candidate_name", "fullName", "姓名"];
const PHONE_KEYS = ["phone", "mobile", "tel", "phone_number", "phoneNumber", "手机号", "手机"];
const EMAIL_KEYS = ["email", "mail", "e_mail", "邮箱"];
const OWNER_KEYS = ["owner", "recruiter", "recruiter_id", "recruiterId", "default_recruiter", "owner_recruiter"];

function newCandidateId(): string {
  return "cand-" + randomUUID().replace(/-/g, "").slice(0, 12);
}

/** Collect the objects worth searching for candidate identity, most-specific
 *  first: the parse result (lastResult, incl. its `.data`), then the trigger
 *  payload. */
function identitySources(ctx: ToolContext): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const push = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out.push(v as Record<string, unknown>);
      const data = (v as Record<string, unknown>).data;
      if (data && typeof data === "object" && !Array.isArray(data)) {
        out.push(data as Record<string, unknown>);
      }
    }
  };
  push(ctx.lastResult);
  push(ctx.event?.data);
  return out;
}

/** First non-empty string found under any alias across the sources. */
function pick(sources: Record<string, unknown>[], keys: string[]): string {
  for (const src of sources) {
    for (const k of keys) {
      const v = src[k];
      if (typeof v === "string" && v.trim().length > 0) return v.trim();
    }
  }
  return "";
}

export const candidateDedupLookup = defineTool({
  name: "candidateDedupLookup",
  description:
    "Candidate de-duplication + one-recruiter-per-candidate lock for RAAS. " +
    "Reads the parsed resume (name / phone / email) from the previous " +
    "parseResumeApi step, matches against the tenant's candidate registry " +
    "(phone > email > name tiers), registers a new candidate when none match, " +
    "and reports {candidate_id, is_new, tier, needs_review, lock_conflict}. " +
    "Soft-fails to a new candidate on any error (never blocks the run).",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
    try {
      const sources = identitySources(ctx);
      const name = pick(sources, NAME_KEYS);
      const phone = pick(sources, PHONE_KEYS);
      const email = pick(sources, EMAIL_KEYS);
      const owner =
        pick(sources, OWNER_KEYS) ||
        (typeof ctx.config?.default_recruiter === "string"
          ? (ctx.config.default_recruiter as string)
          : "") ||
        (ctx.subject ?? "");

      const nPhone = normPhone(phone);
      const nEmail = normEmail(email);
      const nName = normName(name);

      const db = getDb();
      const tenantRow = db
        .select({ id: tenants.id })
        .from(tenants)
        .where(eq(tenants.slug, ctx.tenantSlug))
        .all()[0];
      if (!tenantRow) {
        // Can't scope — fail soft to a new candidate.
        return { data: freshCandidate(name, nPhone, nEmail, true) };
      }
      const tenantId = tenantRow.id;

      const lookup = (key: string): DedupMatch | null => {
        const row = db
          .select({ v: agentMemoryLong.valueJson })
          .from(agentMemoryLong)
          .where(
            and(
              eq(agentMemoryLong.tenantId, tenantId),
              eq(agentMemoryLong.agentName, AGENT_KEY),
              eq(agentMemoryLong.subject, SUBJECT),
              eq(agentMemoryLong.key, key),
            ),
          )
          .all()[0];
        if (!row) return null;
        try {
          const r = JSON.parse(row.v) as { candidateId?: string; owner?: string | null };
          return r.candidateId
            ? { candidateId: r.candidateId, owner: r.owner ?? null }
            : null;
        } catch {
          return null;
        }
      };

      const verdict = selectDedup(
        { phone: nPhone, email: nEmail, name: nName, owner },
        {
          byPhone: nPhone ? lookup(`phone:${nPhone}`) : null,
          byEmail: nEmail ? lookup(`email:${nEmail}`) : null,
          byName: nName ? lookup(`name:${nName}`) : null,
        },
      );

      let candidateId = verdict.sameAsCandidateId;
      if (verdict.isNew) {
        candidateId = newCandidateId();
        const record = JSON.stringify({
          candidateId,
          owner: owner || null,
          name,
          phone: nPhone,
          email: nEmail,
        });
        const keys: string[] = [];
        if (nPhone) keys.push(`phone:${nPhone}`);
        if (nEmail) keys.push(`email:${nEmail}`);
        if (nName) keys.push(`name:${nName}`);
        for (const key of keys) {
          db.insert(agentMemoryLong)
            .values({
              tenantId,
              agentName: AGENT_KEY,
              subject: SUBJECT,
              key,
              valueJson: record,
            })
            .onConflictDoNothing()
            .run();
        }
      }

      return {
        data: {
          candidate_id: candidateId,
          same_as_candidate_id: verdict.sameAsCandidateId,
          is_new: verdict.isNew,
          tier: verdict.tier,
          needs_review: verdict.needsReview,
          lock_conflict: verdict.lockConflict,
          name,
          phone: nPhone,
          email: nEmail,
        },
      };
    } catch (err) {
      return {
        data: {
          candidate_id: newCandidateId(),
          same_as_candidate_id: null,
          is_new: true,
          tier: null,
          needs_review: false,
          lock_conflict: false,
          dedup_degraded: true,
          error: String((err as Error)?.message ?? err),
        },
      };
    }
  },
});

function freshCandidate(
  name: string,
  phone: string,
  email: string,
  degraded: boolean,
): Record<string, unknown> {
  return {
    candidate_id: newCandidateId(),
    same_as_candidate_id: null,
    is_new: true,
    tier: null,
    needs_review: false,
    lock_conflict: false,
    ...(degraded ? { dedup_degraded: true } : {}),
    name,
    phone,
    email,
  };
}
