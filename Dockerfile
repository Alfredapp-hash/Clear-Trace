# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
# ClearTrace — self-hosted Docker image (the supported deploy target).
# SQLite lives on the /app/data volume; never bake a database into the image.
#
# Base images are pinned by digest (multi-arch index) so a rebuild cannot silently pick up
# a different image. Dependabot (docker ecosystem) proposes digest bumps; keep the three
# FROM lines on the same digest.

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS deps
WORKDIR /app
# Toolchain for better-sqlite3's native addon when no musl prebuild matches.
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# prebuild runs scripts/sync-skills.mjs, which fails the build if no skill pack is found.
RUN npm run build

FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS runner
WORKDIR /app
RUN apk add --no-cache libc6-compat
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=/app/data/cleartrace.db \
    OLLAMA_ALLOWED_ORIGINS=http://localhost:11434,http://127.0.0.1:11434,http://host.docker.internal:11434

RUN addgroup -S cleartrace && adduser -S cleartrace -G cleartrace

COPY --from=builder --chown=cleartrace:cleartrace /app/public ./public
COPY --from=builder --chown=cleartrace:cleartrace /app/.next/standalone ./
COPY --from=builder --chown=cleartrace:cleartrace /app/.next/static ./.next/static
# Runtime-read Markdown (skill registry + agent kit export).
COPY --from=builder --chown=cleartrace:cleartrace /app/skills ./skills
COPY --from=builder --chown=cleartrace:cleartrace /app/agent-builder/skillpack ./agent-builder/skillpack
COPY --from=builder --chown=cleartrace:cleartrace /app/agent-builder/mcp-server ./agent-builder/mcp-server
# Operator tools (docs/self-hosting/backup-restore.md): encrypted backup, guarded restore and
# ENCRYPTION_KEY check. Plain ESM on Node built-ins + better-sqlite3 (already in standalone).
# restore.mjs reads "cleartrace.schemaVersion" from package.json.
COPY --from=builder --chown=cleartrace:cleartrace /app/scripts/backup.mjs /app/scripts/restore.mjs /app/scripts/check-key.mjs ./scripts/
COPY --from=builder --chown=cleartrace:cleartrace /app/package.json ./package.json

RUN mkdir -p /app/data/backups && chown -R cleartrace:cleartrace /app/data && chmod 700 /app/data/backups
VOLUME ["/app/data"]

USER cleartrace
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health',{redirect:'manual'}).then(r=>process.exit(r.status>=200&&r.status<300?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
