# Build context: repo root (docker build -f Dockerfile .)
#
# Three-stage build:
#   1. builder      — compiles TypeScript (full devDependencies available)
#   2. runtime-deps — installs production-only node_modules (no devDeps, no build tools)
#   3. production   — gcr.io/distroless/nodejs24-debian12:nonroot
#
# Security model:
#   • Stages 1–2 are ephemeral; Trivy only scans the final (production) image.
#   • Distroless contains only the Node.js 24 runtime binary + minimal glibc/libssl.
#     No shell, no package manager, no tar, no apt, no curl — the entire OS toolchain
#     CVE surface present in bookworm-slim is eliminated.
#   • :nonroot variant runs as uid 65532 (nobody) by default — no USER directive needed.
#   • HEALTHCHECK uses Node built-in `http` module (curl unavailable in distroless).

# ---- Stage 1: Build --------------------------------------------------------
# Pinned to specific version to prevent supply chain attacks.
# Digest pinned to linux/amd64 manifest (resolved 2026-03-28).
# To rotate: docker manifest inspect node:24.2.0-bookworm-slim
#   and replace the sha256 below with the current amd64 digest.
FROM node:24.2.0-bookworm-slim@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9 AS builder

# Cache buster: force rebuild when package-lock.json changes.
ARG CACHE_BUSTER=1

WORKDIR /workspace

# Copy package manifests first for layer-cached dependency install.
COPY package.json package-lock.json ./

RUN npm ci

# Compile API.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- Stage 2: Production dependencies -------------------------------------
# Separate stage: installs --omit=dev so distroless never needs npm or a shell.
FROM node:24.2.0-bookworm-slim@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9 AS runtime-deps

# Cache buster: force rebuild when package-lock.json changes.
ARG CACHE_BUSTER=1

WORKDIR /workspace

COPY package.json package-lock.json ./

RUN npm ci --omit=dev \
  && npm cache clean --force

# ---- Stage 3: Production (distroless) -------------------------------------
# gcr.io/distroless/nodejs24-debian12:nonroot contains only:
#   • Node.js 24 runtime binary (at /nodejs/bin/node)
#   • Minimal glibc + libssl from Debian 12
#   • No shell, no package manager, no OS utilities
# Trivy finds near-zero OS CVEs in this image.
# Digest pinned to linux/amd64 manifest (resolved 2026-03-28).
# To rotate: docker manifest inspect gcr.io/distroless/nodejs24-debian12:nonroot
#   and replace the sha256 below with the current amd64 digest.
# ENTRYPOINT is ["/nodejs/bin/node"]; CMD supplies the script path argument.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:6c75c6e4771c2ea5f02aaf991abdc77391acd3a580accd9d7b68651f12c60dc0 AS production

WORKDIR /app

ENV NODE_ENV=production

# Package manifest — required for Node.js module resolution at runtime.
COPY package.json ./

# Production node_modules.
COPY --from=runtime-deps /workspace/node_modules ./node_modules

# Compiled application output.
COPY --from=builder /workspace/dist ./dist

# Healthcheck script — uses Node built-in http (curl not available in distroless).
COPY healthcheck.js ./healthcheck.js

EXPOSE 3000

# Exec-form required — distroless has no shell to expand shell-form commands.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/healthcheck.js"]

CMD ["dist/server.js"]
