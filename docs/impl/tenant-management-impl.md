# Tenant Management — Implementation Detail
*Companion to: PRD `docs/prd/agentic-operator-prd.md`, Design Spec `docs/design/tenant-management-design-spec.md`. Last updated 2026-05-20.*

Engineer-to-engineer walkthrough of P5-TEN-01. Narrates the code file by file.

## 1. What landed in this PR

Grouped by package. One line per file.

### `packages/contracts/`
- `packages/contracts/src/tenants.ts` (new, 217 lines) — Zod schemas + slug
  regex + reserved-slug set + `isReservedSlug()` helper. Single source of
  truth for both server enforcement and SPA preview.
- `packages/contracts/src/index.ts` — added `export * from "./tenants";`.

### `packages/db/`
- `packages/db/src/schema.ts` — `tenants` table grew two columns
  (`archivedAt`, `updatedAt`) and one index (`tenants_archived_at_idx`).
- `packages/db/drizzle/0011_tenant_lifecycle.sql` (new) — the migration. Bumps
  `_meta.schema_version` to `9`.
- `packages/db/drizzle/meta/_journal.json` — registered the new migration as
  idx 11, tag `0011_tenant_lifecycle`.

### `apps/api/`
- `apps/api/src/queries/tenants.ts` (new, 354 lines) — `listTenantsWithCounts`,
  `getTenantDetail`, `tenantSlugExists`, `tenantHasActiveWork`,
  `listActiveTenantSlugs`, `shapeTenantRow`.
- `apps/api/src/routes/v1/tenants.ts` (new, 769 lines) — six route handlers
  (GET list, GET detail, POST create, PUT update, DELETE archive, POST
  restore) + idempotency LRU + token mint helpers + `performCreate()`.
- `apps/api/src/server.ts` — added `tenantsRoutes` import and registration
  inside the `/v1` plugin (line 25 / line 124).
- `apps/api/src/plugins/auth.ts` — new `assertAuthModeSafe()` boot-time
  guard; called from `registerAuth()`.
- `apps/api/src/services/inngest-registry.ts` — `reregisterChain` promise-
  chain mutex around `reregisterInngest` (lines 102-124).

### `apps/web/`
- `apps/web/lib/spa/source-json.ts` — added `TenantRow` + `TenantListResponse`
  interfaces; the 9-way `Promise.all` now includes a fetch of `/v1/tenants`;
  mapping logic replaces the old `SAMPLE_TENANTS` constant when the API call
  succeeds.
- `apps/web/public/portal/views/tenants.jsx` (new, 886 lines) — the entire
  Tenants management view: table, 4-step create wizard, edit modal, archive
  modal with confirm-by-typing, one-shot token reveal modal, and layout
  primitives.
- `apps/web/public/portal/app.jsx` — `TenantSwitcher` now takes a `navigate`
  prop; new "+ New tenant" button and "Manage tenants" link in the dropdown;
  top-level `App` listens for `agentic-tenants-updated` and re-runs
  `RAAS_RELOAD`; added `view === "tenants" && <Tenants … />` route.
- `apps/web/public/portal/index.html` — new `<script type="text/babel"
  src="/portal/views/tenants.jsx">` tag, inserted between `deployments.jsx`
  and `settings.jsx`.

## 2. Build & run

Fresh-checkout verification:

1. **`nvm use`** — Node 26 from `.nvmrc`. `better-sqlite3` is built against
   Node 26's MODULE_VERSION; any other major crashes with `ERR_DLOPEN_FAILED`.
   See `[feedback_native_modules_in_nextjs.md]`.
2. **`pnpm install`** — `pnpm-workspace.yaml` allow-lists `better-sqlite3`
   for native build.
3. **`pnpm db:migrate`** — applies `0011_tenant_lifecycle.sql`. ALTER + CREATE
   INDEX + `_meta` UPDATE; non-destructive on an existing db.
4. **`pnpm db:seed`** — idempotent. Requires explicit
   `AGENTIC_BOOTSTRAP_ADMIN_EMAIL`, `AGENTIC_BOOTSTRAP_ADMIN_NAME`, and
   `AGENTIC_BOOTSTRAP_ADMIN_PASSWORD`; provisions exactly that one real
   superadmin and no sample identities.
5. **`pnpm dev`** — web :3599, api :3501, inngest :8288. Set `AUTH_MODE=dev`
   in `apps/api/.env.local` so unauthenticated browser requests resolve to
   the `AGENTIC_DEV_TENANT` tenant.
6. **Open `http://localhost:3599`** — click the tenant pill, then "+ New
   tenant" at the bottom of the dropdown. Walk through the 4-step wizard
   (Identity → Template → Quotas → Review). On submit, the token reveal
   modal opens.
7. **Verify**: `curl -H "Authorization: Bearer <token>" http://localhost:3501/v1/tenants`
   shows the new tenant in `items[]` with zero counts and `archivedAt: null`.

## 3. Database schema changes

The migration is short and surgical:

