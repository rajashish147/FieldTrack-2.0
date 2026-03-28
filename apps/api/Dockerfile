# Build context: monorepo root (docker build -f apps/api/Dockerfile .)
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
# NOTE: To pin by digest and prevent base image drift:
#   1. Run: docker pull node:24.2.0-bookworm-slim
#   2. Run: docker inspect node:24.2.0-bookworm-slim | grep RepoDigests
#   3. Replace node:24.2.0-bookworm-slim with node:24.2.0-bookworm-slim@sha256:DIGEST
# This ensures identical binaries even if the tag is re-released.
FROM node:24.2.0-bookworm-slim AS builder

# Cache buster: force rebuild when package-lock.json changes.
# Prevents stale dependency layers from being reused on deployment.
ARG CACHE_BUSTER=1

WORKDIR /workspace

# Copy package manifests first for layer-cached dependency install.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/

RUN npm ci --workspace apps/api --workspace packages/types --include-workspace-root=false

# Compile shared types first (apps/api depends on @fieldtrack/types at runtime).
COPY packages/types/tsconfig.json ./packages/types/
COPY packages/types/src/ ./packages/types/src/
RUN npm run build -w packages/types

# Compile API.
WORKDIR /workspace/apps/api
COPY apps/api/tsconfig.json ./
COPY apps/api/src ./src
RUN npm run build

# ---- Stage 2: Production dependencies -------------------------------------
# Separate stage: installs --omit=dev so distroless never needs npm or a shell.
# mkdir -p guards ensure workspace subdirectories always exist for the COPY in
# stage 3, even when npm hoists all deps to the root node_modules.
# NOTE: Must use SAME base image tag as Stage 1 to ensure consistency.
FROM node:24.2.0-bookworm-slim AS runtime-deps

# Cache buster: force rebuild when package-lock.json changes.
ARG CACHE_BUSTER=1

WORKDIR /workspace

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/

RUN npm ci \
      --omit=dev \
      --workspace apps/api \
      --workspace packages/types \
      --include-workspace-root=false \
  && mkdir -p apps/api/node_modules packages/types/node_modules \
  && npm cache clean --force

# ---- Stage 3: Production (distroless) -------------------------------------
# gcr.io/distroless/nodejs24-debian12:nonroot contains only:
#   • Node.js 24 runtime binary (at /nodejs/bin/node)
#   • Minimal glibc + libssl from Debian 12
#   • No shell, no package manager, no OS utilities
# Trivy finds near-zero OS CVEs in this image.
# NOTE: To pin by digest and prevent base image drift:
#   1. Run: docker pull gcr.io/distroless/nodejs24-debian12:nonroot
#   2. Run: docker inspect gcr.io/distroless/nodejs24-debian12:nonroot | grep RepoDigests
#   3. Replace tag with @sha256:DIGEST in FROM statement
# This prevents "same Dockerfile → different result" risks.
# ENTRYPOINT is ["/nodejs/bin/node"]; CMD supplies the script path argument.
FROM gcr.io/distroless/nodejs24-debian12:nonroot AS production

WORKDIR /app

ENV NODE_ENV=production

# Package manifests — required for npm workspace module resolution at runtime.
# The @fieldtrack/types symlink in node_modules points to ../../packages/types;
# Node.js resolves it to /app/packages/types which is present below.
COPY package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/types/package.json ./packages/types/

# Production node_modules (root-hoisted + workspace-specific).
# BuildKit COPY preserves symlinks, so workspace links resolve correctly.
COPY --from=runtime-deps /workspace/node_modules            ./node_modules
COPY --from=runtime-deps /workspace/apps/api/node_modules   ./apps/api/node_modules
COPY --from=runtime-deps /workspace/packages/types/node_modules ./packages/types/node_modules

# Compiled application output.
COPY --from=builder /workspace/apps/api/dist             ./apps/api/dist
COPY --from=builder /workspace/packages/types/dist       ./packages/types/dist

# Healthcheck script — uses Node built-in http (curl not available in distroless).
COPY apps/api/healthcheck.js ./healthcheck.js

EXPOSE 3000

# Exec-form required — distroless has no shell to expand shell-form commands.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/healthcheck.js"]

CMD ["apps/api/dist/server.js"]
