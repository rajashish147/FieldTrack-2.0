#!/usr/bin/env bash
set -euo pipefail
set -x
trap 'echo "❌ Failed at line $LINENO"' ERR

# ── CI Mode Support ────────────────────────────────────────────────────────────
# When CI_MODE=true, the script simulates deployment without side effects
CI_MODE="${CI_MODE:-false}"
SKIP_EXTERNAL_SERVICES="${SKIP_EXTERNAL_SERVICES:-false}"

# Safety guard: prevent production misuse
if [ "$CI_MODE" != "true" ] && [ "$SKIP_EXTERNAL_SERVICES" = "true" ]; then
    echo "❌ ERROR: SKIP_EXTERNAL_SERVICES=true is only allowed in CI_MODE"
    echo "   This would deploy a container without Redis/Supabase/BullMQ to production"
    exit 1
fi

if [ "$CI_MODE" = "true" ]; then
    echo "========================================="
    echo "CI MODE ENABLED"
    echo "Simulating deployment without side effects"
    if [ "$SKIP_EXTERNAL_SERVICES" = "true" ]; then
        echo "External services (Redis/Supabase/BullMQ) will be skipped"
    fi
    echo "========================================="
fi

IMAGE="ghcr.io/fieldtrack-tech/fieldtrack-backend:${1:-latest}"
IMAGE_SHA="${1:-latest}"

BLUE_NAME="backend-blue"
GREEN_NAME="backend-green"

BLUE_PORT=3001
GREEN_PORT=3002
APP_PORT=3000

NETWORK="fieldtrack_network"

# Resolve paths relative to this script so the deploy script works
# regardless of the working directory it is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# Load and validate environment.
# Sets: DEPLOY_ROOT, ENV_FILE, API_HOSTNAME.
# Exports all variables from apps/api/.env into this process.
# Disable trace to prevent secrets from leaking into logs.
set +x
source "$SCRIPT_DIR/load-env.sh"
set -x

NGINX_CONF="/etc/nginx/sites-enabled/fieldtrack.conf"
NGINX_TEMPLATE="$REPO_DIR/infra/nginx/fieldtrack.conf"
ACTIVE_SLOT_FILE="$HOME/.fieldtrack-active-slot"
DEPLOY_HISTORY="$DEPLOY_ROOT/apps/api/.deploy_history"
MAX_HISTORY=5

MAX_HEALTH_ATTEMPTS=40
HEALTH_INTERVAL=3

# API_HOSTNAME is already validated and exported by load-env.sh.
# It is the bare hostname derived from API_BASE_URL (e.g. api.fieldtrack.app).
echo "✓ API_HOSTNAME: $API_HOSTNAME"

# ---------------------------------------------------------------------------
# Pre-flight: full env contract validation.
# Covers required vars, API_BASE_URL format, API_HOSTNAME derivation, and
# METRICS_SCRAPE_TOKEN alignment between apps/api/.env and infra/.env.monitoring.
# validate-env.sh is self-sufficient (sources load-env.sh internally).
# Disable trace to prevent token values from leaking into logs.
# validate-env.sh exits non-zero on any failure — set -e aborts the deploy here.
# ---------------------------------------------------------------------------
echo "--- Pre-flight: env contract validation ---"
set +x
"$SCRIPT_DIR/validate-env.sh" --check-monitoring
set -x

echo "========================================="
echo "FieldTrack Blue-Green Deployment Started"
echo "========================================="
echo "Image SHA: $IMAGE_SHA"

echo "[1/8] Pulling image..."
if [ "$CI_MODE" = "true" ]; then
    echo "CI MODE: Skipping image pull (using local image)"
else
    docker pull "$IMAGE"
fi

echo "[2/8] Detecting active container..."

# Read active slot from state file (first deploy defaults to green → blue becomes inactive)
if [ -f "$ACTIVE_SLOT_FILE" ] && [ "$(cat "$ACTIVE_SLOT_FILE")" = "blue" ]; then
    ACTIVE="blue"
    ACTIVE_NAME=$BLUE_NAME
    ACTIVE_PORT=$BLUE_PORT

    INACTIVE="green"
    INACTIVE_NAME=$GREEN_NAME
    INACTIVE_PORT=$GREEN_PORT