```sql
-- packages/db/drizzle/0011_tenant_lifecycle.sql
ALTER TABLE `tenants` ADD COLUMN `archived_at` integer;
--> statement-breakpoint
ALTER TABLE `tenants` ADD COLUMN `updated_at` integer
  DEFAULT (unixepoch() * 1000) NOT NULL;
--> statement-breakpoint
CREATE INDEX `tenants_archived_at_idx` ON `tenants` (`archived_at`);
--> statement-breakpoint
UPDATE `_meta` SET `value` = '9', `updated_at` = (unixepoch() * 1000)
  WHERE `key` = 'schema_version';
```

**Why `archivedAt` is nullable, not a status enum.** An enum
(`'active'|'archived'`) would have required a check constraint or join on
every query. A nullable timestamp gives free `WHERE archived_at IS NULL`
filtering and a built-in archived-at value for audit. Lifecycle docstring
at `packages/db/src/schema.ts:39-43`:

```ts
/** P5-TEN-01 — tenant lifecycle. Archived tenants are hidden from the
 * default list and have their Inngest functions de-registered, but rows
 * remain so audit trails and prior runs stay readable. Restore by setting
 * back to null. Hard-delete is a separate platform-admin operation. */
archivedAt: integer("archived_at", { mode: "timestamp_ms" }),
```

**Partial index.** SQLite uses `tenants_archived_at_idx` to skip archived
rows on every default-list query (`packages/db/src/schema.ts:53`):

```ts
archivedAtIdx: index("tenants_archived_at_idx").on(t.archivedAt),
```

**`_meta.schema_version` bump to 9.** The `_meta` table
(`packages/db/src/schema.ts:541-547`) lets the boot-time drift gate assert
"this DB has tenant lifecycle columns" without introspecting
`pragma table_info`.

**Backfill caveat.** `updated_at` is `NOT NULL DEFAULT (unixepoch() * 1000)`,
so SQLite seeds pre-existing rows with the migration's wall-clock time —
`updated_at = created_at` is **not** preserved. Run
`UPDATE tenants SET updated_at = created_at WHERE updated_at > created_at`
post-migration if you want honest "Updated 3m ago" labels. Not done by
default; mutations correct it quickly anyway.

## 4. Zod contracts

`packages/contracts/src/tenants.ts` owns every wire-format used by the
feature.

### `TENANT_SLUG_REGEX`

```ts
/** P5-TEN-01 — slug constraint shared between server validation and SPA preview. */
export const TENANT_SLUG_REGEX = /^[a-z][a-z0-9-]{1,31}$/;
```

Breakdown:
- `^[a-z]` — first char must be lowercase letter. Disallows leading digits,
  underscores, hyphens. System slugs use `_` prefix; URLs and Inngest fn
  ids choke on leading digits.
- `[a-z0-9-]{1,31}` — 1–31 lowercase alphanumeric + hyphen chars. Combined
  total length 2–32, matching `min(2).max(32)` in the body schema.
- Trailing hyphens slip through the regex; `isReservedSlug()` catches them
  (`packages/contracts/src/tenants.ts:212-217`).

### `RESERVED_TENANT_SLUGS`

| Slug | Reason it's reserved |
|------|----------------------|
| `__system` | The seed system tenant row that owns shared catalog rows. |
| `system`, `admin`, `root` | Operator-friendly names that could be mistaken for elevated permissions. |
| `api`, `v1`, `v2` | Collide with HTTP path prefixes. |
| `health`, `metrics`, `inngest` | Collide with unauthenticated routes. |
| `_meta` | Schema metadata table. |
| `static`, `public` | Common static-asset path roots. |
| `internal`, `platform` | Reserved for future platform-admin surface. |
| `tenants` | Would self-shadow `/v1/tenants/tenants`. |
| `new`, `edit`, `create`, `delete`, `archive` | SPA verbs that would conflict with route segments if we ever switch to `/tenants/:slug/edit`. |

### `Tenant`, `TenantListItem`, `TenantDetail`

```ts
export const Tenant = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  subtitle: z.string().nullable(),
  color: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  archivedAt: z.number().nullable(),
});

export const TenantListItem = Tenant.extend({
  agentCount: z.number(),
  runs24h: z.number(),
  openTasks: z.number(),
  membership: z.enum(["admin", "operator", "viewer"]).nullable(),
});

export const TenantDetail = Tenant.extend({
  agentCount: z.number(),
  runs24h: z.number(),
  openTasks: z.number(),
  workflowCount: z.number(),
  deploymentLiveCount: z.number(),
  membership: z.enum(["admin", "operator", "viewer"]).nullable(),
  budgets: z
    .object({
      monthlyTokenCap: z.number().nullable(),
      monthlyUsdCap: z.number().nullable(),
      usedTokensMonth: z.number(),
      usedUsdMonth: z.number(),
    })
    .nullable(),
});
```

`Tenant` is the canonical row. `TenantListItem` extends it with three
roll-up counts used by the sidebar switcher and the management table.
`TenantDetail` adds two more counts (`workflowCount`,
`deploymentLiveCount`) plus a nested `budgets` object — used by the
detail page and by the API's `POST /v1/tenants` 201 response body.

### `TenantCreateBody`

