#!/bin/sh
set -eu

resolve_secret() {
  name="$1"
  eval "direct=\${$name-}"
  eval "filename=\${${name}_FILE-}"
  if [ -n "$direct" ] && [ -n "$filename" ]; then
    echo "$name and ${name}_FILE cannot both be configured" >&2
    exit 78
  fi
  if [ -n "$filename" ]; then
    if [ ! -f "$filename" ] || [ ! -r "$filename" ]; then
      echo "${name}_FILE is not a readable regular file" >&2
      exit 78
    fi
    value=$(sed -e 's/[[:space:]]*$//' "$filename")
    if [ -z "$value" ]; then
      echo "${name}_FILE is empty" >&2
      exit 78
    fi
    export "$name=$value"
  fi
}

resolve_secret INNGEST_EVENT_KEY
resolve_secret INNGEST_SIGNING_KEY
resolve_secret INNGEST_POSTGRES_URI
resolve_secret INNGEST_REDIS_URI

if [ "${AGENTIC_INNGEST_REQUIRE_DURABLE:-0}" = "1" ]; then
  case " $* " in
    *" dev "*)
      echo "durable Inngest mode refuses the dev server" >&2
      exit 78
      ;;
  esac
  if [ -z "${INNGEST_POSTGRES_URI:-}" ] || [ -z "${INNGEST_REDIS_URI:-}" ]; then
    echo "durable Inngest mode requires Postgres and Redis URIs" >&2
    exit 78
  fi
  if [ -z "${INNGEST_EVENT_KEY:-}" ] || [ "${#INNGEST_EVENT_KEY}" -lt 32 ]; then
    echo "durable Inngest mode requires a non-placeholder event key" >&2
    exit 78
  fi
  case "${INNGEST_SIGNING_KEY:-}" in
    ""|*[!0-9a-fA-F]*)
      echo "durable Inngest signing key must be a hexadecimal string" >&2
      exit 78
      ;;
  esac
  if [ "$(( ${#INNGEST_SIGNING_KEY} % 2 ))" -ne 0 ] || [ "${#INNGEST_SIGNING_KEY}" -lt 64 ]; then
    echo "durable Inngest signing key must contain at least 32 bytes" >&2
    exit 78
  fi
fi

exec "$@"