else
    ACTIVE="green"
    ACTIVE_NAME=$GREEN_NAME
    ACTIVE_PORT=$GREEN_PORT

    INACTIVE="blue"
    INACTIVE_NAME=$BLUE_NAME
    INACTIVE_PORT=$BLUE_PORT
fi

echo "Active container   : $ACTIVE ($ACTIVE_PORT)"
echo "Inactive container : $INACTIVE ($INACTIVE_PORT)"

echo "[3/8] Starting inactive container..."

# CI MODE: Ensure Docker network exists
if [ "$CI_MODE" = "true" ]; then
    echo "CI MODE: Ensuring Docker network exists..."
    if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
        docker network create "$NETWORK"
        echo "✓ Created network: $NETWORK"
    else
        echo "✓ Network already exists: $NETWORK"
    fi
fi

if docker ps -a --format '{{.Names}}' | grep -Eq "^${INACTIVE_NAME}$"; then
    docker rm -f "$INACTIVE_NAME"
fi

docker run -d \
  --name "$INACTIVE_NAME" \
  --network "$NETWORK" \
  -p "127.0.0.1:$INACTIVE_PORT:$APP_PORT" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -e CI_MODE="${CI_MODE:-false}" \
  -e SKIP_EXTERNAL_SERVICES="${SKIP_EXTERNAL_SERVICES:-false}" \
  "$IMAGE"

echo "[4/8] Waiting for readiness check..."

# Give the server a moment to boot
sleep 5

ATTEMPT=0

# CI MODE: Use /health (no dependencies)
# Production: Use /ready (validates Redis, Supabase, BullMQ)
if [ "$CI_MODE" = "true" ]; then
    HEALTH_ENDPOINT="/health"
else
    HEALTH_ENDPOINT="/ready"
fi

until curl --max-time 2 -fs "http://127.0.0.1:$INACTIVE_PORT$HEALTH_ENDPOINT" >/dev/null 2>&1; do
    ATTEMPT=$((ATTEMPT+1))

    # Check if container crashed during health check
    if ! docker ps --format '{{.Names}}' | grep -q "^${INACTIVE_NAME}$"; then
        echo "ERROR: Container $INACTIVE_NAME stopped unexpectedly during readiness check."
        echo "===== Container logs ($INACTIVE_NAME) ====="
        docker logs "$INACTIVE_NAME" --tail 100 || true
        echo "==========================================="
        echo "Rolling back — removing failed container..."
        docker rm -f "$INACTIVE_NAME" || true
        exit 1
    fi

    if [ "$ATTEMPT" -ge "$MAX_HEALTH_ATTEMPTS" ]; then
        echo "Readiness check failed after $MAX_HEALTH_ATTEMPTS attempts."
        echo "Endpoint: http://127.0.0.1:$INACTIVE_PORT$HEALTH_ENDPOINT"

        echo "===== Container logs ($INACTIVE_NAME) ====="
        docker logs "$INACTIVE_NAME" --tail 100 || true
        echo "==========================================="

        echo "Rolling back — removing failed container..."
        docker rm -f "$INACTIVE_NAME" || true
        exit 1
    fi

    echo "  Attempt $ATTEMPT/$MAX_HEALTH_ATTEMPTS — waiting ${HEALTH_INTERVAL}s..."
    sleep "$HEALTH_INTERVAL"
done

echo "Readiness check passed."

echo "[5/8] Switching nginx upstream..."

if [ "$CI_MODE" = "true" ]; then
    echo "CI MODE: Skipping nginx configuration (no side effects)"