```ts
export const TenantCreateBody = z
  .object({
    slug: z.string().min(2).max(32).regex(TENANT_SLUG_REGEX, "..."),
    name: z.string().min(1).max(64),
    subtitle: z.string().max(128).optional(),
    color: z.string().regex(HEX_COLOR, "...").optional(),
    budget: z.object({
      monthlyTokenCap: z.number().int().nonnegative().nullable().optional(),
      monthlyUsdCap: z.number().int().nonnegative().nullable().optional(),
    }).optional(),
    starter: z
      .union([
        z.literal("empty"),
        z.literal("hello"),
        z.string().regex(/^copy-from:[a-z][a-z0-9-]{1,31}$/, "..."),
      ])
      .optional()
      .default("hello"),
    mintToken: z.boolean().optional().default(true),
  })
  .superRefine((val, ctx) => {
    if (RESERVED_TENANT_SLUGS.has(val.slug)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["slug"],
        message: `slug "${val.slug}" is reserved`,
      });
    }
  });
```

- **`.superRefine` for reserved slugs.** The regex accepts `admin`; the
  refine catches it. The route also calls `isReservedSlug()` explicitly so
  curl callers bypassing Zod still get a 400 `reserved_slug` instead of 500.
- **Union for `starter`.** Either `"empty"`, `"hello"`, or
  `copy-from:<slug>` where the suffix itself satisfies the slug regex.
  Defaults to `"hello"` because empty dashboards confuse demos.
- **Budget shape.** `monthlyUsdCap` is integer cents
  (`packages/contracts/src/tenants.ts:112`). The SPA wizard multiplies the
  dollar input by 100 before submit. Both fields are
  `.int().nonnegative().nullable()`; null means unlimited.

### `TenantUpdateBody`

```ts
export const TenantUpdateBody = z
  .object({
    name: z.string().min(1).max(64).optional(),
    subtitle: z.string().max(128).nullable().optional(),
    color: z.string().regex(HEX_COLOR).nullable().optional(),
  })
  .strict() // rejects unexpected fields including `slug`
  .refine(
    (val) =>
      val.name !== undefined ||
      val.subtitle !== undefined ||
      val.color !== undefined,
    { message: "at least one of name/subtitle/color is required" },
  );
```

`.strict()` is load-bearing: it rejects any field not in the allow-list,
including `slug`. Slugs are immutable because they're embedded in Inngest
function ids, log paths, and event channel names — renaming would orphan
every existing run row. `.refine` guards against empty-body PUTs that
would otherwise bump `updated_at` and write a no-op audit row.

### `TenantArchiveBody`

```ts
export const TenantArchiveBody = z.object({
  confirm: z.string(),
  reason: z.string().max(512).optional(),
});
```

`confirm` must equal the URL `:slug`. Check happens in the route handler
(`apps/api/src/routes/v1/tenants.ts:625-631`); Zod doesn't see URL params.
Same pattern as GitHub/Atlassian destructive ops.

## 5. API route walk-through

`apps/api/src/routes/v1/tenants.ts` is 769 lines but linear.

### 5.1 Imports

```ts
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { createHash } from "node:crypto";
// ...
import { dataTenantsRoot } from "@agentic/runtime";
```

`dataTenantsRoot()` (`packages/runtime/src/tenant-loader.ts:73`) returns
`AGENTIC_DATA_ROOT/tenants/` or the repo-relative default — same path
the runtime's tenant-loader and hot-reload watcher poll.
`crypto.randomBytes(32)` is the token-mint entropy source (256 bits;
overkill but free).

### 5.2 Idempotency LRU

```ts
const IDEMPOTENCY_TTL_MS = 60 * 60 * 1000;
const idempotencyCache = new Map<string, CachedResponse>();
```

Bounded at 256 entries, 1h TTL. Key is `${callerTenantSlug}:${idemKey}`
so two callers can't collide. The cached value is the **entire** response
envelope including the plaintext bootstrap token — deliberate. Without
that, a flaky network could mint a token, lose it to a 5xx, then mint a
*different* token on retry with no way to recover the first.

Eviction is FIFO by insertion order:

```ts
if (idempotencyCache.size >= 256) {
  const firstKey = idempotencyCache.keys().next().value;
  if (firstKey) idempotencyCache.delete(firstKey);
}
```

Defensive — not a hot path.

### 5.3 Authenticated operator identity

Tenant mutations use `requirePermission(...)` and pass `req.auth.userId`
directly into the transaction for audit attribution and initial membership.
The route never searches for, or substitutes, a bootstrap identity. A
non-user bearer principal is represented honestly with a null actor.

### 5.4 Token mint

```ts
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mintBootstrapToken(): { plaintext: string; hash: string } {
  const raw = crypto.randomBytes(32).toString("base64url");
  const plaintext = `agentic_${raw}`;
  return { plaintext, hash: hashToken(plaintext) };
}
```

`hashToken` is byte-for-byte identical to the auth plugin's hasher
(`apps/api/src/plugins/auth.ts:18-20`), so tokens minted here drop
straight into the bearer-lookup table. The `agentic_` prefix lets a
leaked token be grep'd from logs; base64url avoids `+`/`/` URL/shell
hazards.

