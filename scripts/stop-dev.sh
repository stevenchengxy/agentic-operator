#!/usr/bin/env bash
# Stop every process that belongs to this workspace's local dev stack.
#
# Port-only cleanup is insufficient: watchers and `concurrently` parents keep
# running after their children lose a port, then leave the UI partially alive
# while the API is down. Match both the workspace path and the process cwd so
# similarly named services from other projects are never touched.
set -u

cd "$(dirname "$0")/.."
ROOT="$(pwd -P)"
PORTS="3599,3540,8488,8489,50152,50153"

project_cwd() {
  local pid="$1" cwd
  cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
  case "$cwd" in
    "$ROOT"|"$ROOT"/*) return 0 ;;
    *) return 1 ;;
  esac
}

collect_matching_pids() {
  local pattern pid
  # Every pattern in this first group embeds the absolute workspace root, so
  # another cwd check would only add dozens of slow `lsof` calls.
  for pattern in \
    "$ROOT/node_modules/.bin/../concurrently/dist/bin/concurrently.js" \
    "$ROOT/node_modules/.pnpm/concurrently" \
    "$ROOT/apps/api/node_modules/.bin/../tsx/dist/cli.mjs watch" \
    "$ROOT/apps/web/node_modules/.bin/../next/dist/bin/next dev" \
    "$ROOT/tenants/.*/mcp-server"
  do
    for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
      [ "$pid" != "$$" ] && echo "$pid"
    done
  done

  # The downloaded Inngest executable has no workspace path in argv. Scope it
  # by cwd so other projects using the same conventional callback URL survive.
  for pid in $(pgrep -f "inngest-cli.*dev -u http://localhost:3540/inngest" 2>/dev/null || true); do
    if [ "$pid" != "$$" ] && project_cwd "$pid"; then
      echo "$pid"
    fi
  done

  # Launchers installed by Codex/Corepack may live outside the workspace, and
  # tsx can shorten its argv to a relative `./node_modules/...` path. Match the
  # process role as a fallback, then require its cwd to be this workspace so a
  # failed/restarted stack cannot leave detached watchers behind.
  for pattern in \
    "pnpm.*(--filter .* )?(run )?dev" \
    "tsx.*src/server\.ts" \
    "next.*(bin/next|next) dev" \
    "concurrently.*pnpm.*dev"
  do
    for pid in $(pgrep -f "$pattern" 2>/dev/null || true); do
      if [ "$pid" != "$$" ] && project_cwd "$pid"; then
        echo "$pid"
      fi
    done
  done
}

# The SQLite writer supervisor must go down FIRST and gracefully: on SIGTERM it
# terminates its server child, checkpoints the WAL and releases the writer
# lease. Killing children first (or SIGKILLing the supervisor) strands the
# lease and wedges every subsequent `pnpm dev` fail-closed. None of the
# patterns below match the supervisor's argv, so it gets its own pass.
SUPERVISOR_PIDS=""
for pid in $(pgrep -f "sqlite-writer-supervisor\.ts" 2>/dev/null || true); do
  if [ "$pid" != "$$" ] && project_cwd "$pid"; then
    SUPERVISOR_PIDS="$SUPERVISOR_PIDS $pid"
  fi
done
if [ -n "${SUPERVISOR_PIDS// /}" ]; then
  echo "[stop] gracefully stopping SQLite writer supervisor(s):${SUPERVISOR_PIDS}"
  # shellcheck disable=SC2086
  kill -TERM $SUPERVISOR_PIDS 2>/dev/null || true
  # Child termination is bounded at 15s inside the supervisor; wait a little
  # longer so checkpoint+release can finish. Normal exits take well under 1s.
  for _ in $(seq 1 100); do
    supervisors_alive=""
    for pid in $SUPERVISOR_PIDS; do
      kill -0 "$pid" 2>/dev/null && supervisors_alive="$supervisors_alive $pid"
    done
    [ -z "$supervisors_alive" ] && break
    sleep 0.2
  done
  if [ -n "${supervisors_alive:-}" ]; then
    echo "[stop] supervisor(s) did not exit in time:${supervisors_alive} (lease may need recovery)"
    # shellcheck disable=SC2086
    kill -KILL $supervisors_alive 2>/dev/null || true
  fi
fi

PIDS="$(collect_matching_pids | sort -un | tr '\n' ' ')"
if [ -n "${PIDS// /}" ]; then
  echo "[stop] terminating workspace dev processes: ${PIDS}"
  # shellcheck disable=SC2086
  kill -TERM $PIDS 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    survivors=""
    for pid in $PIDS; do
      kill -0 "$pid" 2>/dev/null && survivors="$survivors $pid"
    done
    [ -z "$survivors" ] && break
    sleep 0.1
  done
  if [ -n "${survivors:-}" ]; then
    # shellcheck disable=SC2086
    kill -KILL $survivors 2>/dev/null || true
  fi
fi

PORT_PIDS="$(lsof -ti:"$PORTS" 2>/dev/null | sort -un | tr '\n' ' ')"
if [ -n "${PORT_PIDS// /}" ]; then
  echo "[stop] freeing reserved dev ports ${PORTS}: ${PORT_PIDS}"
  # These ports are the workspace's declared dev contract.
  # shellcheck disable=SC2086
  kill -TERM $PORT_PIDS 2>/dev/null || true
  sleep 0.3
  for pid in $PORT_PIDS; do
    kill -0 "$pid" 2>/dev/null && kill -KILL "$pid" 2>/dev/null || true
  done
fi

# Self-heal a lease stranded by a crash/SIGKILL: recovery is proof-gated inside
# the CLI (owner pid provably dead + lsof shows no open db/-wal/-shm handles),
# so a live writer anywhere makes this refuse rather than steal.
if [ -d "$ROOT/data/agentic.db.writer-lease" ]; then
  echo "[stop] a writer lease survived the stop; attempting proof-gated recovery…"
  node "$ROOT/scripts/run-db-command.mjs" recover-writer-lease \
    || echo "[stop] lease recovery refused — a writer may still be alive; inspect $ROOT/data/agentic.db.writer-lease"
fi

echo "[stop] dev stack stopped"
