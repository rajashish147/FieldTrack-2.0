#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# load-env.sh — Centralised environment loader for FieldTrack deploy scripts
#
# Source this file at the start of every deploy/rollback script:
#   source "$(dirname "${BASH_SOURCE[0]}")/load-env.sh"
#
# After sourcing, the following are exported into the caller's environment:
#   DEPLOY_ROOT    — absolute path to the repository root on the VPS
#   ENV_FILE       — absolute path to apps/api/.env
#   API_HOSTNAME   — bare hostname derived from API_BASE_URL (no scheme/path)
#
# All KEY=VALUE pairs from apps/api/.env are also exported into the caller's
# process, so downstream scripts can reference any app env var directly.
# ---------------------------------------------------------------------------
set -euo pipefail

# Disable trace to prevent secrets from leaking into logs
set +x 2>/dev/null || true

# Derive repo root from this script's own location so the loader works
# regardless of the current working directory when it is sourced.
_LES_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
_LES_REPO="$(cd "$_LES_DIR/../../.." && pwd)"

# ── DEPLOY_ROOT ─────────────────────────────────────────────────────────────
# Prefer an already-exported value (e.g. set explicitly by the CI SSH step);
# fall back to the path inferred from this script's own location on the VPS.
export DEPLOY_ROOT="${DEPLOY_ROOT:-$_LES_REPO}"

# ── ENV_FILE ─────────────────────────────────────────────────────────────────
export ENV_FILE="$DEPLOY_ROOT/apps/api/.env"

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ Required .env file not found: $ENV_FILE"
    echo "   Create it from apps/api/.env.example and populate all required values."
    exit 1
fi
echo "✓ .env file exists: $ENV_FILE"

# ── Load all variables from .env ─────────────────────────────────────────────
# allexport is enabled so every KEY=VALUE assignment is automatically exported;
# disabled immediately after to avoid exporting any later shell variables.
set -o allexport
# shellcheck source=/dev/null
source "$ENV_FILE"
set +o allexport

# ── Validate required variables ──────────────────────────────────────────────
_LES_MISSING=""
for _LES_VAR in API_BASE_URL CORS_ORIGIN; do
    eval "_LES_VAL=\"\${${_LES_VAR}:-}\""
    if [ -z "$_LES_VAL" ]; then
        _LES_MISSING="${_LES_MISSING}  - ${_LES_VAR}\n"
    fi
done

if [ -n "$_LES_MISSING" ]; then
    echo "❌ Missing required variables in $ENV_FILE:"
    printf "%b" "$_LES_MISSING"
    exit 1
fi

echo "✓ API_BASE_URL is set"
echo "✓ CORS_ORIGIN is set"

# ── Derive API_HOSTNAME from API_BASE_URL ────────────────────────────────────
# Use bash-safe parsing (no Node.js dependency for VPS compatibility)
# Strip protocol (http:// or https://) and take first path segment
API_HOSTNAME=$(echo "$API_BASE_URL" | sed -E 's|^https?://||' | cut -d'/' -f1)

# Validate: result must be a non-empty bare hostname (or host:port).
# Reject if it contains whitespace, path separators, credential markers (@),
# or query/fragment characters — any of these indicate a malformed API_BASE_URL.
if [ -z "$API_HOSTNAME" ] || printf '%s' "$API_HOSTNAME" | grep -qE '[[:space:]/@?#]'; then
    echo "❌ Invalid API_HOSTNAME derived from API_BASE_URL='$API_BASE_URL'"
    echo "   Expected a bare hostname or host:port — e.g.: api.example.com"
    echo "   Got: '$API_HOSTNAME'"
    echo "   Check that API_BASE_URL has no embedded credentials, spaces, or bare paths."
    exit 1
fi

export API_HOSTNAME
echo "✓ API_HOSTNAME: $API_HOSTNAME"

# Clean up internal variables so they do not leak into the caller's scope.
unset _LES_DIR _LES_REPO _LES_VAR _LES_VAL _LES_MISSING
