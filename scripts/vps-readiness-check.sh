#!/bin/bash
# ============================================================================
# FieldTrack API — VPS Readiness Check
# ============================================================================
#
# Validates VPS state before a blue-green deployment is allowed to proceed.
# Invoked by the vps-readiness-check job in deploy.yml via SSH.
#
# SAFE AUTO-FIXES (non-destructive):
#   - Creates api_network if missing
#   - Creates missing deploy-time directories
#   - Auto-prunes docker images if disk is low
#
# HARD FAILURES (exit 1):
#   - Docker daemon not running
#   - Ports 80 or 443 occupied by processes other than docker-proxy / nginx
#   - Any container has host port bindings (violates production architecture)
#   - Required containers not attached to api_network
#   - Required .env file missing
#   - DEPLOY_ROOT does not exist
#
# USAGE:
#   Called automatically by deploy.yml.
#   Can be run manually: bash scripts/vps-readiness-check.sh
#
# EXIT CODES:
#   0 — VPS is ready (all checks passed, auto-fixes applied as needed)
#   1 — VPS is NOT ready (hard failure, deployment must not proceed)
#
# ============================================================================

set -euo pipefail

DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/api}"
NETWORK="api_network"
RUNTIME_DIR="/var/lib/fieldtrack"
LOG_DIR="/var/log/api"

# ── Colour helpers ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'
ok()   { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
fail() { echo -e "${RED}[✗]${NC} $1"; exit 1; }

FAILURES=0
record_failure() { echo -e "${RED}[FAIL]${NC} $1"; FAILURES=$((FAILURES + 1)); }

echo ""
echo "============================================="
echo "  VPS Readiness Check"
echo "  $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "============================================="
echo ""

# ── CHECK 1: DEPLOY_ROOT exists ────────────────────────────────────────────────
echo "--- CHECK 1: Deploy root directory ---"
if [ ! -d "$DEPLOY_ROOT" ]; then
  fail "DEPLOY_ROOT not found: $DEPLOY_ROOT — ensure infra bootstrap has been run and DEPLOY_ROOT is correct."
fi
ok "DEPLOY_ROOT exists: $DEPLOY_ROOT"

# ── CHECK 2: Docker daemon running ─────────────────────────────────────────────
echo ""
echo "--- CHECK 2: Docker daemon ---"
if ! docker info >/dev/null 2>&1; then
  record_failure "Docker daemon is not running."
  echo "  Attempting to start Docker..."
  if sudo systemctl start docker 2>/dev/null && sleep 3 && docker info >/dev/null 2>&1; then
    ok "Docker started successfully."
  else
    fail "Docker daemon could not be started. VPS is not ready."
  fi
else
  ok "Docker daemon is running."
fi

# ── CHECK 3: api_network exists (auto-fix: create if missing) ──────────────────
echo ""
echo "--- CHECK 3: Docker network '$NETWORK' ---"
if ! docker network ls --format '{{.Name}}' | grep -Eq "^${NETWORK}$"; then
  warn "Network '$NETWORK' not found — creating it."
  docker network create --driver bridge "$NETWORK"
  ok "Network '$NETWORK' created."
else
  ok "Network '$NETWORK' exists."
fi
# ── CHECK 4: Ports 80 and 443 — expected listeners only ─────────────────────
#
# Design: we do NOT auto-kill unknown processes. Published container ports show
# up as docker-proxy (full name in `ss -tlnp`; lsof often truncates COMMAND to
# 8 chars e.g. "docker-pr", which broke older allowlists).
#
# Use ss (same as elsewhere in this script) and allow:
#   - docker-proxy / docker-pr (truncated) — Docker publishing nginx :80/:443
#   - nginx — system or container worker name in ss output
#
# Everything else on these ports → hard fail (e.g. apache bind-mount).
echo ""
echo "--- CHECK 4: Port 80/443 — docker-proxy / nginx only ---"
_check_port() {
  local port="$1"
  local listeners
  listeners=$(sudo ss -tlnp "sport = :${port}" 2>/dev/null || ss -tlnp "sport = :${port}" 2>/dev/null || true)

  if ! echo "$listeners" | grep -q 'LISTEN'; then
    ok "Port $port is free."
    return 0
  fi

  # Any LISTEN line that does not reference an allowed process is a failure.
  if echo "$listeners" | grep 'LISTEN' | grep -Ev 'docker-proxy|docker-pr|nginx' | grep -q .; then
    record_failure "Port $port is occupied by an unexpected process (not docker-proxy/nginx)."
    echo "  Listeners (ss -tlnp sport = :${port}):"
    echo "$listeners" | sed 's/^/    /'
    echo "  This is a VPS configuration error. Stop the conflicting service before deploying."
    echo "  Example: sudo systemctl stop nginx  OR  sudo systemctl stop apache2"
    return 1
  fi

  ok "Port $port is held by docker-proxy/nginx (expected)."
  return 0
}

_check_port 80
_check_port 443

# ── CHECK 5: No host port bindings on API containers ────────────────────────
#
# Production architecture invariant: api-blue and api-green MUST NOT bind host
# ports. All inter-service communication uses Docker DNS on api_network.
#
# nginx is EXEMPT: it intentionally binds 0.0.0.0:80 and 0.0.0.0:443 to receive
# external traffic from Cloudflare. That is the intended, correct behaviour.
#
# Only api-blue and api-green are checked. Exposing these containers on host ports
# would bypass the nginx layer and could expose the API without TLS or rate-limiting.
echo ""
echo "--- CHECK 5: API container host port binding invariant ---"
BOUND=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
  | grep -E '^api-(blue|green) ' \
  | grep -E '(0\.0\.0\.0:|127\.0\.0\.1:)[0-9]+->' || true)

