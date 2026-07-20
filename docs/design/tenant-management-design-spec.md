# Tenant Management — Design Spec
*Version 1.0 · Implements PRD §4–§7 · 2026-05-20*

## 0. Scope & non-goals

This milestone delivers self-service tenant lifecycle management without an API restart: a Zod contract layer (`packages/contracts/src/tenants.ts:1-217`), batched query helpers that avoid N+1 (`apps/api/src/queries/tenants.ts:1-354`), six CRUD endpoints with a single-transaction provisioning path (`apps/api/src/routes/v1/tenants.ts:464-763`), two new lifecycle columns on `tenants` (`packages/db/drizzle/0011_tenant_lifecycle.sql:16-22`), an SPA management view with a 4-step "New tenant" wizard (`apps/web/public/portal/views/tenants.jsx:51-211`), and a wired `TenantSwitcher` that re-renders on a `agentic-tenants-updated` event (`apps/web/public/portal/app.jsx:228-338`). Deliberately deferred: hard-delete (only soft-archive), real RBAC enforcement (`isPlatformAdmin()` is a stub at `plugins/auth.ts:136-138`), cross-tenant code-agent registry isolation, per-tenant LLM key sandboxing, hardened actor identity on audit rows, and the `POST /v1/tenants/:slug/clone` + `/tokens` endpoints (clone is folded into the create path via `starter: copy-from:<slug>`).

## 1. Architecture overview

A `POST /v1/tenants` originates in the SPA's 4-step wizard at `apps/web/public/portal/views/tenants.jsx:324-596`. The browser sends a JSON body matching `TenantCreateBody` plus an `Idempotency-Key` derived from the slug + timestamp (`views/tenants.jsx:388`). The request hits Next.js, which passes through unchanged because `next.config.mjs` rewrites `/v1/*` to `http://localhost:3501`. Fastify resolves the bearer (or falls back to dev tenant) in the `onRequest` hook at `apps/api/src/plugins/auth.ts:110-115`. The `tenantsRoutes` handler at `apps/api/src/routes/v1/tenants.ts:510-557` parses the body, checks the idempotency LRU, and delegates to `performCreate()`.

`performCreate()` (`routes/v1/tenants.ts:202-462`) opens **exactly one** `db.transaction(() => { … })`. Inside: insert `tenants`, `tenant_budgets`, `memberships`, starter `event_types` (and optionally a cloned manifest), an `api_tokens` row, and an `audit_log` entry. Any throw rolls back and frees the slug. After commit, two **post-commit** side effects run: `ensureTenantDirs()` does `mkdir -p` for `data/logs/<slug>/{runs,events}`, `data/artifacts/<slug>`, and `data/tenants/<slug>/` (`routes/v1/tenants.ts:149-171`), and `reregisterInngest({ scope: "tenant" })` rebuilds the Inngest function set through the new mutex-serialized chain at `apps/api/src/services/inngest-registry.ts:96-152`. The handler then re-reads the detail via `getTenantDetail()` so the response carries fresh roll-up counts.

The SPA fans this back. The Tenants view dispatches a `agentic-tenants-updated` `CustomEvent` (`views/tenants.jsx:80-82`); the `TenantSwitcher` (`app.jsx:232-240`) and the App-level effect (`app.jsx:32-45`) both listen, the latter calling `window.RAAS_RELOAD()` to re-fan the bootstrap. The new bootstrap pulls a fresh `/v1/tenants` (`apps/web/lib/spa/source-json.ts:272-283`) and the switcher dropdown re-renders without a page reload.

```
   ┌──────────────────┐   ┌───────────────────┐   ┌────────────────────┐
   │ SPA wizard       │──▶│ Next.js rewrite   │──▶│ Fastify auth hook  │
   │ tenants.jsx      │   │ next.config.mjs   │   │ plugins/auth.ts    │
   └────────┬─────────┘   └───────────────────┘   └─────────┬──────────┘
            │ Idempotency-Key                               │
            │ TenantCreateBody                              ▼
            │                                     ┌────────────────────┐
            │                                     │ tenantsRoutes      │
            │                                     │ routes/v1/tenants  │
            │                                     └─────────┬──────────┘
            │                                               │
            │ broadcast 'agentic-tenants-updated'    ┌──────▼──────────┐
            │◀──────────────────────────────────────│ performCreate() │
            │                                       │ db.transaction()│
            │                                       │  ├── tenants    │
            │                                       │  ├── budgets    │
            │                                       │  ├── memberships│
            │                                       │  ├── starter*   │
            │                                       │  ├── api_tokens │
            │                                       │  └── audit_log  │
            │                                       └─────────┬───────┘
            │                                                 │ post-commit
            │                                       ┌─────────▼───────┐
            │                                       │ ensureTenantDirs│
            │                                       │ reregisterInngst│
            │                                       └─────────────────┘
```

