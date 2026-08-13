# syntax=docker/dockerfile:1
#
# Prism — production image, built from source.
# Multi-stage: a full toolchain compiles the app + native modules, then a lean
# runtime image carries only the built output and production dependencies.

########################  Stage 1: build  ########################
FROM node:22-bookworm AS builder

ENV HUSKY=0 \
    NODE_ENV=development
WORKDIR /app

# Toolchain for native modules (better-sqlite3 / node-pty / bcrypt).
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential python3 git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install deps first for layer caching. scripts/ is required by the
# postinstall hook (fix-node-pty.js).
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci

# Build client (dist/) + server (dist-server/), then drop dev dependencies so
# only production node_modules (with compiled native binaries) remain.
COPY . .
RUN npm run build && npm prune --omit=dev

########################  Stage 2: runtime  ########################
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    SERVER_PORT=8080 \
    HOST=0.0.0.0 \
    HOME=/data \
    WORKSPACES_ROOT=/workspace
WORKDIR /app

# git       -> checkpoints / Git panel
# ripgrep   -> fast in-repo search (also bundled via @vscode/ripgrep)
# bash      -> integrated terminal (node-pty) and agent tool calls
# tini      -> proper signal handling / zombie reaping for spawned shells
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep bash ca-certificates tini \
    && rm -rf /var/lib/apt/lists/* \
    && useradd -m -u 10001 -d /data prism \
    && mkdir -p /data /workspace \
    && chown -R prism:prism /data /workspace

# Compiled app + production deps from the builder (same Debian base, so the
# native module ABI matches — no rebuild needed).
COPY --from=builder --chown=prism:prism /app/node_modules ./node_modules
COPY --from=builder --chown=prism:prism /app/dist         ./dist
COPY --from=builder --chown=prism:prism /app/dist-server  ./dist-server
COPY --from=builder --chown=prism:prism /app/public       ./public
COPY --from=builder --chown=prism:prism /app/shared       ./shared
COPY --from=builder --chown=prism:prism /app/package.json ./package.json

USER prism

# /data      -> HOME, and that is what puts Prism's state on the volume:
#               getDataDir() defaults to ~/.prism, so auth.db, uploaded
#               assets, checkpoints and plugins land in /data/.prism with no
#               PRISM_DATA_DIR set. Claude Code's own session transcripts sit
#               beside them in /data/.claude for the same reason.
# /workspace -> the code projects the agent operates on
VOLUME ["/data", "/workspace"]

EXPOSE 8080

# Probes /api/ready rather than /health. Both are mounted before the API-key
# gate so neither needs credentials, but /health is pure liveness and answers
# 200 from a process whose database is unusable; /api/ready round-trips SQLite
# and returns 503 until the process can actually serve requests.
#
# Runs the request through node's global fetch rather than curl or wget: the
# slim base image carries neither, and node is the one binary guaranteed here.
# start-period covers first-boot schema setup and the legacy data-dir migration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.SERVER_PORT||8080)+'/api/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist-server/server/index.js"]