### 5.5 `ensureTenantDirs()`

`mkdir -p` for `data/logs/<slug>/{runs,events}`, `data/artifacts/<slug>`,
and `dataTenantsRoot()/<slug>`. FS errors are caught and warned, **not**
thrown — a read-only filesystem must not roll back the DB transaction
(DB is the source of truth; writers re-create lazily on first use).

### 5.6 `HELLO_STARTER_EVENTS`

Two `event_types` rows (`TENANT_BOOTSTRAPPED` + `HELLO_WORLD`) seeded when
`starter === "hello"`, so a new tenant's dashboard isn't blank on first
load.

### 5.7 `performCreate()`

`apps/api/src/routes/v1/tenants.ts:202-462`. One `db.transaction(() => { … })`:

1. **Slug pre-check** (`tenantSlugExists`) → 409 before the transaction
   opens a write lock.
2. **`copy-from:<slug>` resolution** → 400 `copy_source_unknown` if the
   source isn't present.
3. **Inside the transaction**:
   - `INSERT INTO tenants` (id, slug, name, subtitle, color,
     `created_at = updated_at = now`).
   - `INSERT INTO tenant_budgets` (caps or NULL, counters zeroed,
     `period_start = now`).
   - `INSERT INTO memberships` `(operatorUserId, tenantId, 'admin')` with
     `.onConflictDoNothing` (the authenticated operator may already have a membership).
   - Starter:
     - `"hello"` → two `event_types` rows.
     - `copy-from:<slug>` → clones all `event_types`, `entity_types`, and
       the head workflow version of the source tenant. Workflow clone
       writes a new `workflows` row and a fresh `workflow_versions` row
       at `"1.0.0"`.
     - `"empty"` → no starter content.
   - `INSERT INTO api_tokens` when `mintToken`: scopes
     `['tenant:read','tenant:write','agents:invoke','runs:read']`. Only
     the SHA-256 is stored.
   - `INSERT INTO audit_log` `action: "tenant.create"` with full
     `metaJson` (slug, name, starter, copy-source, mintToken, by_tenant,
     `seeded_event_types`).
4. **After commit**:
   - `ensureTenantDirs(slug)` (best-effort).
   - `reregisterInngest({ scope: "tenant" })` (try/catch + warn; failed
     re-register does not 500).
   - `getTenantDetail(slug, …)` for the response.

Response shape matches `TenantCreateResponse`:
`{tenant, membership, token, starter, inngestFns}`.

### 5.8 The six route handlers

- **`GET /v1/tenants`** (lines 466-492). Reads `?include_archived=1|true`.
  Calls `listTenantsWithCounts` with `forUserId: null` until membership
  RBAC lands. Returns `{items, count, viewer}` where `viewer` carries the
  caller's `{tenantId, tenantSlug, userId}` so the SPA can mark the active
  row.
- **`GET /v1/tenants/:slug`** (lines 495-507). Re-checks the regex on the
  path param so `/v1/tenants/foo bar` returns 400 `invalid_slug` instead
  of a 404. Otherwise delegates to `getTenantDetail`.
- **`POST /v1/tenants`** (lines 510-557). Parses `TenantCreateBody`,
  double-checks `isReservedSlug`, consults idempotency cache, calls
  `performCreate`, caches the response. Error map uses `e.code` /
  `e.statusCode` on the thrown `Error`.
- **`PUT /v1/tenants/:slug`** (lines 560-615). `.strict()` rejects unknown
  fields including `slug`. 404 on unknown slug; otherwise updates the row
  and writes a `tenant.update` audit with a `meta.before` snapshot.
- **`DELETE /v1/tenants/:slug`** (lines 618-701). Confirms `body.confirm
  === slug`; rejects `__system` and reserved slugs; refuses when
  `tenantHasActiveWork` is nonzero. Sets `archived_at = now`, writes
  `tenant.archive` audit, re-registers Inngest so archived manifest fns
  drop.
- **`POST /v1/tenants/:slug/restore`** (lines 704-763). Inverse: sets
  `archived_at = null`, writes `tenant.restore` audit, re-registers
  Inngest, returns refreshed detail.

## 6. Queries (apps/api/src/queries/tenants.ts)

### `listTenantsWithCounts({ includeArchived, forUserId })`

Returns `TenantListItem[]`. Four queries, regardless of tenant count:

1. **`SELECT tenants`** — with optional `WHERE archived_at IS NULL` and
   optional `INNER JOIN memberships` when `forUserId` is set:
   ```ts
   .from(tenants)
   .innerJoin(memberships, eq(memberships.tenantId, tenants.id))
   .where(archivePred
     ? and(archivePred, eq(memberships.userId, opts.forUserId))
     : eq(memberships.userId, opts.forUserId))
   ```
2. **Agent count** — `COUNT(DISTINCT agents.id) FROM agents JOIN workflows
   GROUP BY workflows.tenant_id`.
