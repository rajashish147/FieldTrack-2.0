# Build context: monorepo root (docker build -f apps/api/Dockerfile .)
# ---- Stage 1: Build ----
FROM node:24-alpine AS builder

WORKDIR /workspace

# Install workspace dependencies first (for layer caching)
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/types/package.json ./packages/types/

RUN npm ci

# Copy shared types source and compile
COPY packages/types/tsconfig.json ./packages/types/
COPY packages/types/src/ ./packages/types/src/
RUN npm run build -w packages/types

WORKDIR /workspace/apps/api
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src

RUN npm run build

# ---- Stage 2: Production ----
FROM node:24-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/web/package.json ./apps/web/
COPY packages/types/package.json ./packages/types/

RUN npm ci --omit=dev

COPY --from=builder /workspace/apps/api/dist ./apps/api/dist
COPY --from=builder /workspace/packages/types/dist ./packages/types/dist

# Phase 11: curl required for Docker HEALTHCHECK
RUN apk add --no-cache curl

EXPOSE 3000

# Phase 11: Docker healthcheck — probes /health every 30s.
# start-period gives the Node process time to connect to Redis and boot.
# CI/CD pipelines and orchestrators (ECS, Kubernetes) use this to gate traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node

CMD ["node", "apps/api/dist/server.js"]
