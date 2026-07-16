#!/usr/bin/env bash

set -Eeuo pipefail

readonly REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly DEV_PORTS=(3599 3501 8288 8289 50052 50053)
readonly GRACE_SECONDS="${AGENTIC_RESTART_GRACE_SECONDS:-12}"

log() {
  printf '[restart] %s\n' "$*"
}

die() {
  printf '[restart] ERROR: %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: ./restart.sh [--check | --help]

Restart the complete local Agentic Operator development stack:
  - web:     http://localhost:3599
  - api:     http://localhost:3501
  - Inngest: http://localhost:8288

Options:
  --check  Validate Node, pnpm, native modules, and show active listeners
           without stopping or starting anything.
  --help   Show this help text.

Environment:
  AGENTIC_RESTART_GRACE_SECONDS  Seconds to wait after SIGTERM (default: 12).
  AGENTIC_DEV_READY_TIMEOUT_MS   Maximum wait for the API listener before the
                                dependent services stop (default: 90000).
  AGENTIC_DEV_OUTAGE_TIMEOUT_MS  Maximum continuous API outage before the
                                development stack stops (default: 15000).
  AGENTIC_DEV_SHUTDOWN_TIMEOUT_MS
                                Maximum child drain before force-kill (default:
                                AGENTIC_SHUTDOWN_TIMEOUT_MS + 2000).
  Other variables, including AGENTIC_DEMO_MODE, are passed through to pnpm dev.
EOF
}

mode="restart"
if (( $# > 0 )) && [[ "$1" == "--" ]]; then
  shift
fi

if (( $# > 1 )); then
  usage >&2
  exit 2
fi

if (( $# == 1 )); then
  case "$1" in
    --check)
      mode="check"
      ;;
    --help | -h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
fi

[[ "$GRACE_SECONDS" =~ ^[0-9]+$ ]] ||
  die "AGENTIC_RESTART_GRACE_SECONDS must be a non-negative integer"

cd "$REPO_ROOT"
[[ -f .nvmrc ]] || die ".nvmrc is missing from $REPO_ROOT"
readonly REQUIRED_NODE_VERSION="$(tr -d '[:space:]' < .nvmrc)"

activate_node() {
  local nvm_script="${NVM_DIR:-$HOME/.nvm}/nvm.sh"

  if [[ -s "$nvm_script" ]]; then
    # nvm references optional variables internally and is not set -u clean.
    set +u
    # shellcheck source=/dev/null
    . "$nvm_script"
    if ! nvm use "$REQUIRED_NODE_VERSION" >/dev/null; then
      set -u
      die "Node v$REQUIRED_NODE_VERSION is not available; run: nvm install $REQUIRED_NODE_VERSION"
    fi
    set -u
  fi

  command -v node >/dev/null 2>&1 ||
    die "Node v$REQUIRED_NODE_VERSION is required but node is not on PATH"

  node scripts/ensure-node-version.mjs
}

listener_pids() {
  local port
  for port in "${DEV_PORTS[@]}"; do
    lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
  done | sort -un
}

signal_listener_groups() {
  local signal="$1"
  local pids="$2"
  local current_pgid
  local pgids
  local pgid
  local candidate_pgid
  local pid

  current_pgid="$(ps -o pgid= -p "$$" | tr -d '[:space:]')"
  pgids="$({
    while IFS= read -r pid; do
      [[ -n "$pid" ]] || continue
      candidate_pgid="$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)"
      if [[ -n "$candidate_pgid" ]]; then
        printf '%s\n' "$candidate_pgid"
      fi
    done <<< "$pids"
  } | sort -un)"

  # A watcher such as `tsx watch` can respawn a killed listener. Signal its
  # process group when that group is separate from this restart command.
  while IFS= read -r pgid; do
    [[ -n "$pgid" ]] || continue
    if [[ "$pgid" != "1" && "$pgid" != "$current_pgid" ]]; then
      log "sending SIG$signal to process group $pgid"
      kill -s "$signal" -- "-$pgid" 2>/dev/null || true
    fi
  done <<< "$pgids"

  # Also signal the concrete listeners. This is the safe fallback when a
  # listener shares this script's process group or its parent already exited.
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill -s "$signal" "$pid" 2>/dev/null || true
  done <<< "$pids"
}

wait_for_ports_to_clear() {
  local timeout="$1"
  local deadline=$((SECONDS + timeout))

  while [[ -n "$(listener_pids)" ]]; do
    if (( SECONDS >= deadline )); then
      return 1
    fi
    sleep 0.2
  done
}

stop_existing_stack() {
  local pids
  pids="$(listener_pids)"

  if [[ -z "$pids" ]]; then
    log "no existing development listeners found"
    return
  fi

  log "stopping listeners on ports: ${DEV_PORTS[*]}"
  signal_listener_groups TERM "$pids"

  if wait_for_ports_to_clear "$GRACE_SECONDS"; then
    log "existing stack stopped cleanly"
    return
  fi

  pids="$(listener_pids)"
  log "grace period expired; force-stopping remaining listeners"
  signal_listener_groups KILL "$pids"
  wait_for_ports_to_clear 2 ||
    die "one or more development ports are still occupied"
}

activate_node
command -v pnpm >/dev/null 2>&1 || die "pnpm 11 is required but not on PATH"
command -v lsof >/dev/null 2>&1 || die "lsof is required but not on PATH"

log "validating native modules"
pnpm run ensure:native

if [[ "$mode" == "check" ]]; then
  active_pids="$(listener_pids)"
  log "Node $(node --version); pnpm $(pnpm --version)"
  if [[ -n "$active_pids" ]]; then
    log "active listener PIDs: $(printf '%s' "$active_pids" | tr '\n' ' ')"
  else
    log "no development listeners are active"
  fi
  log "check complete; no processes were changed"
  exit 0
fi

stop_existing_stack
log "starting API, then web and Inngest in the foreground"
log "the stack will stop if the API remains unavailable after startup"
log "press Ctrl-C to stop the stack"
exec pnpm dev
