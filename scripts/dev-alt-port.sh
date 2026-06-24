#!/usr/bin/env bash
#
# dev-alt-port.sh — run the agentic stack on an ALTERNATE api port so it
# coexists with other local apps that occupy :3500–:3505 (e.g. the
# allmetaOntology monorepo). Plain `pnpm dev` can't be used here because its
# predev kills :3501 (someone else's app) and hardcodes Inngest at :3501.
#
# What it does:
#   1. Switches to Node 26 (better-sqlite3 ABI).
#   2. Kills only OUR stale processes (concurrently / api-tsx-watch / next).
#   3. Frees only OUR ports (web + api + inngest) — never :3500–:3505.
#   4. Launches web + api + inngest with api on $API_PORT and the web
#      rewrite + inngest URL pointed at it.
#
# Usage:  ./scripts/dev-alt-port.sh            # api :4520, web :3599
#         API_PORT=4600 ./scripts/dev-alt-port.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
API_PORT="${API_PORT:-4520}"
WEB_PORT="${WEB_PORT:-3599}"   # web dev script pins --port 3599; used for cleanup
PNPM="$HOME/.nvm/versions/node/v24.14.0/bin/pnpm"

export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 26 >/dev/null 2>&1 || true

echo "[dev-alt] cleaning stale agentic processes…"
# This script's own argv is just "bash dev-alt-port.sh", so these -f patterns
# cannot match it (no self-kill). pkill excludes its own process by default.
pkill -9 -f "${ROOT}/node_modules/.bin/../concurrently" 2>/dev/null || true
pkill -9 -f "${ROOT}/apps/api/node_modules/.bin/../tsx" 2>/dev/null || true
pkill -9 -f "${ROOT}/apps/web/node_modules/.bin/../next" 2>/dev/null || true
# Free OUR ports only. NEVER include 3500–3505 (other local apps).
lsof -ti:"${WEB_PORT}","${API_PORT}",8288,8289,50052,50053 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

export PORT="${API_PORT}"
export AGENTIC_API_URL="http://localhost:${API_PORT}"
echo "[dev-alt] node $(node -v) · api :${API_PORT} · web :${WEB_PORT} → :${API_PORT} · inngest → :${API_PORT}"

# NOTE: no `-k`/--kill-others — a transient api tsx-watch restart must NOT
# tear down web+inngest (matches the root `pnpm dev` behavior); tsx recovers
# the api on its own.
exec node "$PNPM" exec concurrently -n web,api,inngest -c blue,green,magenta \
  "pnpm --filter @agentic/web run dev" \
  "pnpm --filter @agentic/api run dev" \
  "npx -y inngest-cli@latest dev -u http://localhost:${API_PORT}/inngest"
