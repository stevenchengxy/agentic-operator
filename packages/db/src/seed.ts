/**
 * Seed script — inserts the tenant fixtures plus a small set of users that
 * exercise every role, so the login + RBAC + Access tab are demonstrable out
 * of the box. Run via `pnpm db:seed`.
 *
 * Users (all share the same dev password — `AGENTIC_SEED_PASSWORD`, default
 * `agentic`):
 *   - ops@agentic.local       platform superadmin · admin in every tenant
 *   - admin@agentic.local     tenant admin in `raas`
 *   - operator@agentic.local  operator in `raas`
 *   - viewer@agentic.local    viewer in `raas`
 *
 * Idempotent: tenants/users are skipped if they already exist by slug/email,
 * but credentials + platform role are re-applied every run so a DB seeded
 * before P6-AUTH (null password) becomes usable without a wipe.
 */

import { makeId } from "@agentic/shared";
import { eq } from "drizzle-orm";
import { closeDb, getDb } from "./client";
import { memberships, tenants, users } from "./schema";
import { hashPassword } from "./password";

const TENANT_FIXTURES = [
  {
    slug: "__system",
    name: "System",
    subtitle: "Code-defined agents (cross-tenant)",
    color: "#6f7178",
  },
  {
    slug: "raas",
    name: "RAAS",
    subtitle: "Recruitment-as-a-Service",
    color: "#d0ff00",
  },
  {
    // 招聘-v1 — faithful 1:1 migration of the old AO recruitment domain's 6
    // production agents (models/zhaopin-v1/). Slug is lowercase-Latin (required
    // by tenantSlugFromFolder); the Chinese label lives in `name`.
    slug: "zhaopin",
    name: "招聘-v1",
    subtitle: "招聘 6-agent 流水线 · JD/简历/查重/规则/匹配/面试邀约",
    color: "#65e0a3",
  },
  {
    // Agents-generation — the agent-factory's input domain, grounded LIVE in
    // AllmetaOntology (Studio :3500) rather than a local models/ folder. Seeded so
    // it shows in the tenant switcher; its ontology is fetched live via
    // AllmetaOntologySource and the factory generates the agents into it. Slug is
    // lowercase-Latin (tenantSlugFromFolder convention); the Allmeta domain id is
    // "Agents-generation" (resolved case-insensitively).
    slug: "agents-generation",
    name: "Agents-generation",
    subtitle: "Agent factory · live AllmetaOntology 本体",
    color: "#c4b5fd",
  },
  {
    slug: "support",
    name: "SupportFlow",
    subtitle: "Tier-1 ticket triage",
    color: "#7c9eff",
  },
  {
    slug: "finance",
    name: "FinanceClose",
    subtitle: "Monthly close orchestration",
    color: "#f5c46b",
  },
] as const;

const SEED_PASSWORD = process.env.AGENTIC_SEED_PASSWORD ?? "agentic";

type Role = "admin" | "operator" | "viewer";

/** Users to provision and the per-tenant memberships to grant them. */
const USER_FIXTURES: Array<{
  email: string;
  name: string;
  platformRole: "none" | "superadmin";
  /** Tenant slug → role. `*` means admin in every seeded tenant. */
  memberships: Record<string, Role> | "all-admin";
}> = [
  {
    email: "ops@agentic.local",
    name: "Operator",
    platformRole: "superadmin",
    memberships: "all-admin",
  },
  {
    email: "admin@agentic.local",
    name: "Ada Admin",
    platformRole: "none",
    memberships: { raas: "admin" },
  },
  {
    email: "operator@agentic.local",
    name: "Otto Operator",
    platformRole: "none",
    memberships: { raas: "operator" },
  },
  {
    email: "viewer@agentic.local",
    name: "Vera Viewer",
    platformRole: "none",
    memberships: { raas: "viewer" },
  },
];

async function main() {
  const db = getDb();
  const now = new Date();

  // ── Tenants ──────────────────────────────────────────────────────────────
  const tenantIds: Record<string, string> = {};
  for (const t of TENANT_FIXTURES) {
    const existing = db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, t.slug))
      .all();
    if (existing.length > 0) {
      tenantIds[t.slug] = existing[0]!.id;
      console.log(`[seed] tenant ${t.slug} exists → ${tenantIds[t.slug]}`);
      continue;
    }
    const id = makeId("ten");
    db.insert(tenants).values({ id, ...t }).run();
    tenantIds[t.slug] = id;
    console.log(`[seed] tenant ${t.slug} → ${id}`);
  }

  const passwordHash = hashPassword(SEED_PASSWORD);

  // ── Users + memberships ──────────────────────────────────────────────────
  for (const u of USER_FIXTURES) {
    let userId: string;
    const existing = db
      .select()
      .from(users)
      .where(eq(users.email, u.email))
      .all();
    if (existing.length > 0) {
      userId = existing[0]!.id;
      // Re-apply credentials + platform role every run (heals pre-P6-AUTH rows).
      db.update(users)
        .set({
          name: u.name,
          passwordHash,
          platformRole: u.platformRole,
          status: "active",
          updatedAt: now,
        })
        .where(eq(users.id, userId))
        .run();
      console.log(`[seed] user ${u.email} exists → ${userId} (creds refreshed)`);
    } else {
      userId = makeId("usr");
      db.insert(users)
        .values({
          id: userId,
          email: u.email,
          name: u.name,
          passwordHash,
          platformRole: u.platformRole,
          status: "active",
          createdAt: now,
          updatedAt: now,
        })
        .run();
      console.log(`[seed] user ${u.email} → ${userId} (${u.platformRole})`);
    }

    const grants: Array<[string, Role]> =
      u.memberships === "all-admin"
        ? Object.keys(tenantIds).map((slug) => [slug, "admin"])
        : Object.entries(u.memberships);

    for (const [slug, role] of grants) {
      const tenantId = tenantIds[slug];
      if (!tenantId) continue;
      const has = db
        .select()
        .from(memberships)
        .where(eq(memberships.userId, userId))
        .all()
        .find((m) => m.tenantId === tenantId);
      if (has) continue;
      db.insert(memberships)
        .values({ userId, tenantId, role, createdAt: now })
        .run();
      console.log(`[seed] ${u.email} → ${slug} (${role})`);
    }
  }

  console.log(`[seed] done — dev password for all seeded users: "${SEED_PASSWORD}"`);
  closeDb();
}

main().catch((err) => {
  console.error("[seed] failed", err);
  closeDb();
  process.exit(1);
});
