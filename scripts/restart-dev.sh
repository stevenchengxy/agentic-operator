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

echo "[restart] killing stale agentic processes…"
# Kill OUR concurrently/tsx/next by path so a stuck watcher can't survive.
# pkill never matches its own pid, and these -f patterns can't match this
# script's argv ("bash restart-dev.sh"), so there is no self-kill.
pkill -9 -f "${ROOT}/node_modules/.pnpm/concurrently" 2>/dev/null || true
pkill -9 -f "${ROOT}/apps/api/node_modules/.bin/../tsx" 2>/dev/null || true
pkill -9 -f "${ROOT}/apps/web/node_modules/.bin/../next" 2>/dev/null || true

echo "[restart] freeing ports ${PORTS}…"
lsof -ti:"${PORTS}" 2>/dev/null | xargs kill -9 2>/dev/null || true
sleep 1

echo "[restart] starting dev stack (web :${WEB_PORT} · api :${API_PORT} · inngest :8488)…"
# `pnpm dev`'s predev re-runs ensure:native + frees the same ports, so this is
# idempotent. exec so Ctrl-C goes straight to the stack.
exec pnpm dev