## 2. Data model

The `tenants` table sits at the root of the FK graph; every user-visible table cascades from it. The Drizzle declaration after the milestone:

```typescript
export const tenants = sqliteTable(
  "tenants",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    subtitle: text("subtitle"),
    color: text("color"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().default(now),
    archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull().default(now),
  },
  (t) => ({
    slugUq: uniqueIndex("tenants_slug_uq").on(t.slug),
    archivedAtIdx: index("tenants_archived_at_idx").on(t.archivedAt),
  }),
);
```

(`packages/db/src/schema.ts:28-55`)

Two new columns from `0011_tenant_lifecycle.sql:16-22`. `archivedAt` is a nullable timestamp — `NULL` means active and appears in the default switcher list; non-null means soft-archived (hidden, Inngest registrations removed, tokens disabled at the auth layer). Nullable because hard-delete is intentionally **not** the lifecycle exit: keeping rows preserves the audit trail and lets restore be reversible. `updatedAt` is `NOT NULL` with a `unixepoch() * 1000` default so existing rows back-fill cleanly during migration; it tracks the *last attribute or lifecycle mutation*, distinct from `createdAt`, so the SPA can render "Updated 3m ago" without a left-join on `audit_log`. Both columns are necessary because one cannot infer "is archived?" from "last updated" — edit flows touch `updatedAt` without changing the archive state.

The companion `tenants_archived_at_idx` makes `WHERE archived_at IS NULL` cheap even with hundreds of archived tenants. Hard-delete remains out of scope; if needed it relies on the cascade behavior already declared on every FK.

Tables that carry `tenant_id` with `references(() => tenants.id, { onDelete: "cascade" })`: `memberships` (`schema.ts:78-80`), `workflows` (`:94-96`), `deployments` (`:136-138`), `events` (`:238-240`), `runs` (`:289-291`), `tasks` (`:375-377`), `artifacts` (`:412-414`), `auditLog` (`:436-438`), `apiTokens` (`:456-458`), `eventTypes` (`:478-480`), `entityTypes` (`:501-503`), `tenantBudgets` (`:524-526`, also `PRIMARY KEY`), `webhookSubscriptions` (`:555-557`), `agentMemoryLong` (`:602-604`).

Indirect cascades flow through parents: `workflowVersions` and `agents` cascade via `workflows.id`; `agentVersions`, `steps`, and `artifacts` cascade through their parent rows; `agentMemoryShort` cascades through `runs.id` (`schema.ts:584-586`). Net effect: a hypothetical hard-delete would correctly remove every dependent row in one SQLite cascade. We rely on this for archive *recovery posture* but don't exercise it.

The `memberships` table (`schema.ts:72-86`) is a `(user_id, tenant_id)` composite PK with `role enum('admin','operator','viewer')`. Create-tenant always inserts one row keyed `(operatorUserId, newTenantId, 'admin')`; an upsert with `onConflictDoNothing` (`routes/v1/tenants.ts:274-284`) makes retries safe.

## 3. API contracts

All endpoints sit under `apps/api/src/routes/v1/tenants.ts`. Responses are wrapped in the `{ ok, data } | { ok: false, error: { code, message } }` envelope by the `reply.ok`/`reply.fail` decorators in `apps/api/src/plugins/error.ts:18-37`.

**GET /v1/tenants** — `routes/v1/tenants.ts:466-492`. Today (pre-RBAC) the handler passes `forUserId: null` and surfaces every row regardless of membership; once `isPlatformAdmin()` is wired we will swap to `forUserId: auth.userId` for non-admins. Query string: `?include_archived=1` (or `=true`) flips the archive filter. Body: `{ items: TenantListItem[], count, viewer: { tenantId, tenantSlug, userId } }`. The `viewer` block lets the SPA highlight the current tenant without a second request. `TenantListItem` (`packages/contracts/src/tenants.ts:68-74`) extends `Tenant` with `agentCount`, `runs24h`, `openTasks`, `membership`. Errors: 401 from `requireAuth`.

**GET /v1/tenants/:slug** — `routes/v1/tenants.ts:495-507`. Validates the slug at the controller (`TENANT_SLUG_REGEX.test(slug)`) and returns `400 invalid_slug` on malformed path so we don't waste a DB roundtrip on `/v1/tenants/<script>`. Body: `TenantDetail` from `contracts/src/tenants.ts:77-93`, which extends `TenantListItem` with `workflowCount`, `deploymentLiveCount`, and a nullable `budgets` block. 404 `tenant_not_found` if unknown.

**POST /v1/tenants** — `routes/v1/tenants.ts:510-557`. Body validated by `TenantCreateBody`:

```typescript
export const TenantCreateBody = z.object({
  slug: z.string().min(2).max(32).regex(TENANT_SLUG_REGEX, "..."),
  name: z.string().min(1).max(64),
  subtitle: z.string().max(128).optional(),
  color: z.string().regex(HEX_COLOR, "...").optional(),
  budget: z.object({ monthlyTokenCap, monthlyUsdCap }).optional(),
  starter: z.union([z.literal("empty"), z.literal("hello"), z.string().regex(/^copy-from:.../)])
    .optional().default("hello"),
  mintToken: z.boolean().optional().default(true),
}).superRefine((val, ctx) => {
  if (RESERVED_TENANT_SLUGS.has(val.slug))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["slug"], message: `...` });
});
```

(`packages/contracts/src/tenants.ts:96-145`)

Status `201` on success. Body: `TenantCreateResponse` (`contracts/src/tenants.ts:183-209`). Idempotent on `Idempotency-Key` header — see §6. Error codes: `400 invalid_input` (Zod failure, surfaced by the global handler in `plugins/error.ts:39-51`); `400 reserved_slug` (defense-in-depth at `routes/v1/tenants.ts:516-522`); `400 copy_source_unknown` (`routes/v1/tenants.ts:227-234`); `409 slug_taken` (`routes/v1/tenants.ts:210-217`).

**PUT /v1/tenants/:slug** — `routes/v1/tenants.ts:560-615`. Partial update of `{name, subtitle, color}`. `TenantUpdateBody` is `.strict()` (`contracts/src/tenants.ts:155`) so any extra field — including a literal `slug` — fails Zod with `invalid_input`; the *slug remains immutable* without a dedicated runtime check. `.refine()` (`contracts/src/tenants.ts:156-162`) requires at least one of the three fields so an empty `{}` 400s. Response: refreshed `TenantDetail`. Writes one `audit_log` row inside the same transaction (`routes/v1/tenants.ts:583-608`) with the before-state in `metaJson.before` for forensics.

**DELETE /v1/tenants/:slug** — `routes/v1/tenants.ts:618-701`. Soft-archive. Body schema is `TenantArchiveBody` (`contracts/src/tenants.ts:166-174`): `{ confirm: string, reason?: string }`. The controller requires `body.confirm === slug` (`routes/v1/tenants.ts:625-631`). Returns `200 { slug, archivedAt }`. Errors: `400 confirm_mismatch`, `400 cannot_archive_system` (`routes/v1/tenants.ts:632-638`), `404 tenant_not_found`, `409 already_archived`, `409 has_active_work` (when `tenantHasActiveWork()` finds non-terminal runs or open tasks; `queries/tenants.ts:295-323`). A second DELETE returns `409 already_archived` rather than silently 200ing.

**POST /v1/tenants/:slug/restore** — `routes/v1/tenants.ts:704-763`. Lifts the archive. Body: `TenantRestoreBody` (optional `reason`). Returns refreshed `TenantDetail`. Errors: `404 tenant_not_found`, `409 not_archived`. Audit row with `action: "tenant.restore"`.

A `HEAD /v1/tenants/:slug` slug-existence probe specified in PRD Story 3 was not shipped; the SPA falls back to regex+local-list validation at `views/tenants.jsx:352-366`. P5-TEN-02 will add it for parity.

## 4. Validation rules (slug, color, reserved)

The slug regex lives in **one** place — the contracts package — so the SPA preview and the API enforcement read the same constant:

```typescript
export const TENANT_SLUG_REGEX = /^[a-z][a-z0-9-]{1,31}$/;
```

(`packages/contracts/src/tenants.ts:24`)

The constraint says: first character must be a lowercase letter; remaining 1–31 characters are lowercase letters, digits, or hyphens. The leading-letter rule guarantees the slug is a legal Inngest function-id segment (Inngest fn ids are `${tenantSlug}.${agentName}` and many downstream parsers split on `.`), and it dodges the "is `9foo` a digit literal or a slug?" ambiguity in URLs. The 2-character minimum prevents single-letter slugs that could shadow short flags or routes. The 32-character maximum keeps `data/logs/<tenant>/...` paths within sensible filesystem limits.

The reserved list:

```typescript
export const RESERVED_TENANT_SLUGS = new Set<string>([
  "__system", "system", "admin", "root", "api", "v1", "v2",
  "health", "metrics", "inngest", "_meta", "static", "public",
  "internal", "platform", "tenants", "new", "edit", "create",
  "delete", "archive",
]);
```

(`contracts/src/tenants.ts:27-49`)

