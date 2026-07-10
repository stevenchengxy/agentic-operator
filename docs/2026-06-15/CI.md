# CI/CD operations

This document covers what runs on every push/PR, what passes are required
for merge, and how to skip CI for genuinely cosmetic changes.

It is the operational counterpart of `docs/IMPLEMENTATION.md §8.4` (which
describes the *what* and *why*); this file is the *how*.

---

## 1. Workflows

Two workflow files in `.github/workflows/`:

| File | Trigger | What it does |
|---|---|---|
| `ci.yml` | every push to `main` + every PR targeting `main` + manual dispatch | Typecheck · lint · unit tests with coverage gate · build · Playwright E2E · Docker buildx smoke. |
| `release.yml` | tag push matching `v*.*.*` + manual dispatch | Re-runs tests on the tagged sha, builds + pushes multi-arch Docker images to the configured registry, drafts a GitHub Release. |

### 1.1 Job layout

```
ci.yml
├─ install         (cache pnpm store)
├─ typecheck       (pnpm -r typecheck)
├─ lint            (pnpm -r lint)
├─ test-coverage   (pnpm -r test:coverage, gate at 70%/60%)
├─ build           (pnpm -r build)
├─ e2e             (Playwright; boots dev stack via PW_AUTO_WEBSERVER=1)
├─ docker          (BuildKit smoke; skips if Dockerfile absent)
└─ ci              (meta gate — green only when all of the above are green)
```

`typecheck`, `lint`, `test-coverage`, `build`, `e2e`, and `docker` run in
parallel after `install`. The `ci` meta job sequences after all of them
and fails if any leaf failed — that's the *single* check you wire into
branch protection (see §3).

### 1.2 Pinned versions

- **Node 26** (matches `.nvmrc`). The native `better-sqlite3` binding is
  compiled per Node major; mismatches surface as `ERR_DLOPEN_FAILED` at
  test boot. Bumping requires regenerating the binding in a dedicated PR.
- **pnpm 11.1.2** (matches `package.json#packageManager`). Pinned because
  pnpm 12 changed `pnpm-workspace.yaml` interpretation in a non-back-
  compatible way around isolated module resolution.

---

## 2. Coverage gate

Each app workspace runs `pnpm test:coverage` which invokes Vitest's v8
coverage provider. Thresholds are encoded per-workspace in
`vitest.config.ts`:

| Workspace | Lines | Branches | Functions | Statements |
|---|---|---|---|---|
| `@agentic/api` | 70 % | 60 % | 60 % | 70 % |
| `@agentic/web` | 70 % | 60 % | 60 % | 70 % |
| `@agentic/cli` | 70 % | 60 % | 60 % | 70 % |

Scope notes:

- **api**: the gate covers `src/services`, `src/queries`,
  `src/plugins/{auth,error,audit}`, `src/routes/v1/**`, and
  `src/routes/{health,metrics}`. Excluded: the server entrypoint
  (`src/server.ts`), env-config defaults under `src/config/`, one-shot
  dev scripts, and the inngest webhook plugin (its body fires only when
  the live inngest dev runner is in the loop). `src/routes/v1/usage.ts`
  is currently excluded — see the inline comment in `vitest.config.ts`
  for the follow-up tracking the missing `server.ts` registration.
- **web**: scope intentionally narrow — pure helpers with a unit-test
  seam. TanStack Query hooks and React effects are exercised end-to-end
  via Playwright (P4-TEST-04 / P4-TEST-05); the unit gate would only
  reward mocking the browser globals out.
- **cli**: `src/**`. The CLI threads stdin/stdout/stderr through ctx so
  every code path is reachable without a subprocess.

### 2.1 Validating coverage locally

```bash
nvm use                        # picks up .nvmrc (26)
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm -r test:coverage
```

Each workspace prints a v8 summary table and emits `coverage/lcov.info`
+ `coverage/coverage-summary.json`. Open
`apps/<workspace>/coverage/lcov-report/index.html` for the drilldown.

### 2.2 Behaviour when a threshold is missed

Vitest exits non-zero on the offending workspace. Turbo propagates the
non-zero exit code via `pnpm -r test:coverage`. CI surfaces this as a
failed `test-coverage` job which fails the meta `ci` gate which blocks
merge.

To recover: open the report, add tests for the lowest-coverage files
(or shrink the include glob if the missed file isn't business-relevant —
but document the exclusion inline).

---

## 3. Required branch-protection rules for `main`

Under **Settings → Branches → Branch protection rules → main**:

| Rule | Setting |
|---|---|
| Require a pull request before merging | ✅ |
| Require approvals | ✅ (1) |
| Dismiss stale pull request approvals when new commits are pushed | ✅ |
| Require status checks to pass before merging | ✅ |
| Require branches to be up to date before merging | ✅ |
| Required status checks | **`CI`** (single, from `ci.yml`'s meta job) |
| Require linear history | ✅ (squash or rebase merges only) |
| Require conversation resolution before merging | ✅ |
| Do not allow bypassing the above settings | ✅ |
| Restrict who can push to matching branches | optional — start permissive |

Only the meta `CI` check is required because it depends on every other
leaf. Adding a new job to `ci.yml` doesn't require updating branch
protection — just add the new job name to the `needs:` list of the meta
`ci:` job at the bottom of the file.

### 3.1 Tag-push protection

Tag pushes don't go through PR review, so the `release.yml` workflow's
first job re-runs the full test + coverage suite on the tagged sha.
Catches the "released the wrong sha" foot-gun (someone tags an
out-of-date branch) without requiring a separate gate.

---

## 4. Skipping CI for docs-only changes

CI rebuilds the entire stack and runs the full test matrix on every
push, which is overkill for changes that don't touch code. Two ways to
short-circuit, in order of preference:

### 4.1 Recommended — `[skip ci]` in the commit subject

Append `[skip ci]` (or the equivalent `[ci skip]`, `[no ci]`,
`[skip actions]`) to the commit subject:

```
docs: clarify env var contract in USER_GUIDE [skip ci]
```

GitHub Actions honours these prefixes on push events. PRs ignore them
(by design — the PR check is a contract with reviewers, not the author).

### 4.2 Best-effort — `paths-ignore` in workflow trigger

We deliberately do NOT use `paths-ignore` in `ci.yml`. Reasoning: a
"docs-only" PR can still break the docs build (CSP example links, Mermaid
diagrams, dead anchors); fully skipping CI hides those. If you want to
skip the heavy jobs but keep a docs-lint pass, add a `docs.yml` workflow
in the future rather than weakening this one.

### 4.3 Force-rerun a flaky check

In the PR's `Checks` tab, find the failed check and click **Re-run**.
Tests are independent per workspace; the SQLite handle race that used to
cause sporadic flakes in `apps/api` is fixed by `pool: "forks"` +
`sequence: { concurrent: false }` in `vitest.config.ts`. If you see
sustained flakiness, file an issue and tag with `flake` — don't normalize
re-runs.

---

## 5. Release process

1. From `main`, ensure the version in `package.json` is bumped and a
   `CHANGELOG.md` entry exists for the upcoming tag.
2. Push a tag:

   ```bash
   git tag -a v1.0.0 -m "v1.0.0 — first GA"
   git push origin v1.0.0
   ```

3. `release.yml` fires:
   - re-runs tests + coverage on the tagged sha,
   - builds linux/amd64 + linux/arm64 images for `apps-api`, `apps-web`,
     and (when present) `apps-inngest-worker`,
   - pushes to `${REGISTRY}/${IMAGE_PREFIX}-<service>:${tag}` and `:latest`,
   - drafts a GitHub Release with auto-generated notes.

4. Review the draft Release, polish notes, publish.

### 5.1 Filling in the registry placeholder

`release.yml` ships with `REGISTRY: ghcr.io/PLACEHOLDER` for two reasons:
the org-level path depends on where you fork to, and GHCR's namespace
must match the GitHub org/user. Before the first release cut:

1. Replace `ghcr.io/PLACEHOLDER` in `release.yml#env.REGISTRY` with your
   org's namespace (e.g. `ghcr.io/anthropic`, `123456789.dkr.ecr.us-east-1.amazonaws.com/agentic`).
2. If the target isn't GHCR (e.g. ECR / GAR / Docker Hub), swap the
   `docker/login-action@v3` step for the appropriate auth action and
   supply the corresponding secrets (`AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`
   for ECR, etc.).

---

## 6. Local CI parity

Reproduce a failure locally with the same env CI uses:

```bash
nvm use                                    # Node 26
export AGENTIC_DEV_TENANT=raas             # what the e2e job sets
export LLM_DEFAULT_PROVIDER=mock
export LLM_DEFAULT_MODEL=mock-model-v1
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm db:seed
pnpm seed:rich
pnpm -r typecheck
pnpm -r lint
pnpm -r test:coverage
pnpm -r build
```

For E2E, in one terminal:

```bash
pnpm dev   # boots api :3501 + web :3599 + inngest :8288
```

In another:

```bash
pnpm --filter @agentic/web exec playwright install chromium
pnpm --filter @agentic/web test:e2e
```

Or, mirroring CI exactly (Playwright boots the stack itself):

```bash
PW_AUTO_WEBSERVER=1 pnpm --filter @agentic/web test:e2e
```

---

## 7. Validating workflow YAML

Use `actionlint` (preferred) or `act`:

```bash
brew install actionlint
actionlint .github/workflows/ci.yml .github/workflows/release.yml
```

`actionlint` catches: invalid `${{ }}` expressions, undefined jobs in
`needs:`, missing `runs-on`, incorrect step keys.

Running the workflow locally with `act` is slower and less reliable
(the `pnpm/action-setup@v4` step requires a node-shim) — prefer
`actionlint` for static validation and trust the runner for execution
semantics.
