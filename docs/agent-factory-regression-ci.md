# Agent Factory promoted-regression CI gate

Every successful Factory promotion is now part of the main/release gate. The
gate does not infer evidence from a developer checkout and does not accept a
manually supplied Actions run id.

## Promotion ledger and production provenance

Promotion writes durable evidence under
`$AGENTIC_DATA_ROOT/factory-regression-promotions`:

- `pending/*.json` is created before the production manifest commit.
- `committed/*.json` is finalized with the exact production `deploymentId`.
- `high-watermark.json` is an append-only checkpoint. It records the previous
  checkpoint hash plus the one newly appended promotion/record hash; finalize
  accepts exactly `count + 1` and validates the old checkpoint before advancing.
- every promoted production agent carries its immutable Factory `versionId`
  and regression-suite fingerprint in the live workflow manifest.

The pending record is deliberately retained if production commits but ledger
finalization does not complete. Export and CI then fail closed. A promotion
completed before this ledger/provenance contract is also rejected as
pre-ledger evidence; it is never silently reconstructed from a current prompt
or manifest.

Each draft version snapshots its exact tool cassettes below its immutable
version directory. The regression artifact uses relative, content-addressed
paths. New promotions reject legacy absolute cassette paths.

## Trusted live exporter

[`.github/workflows/factory-regression-export.yml`](../.github/workflows/factory-regression-export.yml)
runs for every push to `main` on an access-controlled runner labelled
`agentic-production-evidence`. It reads two production evidence sources:

- the read-only live deployment inventory in the Agentic database;
- the persistent Agentic data root containing the promotion ledger and exact
  immutable regression artifacts.

The exporter reconciles all three views before copying data:

1. every committed ledger record is anchored to its exact production
   deployment and manifest;
2. every current live Factory-origin agent is covered by a committed record
   with the same tenant, domain, slug, version and suite fingerprint;
3. the committed inventory exactly matches the ledger high-watermark, with no
   pending, corrupt, omitted or extra record;
4. every live or rolled-back deployment whose note starts
   `agent-factory-promotion:` has exactly one matching committed record. A
   deleted historical record cannot be ratified by writing a smaller checkpoint.

It produces a short-lived private artifact named
`agent-factory-promoted-regressions-<commit-sha>`. The bundle includes only the
required immutable versions, exact referenced binary fixtures, committed
ledger, high-watermark and reconciled inventory. A manifest hashes every file
and HMAC-signs the source repository, exporter workflow, event, ref, commit,
exporter run id/attempt, requesting consumer workflow/run/attempt, a fresh
consumer nonce, expiry, inventory and ledger high-watermark. The exporter reads
the ledger and deployment database again after copying and refuses to sign if
either view changed during the copy.

The production environment must configure:

- variable `AGENTIC_FACTORY_PRODUCTION_DATA_ROOT`;
- variable `AGENTIC_FACTORY_PRODUCTION_DATABASE_URL`;
- secret `FACTORY_REGRESSION_EXPORT_SIGNING_KEY` (at least 32 bytes);
- a self-hosted runner with the `agentic-production-evidence` label and
  read-only access to the matching database/data snapshot.

The exporter sets `AGENTIC_DATABASE_READONLY=1`. That opens SQLite with
`readonly + fileMustExist + query_only` and deliberately skips the runtime's
normal WAL/synchronous write pragmas; the export CLI refuses to start without
this guard.

Missing mounts, database access, signing key, live provenance, fixtures or
ledger coverage fail the exporter. This is expected fail-closed behavior; the
workflow must not replace it with a skipped or empty export. The bundle can
contain approved payload/fixture data, so it remains a private Actions
artifact with one-day retention and must never be committed to Git.

## Main CI and release behavior

For a `main` push, manual run selected on `main`, or hourly scheduled run,
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) generates a fresh
random nonce and dispatches an exporter for that exact consumer run/attempt. It
waits only for the workflow-dispatch run whose display name contains that nonce,
then binds verification to the exact exporter run/attempt, main ref, repository,
commit and signed consumer identity. This prevents an older successful bundle
for the same Git SHA from satisfying a later promotion gate. The hourly run is
required because a runtime promotion changes production evidence without
changing Git.

There is no “not configured” success path on `main`: a missing, failed,
expired, incomplete or mismatched export makes the required CI meta-job fail.
Release likewise dispatches a fresh exporter on the exact release tag and
applies the same nonce/run/attempt verification before publishing images.
For a manual release, the requested tag is resolved and checked out first;
`git rev-parse HEAD` becomes the single SHA used for exporter selection,
artifact naming, signature verification, image builds and the GitHub Release.
The branch from which the manual workflow was opened is never substituted for
the requested tag's commit.
An expired export must be rerun for that same commit; dispatching the exporter
on a different current `main` SHA cannot satisfy the release gate.

The replay CLI also receives the high-watermark `stateHash` read from this same
signed export manifest. That explicit argument prevents accidental verifier
omission, but it is not an independent external witness; freshness is supplied
by the consumer-generated nonce and exact exporter-run binding.

Pull-request jobs intentionally never download or execute production-derived
evidence. They run the ordinary code tests; after merge, the required main-only
gate evaluates the trusted production inventory with the merged code.

Replay runs only against persisted cassettes and the isolated generated-code
worker. It does not resolve live integration profiles or call external
production systems. Reports and CLI errors expose only diagnostic categories
and stable opaque references; artifact paths, fixture values, model output,
worker reasons and credentials are withheld.

Binary fixtures remain short-lived. If a promoted suite references an expired
or deleted asset, export/replay fails. Upload fresh approved test data, run a
new sandbox, finish a new immutable version and promote it; do not mutate old
evidence or extend it in place.