else
    # Backup goes to /etc/nginx/ (not sites-enabled/) so nginx does not load it
    # during validation and trigger a duplicate-upstream error.
    NGINX_BACKUP="/etc/nginx/fieldtrack.conf.bak.$(date +%s)"
    NGINX_TMP="$(mktemp /tmp/fieldtrack-nginx.XXXXXX.conf)"

    # Generate a fresh nginx config from the repo template.
    # Only __BACKEND_PORT__ and __API_HOSTNAME__ are substituted — nothing else.
    sed \
        -e "s|__BACKEND_PORT__|$INACTIVE_PORT|g" \
        -e "s|__API_HOSTNAME__|$API_HOSTNAME|g" \
        "$NGINX_TEMPLATE" > "$NGINX_TMP"

    # Save the current live config so we can restore it if validation fails.
    sudo cp "$NGINX_CONF" "$NGINX_BACKUP"

    # Install the generated config.
    sudo cp "$NGINX_TMP" "$NGINX_CONF"
    rm -f "$NGINX_TMP"

    # Remove any stale backup files that were accidentally left in sites-enabled/
    # by previous deployments. Nginx loads all files in this directory and a
    # leftover backup defines a duplicate upstream, failing the config test.
    sudo rm -f /etc/nginx/sites-enabled/fieldtrack.conf.bak.*
fi

echo "[6/8] Validating and reloading nginx..."

if [ "$CI_MODE" = "true" ]; then
    echo "CI MODE: Skipping nginx reload (no side effects)"
else
    if ! sudo nginx -t 2>&1; then
        echo "ERROR: nginx configuration test failed. Restoring backup..."
        sudo cp "$NGINX_BACKUP" "$NGINX_CONF"
        echo "Backup restored. Deployment aborted."
        exit 1
    fi

    sudo systemctl reload nginx

    # Persist new active slot so the next deploy reads it correctly
    echo "$INACTIVE" > "$ACTIVE_SLOT_FILE"
fi

echo "[7/8] Post-deploy public health check..."

if [ "$CI_MODE" = "true" ]; then
    echo "CI MODE: Skipping public health check (DNS/TLS not available in CI)"
    echo "✓ Internal health check already passed in step 4"
else
    # Dual validation strategy:
    #   1. Internal check (127.0.0.1:$INACTIVE_PORT/health or /ready) — already passed in step 4
    #      This is the source of truth: container is healthy and serving traffic.
    #   2. External check (https://$API_HOSTNAME/health) — validates edge routing
    #      Tests TLS, DNS, nginx upstream, and firewall. Failure here triggers rollback
    #      because the container is unreachable from the internet despite being healthy.
    #
    # Brief settle time — nginx needs a moment to apply the new upstream config
    # before forwarding connections cleanly.
    sleep 3
    _PUBLIC_HEALTH_URL="https://$API_HOSTNAME/health"
    echo "  Probing: $_PUBLIC_HEALTH_URL"
    _PUBLIC_CHECK_PASSED=false
    for _attempt in 1 2 3; do
        if curl --max-time 10 -fsS "$_PUBLIC_HEALTH_URL" >/dev/null 2>&1; then
            _PUBLIC_CHECK_PASSED=true
            break
        fi
        echo "  Attempt $_attempt/3 failed — waiting 5s..."
        sleep 5
    done

    if [ "$_PUBLIC_CHECK_PASSED" != "true" ]; then
        echo "❌ POST-DEPLOY PUBLIC HEALTH CHECK FAILED: $_PUBLIC_HEALTH_URL"
        echo "   Container passed internal readiness but is not reachable publicly."
        echo "   Possible causes: TLS cert, DNS, nginx upstream config, firewall."
        echo ""
        echo "   Restoring previous nginx config and slot..."
        sudo cp "$NGINX_BACKUP" "$NGINX_CONF"
        if sudo nginx -t 2>&1 && sudo systemctl reload nginx; then
            echo "   ✓ Previous nginx config restored."
        else
            echo "   ⚠ Could not restore nginx config automatically — check manually."
        fi
        echo "$ACTIVE" > "$ACTIVE_SLOT_FILE"
        docker rm -f "$INACTIVE_NAME" || true
        # Auto-rollback to previous image — but only if this deploy is not itself
        # an auto-rollback, to prevent an infinite loop:
        #   deploy → fail → rollback.sh → deploy(prev) → fail → (stop here)
        if [ "${FIELDTRACK_ROLLBACK_IN_PROGRESS:-0}" != "1" ]; then
            echo ""
            echo "Triggering automatic rollback to previous stable image..."
            export FIELDTRACK_ROLLBACK_IN_PROGRESS=1
            if ! "$SCRIPT_DIR/rollback.sh" --auto; then
                echo ""
                echo "========================================="
                echo "❌ CRITICAL: ROLLBACK FAILED"
                echo "========================================="
                echo "Both deployment and automatic rollback have failed."
                echo "System state: UNDEFINED"
                echo "Manual intervention required immediately."
                echo "========================================="
                exit 2
            fi
        else
            echo "Already in rollback sequence — stopping without recursive rollback."
        fi
        exit 1
    fi
    unset _PUBLIC_HEALTH_URL _PUBLIC_CHECK_PASSED _attempt
    echo "✓ Public health check passed."
