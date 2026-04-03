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
#   - Ports 80 or 443 occupied by ANY non-docker-proxy, non-nginx process
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
RUNTIME_DIR="/var/run/api"
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
  fail "DEPLOY_ROOT not found: $DEPLOY_ROOT — VPS may not be provisioned. Run vps-setup.sh first."
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
# ── AUTO-FIX: Kill ghost docker-proxy processes that may hold stale ports ──────
#
# docker-proxy processes can linger after container removal and hold ports
# 80/443 as ghosts. They are safe to kill (Docker recreates them as needed).
echo ""
echo "--- AUTO-FIX: ghost docker-proxy cleanup ---"
if pgrep -x docker-proxy >/dev/null 2>&1; then
  warn "Ghost docker-proxy processes detected — killing stale port holders."
  sudo pkill -x docker-proxy 2>/dev/null || true
  sleep 1
  ok "Ghost docker-proxy processes cleared."
else
  ok "No ghost docker-proxy processes."
fi
# ── CHECK 4: Ports 80 and 443 — no non-docker processes ──────────────────────
#
# Design: we do NOT auto-kill unknown processes. If port 80 or 443 is held by
# a non-docker process (e.g., system nginx, apache, lighttpd), that is a VPS
# configuration error that requires operator action. Silently killing unknown
# processes risks breaking the system in unpredictable ways.
#
# Allowed occupants (hard-coded safe list):
#   - docker-proxy  (managed by Docker / our nginx container)
#   - nginx         (running as Docker container — docker exec nginx)
#
# Everything else → hard fail with diagnostics.
echo ""
echo "--- CHECK 4: Port 80/443 — no non-docker processes ---"
_check_port() {
  local port="$1"

  # Check if anything is listening on the port at all
  if ! ss -tlnp "sport = :${port}" 2>/dev/null | grep -q 'LISTEN'; then
    ok "Port $port is free."
    return 0
  fi

  # Check for non-docker-proxy, non-nginx processes via lsof
  # lsof -i :PORT lists ALL processes holding the port.
  # We exclude docker-proxy and nginx (expected Docker-managed processes).
  NON_DOCKER=$(sudo lsof -i ":${port}" -sTCP:LISTEN -P -n 2>/dev/null \
    | awk 'NR>1 {print $1, $2}' \
    | grep -vE '^(docker-pro|nginx)' || true)

  if [ -n "$NON_DOCKER" ]; then
    record_failure "Port $port is occupied by a non-docker process."
    echo "  Offending process(es):"
    sudo lsof -i ":${port}" -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR>1' | sed 's/^/    /'
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
  fi
done

# .env.monitoring is optional (monitoring-sync.sh self-heals from example)
if [ ! -f "$DEPLOY_ROOT/infra/.env.monitoring" ]; then
  warn ".env.monitoring not found — monitoring-sync.sh will create it from example during deploy."
fi

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

# ── CHECK 8: Nginx live config directory ──────────────────────────────────────
echo ""
echo "--- CHECK 8: Nginx live config directory ---"
NGINX_LIVE_DIR="$DEPLOY_ROOT/infra/nginx/live"
NGINX_BACKUP_DIR="$DEPLOY_ROOT/infra/nginx/backup"

for dir in "$NGINX_LIVE_DIR" "$NGINX_BACKUP_DIR"; do
  if [ ! -d "$dir" ]; then
    warn "Nginx directory missing: $dir — creating it."
    mkdir -p "$dir"
    ok "Created: $dir"
  else
    ok "Directory exists: $dir"
  fi
done

# ── CHECK 9: Network attachment for expected containers ───────────────────────
#
# If nginx, prometheus, grafana, or alertmanager are running, they MUST be
# attached to api_network. If they're not, Docker DNS resolution will fail
# and api-blue/api-green will be unreachable by name.
echo ""
echo "--- CHECK 9: Network attachment enforcement ---"
NETWORK_REQUIRED=(nginx prometheus grafana alertmanager)
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

# ── CHECK 10: Disk space (warn if < 2GB free) ──────────────────────────────────
echo ""
echo "--- CHECK 10: Disk space ---"
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
