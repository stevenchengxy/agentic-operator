# syntax=mirror.gcr.io/docker/dockerfile:1.6@sha256:ac85f380a63b13dfcefa89046420e1781752bab202122f8f50032edf31be0021
#
# Inngest worker — P4-OPS-03.
#
# DESIGN DECISION (documented for the runbook):
#
#   Our Inngest *functions* live inside the API process. They're registered
#   at boot via `bootstrapRuntime()` (which reads `models/<tenant>/` and
#   calls `serve()` on `apps/api/src/routes/inngest.ts`). Splitting them
#   into a second container would mean shipping two copies of the same
#   bootstrap code, two copies of the same SQLite + LLM gateway, and
#   coordinating which one is canonical — pointless complexity for v1.
#
#   What WE need a sidecar for is the **Inngest broker**: the event-bus
#   process that accepts `inngest.send()` calls, queues them, and POSTs
#   them to our `serve()` webhook. In development this is `npx inngest-cli
#   dev`; in production it's either Inngest Cloud (managed) or the
#   self-hosted broker image.
#
#   This Dockerfile pins the self-hosted broker. Using the published
#   image directly in `docker-compose.yml` would also work; we keep this
#   thin wrapper so a future ops change (e.g. mounting a custom config,
#   shipping a private CA bundle, or pinning a SHA-locked digest) lives
#   under version control rather than buried in compose.
#
# Build:
#   docker build -f apps/inngest-worker/Dockerfile -t agentic-inngest:dev .
#
# Run (development):
#   docker run --rm -p 8288:8288 agentic-inngest:dev dev \
#     -u http://api:3501/inngest \
#     --no-discovery

FROM inngest/inngest:latest

COPY --chmod=755 apps/inngest-worker/docker-entrypoint.sh \
  /usr/local/bin/agentic-inngest-entrypoint

ENTRYPOINT ["/usr/local/bin/agentic-inngest-entrypoint"]
CMD ["inngest"]

# The published Inngest image already runs as a non-root user `inngest`
# (uid 1001) and EXPOSEs 8288 / 8289 / 8290. Don't override either —
# the image's healthcheck and entrypoint are tuned for the broker.
#
# The compose service injects:
#   * `--no-discovery` so the broker doesn't auto-scan local processes
#     (which doesn't work across docker network boundaries)
#   * `-u http://api:3501/inngest` to point at our serve() webhook
#   * `INNGEST_SIGNING_KEY` + `INNGEST_EVENT_KEY` from .env.production
#
# No CUSTOM CMD — the image's default `inngest` entrypoint is correct;
# compose passes flags through `command:`.
