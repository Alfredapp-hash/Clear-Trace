# syntax=docker/dockerfile:1
# ClearTrace — self-hosted Docker image (the supported deploy target).
# SQLite lives on the /app/data volume; never bake a database into the image.

FROM node:22-alpine AS deps
WORKDIR /app
# Toolchain for better-sqlite3's native addon when no musl prebuild matches.
RUN apk add --no-cache python3 make g++ libc6-compat
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# prebuild runs scripts/sync-skills.mjs, which fails the build if no skill pack is found.
RUN npm run build

FROM node:22-alpine AS runner
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

RUN mkdir -p /app/data && chown -R cleartrace:cleartrace /app/data
VOLUME ["/app/data"]

USER cleartrace
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health',{redirect:'manual'}).then(r=>process.exit(r.status>=200&&r.status<300?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
