#!/bin/sh
# apps/api/docker-entrypoint.sh — enters the SQLite single-writer supervisor.
# The supervisor acquires the lease before migrations and retains that exact
# lease through the complete server lifecycle, so migration → server never
# creates a writer-ownership gap.
#
# Tenant seeding (`pnpm db:seed`) is intentionally NOT run here. It requires
# an operator-supplied bootstrap administrator and is an explicit provisioning
# action, not a container-start side effect. The seed is idempotent, but running
# it on every restart would unnecessarily rotate that administrator's password
# and rewrite memberships. Run it once (and again only when intentionally
# reconciling bootstrap access) with the required AGENTIC_BOOTSTRAP_ADMIN_*
# variables supplied by the deployment secret store.

set -e

cd /app/apps/api
echo "[entrypoint] starting SQLite writer supervisor: $*"
exec node --import tsx /app/apps/api/scripts/sqlite-writer-supervisor.ts -- "$@"