if [ -n "$BOUND" ]; then
  record_failure "API container has host port bindings — violates production architecture:"
  echo "$BOUND" | sed 's/^/  /'
  echo "  Production pattern: api-blue/api-green run --network api_network without -p."
  echo "  Remove and recreate the offending container(s) without port bindings."
else
  ok "No host port bindings on API containers (api-blue/api-green)."
fi

# ── CHECK 6: Required env files ────────────────────────────────────────────────
echo ""
echo "--- CHECK 6: Required environment files ---"
cd "$DEPLOY_ROOT"

REQUIRED_ENV_FILES=(
  ".env"
)

for f in "${REQUIRED_ENV_FILES[@]}"; do
  if [ ! -f "$DEPLOY_ROOT/$f" ]; then
    record_failure "Required env file missing: $DEPLOY_ROOT/$f"
    echo "  This file must be created on the VPS before deployment."
    echo "  See docs/env-contract.md for required variables."
  else
    ok "Env file present: $f"
    # Env contract spot-check: verify critical variables are set (not empty).
    # A valid .env file existence alone is insufficient — missing values cause
    # the API to start then crash after nginx has already been reloaded.
    for var in API_BASE_URL CORS_ORIGIN; do
      if ! grep -qE "^${var}=.+" "$DEPLOY_ROOT/$f" 2>/dev/null; then
        record_failure "Env contract violation: '$var' is missing or empty in $DEPLOY_ROOT/$f"
        echo "  See docs/env-contract.md for required variables."
      fi
    done
    ok "Env contract spot-check passed (API_BASE_URL, CORS_ORIGIN present)."
  fi
done

API_BASE_URL_VALUE="$(grep -E '^API_BASE_URL=' "$DEPLOY_ROOT/.env" 2>/dev/null | head -1 | cut -d'=' -f2- || true)"
API_HOSTNAME="${API_HOSTNAME:-$(printf '%s' "$API_BASE_URL_VALUE" | sed -E 's|^https?://||' | cut -d'/' -f1)}"

# ── CHECK 7: Runtime state directories ────────────────────────────────────────
echo ""
echo "--- CHECK 7: Runtime directories ---"

for dir in "$RUNTIME_DIR" "$LOG_DIR"; do
  if [ ! -d "$dir" ]; then
    warn "Runtime directory missing: $dir — creating it."
    install -d -m 750 "$dir" 2>/dev/null || sudo install -d -m 750 "$dir"
    ok "Created: $dir"
  else
    ok "Directory exists: $dir"
  fi
done

# ── CHECK 8: Network attachment enforcement ───────────────────────────────────
#
# If nginx is running, it MUST be
# attached to api_network. If they're not, Docker DNS resolution will fail
# and api-blue/api-green will be unreachable by name.
echo ""
echo "--- CHECK 8: Network attachment enforcement ---"
NETWORK_REQUIRED=(nginx)
for c in "${NETWORK_REQUIRED[@]}"; do
  if docker inspect "$c" >/dev/null 2>&1; then
    if ! docker inspect "$c" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
         2>/dev/null | grep -q 'api_network'; then
      record_failure "Container '$c' is running but NOT attached to api_network."
      echo "  Docker DNS (container name resolution) requires api_network attachment."
      echo "  Fix: docker network connect api_network $c"
    else
      ok "$c is attached to api_network."
    fi
  else
    ok "$c not running — skipping network check."
  fi