3. **Runs/24h** — `COUNT(*) FROM runs WHERE tenant_id IN(...) AND
   started_at >= since AND deleted_at IS NULL GROUP BY tenant_id`.
4. **Open tasks** — `COUNT(*) FROM tasks WHERE status='open' AND
   deleted_at IS NULL GROUP BY tenant_id`.

Results are joined client-side via three `Map<tenantId, number>`s. Exactly
four round-trips regardless of tenant count — the sidebar switcher calls
this on every page nav, so avoiding the N+1 mattered.

### `getTenantDetail()`

Six queries; no batching needed (single tenant): `SELECT tenants`, agent
count, runs/24h, open tasks, workflow count, live-deployment count, and
budgets. Optional membership lookup when `forUserId` is set. Returns
`null` for unknown slug → 404 `tenant_not_found` in the route.

### `tenantSlugExists()`

Single `SELECT id` on `slug`. Used by `performCreate` as the 409 pre-check.

### `tenantHasActiveWork()`

Returns `{runs, tasks}`. Counts non-terminal runs (`['queued','running','waiting']`)
and `tasks.status='open'`. DELETE handler refuses archive when either is
nonzero → 409 `has_active_work`.

### `listActiveTenantSlugs()`

```ts
db.select({ slug: tenants.slug }).from(tenants)
  .where(and(isNull(tenants.archivedAt), ne(tenants.slug, "__system")))
  .all().map((r) => r.slug);
```

Helper for the runtime tenant-loader. Excludes `__system` (no user
workflows there).

### `shapeTenantRow()`

Drizzle row → `Tenant` shape. Collapses `Date` to `epoch_ms` and
`undefined` to `null`.

## 7. SPA implementation

### 7.1 `lib/spa/source-json.ts`

Two new interfaces describe the endpoint:

```ts
interface TenantRow {
  id: string; slug: string; name: string;
  subtitle: string | null; color: string | null;
  createdAt: number; updatedAt: number;
  archivedAt: number | null;
  agentCount: number; runs24h: number; openTasks: number;
  membership: "admin" | "operator" | "viewer" | null;
}

interface TenantListResponse {
  items: TenantRow[];
  count: number;
  viewer?: { tenantId?: string; tenantSlug?: string; userId?: string | null };
}
```

The bootstrap `Promise.all` grew from 8 to 9 calls
(`apps/web/lib/spa/source-json.ts:263-283`); each `fetchJson` has its
own try/catch so a single 5xx doesn't poison the bootstrap. The mapping
block at lines 309-336:

```ts
if (tenantList && Array.isArray(tenantList.items)) {
  const active = tenantList.items.filter((t) => !t.archivedAt);
  const currentSlug = tenantList.viewer?.tenantSlug;
  tenants = active.map((t) => ({
    id: t.slug, name: t.name,
    subtitle: t.subtitle ?? "", color: t.color ?? "#6f7178",
    active: currentSlug ? t.slug === currentSlug : false,
    agentCount: t.agentCount, runs24h: t.runs24h,
  }));
  if (tenants.length > 0 && !tenants.some((t) => t.active)) {
    tenants[0]!.active = true;
  }
} else {
  // Full API outage: fall back to SAMPLE_TENANTS.
}
```

`SAMPLE_TENANTS` only fires when the fetch returns `null`. Empty
`items: []` is a valid live response — a fresh dev tenant should see zero
rows, not stub data.

### 7.2 `views/tenants.jsx`

Component tree:

```
Tenants                       ← top-level, named bare to match the route
├─ TenantsTable
│  └─ TenantsRow              ← one per tenant
├─ TenantsCreateModal         ← 4-step wizard
├─ TenantsEditModal
├─ TenantsArchiveModal        ← confirm-by-slug
├─ TenantsTokenRevealModal    ← one-shot reveal
└─ Layout primitives:
   ├─ TenantsModalShell
   ├─ TenantsField
   ├─ TenantsRadioRow
   └─ TenantsKv
+ tenantsApi() helper at module scope
```

The `Tenants*` prefix on every internal component is the convention from
project `CLAUDE.md`: `<script type="text/babel">` does not module-isolate,
so a bare `function Row` here would shadow any same-named function in
another view loaded later.

**`Tenants`** (top-level, lines 51-211). Holds the list, loading flag,
error, `includeArchived` toggle, and the four modal targets. Refreshes
via `tenantsApi('/v1/tenants?include_archived=1')` and broadcasts
`agentic-tenants-updated` after every mutation so the sidebar switcher
can refetch.

```jsx
const notify = (kind, payload) => {
  window.dispatchEvent(new CustomEvent("agentic-tenants-updated",
    { detail: { kind, payload } }));
};
```

**`TenantsTable` / `TenantsRow`** (213-320). Pure CSS-Grid. Archived rows
collapse to `opacity: 0.55` and swap Edit/Archive for a single Restore
button. Numeric cells use monospace for scannability.

```jsx
<div style={{ display: "grid",
  gridTemplateColumns: "32px 1.2fr 1.4fr 80px 80px 80px 1fr 160px",
  gap: 12, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
```