Three classes of reservations: (1) **system tenant collisions** — `__system` already exists as the platform tenant hosting test agents; `system`, `admin`, `root`, `platform`, `internal` are common admin-area aliases. (2) **HTTP path collisions** — `api`, `v1`, `v2`, `health`, `metrics`, `inngest`, `static`, `public`, `tenants` would clash with router segments. (3) **Action-verb-as-slug collisions** — `new`, `edit`, `create`, `delete`, `archive` would shadow the wizard's own routes if someone tried `/tenants/new` as a slug. `_meta` is reserved because it matches the SQLite schema-metadata table name.

The validation runs in two layers. First, `TenantCreateBody.superRefine` (`contracts/src/tenants.ts:137-144`) flags any direct match during Zod parsing; this surfaces in the SPA wizard's inline validation. Second, the route handler calls `isReservedSlug()` after Zod parsing (`routes/v1/tenants.ts:516-522`):

```typescript
export function isReservedSlug(slug: string): boolean {
  if (RESERVED_TENANT_SLUGS.has(slug)) return true;
  if (slug.startsWith("_") || slug.startsWith("-")) return true;
  if (slug.endsWith("-")) return true;
  return false;
}
```

(`contracts/src/tenants.ts:212-217`)

The helper adds prefix/suffix checks that the static set misses: any `_`-prefixed slug is rejected (mirrors `__system`), any `-`-prefixed or `-`-suffixed slug is rejected (cosmetic — they read poorly and break the kebab convention). Color validation is a separate `HEX_COLOR = /^#[0-9a-f]{6}$/i` (`contracts/src/tenants.ts:52`) so the database always stores a normalized form.

## 5. Provisioning transaction

`performCreate()` lives at `routes/v1/tenants.ts:202-462`. The contract: either every row lands and the slug is permanently claimed, or nothing lands and the slug stays free. Structure: *pre-checks* (cheap, no transaction), *the transaction* (single all-or-nothing block), and *post-commit side effects* (idempotent, FS- or network-bound).

**Step 1 — Slug existence pre-check** (`routes/v1/tenants.ts:210-217`). `tenantSlugExists(body.slug)` (`queries/tenants.ts:280-289`) throws a typed error caught at the route layer as `409 slug_taken`. The transaction never opens; we don't burn the SQLite write lock on a doomed request. The unique index `tenants_slug_uq` remains the *correctness* guarantee — even if two requests race past the pre-check, only one survives the index conflict. The pre-check is a UX optimization, not a security boundary.

**Step 2 — Copy-source resolution** (`routes/v1/tenants.ts:219-237`). When `starter` starts with `copy-from:`, we look up the source tenant *outside* the transaction. A 400 `copy_source_unknown` here is friendlier than a confusing FK error inside the transaction. The source `tenantId` is held in a closure for two reads inside the transaction body.

**Step 3 — The transaction** (`routes/v1/tenants.ts:248-415`). One `db.transaction(() => { … })` opens a SQLite IMMEDIATE write transaction. Six inserts run in order:

1. `tenants` row with `id = makeId("ten")` and the wizard's identity fields.
2. `tenant_budgets` row keyed to the new tenant. Caps from the wizard; usage starts at zero.
3. `memberships` row binding the operator user as `admin`. Uses `.onConflictDoNothing({ target: [memberships.userId, memberships.tenantId] })` for retry safety.
4. **Starter content branch**. For `starter: "hello"`: insert two seed `event_types` (`HELLO_STARTER_EVENTS` at `routes/v1/tenants.ts:174-192`). For `starter: copy-from:<slug>`: read the source's `event_types`, `entity_types`, and latest `workflows`+`workflow_versions`; re-insert with the new `tenantId` and fresh `wf-…`/`wfv-…` ids (`routes/v1/tenants.ts:304-379`). The clone takes the *last* row of `workflow_versions` (line 366), not necessarily the "live" deployment — a known limitation noted in §13.
5. `api_tokens` row when `body.mintToken === true`. The 32-byte plaintext from `mintBootstrapToken()` (`routes/v1/tenants.ts:136-142`) is hashed via SHA-256 by `hashToken()`. Only the hash persists; the plaintext lives in a closure for the response (and idempotency cache — see §6).
6. `audit_log` row with `action: "tenant.create"`, `targetType: "tenant"`, and a `metaJson` carrying slug, name, starter, copy_from, mintToken, the *caller's* tenant slug, and `seeded_event_types`.

Any throw rolls the entire transaction back, freeing the slug. Failure modes: (a) race on the unique index (second writer loses), or (b) a logical bug in the starter branch.

**Step 4 — Post-commit side effects** (`routes/v1/tenants.ts:417-428`).

- `ensureTenantDirs(body.slug)` — `mkdir -p` for the four data directories. Wrapped in a try/catch that logs but doesn't throw; the DB is the source of truth, and writers recreate missing dirs lazily.
- `reregisterInngest({ scope: "tenant" })` — refresh the Inngest function set so any pre-staged code under `data/tenants/<slug>/` gets registered.