fi

echo "[8/8] Cleaning old container..."

if [ "$CI_MODE" = "true" ]; then
    echo "CI MODE: Skipping old container cleanup (no active container in CI)"
else
    docker rm -f "$ACTIVE_NAME" || true
fi

echo "========================================="
echo "Deployment successful."
echo "$INACTIVE_NAME container is now LIVE."
echo "========================================="

if [ "$CI_MODE" = "true" ]; then
    echo "CI MODE: Skipping deploy history and monitoring stack updates"
    echo "✓ CI deployment simulation completed successfully"
    exit 0
fi

# Record successful deployment for rollback capability
# Maintain history of last MAX_HISTORY deployments
# Use atomic write to prevent partial history corruption
DEPLOY_HISTORY_TMP="${DEPLOY_HISTORY}.tmp.$$"
if [ -f "$DEPLOY_HISTORY" ]; then
    # Prepend new SHA and keep only MAX_HISTORY entries
    (echo "$IMAGE_SHA"; head -n $((MAX_HISTORY - 1)) "$DEPLOY_HISTORY") > "$DEPLOY_HISTORY_TMP"
    mv "$DEPLOY_HISTORY_TMP" "$DEPLOY_HISTORY"
else
    # Create new history file
    echo "$IMAGE_SHA" > "$DEPLOY_HISTORY_TMP"
    mv "$DEPLOY_HISTORY_TMP" "$DEPLOY_HISTORY"
fi

echo "Deployment history updated: $IMAGE_SHA"

# ---------------------------------------------------------------------------
# Monitoring stack: only restart when infra configs have actually changed.
# Hash covers all infra config files INCLUDING docker-compose.monitoring.yml.
# EXCLUDES only nginx template (nginx is rerendered on every deploy above
# and does not require a monitoring restart).
# ---------------------------------------------------------------------------
echo "[monitoring] Checking monitoring stack configuration..."
MONITORING_HASH=$(find "$REPO_DIR/infra" -readable \
    -not -path "$REPO_DIR/infra/nginx/*" \
    \( -name '*.yml' -o -name '*.yaml' -o -name '*.conf' -o -name '*.toml' -o -name '*.json' \) \
    | sort | xargs -r sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 || echo "changed")
MONITORING_HASH_FILE="$HOME/.fieldtrack-monitoring-hash"
if [ -f "$MONITORING_HASH_FILE" ] && [ "$(cat "$MONITORING_HASH_FILE")" = "$MONITORING_HASH" ]; then
    echo "[monitoring] Configuration unchanged — skipping restart."
else
    echo "[monitoring] Configuration changed — restarting monitoring stack..."
    # cd into infra/ so relative volume paths in docker-compose.monitoring.yml
    # (./loki/, ./prometheus/, ./promtail/, ./grafana/) resolve to the correct
    # infra subdirectories regardless of where this script was invoked from.
    cd "$REPO_DIR/infra"
    docker compose --env-file .env.monitoring -f docker-compose.monitoring.yml pull --quiet
    docker compose --env-file .env.monitoring -f docker-compose.monitoring.yml up -d --remove-orphans
    cd "$REPO_DIR"
    echo "$MONITORING_HASH" > "$MONITORING_HASH_FILE"
    echo "[monitoring] Monitoring stack restarted."
fi

