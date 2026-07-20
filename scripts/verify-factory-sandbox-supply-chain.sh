#!/usr/bin/env bash
set -euo pipefail

manifest="${1:-}"
output_env="${2:-}"
bundle_dir="${3:-}"
if [[ -z "$manifest" || -z "$output_env" || -z "$bundle_dir" || "$#" -ne 3 ]]; then
  echo "usage: $0 <attested-release-manifest.json> <output.env> <release-bundle-dir>" >&2
  exit 2
fi
for command in gh node; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required; supply-chain verification cannot be skipped" >&2
    exit 1
  fi
done

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo "sha256sum or shasum is required; SBOM bytes cannot be verified" >&2
    return 1
  fi
}

repository="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.source?.repository||"")' "$manifest")"
commit="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.source?.commit||"")' "$manifest")"
source_ref="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.source?.sourceRef||"")' "$manifest")"
signer_workflow="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.source?.signerWorkflow||"")' "$manifest")"
release_schema="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.schema||"")' "$manifest")"
control_ref="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.control?.reference||"")' "$manifest")"
workload_ref="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.workload?.reference||"")' "$manifest")"
gateway_ref="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.gateway?.reference||"")' "$manifest")"
candidate_ref="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.candidate?.reference||"")' "$manifest")"
executor_ref="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.executor?.reference||"")' "$manifest")"
control_sbom_digest="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.control?.sbomDigest||"")' "$manifest")"
workload_sbom_digest="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.workload?.sbomDigest||"")' "$manifest")"
gateway_sbom_digest="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.gateway?.sbomDigest||"")' "$manifest")"
candidate_sbom_digest="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.candidate?.sbomDigest||"")' "$manifest")"
executor_sbom_digest="$(node -e 'const m=require(process.argv[1]);process.stdout.write(m.images?.executor?.sbomDigest||"")' "$manifest")"

# Structural validation happens before any network lookup, so a malformed
# manifest cannot choose a weaker signer/repository policy for gh verification.
node scripts/factory-sandbox-release-manifest.mjs verify \
  --manifest "$manifest" \
  --expected-repository "${FACTORY_SANDBOX_EXPECTED_REPOSITORY:?set exact owner/repository}" \
  --expected-commit "${FACTORY_SANDBOX_EXPECTED_COMMIT:?set exact release git SHA}" \
  --expected-ref "${FACTORY_SANDBOX_EXPECTED_REF:?set exact refs/tags/vX.Y.Z}" \
  >/dev/null

required_files=( \
  control.provenance.sigstore.json \
  control.sbom.sigstore.json \
  workload.provenance.sigstore.json \
  workload.sbom.sigstore.json \
  gateway.provenance.sigstore.json \
  gateway.sbom.sigstore.json \
  candidate.provenance.sigstore.json \
  candidate.sbom.sigstore.json \
  release-manifest.provenance.sigstore.json \
  control.spdx.json \
  workload.spdx.json \
  gateway.spdx.json \
  candidate.spdx.json
)
if [[ "$release_schema" == "agent-factory-sandbox-image-release/v4" ]]; then
  required_files+=(
    executor.provenance.sigstore.json
    executor.sbom.sigstore.json
    executor.spdx.json
  )
elif [[ "$release_schema" != "agent-factory-sandbox-image-release/v3" ]]; then
  echo "unsupported Factory sandbox release schema: $release_schema" >&2
  exit 1
fi
for required_file in "${required_files[@]}"; do
  if [[ ! -f "$bundle_dir/$required_file" ]]; then
    echo "required release evidence is missing: $bundle_dir/$required_file" >&2
    exit 1
  fi
done

actual_control_sbom="sha256:$(sha256_file "$bundle_dir/control.spdx.json")"
actual_workload_sbom="sha256:$(sha256_file "$bundle_dir/workload.spdx.json")"
actual_gateway_sbom="sha256:$(sha256_file "$bundle_dir/gateway.spdx.json")"
actual_candidate_sbom="sha256:$(sha256_file "$bundle_dir/candidate.spdx.json")"
actual_executor_sbom=""
if [[ "$release_schema" == "agent-factory-sandbox-image-release/v4" ]]; then
  actual_executor_sbom="sha256:$(sha256_file "$bundle_dir/executor.spdx.json")"
fi
if [[ "$actual_control_sbom" != "$control_sbom_digest" \
  || "$actual_workload_sbom" != "$workload_sbom_digest" \
  || "$actual_gateway_sbom" != "$gateway_sbom_digest" \
  || "$actual_candidate_sbom" != "$candidate_sbom_digest" \
  || ( "$release_schema" == "agent-factory-sandbox-image-release/v4" \
    && "$actual_executor_sbom" != "$executor_sbom_digest" ) ]]; then
  echo "release SBOM bytes do not match the signed digest-only manifest" >&2
  exit 1
fi

verify_attestation() {
  local subject="$1"
  local predicate="$2"
  local bundle="$3"
  gh attestation verify "$subject" \
    --repo "$repository" \
    --signer-workflow "$signer_workflow" \
    --source-digest "$commit" \
    --source-ref "$source_ref" \
    --predicate-type "$predicate" \
    --deny-self-hosted-runners \
    --bundle "$bundle" \
    >/dev/null
}

verify_attestation "$manifest" "https://slsa.dev/provenance/v1" \
  "$bundle_dir/release-manifest.provenance.sigstore.json"
verify_attestation "oci://$control_ref" "https://slsa.dev/provenance/v1" \
  "$bundle_dir/control.provenance.sigstore.json"
verify_attestation "oci://$control_ref" "https://spdx.dev/Document/v2.3" \
  "$bundle_dir/control.sbom.sigstore.json"
verify_attestation "oci://$workload_ref" "https://slsa.dev/provenance/v1" \
  "$bundle_dir/workload.provenance.sigstore.json"
verify_attestation "oci://$workload_ref" "https://spdx.dev/Document/v2.3" \
  "$bundle_dir/workload.sbom.sigstore.json"
verify_attestation "oci://$gateway_ref" "https://slsa.dev/provenance/v1" \
  "$bundle_dir/gateway.provenance.sigstore.json"
verify_attestation "oci://$gateway_ref" "https://spdx.dev/Document/v2.3" \
  "$bundle_dir/gateway.sbom.sigstore.json"
verify_attestation "oci://$candidate_ref" "https://slsa.dev/provenance/v1" \
  "$bundle_dir/candidate.provenance.sigstore.json"
verify_attestation "oci://$candidate_ref" "https://spdx.dev/Document/v2.3" \
  "$bundle_dir/candidate.sbom.sigstore.json"
if [[ "$release_schema" == "agent-factory-sandbox-image-release/v4" ]]; then
  verify_attestation "oci://$executor_ref" "https://slsa.dev/provenance/v1" \
    "$bundle_dir/executor.provenance.sigstore.json"
  verify_attestation "oci://$executor_ref" "https://spdx.dev/Document/v2.3" \
    "$bundle_dir/executor.sbom.sigstore.json"
fi

# Only a fully verified release can produce the digest-only Compose/API
# fragment. Secrets remain separate and are never written by this script.
node scripts/factory-sandbox-release-manifest.mjs env \
  --manifest "$manifest" \
  --expected-repository "$repository" \
  --expected-commit "$commit" \
  --expected-ref "$source_ref" \
  --output "$output_env"
chmod 600 "$output_env"
echo "Verified Factory sandbox provenance + SPDX SBOM; wrote $output_env"