Both sit *outside* the transaction for two reasons. First, filesystem and network errors must not roll back a successful database commit — we can't un-commit, and partial FS state is recoverable. Second, `reregisterInngest()` rebuilds *the entire function set*; inside a transaction a registration error would invalidate an otherwise-good commit, which is worse than leaving Inngest stale until the next mutation.

## 6. Idempotency

The create endpoint accepts an `Idempotency-Key` header. The cache is a bounded `Map<string, CachedResponse>` at `routes/v1/tenants.ts:84-108` with a 1-hour TTL (`IDEMPOTENCY_TTL_MS = 60 * 60 * 1000`) and a soft cap of 256 entries — when full, we evict the oldest entry by `Map.keys().next().value`.

Key derivation: `${auth.tenantSlug}:${idemKey}` (`routes/v1/tenants.ts:524-528`). The caller's tenant slug is prepended so two operators using the same client-generated key (e.g. `"create-acme"`) don't collide. On a hit, we replay the cached envelope — status code and body byte-for-byte (`routes/v1/tenants.ts:529-534`).

The cached body **includes the plaintext bootstrap token**. This is the load-bearing reason the cache exists: if a 5xx interrupts the response after the transaction commits, the operator's retry must see the same plaintext or the freshly-minted token is forever unrecoverable (only the hash is in the DB). The 1-hour TTL is long enough for a human-operator retry and short enough that the in-memory secret doesn't linger.

The cache is in-process; horizontal scaling would require swapping the `Map` for a Redis-backed store. Single-node SQLite already constrains us to one api process, so this is acceptable.

Other mutations are *naturally* idempotent through guard clauses: `already_archived` short-circuits a second DELETE; the unique index short-circuits a second create; PUT's audit row makes repeat-update detectable in the log even though the state converges. We did not extend idempotency-key handling to those endpoints.

## 7. Archive semantics

Archive is **soft-delete with `archivedAt`**, not hard-delete. Three reasons. (1) **Audit preservation** — `audit_log` rows carry `tenant_id` with FK cascade; deleting the tenant would drop every prior tenant action from the global audit query. Operators auditing an incident need to reconstruct who-did-what for a tenant that no longer exists. (2) **FK cascade fear** — runs, events, tasks, and artifacts all cascade from `tenants.id`; a misclicked DELETE on a tenant with months of run history would silently nuke everything. (3) **Reversibility** — soft-archive supports a restore window. PRD specifies 90 days as the default; this milestone enforces no automated sweep but leaves data intact for manual recovery.

The archive request body requires the operator to re-type the slug:

```typescript
if (body.confirm !== slug) {
  return reply.fail("confirm_mismatch", `confirm must equal the slug ("${slug}")`, 400);
}
```

(`routes/v1/tenants.ts:625-631`)

This is the GitHub / Atlassian "type the repository name" convention, at the API layer. The SPA modal at `views/tenants.jsx:712-720` enforces the same client-side; the API guard means a `curl -X DELETE` with a wrong `confirm` returns 400 instead of irrevocably archiving the wrong tenant.

Before archiving we check for active work:

```typescript
const active = tenantHasActiveWork(row.id);
if (active.runs > 0 || active.tasks > 0) {
  return reply.fail("has_active_work", `tenant has ${active.runs} active runs and ${active.tasks} open tasks; resolve them before archiving`, 409);
}
```

(`routes/v1/tenants.ts:657-664`, helper at `queries/tenants.ts:295-323`)

`tenantHasActiveWork` counts runs in `('queued','running','waiting')` and tasks in `'open'`. An in-flight run that emitted into an archived namespace would be hard to debug; forcing resolution first keeps the state machine clean.

The transaction itself is small (`routes/v1/tenants.ts:666-688`): set `archivedAt = now`, set `updatedAt = now`, write an audit row. After commit, `reregisterInngest({ scope: "tenant" })` re-runs `rebuildTenantFns()` which now skips this tenant — the rebuild reads `listActiveTenantSlugs()` from `queries/tenants.ts:329-337`, filtered on `isNull(archivedAt)`. The archived tenant's Inngest functions drop out atomically on the next request.

Restore (`routes/v1/tenants.ts:704-763`) is the mirror: clear `archivedAt`, bump `updatedAt`, audit, re-register. No retention-window enforcement yet — PRD §11 lists this as a phase-3 sweeper.

## 8. Auth hardening (P5 hardening)

The dev-mode auth fallback at `apps/api/src/plugins/auth.ts:22-26` makes every unauthenticated request the `AGENTIC_DEV_TENANT` admin. With tenant management exposed via API, an unauthenticated `POST /v1/tenants` in production would be a wholesale platform takeover. The boot-time guard at `plugins/auth.ts:78-103`:

```typescript
function assertAuthModeSafe(): void {
  if (process.env.AUTH_MODE === "dev" && process.env.NODE_ENV === "production") {
    throw new Error(
      "[auth] refusing to start: AUTH_MODE=dev is incompatible with " +
        "NODE_ENV=production. ..."
    );
  }
  if (process.env.AUTH_MODE === "dev") {
    const slug = process.env.AGENTIC_DEV_TENANT ?? "raas";
    const t = getDb().select().from(tenants).where(eq(tenants.slug, slug)).all()[0];
    if (!t) {
      throw new Error(
        `[auth] AUTH_MODE=dev requires AGENTIC_DEV_TENANT to match an existing ` +
          `tenant slug; "${slug}" was not found. ...`
      );
    }
    console.warn(`[auth] AUTH_MODE=dev is enabled — every unauthenticated request is the "${slug}" tenant admin. ...`);
  }
}
```

(`plugins/auth.ts:78-103`)

Three checks, in order. **Refuse to boot** when `AUTH_MODE === "dev"` *and* `NODE_ENV === "production"` — there is no legitimate reason these flags appear together. **Validate AGENTIC_DEV_TENANT exists** when dev mode is enabled — a stale slug from a renamed tenant would silently return `null` from `devTenant()` and every request would 401; the boot check turns that into a clear startup error. **Warn** when dev mode is enabled, so the operator can't claim they didn't know.

These run in `registerAuth(app)` at `plugins/auth.ts:110-115`, before the `onRequest` hook is installed. Fail-fast at registration means a misconfigured deploy never accepts traffic; per-request checking would let the process drift into a degraded mode that only pages on the first request.

The guard does not yet enforce *who* can call `POST /v1/tenants`. `isPlatformAdmin()` at `plugins/auth.ts:136-138` is a stub returning `false`; routes accept any authenticated caller. P5-TEN-02 wires a real platform-admin gate.

## 9. Inngest mutex

`reregisterInngest()` rebuilds the entire Inngest function set in process memory. Pre-milestone, two concurrent callers — say a `PUT /v1/workflows/:slug` racing a `POST /v1/tenants/:slug/code` — would interleave their `rebuildTenantFns()` and `rebuildCodeAgentFns()` calls; the second to finish overwrote the first's `state.fns.tenant`. Symptom: a deployed agent silently disappeared from the function list.

The fix in `apps/api/src/services/inngest-registry.ts:96-124`:

```typescript
let reregisterChain: Promise<unknown> = Promise.resolve();

export async function reregisterInngest(opts: { tenantSlug?: string; scope?: "tenant" | "code_agent" | "all" }): Promise<{ fnCount: number; scope: string }> {
  const next = reregisterChain.then(() => _reregisterImpl(opts));
  reregisterChain = next.catch(() => undefined);
  return next;
}
```

`reregisterChain` is a promise chain that serializes every rebuild. The Nth caller does `reregisterChain.then(...)` so it starts only after the (N-1)th resolves. The `.catch(() => undefined)` on line 122 is **not** an error swallow on the *caller's* path (the caller awaits `next` directly at line 123, so they see rejections) — it is a chain-poisoning guard. Without it, a single rejected rebuild would leave `reregisterChain` permanently rejected and every subsequent `then` would skip its handler. With the `.catch` wrapper, the chain "recovers" to fulfilled-with-undefined after each failure and the next caller proceeds normally.

The mutex is global to the api process — no per-tenant lock. Acceptable because (a) rebuild takes single-digit milliseconds, and (b) the function-set rebuild is intrinsically global; Inngest's `serve()` captures the array at construction time so a partial swap is meaningless.

Tenant create, archive, and restore all go through this serialized path (`routes/v1/tenants.ts:423-428`, `:690-694`, `:752-756`).

## 10. SPA wiring

The bootstrap loader at `apps/web/lib/spa/source-json.ts:260-353` is the SPA's single entry point — Next.js `app/api/spa/bootstrap/route.ts:18-35` forwards browser auth headers and calls `loadBootstrapFromApi`. The function fans nine endpoints in parallel via `Promise.all` (`source-json.ts:263-283`); the new ninth call is `/v1/tenants`. Each `fetchJson` has its own try/catch (`source-json.ts:153-167`) so a single 5xx degrades to `null` — a transient tenant-list 500 must not blank the dashboard.

The projection at `source-json.ts:306-336` maps `TenantListItem[]` to `SpaTenant[]` (`apps/web/lib/spa/types.ts:50-58`). Archived rows are filtered out by default (`.filter((t) => !t.archivedAt)`, line 311). Current tenant is matched by `tenantList.viewer.tenantSlug === t.slug`; if no match the first row is set active (lines 322-326) so the switcher always has a selection. On total endpoint failure we fall back to `SAMPLE_TENANTS` (line 329) so the SPA keeps rendering.

