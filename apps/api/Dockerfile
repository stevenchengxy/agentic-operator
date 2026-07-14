# syntax=docker/dockerfile:1.6
#
# apps/api — Fastify 5 + Drizzle (better-sqlite3) on Node 26.
#
# Three stages so the runtime image only carries production deps:
#
#   1. base   — Node 26 + pnpm 11 + corepack pinning. Shared by the build
#               and runtime stages so both speak the same lockfile.
#   2. build  — installs every workspace dep (including dev) and runs
#               `pnpm -r --filter "@agentic/api..." typecheck`. We don't
#               emit JS — the runtime container runs `tsx`, which strips
#               TypeScript on the fly — so `typecheck` is the build gate.
#               Native modules (better-sqlite3) are compiled against the
#               Debian-slim libc here and copied verbatim into the runtime
#               stage.
#   3. runtime — Node 26 slim with only the production node_modules graph,
#               our compiled source tree, and a non-root `agentic` user.
#               `data/` and `models/` are NOT baked in; they must be bind
#               mounted (see docker-compose.yml).
#
# Build:
#   docker build -f apps/api/Dockerfile -t agentic-api:dev .
#
# Run (development sanity check — production runs through compose):
#   docker run --rm -p 3501:3501 \
#     -v $(pwd)/data:/app/data \
#     -v $(pwd)/models:/app/models \
#     --env-file .env.production \
#     agentic-api:dev

# --- base ----------------------------------------------------------------
FROM node:26.5.0-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
# Better-sqlite3 requires Python and a C++ toolchain to build natively.
# `apt-get -y --no-install-recommends` keeps the layer small.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      make \
      g++ \
      ca-certificates \
      tini \
 && rm -rf /var/lib/apt/lists/*
# node:26.5.0-slim does NOT ship corepack; install pnpm via npm to keep the
# layer reproducible (avoids `corepack: not found`).
RUN npm install --global pnpm@11.1.2
WORKDIR /app

# --- build ---------------------------------------------------------------
FROM base AS build
# Copy lockfiles + workspace manifests first so dep installs are cacheable
# independent of source-code changes.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./
COPY apps/api/package.json apps/api/tsconfig.json apps/api/
COPY apps/web/package.json apps/web/tsconfig.json apps/web/
COPY apps/cli/package.json apps/cli/tsconfig.json apps/cli/
COPY packages packages
COPY tenants tenants
COPY data/system-agents/package.json data/system-agents/tsconfig.json data/system-agents/
# Install every workspace package so better-sqlite3 builds against this
# image's libc + node ABI. `--ignore-scripts=false` is the default; the
# pnpm-workspace allowBuilds list pre-approves the natives we trust.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# Now copy the rest of the source. Layer caching on the previous step
# means a code-only change won't reinstall deps.
COPY apps/api/src apps/api/src
COPY apps/api/scripts apps/api/scripts
COPY data/system-agents data/system-agents
COPY packages packages
COPY tenants tenants
COPY models models

# Build gate — typecheck the api + its workspace dependencies.
RUN pnpm --filter @agentic/api... typecheck

# --- runtime -------------------------------------------------------------
FROM node:26.5.0-slim AS runtime
ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
ENV PORT=3501
ENV HOST=0.0.0.0
ENV AGENTIC_DATA_DIR=/app/data
ENV AGENTIC_MODELS_DIR=/app/models
ENV AGENTIC_LOGS_DIR=/app/data/logs
ENV AGENTIC_ARTIFACTS_DIR=/app/data/artifacts
ENV AGENTIC_TENANTS_DIR=/app/data/tenants
# Default DB path lives on the persistent volume; override via env_file
# when running against a different layout.
ENV DATABASE_URL=file:/app/data/agentic.db
# `tini` is dropped in via the runtime base to forward SIGTERM into the
# Node process; without it, signals from `docker stop` go to PID 1 and
# never reach our graceful shutdown hook.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 1001 agentic \
 && useradd  --system --uid 1001 --gid agentic --home /app --shell /usr/sbin/nologin agentic

RUN npm install --global pnpm@11.1.2

WORKDIR /app

# Copy the workspace exactly as the build stage left it — pnpm's
# isolated module layout means each workspace has its own node_modules
# symlinked into the .pnpm store; we need both the store and the symlinks.
COPY --from=build --chown=agentic:agentic /app /app

# Default data / artifact directories — content is volume-mounted at
# runtime; create the mount points so a fresh container without volumes
# still boots (e.g. for `docker run --rm` smoke tests).
RUN mkdir -p /app/data/logs /app/data/artifacts /app/data/backups /app/data/tenants \
 && chown -R agentic:agentic /app/data

USER agentic
EXPOSE 3501

# Healthcheck — `wget` isn't available in the slim image; fall back to a
# tiny Node one-liner that hits /health and exits non-zero on error.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||3501) +'/health').then(r=>{if(r.status!==200)process.exit(1)}).catch(()=>process.exit(1))" || exit 1

# Entry-point wrapper script — runs migrations against the mounted DB
# volume (idempotent, no-op when up to date) then exec's the server.
# Lives in the image so operators don't need to remember a separate
# `db:migrate` step on first boot.
COPY --chown=agentic:agentic apps/api/docker-entrypoint.sh /app/apps/api/docker-entrypoint.sh
RUN chmod +x /app/apps/api/docker-entrypoint.sh

# `tini -- ...` makes tini PID 1 so it forwards SIGTERM into the Node
# process unmodified (without tini, signals to PID 1 don't trigger our
# P4-API-01 graceful-shutdown handler).
#
# tsx ships a shell wrapper at .bin/tsx and the real JS entry under
# `dist/cli.mjs`. We invoke the shell wrapper directly (tini → /bin/sh
# → node), which keeps PATH resolution simple and survives pnpm's
# isolated-module layout. The tsx wrapper exec's node, so our SIGTERM
# handler sits on the only Node process in the tree.
WORKDIR /app/apps/api
ENTRYPOINT ["/usr/bin/tini", "--", "/app/apps/api/docker-entrypoint.sh"]
CMD ["./node_modules/.bin/tsx", "src/server.ts"]