done

# ── CHECK 9: Nginx container exists and is reachable ─────────────────────────
#
# nginx is the sole entry point for all API traffic (Cloudflare → nginx → api).
# Deploying without a running, reachable nginx means zero traffic will reach
# the new container even after a successful switch.
#
# Hard failure: nginx container must exist before deployment is allowed.
# Note: reachability check is advisory (nginx may not serve requests until
# an API container is first deployed).
echo ""
echo "--- CHECK 9: Nginx container ---"
if ! docker inspect nginx >/dev/null 2>&1; then
  record_failure "nginx container not found — required for deployment routing."
  echo "  nginx must be running before deploy can proceed."
  echo "  Fix: docker compose -f docker-compose.nginx.yml up -d"
else
  ok "nginx container exists."
  # Advisory in-network health probe — nginx may return non-200 before
  # first API deploy (upstream not yet configured), so warn but don't fail.
  FT_CURL_IMG="curlimages/curl:8.7.1"
  if [ -z "${API_HOSTNAME}" ]; then
    warn "Skipping advisory nginx probe because API_HOSTNAME could not be derived from .env."
  elif docker run --rm --network api_network "$FT_CURL_IMG" \
       -skf --max-time 5 -H "Host: ${API_HOSTNAME}" "https://nginx/health" >/dev/null 2>&1 \
     || docker run --rm --network api_network "$FT_CURL_IMG" \
       -sf --max-time 5 -H "Host: ${API_HOSTNAME}" "http://nginx/health" >/dev/null 2>&1; then
    ok "nginx is reachable on api_network with Host=${API_HOSTNAME}."
  else
    warn "nginx running but health probe returned non-2xx — may be normal before first API deploy."
  fi
fi

# ── CHECK 10: Redis reachability (if redis container is running) ───────────────
#
# If a Redis container named 'redis' is running, validate it is attached to
# api_network and responding to PING. Workers will fail to start if Redis is
# present but unreachable via Docker DNS.
echo ""
echo "--- CHECK 10: Redis (if running) ---"
if docker inspect redis >/dev/null 2>&1; then
  if ! docker inspect redis \
       --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
       2>/dev/null | grep -q 'api_network'; then
    record_failure "redis container is running but NOT attached to api_network."
    echo "  Fix: docker network connect api_network redis"
  else
    if docker exec redis redis-cli ping 2>/dev/null | grep -q PONG; then
      ok "Redis is reachable on api_network."
    else
      record_failure "redis container is running on api_network but not responding to PING."
      echo "  Check redis container logs: docker logs redis"
    fi
  fi
else
  ok "Redis container not running — skipping check (validated at application startup)."
fi

# ── CHECK 11: Disk space (warn if < 2GB free) ———————————————————————————————
echo ""
echo "--- CHECK 11: Disk space ---"
FREE_KB=$(df -k / | awk 'NR==2 {print $4}')
FREE_GB=$(awk "BEGIN {printf \"%.1f\", $FREE_KB/1024/1024}")
if [ "$FREE_KB" -lt 2097152 ]; then
  warn "Low disk space: ${FREE_GB}GB free (< 2GB). Pruning unused Docker images."
  docker image prune -f --filter "until=48h" >/dev/null 2>&1 || true
  FREE_KB_AFTER=$(df -k / | awk 'NR==2 {print $4}')
  FREE_GB_AFTER=$(awk "BEGIN {printf \"%.1f\", $FREE_KB_AFTER/1024/1024}")
  ok "After prune: ${FREE_GB_AFTER}GB free."
  if [ "$FREE_KB_AFTER" -lt 1048576 ]; then
    record_failure "Critically low disk space: ${FREE_GB_AFTER}GB free after prune. Cannot deploy safely."
  fi
else
  ok "Disk space OK: ${FREE_GB}GB free."
fi

# ── FINAL RESULT ───────────────────────────────────────────────────────────────
echo ""
echo "============================================="
if [ "$FAILURES" -eq 0 ]; then
  echo -e "${GREEN}  VPS READY — all checks passed${NC}"
  echo "============================================="
  echo ""
  exit 0
else
  echo -e "${RED}  VPS NOT READY — $FAILURES check(s) failed${NC}"
  echo "  Deployment must not proceed."
  echo "============================================="
  echo ""
  exit 1
fi