**`TenantsCreateModal`** (324-596). The 4-step wizard. Step 1 (Identity)
auto-derives the slug as you type the display name; manual override sets
`slugDirty` and locks the auto-derive. Step 2 (Template) is three radio
rows (`empty` / `hello` / `copy-from`) with a conditional source-tenant
`<select>`. Step 3 (Quotas) collects monthly token + USD caps (×100 on
submit). Step 4 (Review) renders a `TenantsKv` list of every value. The
idempotency key is `ten-<slug>-<base36 timestamp>` — unique per click:

```jsx
const idemKey = `ten-${slug}-${Date.now().toString(36)}`;
const created = await tenantsApi("/v1/tenants", {
  method: "POST", body, idempotencyKey: idemKey,
});
```

**`TenantsEditModal`** (600-665). `PUT /v1/tenants/:slug` with
`{name, subtitle: subtitle || null, color}`. Null-coalesce on subtitle
mirrors Zod `.nullable()` so clearing the field actually clears it.

```jsx
await tenantsApi(`/v1/tenants/${target.slug}`, {
  method: "PUT",
  body: { name, subtitle: subtitle || null, color },
});
```

**`TenantsArchiveModal`** (669-731). Confirm field that must equal the
slug (Archive button is disabled otherwise) plus an optional free-text
reason logged in `audit_log.meta.reason`:

```jsx
<Button tone="danger" onClick={submit}
  disabled={submitting || confirm !== target.slug}>
  {submitting ? "Archiving…" : "Archive"}
</Button>
```

**`TenantsTokenRevealModal`** (735-795). Renders the plaintext token once,
in a monospace box with a Copy button. Dismiss is disabled until the
operator ticks the "I have stored this token securely" checkbox:

```jsx
<label>
  <input type="checkbox" checked={acked}
    onChange={(e) => setAcked(e.target.checked)} />
  I have stored this token securely
</label>
<Button tone="primary" disabled={!acked} onClick={onClose}>Dismiss</Button>
```

**`TenantsModalShell`** (799-830) — scrim + title bar + body + footer.
**`TenantsField`** (832-841) — label/hint/error layout. **`TenantsRadioRow`**
(843-864) — clickable radio card used by the Template step. **`TenantsKv`**
(866-873) — two-column key/value renderer.

**`tenantsApi()`** (28-49) — fetch wrapper. Adds JSON headers + optional
`idempotency-key`, parses the envelope, throws on `!res.ok || body.ok
=== false` with `e.code` / `e.status` attached.

### 7.3 `app.jsx` changes

Three additions:

- **`TenantSwitcher` prop**: now takes `navigate` so the dropdown can
  jump straight to the Tenants view. The fallback when there are zero
  tenants opens the create wizard via `navigate("tenants",
  { openCreate: true })` (line 246).
- **`+ New tenant` button** at the bottom of the dropdown (lines
  309-323) — emits `navigate("tenants", { openCreate: true })`. The
  `Tenants` view reads `params.openCreate` and sets `createOpen` true on
  first render (`tenants.jsx:56`).
- **`Manage tenants` link** below the new-tenant row (lines 324-333) —
  emits `navigate("tenants")` (no params, so the wizard does not auto-
  open).
- **`agentic-tenants-updated` event listener** at the top of `App`
  (lines 32-45). When fired, it calls `window.RAAS_RELOAD(...)` to
  re-run the SPA bootstrap, then bumps `tenantsRev` so React knows to
  re-render. The TenantSwitcher (lines 232-240) subscribes separately so
  its dropdown reflects the new list even if it isn't mounted under the
  active view.
- **`view === "tenants"` route** (line 98): `<Tenants navigate={navigate}
  params={params} />`.

### 7.4 `index.html` script tag

```html
<script type="text/babel" src="/portal/views/deployments.jsx"></script>
<script type="text/babel" src="/portal/views/tenants.jsx"></script>  <!-- new -->
<script type="text/babel" src="/portal/views/settings.jsx"></script>
```

Order matters because Babel-standalone evaluates each `<script
type="text/babel">` in document order and registers the result in the
shared global scope. `tenants.jsx` only depends on `components.jsx`
(which loads first), so any position after `components.jsx` would have
worked — between `deployments.jsx` and `settings.jsx` keeps the Manage
group together.

## 8. Auth & ops hardening

Two small but important boot-time guards landed alongside the route.

**`assertAuthModeSafe()`** (`apps/api/src/plugins/auth.ts:78-103`). Two
checks, run inside `registerAuth()` before the `onRequest` hook is
installed:

1. If `AUTH_MODE=dev` AND `NODE_ENV=production`, throw and refuse to
   start. This combination would make every unauthenticated request
   resolve to the `AGENTIC_DEV_TENANT` admin context — fine for local
   work, catastrophic in prod. The error message names the two env
   vars and the two valid resolutions.
2. If `AUTH_MODE=dev` AND the `AGENTIC_DEV_TENANT` slug does not exist
   in the `tenants` table, throw. Refuses to start with a "phantom dev
   tenant" because every unauth request would 401 in confusing ways
   otherwise.

