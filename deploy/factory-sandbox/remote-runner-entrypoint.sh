#!/bin/sh

set -eu

fail() {
  echo "[external-sandbox] remote VM identity check failed: $1" >&2
  exit 78
}

[ "${SANDBOX_RUNNER_ACTUAL_ISOLATION_TIER:-}" = "remote_vm" ] \
  || fail "isolation tier is not fixed to remote_vm"

host_id_file="${EXTERNAL_SANDBOX_HOST_ID_FILE:-}"
[ -n "$host_id_file" ] && [ -r "$host_id_file" ] \
  || fail "the reviewed host machine-id file is not readable"

expected="${EXTERNAL_SANDBOX_EXPECTED_HOST_ID_SHA256:-}"
primary="${EXTERNAL_SANDBOX_PRIMARY_HOST_ID_SHA256:-}"
case "$expected:$primary" in
  *[!0-9a-f:]*|*:*:*|:*|*:)
    fail "host identity hashes must be lowercase sha256 hex"
    ;;
esac
[ "${#expected}" -eq 64 ] && [ "${#primary}" -eq 64 ] \
  || fail "host identity hashes must contain 64 hex characters"
[ "$expected" != "$primary" ] \
  || fail "remote and primary host identities are the same"

host_id="$(tr -d '\r\n ' < "$host_id_file")"
[ -n "$host_id" ] || fail "host machine-id is empty"
actual="$(printf '%s' "$host_id" | sha256sum | awk '{print $1}')"
[ "$actual" = "$expected" ] \
  || fail "this is not the reviewed remote VM"

workload_image="${EXTERNAL_SANDBOX_WORKLOAD_IMAGE_IDENTITY:-}"
case "$workload_image" in
  *@sha256:*) workload_digest="sha256:${workload_image##*@sha256:}" ;;
  *) fail "workload image is not pinned by repository@sha256 digest" ;;
esac
workload_digest_hex="${workload_digest#sha256:}"
case "$workload_digest_hex" in
  *[!0-9a-f]*|'') fail "workload image digest is malformed" ;;
esac
[ "${#workload_digest_hex}" -eq 64 ] \
  || fail "workload image digest is malformed"
[ "$workload_digest" = "${SANDBOX_RUNNER_RUNTIME_IMAGE_DIGEST:-}" ] \
  || fail "signed runtime digest is not bound to the deployed workload image"

exec "$@"
