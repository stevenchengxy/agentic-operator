#!/bin/sh
# Start a durable self-hosted Inngest server without baking credentials into
# an image or a checked-in configuration.  Every secret is read from a mounted
# file, validated, and written to a process-private config on the container's
# tmpfs.  Nothing secret is printed.

set -eu
umask 077

required_file() {
  name="$1"
  value="$(eval "printf '%s' \"\${$name:-}\"")"
  if [ -z "$value" ] || [ "${value#/}" = "$value" ] || [ ! -r "$value" ]; then
    echo "[inngest-entrypoint] $name must name a readable absolute file" >&2
    exit 1
  fi
  printf '%s' "$value"
}

read_secret() {
  file="$1"
  value="$(tr -d '\r\n' < "$file")"
  if [ -z "$value" ]; then
    echo "[inngest-entrypoint] secret file is empty" >&2
    exit 1
  fi
  printf '%s' "$value"
}

event_keys_file="$(required_file INNGEST_EVENT_KEYS_FILE)"
signing_file="$(required_file INNGEST_SIGNING_KEY_FILE)"
postgres_file="$(required_file INNGEST_POSTGRES_PASSWORD_FILE)"
redis_file="$(required_file INNGEST_REDIS_PASSWORD_FILE)"

signing_key="$(read_secret "$signing_file")"
postgres_password="$(read_secret "$postgres_file")"
redis_password="$(read_secret "$redis_file")"

case "$signing_key" in
  *[!0-9a-fA-F]*|'')
    echo "[inngest-entrypoint] signing key must be hexadecimal" >&2
    exit 1
    ;;
esac
if [ $(( ${#signing_key} % 2 )) -ne 0 ] || [ "${#signing_key}" -lt 64 ]; then
  echo "[inngest-entrypoint] signing key must contain at least 32 bytes" >&2
  exit 1
fi
case "$postgres_password:$redis_password" in
  *[!0-9a-fA-F:]*|'':*|*:'')
    echo "[inngest-entrypoint] database passwords must be non-empty hexadecimal values" >&2
    exit 1
    ;;
esac

postgres_host="${INNGEST_POSTGRES_HOST:-inngest-postgres}"
postgres_port="${INNGEST_POSTGRES_PORT:-5432}"
postgres_db="${INNGEST_POSTGRES_DB:-inngest}"
postgres_user="${INNGEST_POSTGRES_USER:-inngest}"
redis_host="${INNGEST_REDIS_HOST:-inngest-redis}"
redis_port="${INNGEST_REDIS_PORT:-6379}"

config="$(mktemp /tmp/agentic-inngest.XXXXXX.json)"
{
  printf '{\n  "event-key": ['
  first=1
  key_count=0
  while IFS= read -r raw || [ -n "$raw" ]; do
    key="$(printf '%s' "$raw" | tr -d '\r\n')"
    [ -z "$key" ] && continue
    case "$key" in
      *[!0-9a-fA-F]*)
        echo "[inngest-entrypoint] every event key must be hexadecimal" >&2
        rm -f "$config"
        exit 1
        ;;
    esac
    if [ "${#key}" -lt 32 ]; then
      echo "[inngest-entrypoint] every event key must contain at least 16 bytes" >&2
      rm -f "$config"
      exit 1
    fi
    [ "$first" -eq 0 ] && printf ', '
    printf '"%s"' "$key"
    first=0
    key_count=$((key_count + 1))
  done < "$event_keys_file"
  if [ "$key_count" -eq 0 ]; then
    echo "[inngest-entrypoint] event-key file contains no usable keys" >&2
    rm -f "$config"
    exit 1
  fi
  printf '],\n'
  printf '  "signing-key": "%s",\n' "$signing_key"
  printf '  "host": "0.0.0.0",\n'
  printf '  "port": "8288",\n'
  printf '  "poll-interval": %s,\n' "${INNGEST_POLL_INTERVAL:-30}"
  printf '  "queue-workers": %s,\n' "${INNGEST_QUEUE_WORKERS:-100}"
  printf '  "postgres-uri": "postgresql://%s:%s@%s:%s/%s?sslmode=disable",\n' \
    "$postgres_user" "$postgres_password" "$postgres_host" "$postgres_port" "$postgres_db"
  printf '  "redis-uri": "redis://:%s@%s:%s/0"\n' \
    "$redis_password" "$redis_host" "$redis_port"
  printf '}\n'
} > "$config"
chmod 600 "$config"

exec inngest start --config "$config"
