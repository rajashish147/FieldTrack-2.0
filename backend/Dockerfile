# ---- Stage 1: Build ----
FROM node:18-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---- Stage 2: Production ----
FROM node:18-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Phase 11: curl required for Docker HEALTHCHECK
RUN apk add --no-cache curl

EXPOSE 3000

# Phase 11: Docker healthcheck — probes /health every 30s.
# start-period gives the Node process time to connect to Redis and boot.
# CI/CD pipelines and orchestrators (ECS, Kubernetes) use this to gate traffic.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

USER node

CMD ["node", "dist/server.js"]
