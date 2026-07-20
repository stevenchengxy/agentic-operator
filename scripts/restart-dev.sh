#!/usr/bin/env bash
#
# restart-dev.sh — cleanly restart the full agentic dev stack.
#
# Why this exists: tsx-watch (api) and Next (web) usually hot-reload, but a
# half-applied reload can leave the api serving STALE code — e.g. a newly
# added route 404s even though it's on disk (this bit us after merging the
# dashboard + funnel work). A hard restart guarantees every process picks up
# the current tree. Also forces Node 26 (better-sqlite3 ABI) and re-runs the
# native-module guard via `pnpm dev`'s predev hook.
#
# Standard ports (must match package.json predev + next.config.mjs):
#   web :3599 · api :3540 · inngest :8488  (+ 8489 / 50152 / 50153 helpers)
#
# Usage:  pnpm restart            # or: pnpm dev:restart · ./scripts/restart-dev.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"

WEB_PORT=3599
API_PORT=3540
# inngest dev + its connect helpers — MUST match package.json's `dev` (-p 8488
# --connect-gateway-port 8489 --connect-gateway-grpc-port 50152 --connect-executor-grpc-port 50153).
PORTS="${WEB_PORT},${API_PORT},8488,8489,50152,50153"

echo "[restart] switching to Node 26 (better-sqlite3 ABI)…"
export NVM_DIR="$HOME/.nvm"
# shellcheck source=/dev/null
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 26 >/dev/null 2>&1 || true

# Codex's bundled Node runtime includes pnpm as a module, but does not always
# expose a `pnpm` executable on PATH. Resolve a stable launcher before killing
# the currently healthy stack so a restart cannot leave the workspace down.
if command -v pnpm >/dev/null 2>&1; then
  PNPM_LAUNCH=(pnpm)
elif [ -n "${PNPM_HOME:-}" ] && [ -x "${PNPM_HOME}/pnpm" ]; then
  PNPM_LAUNCH=("${PNPM_HOME}/pnpm")
elif [ -x "${HOME}/Library/pnpm/pnpm" ]; then
  PNPM_LAUNCH=("${HOME}/Library/pnpm/pnpm")
elif [ -f "${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs" ]; then
  PNPM_LAUNCH=(node "${HOME}/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs")
else
  echo "[restart] pnpm was not found. Install pnpm or set PNPM_HOME, then retry." >&2
  exit 127
fi

echo "[restart] stopping the previous workspace stack…"
bash scripts/stop-dev.sh

echo "[restart] starting dev stack (web :${WEB_PORT} · api :${API_PORT} · inngest :8488)…"
# `pnpm dev`'s predev re-runs ensure:native + frees the same ports, so this is
# idempotent. exec so Ctrl-C goes straight to the stack.
exec env AGENTIC_SKIP_PREDEV_STOP=1 "${PNPM_LAUNCH[@]}" dev
