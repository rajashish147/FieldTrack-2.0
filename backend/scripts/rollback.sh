#!/usr/bin/env bash
set -euo pipefail

DEPLOY_HISTORY="/home/ashish/FieldTrack-2.0/backend/.deploy_history"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

AUTO_MODE=false

if [[ "${1:-}" == "--auto" ]]; then
  AUTO_MODE=true
fi

echo "========================================="
echo "FieldTrack Rollback System"
echo "========================================="

# Check if deployment history exists
if [ ! -f "$DEPLOY_HISTORY" ]; then
    echo "ERROR: No deployment history found."
    echo "File not found: $DEPLOY_HISTORY"
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

"$SCRIPT_DIR/deploy-bluegreen.sh" "$PREVIOUS_SHA"

echo ""
echo "========================================="
echo "Rollback completed successfully"
echo "Production now running: $PREVIOUS_SHA"
echo "========================================="