Both throws fire from inside `registerAuth`, which is awaited from
`build()` in `server.ts`. A failing assertion exits the process with
the thrown stack trace before `app.listen()` runs.

When `AUTH_MODE=dev` is set but the env is otherwise fine, the function
also emits a loud `console.warn` on every boot so the operator can't
miss it.

**`reregisterInngest` mutex** (`apps/api/src/services/inngest-registry.ts:96-124`).
Two concurrent callers used to clobber each other: a workflow PUT racing a
tenant POST would have `state.fns.tenant` overwritten by whichever
`rebuildTenantFns()` completed second, dropping the other's work. The fix
is a tail promise that serializes all rebuilds:

```ts
let reregisterChain: Promise<unknown> = Promise.resolve();

export async function reregisterInngest(opts: {...}) {
  const next = reregisterChain.then(() => _reregisterImpl(opts));
  // Swallow errors on the chain so one failed re-register doesn't poison
  // every future call. Callers still see the rejection on their own promise.
  reregisterChain = next.catch(() => undefined);
  return next;
}
```

Two notes:

- The chain swallows errors (`.catch(() => undefined)`) so a single
  failed rebuild doesn't permanently block every subsequent re-register.
  The *caller's* promise (`next`) still rejects with the original error;
  only the internal chain is sanitized.
- The current implementation always re-runs `rebuildTenantFns()` for the
  full tenant set; `opts.tenantSlug` is currently a hint, not a scoping
  parameter. Section 11 captures this as known limitation.

## 9. Errors and status codes

| Code | Status | Trigger |
|------|--------|---------|
| `invalid_input` | 400 | Zod parse failure on any body (envelope plugin) |
| `invalid_slug` | 400 | Malformed slug on `GET /v1/tenants/:slug` (regex check before DB hit) |
| `reserved_slug` | 400 | `isReservedSlug(body.slug)` returns true on `POST /v1/tenants` |
| `confirm_mismatch` | 400 | `body.confirm !== params.slug` on `DELETE /v1/tenants/:slug` |
| `cannot_archive_system` | 400 | Archive attempt on `__system` or any reserved slug |
| `copy_source_unknown` | 400 | `starter: "copy-from:<slug>"` where `<slug>` is not in `tenants` |
| `tenant_not_found` | 404 | `GET`/`PUT`/`DELETE`/`POST /restore` by unknown slug |
| `slug_taken` | 409 | `tenantSlugExists(body.slug)` true on `POST` |
| `already_archived` | 409 | `DELETE` on a row where `archived_at IS NOT NULL` |
| `not_archived` | 409 | `POST /restore` on a row where `archived_at IS NULL` |
| `has_active_work` | 409 | `tenantHasActiveWork()` returns nonzero `runs` or `tasks` on `DELETE` |
| `unauthorized` | 401 | `requireAuth` finds no `req.auth` (no bearer + `AUTH_MODE` not `dev`) |