The Tenants management view at `apps/web/public/portal/views/tenants.jsx:51-211` is the top-level entry. Its component name is the bare `Tenants` (line 51) per the global-scope convention in `CLAUDE.md` — every other internal component is prefixed `Tenants*` to avoid colliding with same-named symbols in other view files. The four modal components are siblings, not children: `TenantsCreateModal` (`tenants.jsx:324-596`), `TenantsEditModal` (`tenants.jsx:600-665`), `TenantsArchiveModal` (`tenants.jsx:669-731`), and `TenantsTokenRevealModal` (`tenants.jsx:735-795`). The token-reveal modal has the only one-way-confirmation flow in the surface: the close handler at line 750 short-circuits if the operator hasn't checked "I have stored this token securely" — they cannot dismiss the modal without acknowledging they've copied the plaintext.

The `TenantSwitcher` in `app.jsx:228-338` is the live rewrite. It receives `navigate` as a prop (line 228, threaded from the Sidebar at line 170), subscribes to two events at lines 232-240 (`agentic-tenants-updated` and `raas-data-loaded`), and forces a re-render on either. The "+ New tenant" CTA in the dropdown (lines 309-323) calls `navigate("tenants", { openCreate: true })`; the Tenants view at `tenants.jsx:56` reads `params.openCreate` to auto-open the wizard modal. The "Manage tenants" footer link at lines 324-333 navigates without `openCreate`. The empty-state branch at lines 242-259 handles the case where no tenants exist (effectively only possible for a brand-new install).

The `agentic-tenants-updated` `CustomEvent` is the cross-view refresh primitive. The Tenants view emits it on every successful mutation (`tenants.jsx:80-82`); the switcher's listener re-renders, and the App-level listener at `app.jsx:32-45` calls `window.RAAS_RELOAD(...)` which re-fans the bootstrap, refreshing `window.TENANTS` itself. The pattern keeps the Tenants view self-contained without prop-drilling a callback through every component.

## 11. Audit & observability

Every mutation writes exactly one `audit_log` row inside the same transaction as the state change. Action verbs:

- `tenant.create` — `routes/v1/tenants.ts:395-414`. Meta: `slug`, `name`, `starter`, `copy_from`, `mintToken`, `by_tenant` (caller's tenant slug), `seeded_event_types`.
- `tenant.update` — `routes/v1/tenants.ts:588-607`. Meta: `changed` (modified fields) and `before` (prior name/subtitle/color snapshot) so forensics can replay the field-level change.
- `tenant.archive` — `routes/v1/tenants.ts:672-687`. Meta: `slug`, operator-supplied `reason`, `by_tenant`.
- `tenant.restore` — `routes/v1/tenants.ts:734-749`. Same shape as archive.

Transactional placement matters: if the audit insert fails, the state change rolls back too. We never end up with state changes absent from the audit trail.

`actorUserId` is populated from the authenticated `req.auth.userId`. Tenant
creation also passes that same id into the transaction for the initial admin
membership. Bearer tokens without a user principal retain a null actor rather
than being falsely attributed to a bootstrap account; `by_tenant` remains
additional cross-tenant context in `metaJson`.

There is no separate tenant audit view; the global audit view filters by tenant. `targetType = "tenant"` plus `action LIKE 'tenant.%'` is the query for the per-tenant lifecycle report.

## 12. Performance posture

The list endpoint is the hot path — the SPA bootstrap re-fetches it on every mutation. The query helper at `queries/tenants.ts:46-166` runs **four** DB queries regardless of tenant count:

1. `SELECT … FROM tenants [INNER JOIN memberships] WHERE archived_at IS NULL ORDER BY created_at DESC` (`queries/tenants.ts:55-94`). One row per tenant.
2. `SELECT workflows.tenantId, COUNT(DISTINCT agents.id) FROM agents INNER JOIN workflows ON workflows.id = agents.workflowId WHERE workflows.tenantId IN (?) GROUP BY workflows.tenantId` (`queries/tenants.ts:101-110`).
3. `SELECT runs.tenantId, COUNT(*) FROM runs WHERE tenantId IN (?) AND startedAt >= since AND deletedAt IS NULL GROUP BY tenantId` (`queries/tenants.ts:115-129`).
4. `SELECT tasks.tenantId, COUNT(*) FROM tasks WHERE tenantId IN (?) AND status = 'open' AND deletedAt IS NULL GROUP BY tenantId` (`queries/tenants.ts:134-148`).

Each is one indexed-aggregation query against a `(tenant_id, …)` composite index already on the schema (`runs_tenant_started_idx`, `tasks_tenant_status_idx`). The result rows are joined client-side via three `Map<tenantId, count>` lookups at `queries/tenants.ts:152-165`. With ten tenants this is ~4 queries; with a thousand tenants it remains 4 queries.

The detail endpoint runs six small queries (`queries/tenants.ts:176-274`) — one row read plus five `COUNT(*)` aggregations plus one budget lookup. Each `COUNT(*)` hits a composite index. No N+1.

The `listActiveTenantSlugs()` helper at `queries/tenants.ts:329-337` is a one-column projection used by the runtime's tenant bootstrapping; it filters out archived tenants and the `__system` row in a single indexed scan. This is what causes archived tenants to disappear from the Inngest function list after a re-register.

## 13. Risks accepted (this milestone) and follow-ups

Items deliberately out of scope and tracked for follow-up:

- **Real RBAC enforcement.** `isPlatformAdmin()` at `plugins/auth.ts:136-138` returns `false`; routes accept any authenticated caller. Mitigation: `assertAuthModeSafe()` ensures production requires bearer tokens, which are tenant-scoped, so cross-tenant mutation requires a compromised admin token.
- **Cross-tenant code-agent registry collision (architect-review gap G4).** The in-memory `agentRegistry` from `packages/agents` is platform-global; two tenants registering `processResume` produce unique Inngest fn ids but share the same JS class. Deferred.
- **Per-tenant LLM keys (G5).** Provider keys remain platform-level. Phase-2 PRD item.
- **Tenant-code sandboxing (G3).** A tenant's uploaded TypeScript runs in the platform process. Deferred.
- **HITL `task.resolved` tenant filter.** Matcher filters by task id but not tenant id. Cross-trigger risk if task ids collide. Follow-up.
- **Slug uniqueness across archived rows.** `tenants_slug_uq` is global — archived `acme` blocks new `acme`. PRD documents the "clone-then-archive" workaround.
- **Hard-delete and retention sweeper.** Archived data lives indefinitely. PRD §11 phase-3.
- **Clone fidelity for code-agent tarballs.** `copy-from:<slug>` duplicates the manifest but does *not* deep-copy `data/tenants/<source>/<version>/`. The cloned tenant must redeploy.
- **`actorUserId` derivation is complete.** Audit rows use `req.auth.userId`; there is no bootstrap-user substitution.
- **No `HEAD /v1/tenants/:slug` slug probe.** Wizard uses regex+local-list validation; collisions surface as 409 on submit.

## 14. Testing strategy

What we would write before merging the milestone to main:

(a) **Vitest unit tests against `performCreate`** in `apps/api/test/`. The config uses `pool: "forks"` + `sequence.concurrent: false` because `data/agentic.db` is shared. Cases: baseline create writes seven inserts (tenant, budget, membership, two event_types, api_tokens, audit_log) — assert each by direct DB query; `slug_taken` flow returns 409 with no second tenant row; `copy_source_unknown` returns 400 with the transaction never opening (no audit row); a forced-failure inside the starter branch rolls everything back and the slug is re-claimable on retry.

(b) **Integration tests** against a running Fastify instance with `AUTH_MODE=dev` and `AGENTIC_DEV_TENANT=__system`. Walk the lifecycle: `POST /v1/tenants` with `starter: "hello"`, `GET /v1/tenants/:slug` and assert the seeded event types + budget row, `PUT` to change `name`, `DELETE` with matching `confirm`, `GET /v1/tenants?include_archived=1` and assert the row appears, `POST .../restore` and assert `archivedAt: null`. Each call produces one audit row.

(c) **Cross-tenant IDOR sweep.** Create tenants A and B with separate bearer tokens. From A's token, attempt `GET/PUT/DELETE/restore` against B. After RBAC lands (P5-TEN-02) these should return 403 or 404; for now assert current behavior and tag the tests `TODO-rbac`.

(d) **SPA smoke test** via Playwright or manual. Start `pnpm dev`, walk the wizard with a fresh slug, assert the token-reveal modal renders the plaintext, the "store securely" checkbox gates dismissal, the new tenant appears in the switcher without a page reload, the Tenants view shows the new row. Archive the tenant and assert it disappears from the default list and reappears under "Show archived".

(e) **Idempotency replay.** Send `POST /v1/tenants` twice with the same `Idempotency-Key`; assert response body byte-equals (including the plaintext token) and only one tenant row exists.

(f) **`assertAuthModeSafe` boot tests.** `AUTH_MODE=dev` + `NODE_ENV=production` → process exits; `AUTH_MODE=dev` + `AGENTIC_DEV_TENANT=nonexistent` → process exits; `AUTH_MODE=dev` + valid slug → warning banner logged once and the process accepts requests.

These six categories cover the load-bearing paths: the transaction's all-or-nothing guarantee, the lifecycle state machine, the cross-tenant isolation surface, the SPA-to-API integration, the idempotency contract, and the boot-time guard.
