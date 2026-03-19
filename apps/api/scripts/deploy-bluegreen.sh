#!/bin/bash
set -euo pipefail

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

# Deployment root must be explicitly defined
DEPLOY_USER="${DEPLOY_USER:-$(whoami)}"
DEPLOY_ROOT="${DEPLOY_ROOT:-}"

if [ -z "$DEPLOY_ROOT" ]; then
    echo "ERROR: DEPLOY_ROOT environment variable must be set."
    echo "Example: export DEPLOY_ROOT=/home/ashish/FieldTrack-2.0"
    exit 1
fi

ENV_FILE="$DEPLOY_ROOT/apps/api/.env"
NGINX_CONF="/etc/nginx/sites-enabled/fieldtrack.conf"
NGINX_TEMPLATE="$REPO_DIR/infra/nginx/fieldtrack.conf"
ACTIVE_SLOT_FILE="$HOME/.fieldtrack-active-slot"
DEPLOY_HISTORY="$DEPLOY_ROOT/apps/api/.deploy_history"
MAX_HISTORY=5

MAX_HEALTH_ATTEMPTS=40
HEALTH_INTERVAL=3

# ---------------------------------------------------------------------------
# Pre-flight: resolve API_DOMAIN.
# Prefer the calling environment (CI sets it explicitly); fall back to the
# app .env file so direct VPS invocations work without exporting the var.
# ---------------------------------------------------------------------------
if [ -z "${API_DOMAIN:-}" ] && [ -f "$ENV_FILE" ]; then
    API_DOMAIN=$(grep -E '^API_DOMAIN=' "$ENV_FILE" | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
fi

if [ -z "${API_DOMAIN:-}" ]; then
    echo "ERROR: API_DOMAIN is not set and could not be read from $ENV_FILE. Deployment aborted."
    exit 1
fi

# Strip any scheme prefix (http:// or https://) — server_name only accepts bare hostnames.
API_DOMAIN="${API_DOMAIN#https://}"
API_DOMAIN="${API_DOMAIN#http://}"

# ---------------------------------------------------------------------------
# Pre-flight: validate API_DOMAIN is consistent with API_BASE_URL.
# Both values must agree on the hostname so nginx and the API agree on identity.
# Misconfiguration here causes subtle failures (wrong cert, wrong CORS, etc.)
# ---------------------------------------------------------------------------
if [ -f "$ENV_FILE" ]; then
    API_BASE_URL_VAL=$(grep -E '^API_BASE_URL=' "$ENV_FILE" 2>/dev/null | head -1 | cut -d'=' -f2- | tr -d '"' | tr -d "'")
    if [ -n "$API_BASE_URL_VAL" ]; then
        # Extract just the hostname from the URL (strips scheme + trailing slash/path).
        API_BASE_HOST="${API_BASE_URL_VAL#https://}"
        API_BASE_HOST="${API_BASE_HOST#http://}"
        API_BASE_HOST="${API_BASE_HOST%%/*}"
        if [ "$API_DOMAIN" != "$API_BASE_HOST" ]; then
            echo "ERROR: API_DOMAIN / API_BASE_URL mismatch — deployment aborted."
            echo "  API_DOMAIN:   $API_DOMAIN"
            echo "  API_BASE_URL: $API_BASE_URL_VAL  (resolved host: $API_BASE_HOST)"
            echo ""
            echo "API_DOMAIN must equal the hostname portion of API_BASE_URL."
            echo "Fix both values in $ENV_FILE before retrying."
            exit 1
        fi
        echo "✓ API_DOMAIN matches API_BASE_URL host ($API_DOMAIN)"
    fi
fi

# ---------------------------------------------------------------------------
# Pre-flight: validate METRICS_SCRAPE_TOKEN consistency.
# The token must match between API and Prometheus or scraping will silently
# fail and alerts will go blind. Fail fast here instead of deploying broken
# monitoring.
# ---------------------------------------------------------------------------
MONITORING_ENV_FILE="$REPO_DIR/infra/.env.monitoring"
if [ -f "$MONITORING_ENV_FILE" ]; then
    API_TOKEN=$(grep -E '^METRICS_SCRAPE_TOKEN=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    PROM_TOKEN=$(grep -E '^METRICS_SCRAPE_TOKEN=' "$MONITORING_ENV_FILE" 2>/dev/null | cut -d'=' -f2- | tr -d '"' | tr -d "'" || echo "")
    
    if [ -n "$API_TOKEN" ] && [ -n "$PROM_TOKEN" ] && [ "$API_TOKEN" != "$PROM_TOKEN" ]; then
        echo "ERROR: METRICS_SCRAPE_TOKEN mismatch detected!"
        echo "  API token:        $ENV_FILE"
        echo "  Prometheus token: $MONITORING_ENV_FILE"
        echo ""
        echo "These must be identical or Prometheus scraping will fail silently."
        echo "Update both files with the same token value."
        exit 1
    fi
    
    if [ -n "$API_TOKEN" ] && [ -z "$PROM_TOKEN" ]; then
        echo "WARNING: METRICS_SCRAPE_TOKEN set in API but not in Prometheus config."
        echo "Prometheus will fail to scrape metrics. Update $MONITORING_ENV_FILE"
    fi
fi

echo "========================================="
echo "FieldTrack Blue-Green Deployment Started"
echo "========================================="
echo "Image SHA: $IMAGE_SHA"

echo "[1/7] Pulling image..."
docker pull "$IMAGE"

echo "[2/7] Detecting active container..."

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

echo "[3/7] Starting inactive container..."

if docker ps -a --format '{{.Names}}' | grep -Eq "^${INACTIVE_NAME}$"; then
    docker rm -f "$INACTIVE_NAME"
fi

docker run -d \
  --name "$INACTIVE_NAME" \
  --network "$NETWORK" \
  -p "127.0.0.1:$INACTIVE_PORT:$APP_PORT" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  "$IMAGE"

echo "[4/7] Waiting for readiness check..."

# Give the server a moment to boot
sleep 5

ATTEMPT=0

until curl --max-time 2 -fs "http://127.0.0.1:$INACTIVE_PORT/ready" >/dev/null 2>&1; do
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

echo "[5/7] Switching nginx upstream..."

# Backup goes to /etc/nginx/ (not sites-enabled/) so nginx does not load it
# during validation and trigger a duplicate-upstream error.
NGINX_BACKUP="/etc/nginx/fieldtrack.conf.bak.$(date +%s)"
NGINX_TMP="$(mktemp /tmp/fieldtrack-nginx.XXXXXX.conf)"

# Generate a fresh nginx config from the repo template.
# Only __BACKEND_PORT__ and __API_DOMAIN__ are substituted — nothing else.
sed \
    -e "s|__BACKEND_PORT__|$INACTIVE_PORT|g" \
    -e "s|__API_DOMAIN__|$API_DOMAIN|g" \
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

echo "[6/7] Validating and reloading nginx..."

if ! sudo nginx -t 2>&1; then
    echo "ERROR: nginx configuration test failed. Restoring backup..."
    sudo cp "$NGINX_BACKUP" "$NGINX_CONF"
    echo "Backup restored. Deployment aborted."
    exit 1
fi

sudo systemctl reload nginx

# Persist new active slot so the next deploy reads it correctly
echo "$INACTIVE" > "$ACTIVE_SLOT_FILE"

echo "[7/7] Cleaning old container..."

docker rm -f "$ACTIVE_NAME" || true

echo "========================================="
echo "Deployment successful."
echo "$INACTIVE_NAME container is now LIVE."
echo "========================================="

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

