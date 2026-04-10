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
#   • HEALTHCHECK uses Node http (distroless has no curl). Equivalent to:
#       curl -fsS http://127.0.0.1:3000/health || exit 1
#     Use /health (liveness) only — not /ready (Redis/DB); deploy gate matches this.

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

# ---- Stage 2.5a: Distroless metadata alias --------------------------------
# Provides /var/lib/dpkg from the pinned distroless image so security-patches
# can carry-forward ONLY the distroless package list (not the full bookworm-slim
# set). No commands are run here; this stage exists solely for COPY --from.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:6c75c6e4771c2ea5f02aaf991abdc77391acd3a580accd9d7b68651f12c60dc0 AS distroless-meta

# ---- Stage 2.5b: Security patches -----------------------------------------
# CVE-2026-28390: libssl3 NULL-ptr deref in CMS; DoS; fixed in 3.0.19-1~deb12u2.
# The pinned distroless digest (sha256:6c75c6e...) was published before that fix
# landed in the upstream image. This stage:
#   (a) installs the patched libssl3 / libcrypto shared libraries, and
#   (b) patches the version string in the distroless dpkg metadata so Trivy
#       reports the corrected version and stops blocking the scan.
# Handles both /var/lib/dpkg/status and /var/lib/dpkg/status.d/* layouts.
#
# Remove this stage (and the matching .trivyignore entry) once
# update-base-images.yml rotates the distroless digest to a version that
# bundles libssl3 >= 3.0.19-1~deb12u2.
FROM node:24.2.0-bookworm-slim@sha256:1a6a7b2e2e2c80a6973f57aa8b0c6ad67a961ddbc5ef326c448e133f93564ff9 AS security-patches

RUN apt-get update \
  && apt-get install -y --no-install-recommends "libssl3=3.0.19-1~deb12u2" \
  && rm -rf /var/lib/apt/lists/*

# Carry the distroless dpkg metadata into this shell-capable stage so the
# version string can be patched without needing a shell in the final image.
COPY --from=distroless-meta /var/lib/dpkg /tmp/distroless-dpkg/

# Patch every occurrence of the old libssl3 version across all dpkg metadata
# files (handles both /var/lib/dpkg/status and /var/lib/dpkg/status.d/* formats).
# The || true prevents a build failure when the distroless image ships a future
# version where this version string no longer appears.
RUN find /tmp/distroless-dpkg -type f \
      | xargs grep -l "3\.0\.18-1~deb12u2" 2>/dev/null \
      | xargs sed -i 's/3\.0\.18-1~deb12u2/3.0.19-1~deb12u2/g' \
    || true

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

# Overlay patched libssl3 (CVE-2026-28390 — fixed in 3.0.19-1~deb12u2).
# Replaces the vulnerable shared libraries bundled in the distroless base and
# overlays the patched dpkg metadata so Trivy reports the corrected version.
# Remove these three COPY lines (and stages 2.5a / 2.5b) once the distroless
# digest is rotated to include libssl3 >= 3.0.19-1~deb12u2.
COPY --from=security-patches /usr/lib/x86_64-linux-gnu/libssl.so.3    /usr/lib/x86_64-linux-gnu/libssl.so.3
COPY --from=security-patches /usr/lib/x86_64-linux-gnu/libcrypto.so.3 /usr/lib/x86_64-linux-gnu/libcrypto.so.3
COPY --from=security-patches /tmp/distroless-dpkg/                    /var/lib/dpkg/

EXPOSE 3000

# Exec-form required — distroless has no shell to expand shell-form commands.
# start-period must cover cold start (OTel, env, Fastify listen); interval allows
# timely transition starting → healthy once /health returns 200.
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=5 \
  CMD ["/nodejs/bin/node", "/app/healthcheck.js"]

CMD ["dist/server.js"]
