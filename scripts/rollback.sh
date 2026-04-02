#!/usr/bin/env bash
set -euo pipefail
set -x
trap '[[ "${BASH_COMMAND}" != _ft_log* ]] && printf "[DEPLOY] ts=%s state=ROLLBACK level=ERROR msg=\"rollback script failed at line %s\"\n" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$LINENO"' ERR

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Load and validate environment.
# Sets: DEPLOY_ROOT, ENV_FILE, API_HOSTNAME.
# Exports all variables from .env into this process.
# Disable trace to prevent secrets from leaking into logs.
set +x
source "$SCRIPT_DIR/load-env.sh"
set -x

DEPLOY_HISTORY="$DEPLOY_ROOT/.deploy_history"

AUTO_MODE=false

if [[ "${1:-}" == "--auto" ]]; then
  AUTO_MODE=true
fi

echo "========================================="
echo "FieldTrack Rollback System"
echo "========================================="

# Check if deployment history exists and validate checksum
if [ ! -f "$DEPLOY_HISTORY" ]; then
    echo "ERROR: No deployment history found."
    echo "File not found: $DEPLOY_HISTORY"
    exit 1
fi

# Validate deployment history file integrity
if [ ! -s "$DEPLOY_HISTORY" ]; then
    echo "ERROR: Deployment history file is empty or corrupted."
    exit 1
fi

mapfile -t HISTORY < "$DEPLOY_HISTORY"

if [ ${#HISTORY[@]} -lt 2 ]; then
    echo "ERROR: Need at least two deployments to rollback."
    exit 1
fi

CURRENT_SHA="${HISTORY[0]}"
PREVIOUS_SHA="${HISTORY[1]}"

echo "Current deployment : $CURRENT_SHA"
echo "Rollback target    : $PREVIOUS_SHA"
echo ""

# Validate that the rollback image exists in the registry
echo "Validating rollback image exists..."
if ! docker manifest inspect "ghcr.io/fieldtrack-tech/api:$PREVIOUS_SHA" >/dev/null 2>&1; then
    echo "ERROR: Rollback image not found in registry."
    echo "Image: ghcr.io/fieldtrack-tech/api:$PREVIOUS_SHA"
    echo "Cannot proceed with rollback to non-existent image."
    exit 1
fi
echo "✓ Rollback image verified in registry."
echo ""

if [ "$AUTO_MODE" = false ]; then
  echo "⚠️  WARNING: This will replace the current deployment."
  read -p "Continue with rollback? (yes/no): " -r

  if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
      echo "Rollback cancelled."
      exit 0
  fi
else
  echo "Auto rollback mode enabled (CI)."
fi

echo ""
echo "Starting rollback to: $PREVIOUS_SHA"
echo ""

# Set guard to prevent infinite rollback loops
export API_ROLLBACK_IN_PROGRESS=1

# Attempt rollback deploy
if ! "$SCRIPT_DIR/deploy-bluegreen.sh" "$PREVIOUS_SHA"; then
    echo ""
    echo "========================================="
    echo "❌ CRITICAL: ROLLBACK FAILED"
    echo "========================================="
    echo "Both deployment and rollback have failed."
    echo ""
    echo "SYSTEM STATE SNAPSHOT:"
    echo "  Active containers:"
    docker ps --format '  {{.Names}} → {{.Status}} ({{.Ports}})' 2>/dev/null || echo "  (docker ps failed)"
    echo "  Active slot file: $(cat "/var/run/api/active-slot" 2>/dev/null || echo 'MISSING')"
    echo "  Nginx config test: $(sudo nginx -t 2>&1)"
    echo ""
    echo "Target SHA:    $PREVIOUS_SHA"
    echo ""
    echo "Action required:"
    echo "  1. Check container status: docker ps -a"
    echo "  2. Check nginx config: sudo nginx -t"
    echo "  3. Review logs: docker logs api-blue api-green"
    echo "  4. Manually restore last known good state"
    echo "========================================="
    exit 2
fi

echo ""
echo "========================================="
echo "Rollback completed successfully"
echo "Production now running: $PREVIOUS_SHA"
echo "========================================="
