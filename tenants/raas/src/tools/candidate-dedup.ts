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
 * Failure semantics: fail closed. A tenant/DB/registry error is not evidence
 * that the person is new, so the tool throws and the runtime fails/retries the
 * step. A candidate id is returned only after every identity index row has
 * committed successfully.
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
    "Fails closed when tenant-scoped storage or identity data is unavailable.",
  output: z.record(z.string(), z.unknown()),
  // eslint-disable-next-line @typescript-eslint/require-await
  async handler(ctx) {
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
    const keys = [
      nPhone ? `phone:${nPhone}` : "",
      nEmail ? `email:${nEmail}` : "",
      nName ? `name:${nName}` : "",
    ].filter(Boolean);
    if (keys.length === 0) {
      throw new Error(
        `[candidateDedupLookup] ${ctx.tenantSlug}: no usable name, phone, or email; refusing to create an unidentifiable candidate`,
      );
    }

    const db = getDb();
    const tenantRow = db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, ctx.tenantSlug))
      .all()[0];
    if (!tenantRow) {
      throw new Error(
        `[candidateDedupLookup] unknown tenant slug=${ctx.tenantSlug}; dedup cannot be tenant-scoped`,
      );
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
      let parsed: { candidateId?: unknown; owner?: unknown };
      try {
        parsed = JSON.parse(row.v) as { candidateId?: unknown; owner?: unknown };
      } catch (err) {
        throw new Error(
          `[candidateDedupLookup] corrupt registry row for ${key}`,
          { cause: err },
        );
      }
      if (typeof parsed.candidateId !== "string" || !parsed.candidateId.trim()) {
        throw new Error(
          `[candidateDedupLookup] registry row for ${key} has no candidateId`,
        );
      }
      return {
        candidateId: parsed.candidateId,
        owner: typeof parsed.owner === "string" ? parsed.owner : null,
      };
    };

    const lookups = {
      byPhone: nPhone ? lookup(`phone:${nPhone}`) : null,
      byEmail: nEmail ? lookup(`email:${nEmail}`) : null,
      byName: nName ? lookup(`name:${nName}`) : null,
    };
    const matchedIds = new Set(
      Object.values(lookups)
        .map((match) => match?.candidateId)
        .filter((id): id is string => Boolean(id)),
    );
    if (matchedIds.size > 1) {
      throw new Error(
        `[candidateDedupLookup] conflicting identity indexes resolve to multiple candidates: ${[...matchedIds].join(", ")}`,
      );
    }

    const verdict = selectDedup(
      { phone: nPhone, email: nEmail, name: nName, owner },
      lookups,
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
      // A unique-key race must abort the whole registration. On retry the
      // winning durable row will be read and returned as the existing match.
      db.transaction((tx) => {
        for (const key of keys) {
          tx.insert(agentMemoryLong)
            .values({
              tenantId,
              agentName: AGENT_KEY,
              subject: SUBJECT,
              key,
              valueJson: record,
            })
            .run();
        }
      });
    }

    if (!candidateId) {
      throw new Error(
        "[candidateDedupLookup] dedup completed without a durable candidate id",
      );
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
  },
});