All codes are emitted via the envelope plugin's `reply.fail(code,
message, status)` and surface to the SPA as
`{ok: false, error: {code, message}}`.

## 10. Test plan

Concrete tests to add next, ordered by yield. Each lives under
`apps/api/test/` and shares the `apps/api/test/setup.ts` SQLite bootstrap.

### `apps/api/test/tc-70-tenants-crud.test.ts`
- `POST /v1/tenants {slug:"acme",name:"Acme",starter:"hello"}` → 201
  with `data.token.plaintext` matching `/^agentic_/`.
- `POST` same body again → 409 `slug_taken`.
- `GET /v1/tenants` → `items` includes `{slug:"acme"}`,
  `agentCount === 0`, `runs24h === 0`.
- `PUT /v1/tenants/acme {name:"Acme Inc."}` → 200, name updated.
- `PUT /v1/tenants/acme {slug:"acme-new"}` → 400 `invalid_input` (slug
  is rejected by `.strict()`).
- `DELETE /v1/tenants/acme {confirm:"wrong"}` → 400 `confirm_mismatch`.
- `DELETE /v1/tenants/acme {confirm:"acme"}` → 200, `archived_at` set.
- `GET /v1/tenants` → does NOT include `acme`.
- `GET /v1/tenants?include_archived=1` → DOES include `acme` with
  `archivedAt` non-null.
- `POST /v1/tenants/acme/restore` → 200, `archived_at` back to null.
- `POST /v1/tenants {slug:"admin"}` → 400 `reserved_slug`.
- `POST /v1/tenants {slug:"acme",starter:"copy-from:nonexistent"}` →
  400 `copy_source_unknown`.

### `apps/api/test/tc-71-tenants-idempotency.test.ts`
- `POST /v1/tenants` with `Idempotency-Key: K1` → 201 with token T1.
- `POST /v1/tenants` with the same body and `Idempotency-Key: K1` → 201,
  EXACT same response body, same plaintext T1, no second row in DB.
- `POST /v1/tenants` with a different body and `Idempotency-Key: K1` →
  still returns the original T1 response (key wins; body is ignored
  on cache hit — that's the GitHub-style contract).
- Same key from a different caller tenant (different bearer token) →
  treated as distinct cache entry; new row created.

### `apps/api/test/tc-62-tenants-isolation.test.ts`
- Token for tenant A cannot read tenant B's `/v1/tenants/B` detail
  beyond what `listTenantsWithCounts` chooses to expose. (Currently
  every authenticated caller can see all tenants — once RBAC lands,
  this test tightens.)
- Membership filter: when `forUserId` is supplied, only tenants where a
  membership row exists return.
- IDOR sweep: `GET /v1/tenants/__system` from a non-system tenant must
  not leak the system tenant's `usedTokensMonth` budget.

### `apps/api/test/tc-63-auth-mode-guard.test.ts`
- Set `AUTH_MODE=dev` + `NODE_ENV=production` → `build()` throws with
  `[auth] refusing to start: AUTH_MODE=dev is incompatible with
  NODE_ENV=production`.
- Set `AUTH_MODE=dev` + `AGENTIC_DEV_TENANT=does-not-exist` →
  `build()` throws with `requires AGENTIC_DEV_TENANT to match an
  existing tenant slug`.
- Set neither → boots silently, no warn.
- Set `AUTH_MODE=dev` + valid slug + `NODE_ENV=development` → boots,
  emits a single console.warn.

## 11. Open issues / known limitations

- **Actor attribution is principal-derived.** User sessions populate
  `req.auth.userId`; non-user bearer principals remain null instead of being
  attributed to an unrelated bootstrap administrator.
- **Inngest re-register rebuilds ALL tenants.** `reregisterInngest`
  accepts `tenantSlug` but currently re-runs `rebuildTenantFns()` for
  every active tenant on every call. At small tenant counts this is
  negligible; at hundreds of tenants the rebuild walks every
  `data/tenants/<slug>/<version>/agentic.json`. The scoping parameter is
  plumbed; the implementation just needs an early-return path that
  refreshes only the named slug's functions and splices them into
  `state.fns.tenant`.
- **SPA mutates `window.TENANTS` globally.** The bootstrap loader writes
  the tenant list to a top-level global instead of a React context.
  Mutations broadcast `agentic-tenants-updated`; the App component
  responds by re-running `RAAS_RELOAD()` to refresh the global. This
  works but couples every consumer (sidebar, dashboard, tenant switcher)
  to the same global write-through. A future refactor should move this
  to a `TenantContext.Provider` so React re-renders are driven by
  context value, not a hand-rolled custom event.
- **Membership-filter list is opt-in only.** `GET /v1/tenants` currently
  passes `forUserId: null`, returning every tenant to any authenticated
  caller. Once RBAC lands the route must compute `forUserId` from
  `req.auth.userId` for non-platform-admin callers.
- **`updated_at` backfill.** As called out in section 3, rows that existed
  before the migration have `updated_at` equal to the migration's
  wall-clock time, not their original `created_at`. The "Updated" column
  in the SPA shows these as "Updated just now" until the next mutation
  rewrites the timestamp.
- **Hard-delete is not exposed.** Soft-archive sets `archived_at`; there
  is no UI or route for hard-delete. Cascade is wired on every FK
  referencing `tenants(id)` so a future `DELETE FROM tenants WHERE
  id=?` will clean up cleanly, but the operator must shell into the
  database to do it.

## 12. Rollback plan

If something breaks in production, the change set is small and unwinds
cleanly.

**Migration rollback.** `0011_tenant_lifecycle.sql` is reversible by
hand:

```sql
DROP INDEX IF EXISTS tenants_archived_at_idx;
ALTER TABLE tenants DROP COLUMN updated_at;
ALTER TABLE tenants DROP COLUMN archived_at;
UPDATE _meta SET value = '8', updated_at = (unixepoch() * 1000)
  WHERE key = 'schema_version';
```

SQLite supports `DROP COLUMN` natively as of 3.35. After the down-migration,
the old binary still reads the table — `Tenant` no longer parses (it
expects `archived_at` / `updated_at`), but contracts can be temporarily
loosened with `.optional()` while a fix ships.

**Route rollback.** `apps/api/src/routes/v1/tenants.ts` is self-contained.
Remove the file, drop the import + registration in `apps/api/src/server.ts`
(lines 25 + 124), and the `/v1/tenants` surface disappears. The auth
plugin's `assertAuthModeSafe()` is also independent — remove the call
from `registerAuth()` to revert the boot-time guard.

**SPA rollback.** Three reverts:
1. Delete `apps/web/public/portal/views/tenants.jsx`.
2. Remove the `<script>` tag from `apps/web/public/portal/index.html`.
3. Revert the additions to `app.jsx` (new-tenant button, Manage link,
   `agentic-tenants-updated` listener, route line) and to
   `apps/web/lib/spa/source-json.ts` (the 9th fetch + the mapping
   block). The fallback `SAMPLE_TENANTS` constant is still in place,
   so the SPA degrades to the legacy stub list without any further
   code change.

Because the migration is additive and the route is namespaced under
`/v1/tenants` with no cross-references from other handlers, rolling
back the route alone (keeping the columns) is also safe — the columns
just remain unused.

— end of document.
