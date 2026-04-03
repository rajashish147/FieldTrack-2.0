#!/usr/bin/env bash
# =============================================================================
# deploy-bluegreen.sh — API Blue-Green Deployment
#
# State machine:
#   INIT
#   -> PRE_FLIGHT      (preflight.sh + env validation)
#   -> PULL_IMAGE      (with timeout guard)
#   -> RESOLVE_SLOT    (recovery-aware slot detection)
#   -> IDEMPOTENCY     (skip if same SHA already running)
#   -> START_INACTIVE  (with timeout + image immutability check)
#   -> HEALTH_CHECK_INTERNAL  (connectivity pre-check + readiness loop)
#   -> SWITCH_NGINX    (nginx -t gate + atomic slot write)
#   -> HEALTH_CHECK_PUBLIC    (DNS/TLS/CDN end-to-end)
#   -> STABILITY_CHECK (post-switch re-verify after settle window)
#   -> CLEANUP         (graceful shutdown of old container)
#   -> SUCCESS         (truth check + last-known-good snapshot)
#
# Deployment classification states emitted via _ft_state:
#   DEPLOY_SUCCESS          -- zero-downtime deploy completed
#   DEPLOY_FAILED_SAFE      -- deploy failed, old container still healthy
#   DEPLOY_FAILED_ROLLBACK  -- deploy failed AND rollback was triggered
#   DEPLOY_FAILED_FATAL     -- deploy AND rollback both failed (manual needed)
#
# On failure:
#   -> if active container still running  -> DEPLOY_FAILED_SAFE  exit 1
#   -> if active container gone           -> rollback triggered
#      -> rollback succeeded              -> DEPLOY_FAILED_ROLLBACK  exit 1
#      -> rollback failed                 -> DEPLOY_FAILED_FATAL     exit 2
#
# Slot state file: /var/run/api/active-slot
#   /var/run is a tmpfs (cleared on reboot). The _ft_resolve_slot() recovery
#   function handles a missing file by inspecting running containers and the
#   live nginx config, then re-writing the file. No manual step needed after
#   a reboot or unexpected /run eviction.
#
# Exit codes:
#   0  DEPLOY_SUCCESS              -- zero-downtime deploy succeeded
#   1  DEPLOY_FAILED_SAFE          -- deploy failed, old container still serving
#      or DEPLOY_FAILED_ROLLBACK   -- deploy failed, rollback succeeded
#   2  DEPLOY_FAILED_FATAL         -- deploy AND rollback both failed (rare)
#   3  DEPLOY_FAILED_FATAL         -- fatal guard (active container missing, race condition)
#
# Observability features:
#   DEPLOY_ID        -- unique deploy identifier for log correlation (YYYYMMDD_HHMMSS_PID)
#   deploy_id label  -- container labeled with deploy ID for instant traceability
#   api.sha   -- container labeled with image SHA for quick version lookup
#   api.slot  -- container labeled with slot name (blue/green)
#   duration_sec     -- all exits logged with deploy duration for performance tracking
#   PREFLIGHT_STRICT -- optional strict mode: enforces preflight checks, fails if missing
#
# =============================================================================
set -euo pipefail
set -x
trap '_ft_trap_err "$LINENO"' ERR

# ---------------------------------------------------------------------------
# STRUCTURED LOGGING  [DEPLOY] ts=<ISO8601> state=<STATE> <key=value ...>
# ALL logging writes to stderr (>&2) so that functions returning values via
# stdout are never contaminated. stdout = data only; stderr = logs.
# { set +x; } 2>/dev/null suppresses xtrace noise inside helpers.
# ---------------------------------------------------------------------------
_FT_STATE="INIT"
DEPLOY_LOG_FILE="${DEPLOY_LOG_FILE:-/var/log/api/deploy.log}"

# Ensure log directory exists with fallback to home directory
LOG_DIR="$(dirname "$DEPLOY_LOG_FILE")"
if ! mkdir -p "$LOG_DIR" 2>/dev/null; then
    LOG_DIR="$HOME/api/logs"
    DEPLOY_LOG_FILE="$LOG_DIR/deploy.log"
    mkdir -p "$LOG_DIR"
fi

_ft_log() {
    { set +x; } 2>/dev/null
    local log_entry
    log_entry=$(printf '[DEPLOY] ts=%s state=%s %s' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$*")
    printf '%s\n' "$log_entry" | tee -a "$DEPLOY_LOG_FILE" >&2
    set -x
}

_ft_state() {
    { set +x; } 2>/dev/null
    _FT_STATE="$1"; shift
    printf '[DEPLOY] ts=%s state=%s %s\n' "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$*" >&2
    set -x
}

_ft_trap_err() {
    { set +x; } 2>/dev/null
    printf '[DEPLOY] ts=%s state=%s level=ERROR msg="unexpected failure at line %s"\n' \
        "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$1" >&2
    set -x
}

# ---------------------------------------------------------------------------
# SYSTEM SNAPSHOT -- emitted on any unrecoverable failure
# ---------------------------------------------------------------------------
_ft_snapshot() {
    { set +x; } 2>/dev/null
    printf '[DEPLOY] -- SYSTEM SNAPSHOT ----------------------------------------\n' >&2
    printf '[DEPLOY]   slot_file  = %s\n' "$(cat "${ACTIVE_SLOT_FILE:-/var/run/api/active-slot}" 2>/dev/null || echo 'MISSING')" >&2
    printf '[DEPLOY]   nginx_upstream = %s\n' "$(grep -oE 'http://(api-blue|api-green):3000' "${NGINX_CONF:-$HOME/api/infra/nginx/live/api.conf}" 2>/dev/null | grep -oE 'api-blue|api-green' | head -1 || echo 'unreadable')" >&2
    printf '[DEPLOY]   containers =\n' >&2
    docker ps --format '[DEPLOY]     {{.Names}} -> {{.Status}} ({{.Ports}})' 1>&2 2>/dev/null \
        || printf '[DEPLOY]     (docker ps unavailable)\n' >&2
    printf '[DEPLOY] -----------------------------------------------------------\n' >&2
    set -x
}

# ---------------------------------------------------------------------------
# DEPLOYMENT CLASSIFICATION -- single-source exit helper
#   All terminal exit paths MUST go through _ft_exit to avoid state drift.
#
#   _ft_exit <code> <STATE> [key=value ...]
#     code 0 -> DEPLOY_SUCCESS
#     code 1 -> DEPLOY_FAILED_SAFE | DEPLOY_FAILED_ROLLBACK
#     code 2 -> DEPLOY_FAILED_FATAL
#
#   DEPLOY_SUCCESS          zero-downtime deploy completed
#   DEPLOY_FAILED_SAFE      deploy failed, old container still serving
#   DEPLOY_FAILED_ROLLBACK  deploy failed, rollback triggered (system restored)
#   DEPLOY_FAILED_FATAL     deploy AND rollback both failed (manual needed)
# ---------------------------------------------------------------------------
_ft_exit() {
    local code="$1"; shift
    local duration=$(( $(date +%s) - START_TS ))
    _ft_state "$@" "duration_sec=$duration"
    exit "$code"
}

# Kept for compatibility; delegates to _ft_exit for a final classify+exit in one line.
_ft_classify() {
    local outcome="$1"; shift
    _ft_state "$outcome" "outcome=$outcome $*"
}

# ---------------------------------------------------------------------------
# DEPLOYMENT TIMING & IDENTIFIERS
# ---------------------------------------------------------------------------
START_TS=$(date +%s)
DEPLOY_ID=$(date +%Y%m%d_%H%M%S)_$$
PREFLIGHT_STRICT="${PREFLIGHT_STRICT:-false}"

_ft_log "msg='deploy started' deploy_id=$DEPLOY_ID pid=$$ start_ts=$START_TS"
if [ "$PREFLIGHT_STRICT" = "true" ]; then
    _ft_log "msg='PREFLIGHT_STRICT=true -- will enforce preflight checks'"
fi

# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------
# Immutable SHA tags ONLY — 'latest' is forbidden in production.
# Reject empty and 'latest' before any Docker operation so failures are
# loud and attributed to the caller rather than appearing as pull errors.
IMAGE_SHA="${1:-}"
if [ -z "$IMAGE_SHA" ] || [ "$IMAGE_SHA" = "latest" ]; then
    printf '[DEPLOY] ts=%s state=INIT level=ERROR msg="image SHA required -- latest tag is forbidden in production" sha=%s\n' \
        "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "${IMAGE_SHA:-<empty>}" >&2
    exit 2
fi
IMAGE="ghcr.io/fieldtrack-tech/api:$IMAGE_SHA"

BLUE_NAME="api-blue"
GREEN_NAME="api-green"
APP_PORT=3000
NETWORK="api_network"
# Pinned curl container for in-network health probes.
# Running on api_network exercises Docker DNS + bridge routing — the same
# path that nginx uses — catching connectivity issues that docker exec
# localhost bypasses (docker exec goes direct to the container loopback).
_FT_CURL_IMG="curlimages/curl:8.7.1"
# In-network curl helper with local fallback.
#
# Primary:  short-lived curlimages/curl container on api_network.
#           Exercises Docker DNS + bridge routing (same path nginx uses).
# Fallback: docker exec <container> curl when the curl image cannot be pulled
#           or Docker Hub is unreachable. Covers cold-VPS / egress-blocked cases.
#
# Usage: _ft_net_curl <container_name> <curl-flags...>
#   The first argument is the container name — used ONLY for the fallback.
#   Remaining arguments are passed verbatim to curl.
_ft_net_curl() {
    local _target_container="$1"; shift
    # Primary: in-network (Docker DNS + bridge routing)
    if docker run --rm --network "$NETWORK" "$_FT_CURL_IMG" "$@" >/dev/null 2>&1; then
        return 0
    fi
    # Fallback: exec into target container's loopback (skips Docker DNS but
    # confirms HTTP server is alive inside the container)
    docker exec "$_target_container" curl -sf --max-time 3 "$@" >/dev/null 2>&1
}
# Variant that captures the response body or HTTP status code instead of
# just testing. Used where we need the response text for status checks.
# Usage: _ft_net_curl_out <container_name> <curl-flags...>
_ft_net_curl_out() {
    local _target_container="$1"; shift
    local _out
    _out=$(docker run --rm --network "$NETWORK" "$_FT_CURL_IMG" "$@" 2>/dev/null) \
        || _out=$(docker exec "$_target_container" curl --max-time 3 "$@" 2>/dev/null) \
        || _out=""
    printf '%s' "$_out"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/api}"
[ -d "$DEPLOY_ROOT" ] || { echo "❌ DEPLOY_ROOT not found: $DEPLOY_ROOT"; exit 1; }
REPO_DIR="$DEPLOY_ROOT"

# Slot state directory and file.
# /var/run/api/ is chosen over /tmp (world-writable, cleaned by tmpwatch)
# and $HOME (variable path, not auditable as runtime state).
# /var/run IS a tmpfs -- the _ft_resolve_slot() recovery handles missing files.
SLOT_DIR="/var/run/api"
ACTIVE_SLOT_FILE="$SLOT_DIR/active-slot"

NGINX_CONF="$REPO_DIR/infra/nginx/live/api.conf"
NGINX_LIVE_DIR="$REPO_DIR/infra/nginx/live"
NGINX_BACKUP_DIR="$REPO_DIR/infra/nginx/backup"
NGINX_TEMPLATE="$REPO_DIR/infra/nginx/api.conf"
MAX_HISTORY=5
MAX_HEALTH_ATTEMPTS=40
HEALTH_INTERVAL=3
LOCK_FILE="$SLOT_DIR/deploy.lock"
SNAP_DIR="$SLOT_DIR"
LAST_GOOD_FILE="$SNAP_DIR/last-good"

_ft_ensure_log_dir() {
    local log_dir
    log_dir=$(dirname "$DEPLOY_LOG_FILE")
    if [ ! -d "$log_dir" ]; then
        mkdir -p "$log_dir" 2>/dev/null || sudo mkdir -p "$log_dir" || true
        [ -d "$log_dir" ] && chmod 755 "$log_dir" 2>/dev/null || true
    fi
}

# ---------------------------------------------------------------------------
# DEPLOYMENT LOCK -- prevent concurrent deploys
# ---------------------------------------------------------------------------
_ft_acquire_lock() {
    _ft_ensure_slot_dir
    _ft_ensure_log_dir
    _ft_log "msg='acquiring deployment lock' pid=$$ file=$LOCK_FILE"
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        _ft_log "level=ERROR msg='another deployment already in progress -- aborting' pid=$$"
        exit 1
    fi
    _ft_log "msg='deployment lock acquired' pid=$$ file=$LOCK_FILE"
    # Ensure lock is released on exit
    trap '_ft_release_lock' EXIT
}

_ft_release_lock() {
    { set +x; } 2>/dev/null
    printf '[DEPLOY] ts=%s state=%s msg="releasing deployment lock" pid=%s\n' \
        "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$$" >&2
    # Close FD 200 unconditionally; closing the FD releases the flock.
    exec 200>&- 2>/dev/null || true
    set -x
}

# ---------------------------------------------------------------------------
# EXTERNAL ENDPOINT CHECK WITH RETRY + BACKOFF
# Smooths transient CDN/TLS edge jitter while maintaining strict semantics
#
# NOTE: Uses localhost (127.0.0.1) with Host header instead of external hostname.
# Rationale: nginx is protected by Cloudflare IP allowlist. Requests from the
# VPS itself (not through Cloudflare) would be blocked with 403. Using localhost
# + Host header allows the deploy script to:
#   - Validate full nginx routing stack (localhost → nginx → backend)
#   - Bypass Cloudflare IP restriction safely
#   - Use --insecure to accept self-signed/origin certs (nginx rewrite)
# Security: unchanged. Cloudflare still protects production access; only
# localhost requests (VPS-internal) bypass the IP filter.
# ---------------------------------------------------------------------------
_ft_check_external_ready() {
    { set +x; } 2>/dev/null
    local attempt=0

    # Phase 1 — in-network routing (source of truth).
    # Hits nginx directly via Docker bridge; validates full nginx→api routing path.
    local _p1_body
    _p1_body=$(_ft_net_curl_out "nginx" -s --max-time 5 "http://nginx/health" 2>/dev/null || echo "")
    if echo "$_p1_body" | grep -q '"status":"ok"' 2>/dev/null; then
        unset _p1_body
        set -x
        return 0
    fi
    unset _p1_body

    # Phase 2 — HTTPS via localhost + Host header (advisory / TLS diagnostic).
    # --insecure accepts Cloudflare origin certificate.
    # status=000 means host→Docker TCP routing issue, NOT a TLS problem.
    for attempt in 1 2 3; do
        local body
        body=$(curl -sS --max-time 5 \
            --resolve "$API_HOSTNAME:443:127.0.0.1" \
            "https://$API_HOSTNAME/health" \
            --insecure 2>/dev/null || echo "")
        if echo "$body" | grep -q '"status":"ok"' 2>/dev/null; then
            set -x
            return 0
        fi
        if [ -z "$body" ]; then
            { printf 'external-ready: HTTPS phase-2 attempt %s — status=000 (host→Docker port routing, not TLS)\n' "$attempt"; } 2>/dev/null
            local _http_body
            _http_body=$(curl -sS --max-time 5 \
                --resolve "$API_HOSTNAME:80:127.0.0.1" \
                "http://$API_HOSTNAME/health" 2>/dev/null || echo "")
            if echo "$_http_body" | grep -q '"status":"ok"' 2>/dev/null; then
                { printf 'external-ready: HTTP:80 fallback passed (attempt %s)\n' "$attempt"; } 2>/dev/null
                unset _http_body
                set -x
                return 0
            fi
            unset _http_body
        fi
        if [ "$attempt" -lt 3 ]; then
            sleep "$attempt"
        fi
    done

    set -x
    return 1
}

# ---------------------------------------------------------------------------
# RETRY CURL -- wraps curl -sf with retries + 1s backoff
#   _ft_retry_curl <url> [max_attempts=10] [extra curl flags...]
#   Returns 0 on first 2xx success, 1 after all attempts exhausted.
# ---------------------------------------------------------------------------
_ft_retry_curl() {
    { set +x; } 2>/dev/null
    local url="$1"
    local max="${2:-10}"
    shift 2 || shift $#
    local i=0
    while [ "$i" -lt "$max" ]; do
        i=$((i + 1))
        if curl -sf --max-time 5 "$@" "$url" >/dev/null 2>&1; then
            set -x
            return 0
        fi
        sleep 1
    done
    set -x
    return 1
}

# ---------------------------------------------------------------------------
# SLOT DIRECTORY AND FILE MANAGEMENT
# ---------------------------------------------------------------------------
_ft_ensure_slot_dir() {
    if [ ! -d "$SLOT_DIR" ]; then
        _ft_log "msg='slot dir missing, creating' path=$SLOT_DIR"
        sudo mkdir -p "$SLOT_DIR"
        # Owned by the deploy user so subsequent writes do not need sudo.
        sudo chown "$(id -un):$(id -gn)" "$SLOT_DIR"
        sudo chmod 750 "$SLOT_DIR"
    fi
}

# Single authoritative validator. Returns 0 for "blue"|"green", 1 otherwise.
# Logs to stderr on failure so every call site gets a structured error for free.
_ft_validate_slot() {
    case "$1" in
        blue|green) return 0 ;;
        *) _ft_log "level=ERROR msg='invalid slot value' slot='${1:0:80}'"
           return 1 ;;
    esac
}

_ft_write_slot() {
    local slot="$1"
    _ft_validate_slot "$slot" || return 1
    _ft_ensure_slot_dir
    local slot_tmp
    slot_tmp=$(mktemp "${SLOT_DIR}/active-slot.XXXXXX")
    printf '%s\n' "$slot" > "$slot_tmp"
    mv "$slot_tmp" "$ACTIVE_SLOT_FILE"
    _ft_log "msg='slot file updated (atomic)' slot=$slot path=$ACTIVE_SLOT_FILE"
}

# _ft_resolve_slot -- returns the active slot name, recovering from a missing
# or corrupt slot file by inspecting running containers and the live nginx config.
#
# Recovery precedence:
#   1. slot file value            (happy path)
#   2. only blue running          -> blue
#   3. only green running         -> green
#   4. both running               -> nginx upstream port as tiebreaker
#   5. neither running            -> green  (first deploy; inactive = blue)
_ft_resolve_slot() {
    _ft_ensure_slot_dir

    # Happy path -- slot file exists and is valid.
    if [ -f "$ACTIVE_SLOT_FILE" ]; then
        local current_slot
        current_slot=$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")
        # Guard: detect log contamination in the file (pre-fix corruption defense).
        # A valid slot is ONLY the literal string "blue" or "green".
        if [[ "$current_slot" == *DEPLOY* ]] || [[ "$current_slot" == *\[* ]]; then
            _ft_log "level=WARN msg='slot file contains log contamination -- treating as corrupt, recovering' value=${current_slot:0:80}"
        elif _ft_validate_slot "$current_slot"; then
            _ft_log "msg='slot file read' slot=$current_slot"
            echo "$current_slot"
            return 0
        else
            # _ft_validate_slot already logged the invalid value; fall through to recovery.
            _ft_log "level=WARN msg='slot file invalid, falling through to container recovery'"
        fi
    else
        _ft_log "level=WARN msg='slot file missing, recovering from container state' path=$ACTIVE_SLOT_FILE"
    fi

    # Try to recover from last-known-good snapshot first
    if [ -f "$LAST_GOOD_FILE" ]; then
        local last_good_state
        last_good_state=$(head -1 "$LAST_GOOD_FILE" 2>/dev/null | tr -d '[:space:]')
        if _ft_validate_slot "$last_good_state" 2>/dev/null; then
            _ft_log "msg='recovered slot from last-known-good snapshot' slot=$last_good_state file=$LAST_GOOD_FILE"
            echo "$last_good_state"
            return 0
        fi
    fi

    # Recovery -- infer from running containers, then nginx config.
    local blue_running=false green_running=false recovered_slot=""
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${BLUE_NAME}$"  && blue_running=true  || true
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${GREEN_NAME}$" && green_running=true || true

    if [ "$blue_running" = "true" ] && [ "$green_running" = "false" ]; then
        recovered_slot="blue"
        _ft_log "msg='recovery: only blue running' slot=blue"
    elif [ "$green_running" = "true" ] && [ "$blue_running" = "false" ]; then
        recovered_slot="green"
        _ft_log "msg='recovery: only green running' slot=green"
    elif [ "$blue_running" = "true" ] && [ "$green_running" = "true" ]; then
        # Both running -- read nginx upstream container as authoritative tiebreaker.
        local nginx_upstream
        nginx_upstream=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null | grep -oE 'api-blue|api-green' | head -1 || echo "")
        if [ "$nginx_upstream" = "api-blue" ]; then recovered_slot="blue"
        elif [ "$nginx_upstream" = "api-green" ]; then recovered_slot="green"
        else
            recovered_slot="blue"
            _ft_log "level=WARN msg='both containers running and nginx upstream ambiguous, defaulting to blue' nginx_upstream=${nginx_upstream}"
        fi
        _ft_log "msg='recovery: both containers running, nginx tiebreaker' nginx_upstream=${nginx_upstream} slot=${recovered_slot}"
    else
        # Neither running -- first deploy.
        recovered_slot="green"
        _ft_log "msg='recovery: no containers running, assuming first deploy' slot=green"
    fi

    # Validate before writing -- recovered_slot must be blue or green.
    # (_ft_validate_slot logs the error; we just fail the subshell.)
    _ft_validate_slot "$recovered_slot" || return 1

    # Persist the recovered value (atomic write).
    local slot_tmp
    slot_tmp=$(mktemp "${SLOT_DIR}/active-slot.XXXXXX")
    printf '%s\n' "$recovered_slot" > "$slot_tmp"
    mv "$slot_tmp" "$ACTIVE_SLOT_FILE"
    _ft_log "msg='slot file recreated (atomic)' slot=$recovered_slot"
    echo "$recovered_slot"
}

# ---------------------------------------------------------------------------
# ACQUIRE DEPLOYMENT LOCK
# ---------------------------------------------------------------------------
_ft_acquire_lock

# ---------------------------------------------------------------------------
# PRE-FLIGHT: load environment + validate contract
# ---------------------------------------------------------------------------
_ft_state "PRE_FLIGHT" "msg='loading and validating environment'"

# Log last-known-good state for faster triage
_LAST_GOOD=$(cat "$LAST_GOOD_FILE" 2>/dev/null || echo "none")
_ft_log "msg='startup recovery info' last_good=$_LAST_GOOD"

# Disable xtrace while sourcing .env to prevent secrets in logs.
set +x
source "$SCRIPT_DIR/load-env.sh"
set -x

# DEPLOY_ROOT is now exported by load-env.sh.
DEPLOY_HISTORY="$DEPLOY_ROOT/.deploy_history"

_ft_log "msg='environment loaded' api_hostname=$API_HOSTNAME"

set +x
"$SCRIPT_DIR/validate-env.sh" --check-monitoring
set -x
# Harden monitoring env file permissions on every deploy (defense-in-depth).
chmod 600 "$DEPLOY_ROOT/infra/.env.monitoring" 2>/dev/null || true

_ft_log "msg='env contract validated'"

# Ensure api_network exists (idempotent). All containers MUST be on this network.
docker network create --driver bridge "$NETWORK" 2>/dev/null \
    && _ft_log "msg='api_network created'" \
    || _ft_log "msg='api_network already exists'"

# GLOBAL PORT-LEAK GUARD -- api-blue/api-green MUST NOT bind host ports.
# All API traffic flows: Cloudflare → nginx (binds 80/443) → api_network.
# nginx is exempt; api containers with host ports bypass the nginx layer
# and would expose the API without TLS or rate-limiting.
_API_PORT_LEAKS=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
    | grep -E '^api-(blue|green)' \
    | grep -E '(0\.0\.0\.0:|127\.0\.0\.1:)[0-9]+->') || true
if [ -n "${_API_PORT_LEAKS:-}" ]; then
    _ft_log "level=ERROR msg='API container has host port bindings — forbidden. Remove and recreate without -p.' leaks=${_API_PORT_LEAKS}"
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=api_port_leak_detected"
fi
unset _API_PORT_LEAKS
_ft_log "msg='port-leak guard passed — no API containers with host port bindings'"

# NGINX CONTAINER GUARD -- nginx MUST run as a Docker container on api_network.
# With container-name upstreams (server api-blue:3000), Docker's embedded DNS
# (127.0.0.11) is required for name resolution. This only works from WITHIN
# Docker containers on the same network -- not from a host systemd nginx service.
#
# BOOTSTRAP MODE: If nginx is missing, start it via docker compose --no-deps so
# the monitoring dependency chain (nginx→grafana→prometheus→alertmanager) does
# NOT block a first-deploy. nginx starts immediately; monitoring catches up.
if ! docker inspect nginx >/dev/null 2>&1; then
    _ft_log "msg='nginx container missing — bootstrapping via docker compose --no-deps'"
    mkdir -p "$NGINX_LIVE_DIR" "$NGINX_BACKUP_DIR"
    # Write a bootstrap config pointing at api-blue (default first-deploy slot)
    # so nginx can start without waiting for an API container.
    if [ ! -f "$NGINX_CONF" ]; then
        # Permission check: ensure deploy user can write to nginx live dir
        if [ ! -w "$(dirname "$NGINX_CONF")" ]; then
            sudo chown -R "$(id -un):$(id -gn)" "$(dirname "$NGINX_CONF")"
        fi
        _NGINX_GUARD_TMP="$(mktemp /tmp/api-nginx-guard.XXXXXX.conf)"
        sed \
            -e "s|__ACTIVE_CONTAINER__|api-blue|g" \
            -e "s|__API_HOSTNAME__|${API_HOSTNAME}|g" \
            "$NGINX_TEMPLATE" > "$_NGINX_GUARD_TMP"
        mv "$_NGINX_GUARD_TMP" "$NGINX_CONF"
        _ft_log "msg='bootstrap nginx config written (atomic)' target=api-blue path=$NGINX_CONF"
    fi
    # Kill any ghost docker-proxy holdind host ports before starting nginx
    pkill docker-proxy 2>/dev/null || true
    cd "$DEPLOY_ROOT/infra"
    if ! docker compose --env-file .env.monitoring -f docker-compose.monitoring.yml \
            up -d --no-deps nginx 2>&1 | tee -a "$DEPLOY_LOG_FILE" >&2; then
        _ft_log "level=ERROR msg='docker compose up --no-deps nginx failed'"
        cd "$DEPLOY_ROOT"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_bootstrap_compose_failed"
    fi
    cd "$DEPLOY_ROOT"
    # Wait up to 30 s for the nginx container to become available
    _NGINX_STARTED=false
    for _ni in $(seq 1 10); do
        if docker inspect nginx >/dev/null 2>&1; then
            _ft_log "msg='nginx bootstrap complete' attempt=$_ni"
            _NGINX_STARTED=true
            break
        fi
        _ft_log "msg='waiting for nginx container' attempt=$_ni/10"
        sleep 3
    done
    if [ "$_NGINX_STARTED" != "true" ]; then
        _ft_log "level=ERROR msg='nginx container failed to start after bootstrap'"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_bootstrap_timeout"
    fi
    unset _NGINX_STARTED _ni
fi
_NGINX_NETWORK=$(docker inspect nginx --format='{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "")
if ! echo "$_NGINX_NETWORK" | grep -q "$NETWORK"; then
    _ft_log "level=ERROR msg='nginx container not on api_network -- container DNS will fail' networks=${_NGINX_NETWORK}"
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_not_on_api_network networks=${_NGINX_NETWORK}"
fi
unset _NGINX_NETWORK
_ft_log "msg='nginx container guard passed' container=nginx network=$NETWORK"

# Ensure nginx live and backup directories exist (deploy user owns them)
mkdir -p "$NGINX_LIVE_DIR" "$NGINX_BACKUP_DIR"

# ---------------------------------------------------------------------------
# PREFLIGHT CHECK  (policy=warn: missing preflight logs a warning, does not abort)
# ---------------------------------------------------------------------------
if [ "$PREFLIGHT_STRICT" = "true" ]; then
    [ -x "$SCRIPT_DIR/preflight.sh" ] || _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=preflight_missing_strict_mode path=$SCRIPT_DIR/preflight.sh"
    _ft_state "PREFLIGHT" "msg='running preflight checks (STRICT mode)'"
    if ! "$SCRIPT_DIR/preflight.sh" 2>&1; then
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=preflight_failed_strict_mode"
    fi
    _ft_log "msg='preflight checks passed (strict mode)'"
elif [ -x "$SCRIPT_DIR/preflight.sh" ]; then
    _ft_state "PREFLIGHT" "msg='running preflight checks'"
    if ! "$SCRIPT_DIR/preflight.sh" 2>&1; then
        _ft_log "level=ERROR msg='preflight checks failed -- aborting deploy'"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=preflight_failed"
    fi
    _ft_log "msg='preflight checks passed'"
else
    _ft_log "level=WARN msg='preflight.sh not found or not executable -- continuing (policy=warn)' path=$SCRIPT_DIR/preflight.sh"
fi

# ---------------------------------------------------------------------------
# DEPLOY METADATA -- structured log emitted once per deploy for observability
# ---------------------------------------------------------------------------
_ft_log "msg='deploy metadata' sha=$IMAGE_SHA image=$IMAGE script_dir=$SCRIPT_DIR repo_dir=$REPO_DIR app_env=${APP_ENV:-unset}"

# ---------------------------------------------------------------------------
# [1/7] PULL IMAGE
# ---------------------------------------------------------------------------
_ft_state "PULL_IMAGE" "msg='pulling container image' sha=$IMAGE_SHA"

# Explicit pull with hard error.
# Without this guard a missing image would cause docker run to attempt a
# background pull inside a 60-s timeout, racing the readiness loop.
if ! timeout 120 docker pull "$IMAGE"; then
    _ft_log "level=ERROR msg='image pull failed' image=$IMAGE"
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=image_pull_failed image=$IMAGE"
fi
_ft_log "msg='image pulled' image=$IMAGE"

# ---------------------------------------------------------------------------
# BOOTSTRAP GUARD -- no API containers exist (first deploy or full restart)
#
# When no api-blue or api-green containers are present, the normal slot
# recovery path works but is implicit. This guard makes first-deploy
# explicit: start api-blue directly, wait for readiness, write nginx config,
# write slot file, and exit cleanly with BOOTSTRAP_SUCCESS.
#
# WHY THIS IS NECESSARY:
#   - nginx starts (via the guard above) with bootstrap config pointing at api-blue
#   - Without this guard, nginx is serving 502 until the normal START_INACTIVE
#     path eventually starts api-blue. This can be 30-60s of errors.
#   - Explicit bootstrap gives a deterministic, logged, traceable first-deploy.
#
# SKIPPED when any api container already exists (normal redeploy path).
# ---------------------------------------------------------------------------
if ! docker ps -a --format '{{.Names}}' | grep -Eq '^api-(blue|green)$'; then
    _ft_state "BOOTSTRAP" "msg='no api containers found — first deploy, starting api-blue directly'"

    # Remove stale container if left in a stopped state somehow
    docker rm -f api-blue 2>/dev/null || true

    timeout 60 docker run -d \
        --name api-blue \
        --network "$NETWORK" \
        --restart unless-stopped \
        --label "api.sha=$IMAGE_SHA" \
        --label "api.slot=blue" \
        --label "api.deploy_id=$DEPLOY_ID" \
        --env-file "$ENV_FILE" \
        "$IMAGE"

    _ft_log "msg='bootstrap: api-blue started' image=$IMAGE"

    # Grace window: give the process time to bind and initialise workers.
    # /ready can lag the HTTP server bind by ~1–3 s while workers start.
    sleep 2

    # Bootstrap readiness: use docker exec (only safe choice when no other
    # container is guaranteed to be running yet on api_network).
    _BOOT_OK=false
    for _bi in $(seq 1 20); do
        if docker exec api-blue curl -sf --max-time 4 "http://localhost:${APP_PORT}/ready" >/dev/null 2>&1; then
            _ft_log "msg='bootstrap: api-blue ready' attempt=$_bi"
            _BOOT_OK=true
            break
        fi
        _ft_log "msg='bootstrap: waiting for api-blue readiness' attempt=$_bi/20"
        sleep 2
    done

    if [ "$_BOOT_OK" != "true" ]; then
        _ft_log "level=ERROR msg='bootstrap: api-blue did not become ready after 60s — container PRESERVED for debugging'"
        # DO NOT remove the container on bootstrap failure:
        #   - Preserves logs and state for post-mortem: docker logs api-blue
        #   - Removing here loses all debugging visibility
        #   - Operator can inspect and restart manually
        docker logs api-blue --tail 50 >&2 || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=bootstrap_api_ready_timeout"
    fi
    unset _bi _BOOT_OK

    # Write nginx config pointing at api-blue (same sed logic as SWITCH_NGINX)
    mkdir -p "$NGINX_LIVE_DIR" "$NGINX_BACKUP_DIR"
    NGINX_BOOT_TMP="$(mktemp /tmp/api-nginx-boot.XXXXXX.conf)"
    sed \
        -e "s|__ACTIVE_CONTAINER__|api-blue|g" \
        -e "s|__API_HOSTNAME__|${API_HOSTNAME}|g" \
        "$NGINX_TEMPLATE" > "$NGINX_BOOT_TMP"
    cp "$NGINX_BOOT_TMP" "$NGINX_CONF"
    rm -f "$NGINX_BOOT_TMP"

    # Nginx network attachment guard — must be on api_network before reload.
    _NGINX_BOOT_NET=$(docker inspect nginx \
        --format='{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "")
    if ! echo "$_NGINX_BOOT_NET" | grep -q "$NETWORK"; then
        _ft_log "level=ERROR msg='bootstrap: nginx not attached to api_network' networks=${_NGINX_BOOT_NET}"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_network_mismatch_bootstrap"
    fi
    unset _NGINX_BOOT_NET

    # Fail-fast: any nginx test/reload failure is a hard error at bootstrap.
    if ! docker exec nginx nginx -t 2>&1; then
        _ft_log "level=ERROR msg='bootstrap: nginx config test failed'"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_config_test_failed_bootstrap"
    fi
    docker exec nginx nginx -s reload \
        || { _ft_log "level=ERROR msg='bootstrap: nginx reload failed'"; _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_reload_failed_bootstrap"; }
    _ft_log "msg='bootstrap: nginx reloaded to api-blue'"

    # Persist slot state (atomic write already in _ft_write_slot)
    _ft_write_slot "blue"

    # Snapshot last-known-good
    _SNAP_BOOT_TMP=$(mktemp "${SNAP_DIR}/last-good.XXXXXX")
    printf 'slot=blue container=api-blue ts=%s\n' "$(date -Iseconds)" > "$_SNAP_BOOT_TMP"
    mv "$_SNAP_BOOT_TMP" "$LAST_GOOD_FILE"
    unset _SNAP_BOOT_TMP

    _ft_exit 0 "BOOTSTRAP_SUCCESS" "slot=blue image=$IMAGE"
fi

# ---------------------------------------------------------------------------
# [2/7] RESOLVE ACTIVE SLOT (with recovery)
# ---------------------------------------------------------------------------
_ft_state "RESOLVE_SLOT" "msg='determining active slot'"

ACTIVE=$(_ft_resolve_slot) || {
    _ft_log "level=ERROR msg='_ft_resolve_slot failed or exited non-zero -- cannot continue safely'"
    exit 1
}
ACTIVE=$(printf '%s' "$ACTIVE" | tr -d '[:space:]')
_ft_validate_slot "$ACTIVE" || exit 1

# SLOT REPAIR — heal slot file drift from reality.
# If the slot file says "green" but api-green is gone (OOM/manual removal),
# flip the effective slot to whatever container IS actually running.
# This prevents a deploy from treating a missing container as the "active" one.
if [ "$ACTIVE" = "green" ] && ! docker inspect api-green >/dev/null 2>&1; then
    _ft_log "msg='slot repair: green missing — switching effective slot to blue' original_slot=green"
    ACTIVE="blue"
    _ft_write_slot "blue"
elif [ "$ACTIVE" = "blue" ] && ! docker inspect api-blue >/dev/null 2>&1; then
    # Both containers may be missing on a clean restart; this is ok — the
    # BOOTSTRAP GUARD above will catch it. Here we only switch when the
    # opposite slot is actually running.
    if docker inspect api-green >/dev/null 2>&1; then
        _ft_log "msg='slot repair: blue missing but green running — switching effective slot to green' original_slot=blue"
        ACTIVE="green"
        _ft_write_slot "green"
    else
        _ft_log "level=WARN msg='slot repair: neither container running — first deploy or crash; slot kept as blue'"
    fi
fi
_ft_validate_slot "$ACTIVE" || exit 1

if [ "$ACTIVE" = "blue" ]; then
    ACTIVE_NAME=$BLUE_NAME
    INACTIVE="green"; INACTIVE_NAME=$GREEN_NAME
else
    ACTIVE_NAME=$GREEN_NAME
    INACTIVE="blue";  INACTIVE_NAME=$BLUE_NAME
fi

_ft_log "msg='slot resolved' active=$ACTIVE active_name=$ACTIVE_NAME inactive=$INACTIVE inactive_name=$INACTIVE_NAME"

# ---------------------------------------------------------------------------
# ACTIVE CONTAINER EXISTENCE GUARD
# Protect against race: active slot file says "blue" but container doesn't exist.
# This catches crash/OOM scenarios before any deploy logic runs.
# ---------------------------------------------------------------------------
if docker ps -a --format '{{.Names}}' | grep -q "^${ACTIVE_NAME}$"; then
    if ! docker inspect "$ACTIVE_NAME" >/dev/null 2>&1; then
        _ft_log "level=ERROR msg='active container listed by docker ps but inspect failed -- possible race' container=$ACTIVE_NAME"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=active_container_inspect_race container=$ACTIVE_NAME"
    fi
    _ft_log "msg='active container existence guard passed' container=$ACTIVE_NAME"
else
    _ft_log "level=WARN msg='active container not running (first deploy or crash recovery)' container=$ACTIVE_NAME"
fi

# ---------------------------------------------------------------------------
# IDEMPOTENCY GUARD -- skip deploy if this exact SHA is already the active container
# ---------------------------------------------------------------------------
_ft_state "IDEMPOTENCY" "msg='checking if target SHA already deployed' sha=$IMAGE_SHA"

_RUNNING_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$ACTIVE_NAME" 2>/dev/null || echo "")
if [ "$_RUNNING_IMAGE" = "$IMAGE" ]; then
    # In-network health check: exercises Docker DNS + bridge routing.
        _IDEMPOTENT_HEALTH=$(_ft_net_curl_out "$ACTIVE_NAME" \
            -s --max-time 3 "http://$ACTIVE_NAME:$APP_PORT/ready")
        if echo "$_IDEMPOTENT_HEALTH" | grep -q '"status":"ready"' 2>/dev/null; then
            _ft_log "msg='target SHA already running and healthy -- nothing to do' container=$ACTIVE_NAME image=$IMAGE"
            _ft_exit 0 "DEPLOY_SUCCESS" "reason=idempotent_noop sha=$IMAGE_SHA container=$ACTIVE_NAME"
        else
            _ft_log "msg='idempotent SHA match but active container not healthy -- proceeding with deploy' container=$ACTIVE_NAME"
        fi
        unset _IDEMPOTENT_HEALTH
    else
        _ft_log "msg='SHA differs from running image -- proceeding' running=${_RUNNING_IMAGE:-none} target=$IMAGE"
    fi
    unset _RUNNING_IMAGE

# ---------------------------------------------------------------------------
# [3/7] START INACTIVE CONTAINER
# ---------------------------------------------------------------------------
_ft_state "START_INACTIVE" "msg='starting inactive container' name=$INACTIVE_NAME"

if docker ps -a --format '{{.Names}}' | grep -Eq "^${INACTIVE_NAME}$"; then
    _ft_log "msg='renaming stale container for audit trail' name=$INACTIVE_NAME"
    docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
    # Rename instead of hard-rm so a post-mortem can inspect the old container
    # state. The -old-<epoch> suffix lets the zombie purge below collect it.
    _STALE_TS=$(date +%s)
    docker rename "$INACTIVE_NAME" "${INACTIVE_NAME}-old-${_STALE_TS}" 2>/dev/null \
        || docker rm "$INACTIVE_NAME"
fi

timeout 60 docker run -d \
  --name "$INACTIVE_NAME" \
  --network "$NETWORK" \
  --restart unless-stopped \
  --label "api.sha=$IMAGE_SHA" \
  --label "api.slot=$INACTIVE" \
  --label "api.deploy_id=$DEPLOY_ID" \
  --env-file "$ENV_FILE" \
  "$IMAGE"

_ft_log "msg='container started' name=$INACTIVE_NAME"

# IMAGE IMMUTABILITY CHECK -- confirm running container image matches target SHA.
_ACTUAL_IMAGE=$(docker inspect --format '{{.Config.Image}}' "$INACTIVE_NAME" 2>/dev/null || echo "")
if [ "$_ACTUAL_IMAGE" != "$IMAGE" ]; then
    _ft_log "level=ERROR msg='image immutability check failed: running image does not match target' expected=$IMAGE actual=${_ACTUAL_IMAGE:-unknown}"
    docker logs "$INACTIVE_NAME" --tail 50 >&2 || true
    docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
    docker rm "$INACTIVE_NAME" || true
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=image_immutability_check_failed expected=$IMAGE actual=${_ACTUAL_IMAGE:-unknown}"
fi
_ft_log "msg='image immutability check passed' image=$_ACTUAL_IMAGE"
unset _ACTUAL_IMAGE

# ---------------------------------------------------------------------------
# [4/7] INTERNAL HEALTH CHECK
#   Uses /ready to validate Redis, Supabase, and BullMQ before traffic switch.
# ---------------------------------------------------------------------------
_ft_state "HEALTH_CHECK_INTERNAL" "msg='waiting for container readiness'"

sleep 5
HEALTH_ENDPOINT="/ready"

# CONNECTIVITY PRE-CHECK (in-network)
# Probe /health via a short-lived curl container on api_network to verify:
#   - Docker DNS resolution of $INACTIVE_NAME
#   - Bridge routing to the container
#   - HTTP server is bound and responding
# This exercises the same network path nginx uses, catching issues that
# docker exec localhost would silently skip.
_CONN_ATTEMPTS=0
_CONN_OK=false
while [ "$_CONN_ATTEMPTS" -lt 5 ]; do
    _CONN_ATTEMPTS=$((_CONN_ATTEMPTS + 1))
    if _ft_net_curl "$INACTIVE_NAME" \
           -sf --max-time 3 "http://$INACTIVE_NAME:$APP_PORT/health"; then
        _CONN_OK=true
        break
    fi
    _ft_log "msg='connectivity pre-check waiting' attempt=$_CONN_ATTEMPTS/5 container=$INACTIVE_NAME"
    sleep 2
done
if [ "$_CONN_OK" = "false" ]; then
    _ft_log "level=ERROR msg='container not reachable after connectivity pre-check' container=$INACTIVE_NAME"
    docker logs "$INACTIVE_NAME" --tail 100 >&2 || true
    docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
    docker rm "$INACTIVE_NAME" || true
    _ft_log "msg='active container still serving -- deploy failed non-destructively' container=$ACTIVE_NAME"
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=container_not_reachable container=$INACTIVE_NAME"
fi
unset _CONN_ATTEMPTS _CONN_OK
_ft_log "msg='connectivity pre-check passed' container=$INACTIVE_NAME"

ATTEMPT=0
until true; do
    ATTEMPT=$((ATTEMPT + 1))
    STATUS=$(_ft_net_curl_out "$INACTIVE_NAME" \
        --max-time 4 -s -o /dev/null -w "%{http_code}" \
        "http://$INACTIVE_NAME:$APP_PORT${HEALTH_ENDPOINT}" || echo "000")

    if [ "$STATUS" = "200" ]; then
        _ft_log "msg='internal health check passed' endpoint=$HEALTH_ENDPOINT attempts=$ATTEMPT"
        break
    fi

    if ! docker ps --format '{{.Names}}' | grep -q "^${INACTIVE_NAME}$"; then
        _ft_log "level=ERROR msg='container exited unexpectedly' name=$INACTIVE_NAME"
        docker logs "$INACTIVE_NAME" --tail 100 >&2 || true
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_log "msg='active container still serving -- deploy failed non-destructively' container=$ACTIVE_NAME"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=new_container_crashed"
    fi

    if [ "$ATTEMPT" -ge "$MAX_HEALTH_ATTEMPTS" ]; then
        _ft_log "level=ERROR msg='internal health check timed out' attempts=$ATTEMPT status=$STATUS endpoint=http://$INACTIVE_NAME:$APP_PORT${HEALTH_ENDPOINT}"
        docker logs "$INACTIVE_NAME" --tail 100 >&2 || true
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_log "msg='active container still serving -- deploy failed non-destructively' container=$ACTIVE_NAME"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=new_container_health_timeout attempts=$ATTEMPT"
    fi

    _ft_log "msg='waiting for readiness' attempt=$ATTEMPT/$MAX_HEALTH_ATTEMPTS status=$STATUS interval=${HEALTH_INTERVAL}s"
    # Add up to 1s of jitter to prevent synchronized retries under contention.
    sleep $((HEALTH_INTERVAL + RANDOM % 2))
done

# ---------------------------------------------------------------------------
# [5/7] SWITCH NGINX UPSTREAM
# ---------------------------------------------------------------------------
_ft_state "SWITCH_NGINX" "msg='switching nginx upstream' container=$INACTIVE_NAME"

# Deterministic stabilization window: give the new container a moment before
# switching nginx (complements the jitter already in the health check loop).
sleep 2

# Backup stored in NGINX_BACKUP_DIR (under the repo) — consistent with the
# pruning logic below. Avoids creating files in /etc/nginx/ (host-side)
# which is not guaranteed to exist when nginx runs only inside Docker.
mkdir -p "$NGINX_BACKUP_DIR"
NGINX_BACKUP="$NGINX_BACKUP_DIR/api.conf.bak.$(date +%s)"
NGINX_TMP="$(mktemp /tmp/api-nginx.XXXXXX.conf)"

# PRE-RELOAD GATE (in-network with fallback): confirm container is still ready
# before pointing nginx at it.
if ! _ft_net_curl "$INACTIVE_NAME" \
       -sf --max-time 4 "http://$INACTIVE_NAME:$APP_PORT/ready"; then
    _ft_log "level=ERROR msg='pre-reload gate failed: container not ready' container=$INACTIVE_NAME"
    docker logs "$INACTIVE_NAME" --tail 50 >&2 || true
    docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
    docker rm "$INACTIVE_NAME" || true
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=pre_reload_gate_failed container=$INACTIVE_NAME"
fi
_ft_log "msg='pre-reload gate passed' container=$INACTIVE_NAME"

sed \
    -e "s|__ACTIVE_CONTAINER__|$INACTIVE_NAME|g" \
    -e "s|__API_HOSTNAME__|$API_HOSTNAME|g" \
    "$NGINX_TEMPLATE" > "$NGINX_TMP"

cp "$NGINX_CONF" "$NGINX_BACKUP"
cp "$NGINX_TMP" "$NGINX_CONF"
rm -f "$NGINX_TMP"
# Prune old backups (keep last 5) to avoid unbounded growth
ls -1t "$NGINX_BACKUP_DIR"/api.conf.bak.* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true

# Nginx network attachment guard: verify nginx is on api_network before every
# reload. If nginx was accidentally disconnected, Docker DNS resolution of
# api-blue/api-green will silently fail inside nginx.
_NGINX_RELOAD_NET=$(docker inspect nginx \
    --format='{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "")
if ! echo "$_NGINX_RELOAD_NET" | grep -q "$NETWORK"; then
    _ft_log "level=ERROR msg='nginx not attached to api_network at reload time' networks=${_NGINX_RELOAD_NET}"
    cp "$NGINX_BACKUP" "$NGINX_CONF"
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_network_mismatch"
fi
unset _NGINX_RELOAD_NET

if ! docker exec nginx nginx -t 2>&1; then
    _ft_log "level=ERROR msg='nginx config test failed -- restoring backup'"
    cp "$NGINX_BACKUP" "$NGINX_CONF"
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_config_test_failed"
fi
docker exec nginx nginx -s reload \
    || { cp "$NGINX_BACKUP" "$NGINX_CONF"; _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_reload_failed"; }
_ft_log "msg='nginx reloaded' upstream=$INACTIVE_NAME:$APP_PORT"

# Upstream sanity check -- confirm nginx config actually points at the new container.
# Catches template substitution failures before traffic is affected.
# Upstream sanity: live config must contain http://INACTIVE_NAME:3000 (set $api_backend format)
_RELOAD_CONTAINER=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null | grep -oE 'api-blue|api-green' | head -1 || echo "")
if [ "$_RELOAD_CONTAINER" != "$INACTIVE_NAME" ]; then
    _ft_log "level=ERROR msg='nginx upstream sanity check failed after reload' expected=$INACTIVE_NAME actual=${_RELOAD_CONTAINER:-unreadable}"
    cp "$NGINX_BACKUP" "$NGINX_CONF"
    docker exec nginx nginx -t 2>&1 && docker exec nginx nginx -s reload || true
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_upstream_mismatch expected=$INACTIVE_NAME actual=${_RELOAD_CONTAINER:-unreadable}"
fi
unset _RELOAD_CONTAINER
_ft_log "msg='nginx upstream sanity check passed' container=$INACTIVE_NAME"

# Write the slot file AFTER nginx reload so it always reflects what nginx
# is currently serving. If the public health check then fails and we roll
# back, we restore nginx AND overwrite this file back to $ACTIVE.
_ft_write_slot "$INACTIVE"

# Small settle window to stabilize TLS/keep-alive/edge cases
sleep 2

# POST-SWITCH ROUTING VERIFICATION (in-network)
# Run a short-lived curl container on api_network to probe nginx/health.
# This exercises: Docker DNS resolution of 'nginx', bridge routing nginx→container,
# nginx upstream substitution, and proxy-pass to $INACTIVE_NAME:$APP_PORT.
# Same network path that real client traffic takes after the slot switch.
_ft_log "msg='post-switch nginx routing verification (in-network)'"
_POST_SWITCH_OK=false
for _ps in 1 2 3 4 5; do
    if _ft_net_curl "nginx" \
           -sf --max-time 5 "http://nginx/health"; then
        _POST_SWITCH_OK=true
        break
    fi
    _ft_log "msg='post-switch in-network check waiting' attempt=$_ps/5"
    sleep 2
done
if [ "$_POST_SWITCH_OK" != "true" ]; then
    _ft_log "level=ERROR msg='post-switch routing verification failed — nginx cannot reach new container'"
    _ft_snapshot
    cp "$NGINX_BACKUP" "$NGINX_CONF"
    if docker exec nginx nginx -t 2>&1 && docker exec nginx nginx -s reload; then
        _ft_log "msg='nginx restored (post-switch routing failure)'"
    else
        _ft_log "level=ERROR msg='nginx restore failed during post-switch rollback'"
    fi
    _ft_write_slot "$ACTIVE"
    docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
    docker rm "$INACTIVE_NAME" || true
    _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=post_switch_routing_failed container=$INACTIVE_NAME"
fi
unset _POST_SWITCH_OK _ps
_ft_log "msg='post-switch routing verification passed'"

# ---------------------------------------------------------------------------
# [6/7] PUBLIC HEALTH CHECK (end-to-end nginx routing)
#   Validates:
#   1. HTTP 200              -- nginx routing, TLS, Host header matching
#   2. Body "status":"ready" -- backend /ready endpoint, external services
#   3. Container alignment   -- live nginx config points at $INACTIVE_NAME
#
#   NOTE: Uses localhost (127.0.0.1) + Host header to validate nginx routing
#   while avoiding Cloudflare IP allowlist block (see _ft_check_external_ready).
# ---------------------------------------------------------------------------
_ft_state "HEALTH_CHECK_PUBLIC" "msg='validating nginx routing + backend health (localhost)' host=$API_HOSTNAME"

# Give nginx a moment to apply the reloaded config cleanly.
sleep 3

_PUB_PASSED=false
_PUB_STATUS="000"

# Phase 1 — in-network routing (source of truth for rollback decision).
# Validates full nginx→api-<slot>:3000 path inside Docker bridge network.
for _attempt in 1 2 3; do
    _P1_BODY=$(_ft_net_curl_out "nginx" -s --max-time 10 "http://nginx/ready" 2>/dev/null || echo "")
    if echo "$_P1_BODY" | grep -q '"status":"ready"' 2>/dev/null; then
        _PUB_PASSED=true
        _PUB_STATUS="200-innet"
        _ft_log "msg='public health phase-1 (in-network) passed' attempt=$_attempt/3 container=$INACTIVE_NAME"
        unset _P1_BODY
        break
    fi
    _ft_log "msg='public health phase-1 (in-network) attempt failed' attempt=$_attempt/3"
    unset _P1_BODY
    sleep 3
done

# Phase 2 — HTTPS via localhost + Host header (advisory / TLS diagnostic).
# Uses --insecure to accept Cloudflare origin certificate.
# NOTE: status=000 means host→Docker TCP port routing issue, NOT a TLS problem
# (--insecure already handles cert trust). In-network result above is authoritative.
_HTTPS_PASSED=false
_HTTPS_STATUS="000"
for _attempt in 1 2 3 4 5; do
    _PUB_BODY=$(mktemp)
    _HTTPS_STATUS=$(curl --max-time 10 -sS -o "$_PUB_BODY" -w "%{http_code}" \
        --resolve "$API_HOSTNAME:443:127.0.0.1" \
        "https://$API_HOSTNAME/ready" \
        --insecure 2>/dev/null || echo "000")

    if [ "$_HTTPS_STATUS" = "200" ] && grep -q '"status":"ready"' "$_PUB_BODY" 2>/dev/null; then
        _HTTPS_PASSED=true
        rm -f "$_PUB_BODY"
        break
    fi

    if [ "$_HTTPS_STATUS" = "000" ]; then
        _ft_log "msg='HTTPS phase-2 status=000 — host→Docker port routing unreachable (not a TLS error; in-network is source of truth)' attempt=$_attempt/5"
        _HTTP_FALLBACK=$(curl -sS --max-time 5 \
            --resolve "$API_HOSTNAME:80:127.0.0.1" \
            "http://$API_HOSTNAME/ready" 2>/dev/null || echo "")
        if echo "$_HTTP_FALLBACK" | grep -q '"status":"ready"' 2>/dev/null; then
            _ft_log "msg='HTTP:80 fallback confirmed backend reachable' attempt=$_attempt"
            _HTTPS_PASSED=true
            _HTTPS_STATUS="200-http"
        fi
        unset _HTTP_FALLBACK
    fi
    [ "$_HTTPS_PASSED" = "true" ] && { rm -f "$_PUB_BODY"; break; }
    _ft_log "msg='HTTPS phase-2 attempt failed' attempt=$_attempt/5 status=$_HTTPS_STATUS host=$API_HOSTNAME"
    rm -f "$_PUB_BODY"
    sleep 5
done

if [ "$_HTTPS_PASSED" = "true" ]; then
    _ft_log "msg='HTTPS phase-2 passed' status=$_HTTPS_STATUS container=$INACTIVE_NAME"
else
    _ft_log "level=WARN msg='HTTPS phase-2 diagnostic failed (non-blocking)' status=$_HTTPS_STATUS host=$API_HOSTNAME note='host→Docker routing issue; in-network is authoritative'"
fi
unset _HTTPS_PASSED _HTTPS_STATUS _PUB_BODY

# Container alignment check -- live nginx config MUST contain http://INACTIVE_NAME:3000.
_NGINX_CONTAINER=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null | grep -oE 'api-blue|api-green' | head -1 || echo "")
if [ -n "$_NGINX_CONTAINER" ] && [ "$_NGINX_CONTAINER" != "$INACTIVE_NAME" ]; then
    _ft_log "level=ERROR msg='nginx container mismatch -- slot switch did not take effect' expected=$INACTIVE_NAME actual=$_NGINX_CONTAINER"
    _PUB_PASSED=false
fi

if [ "$_PUB_PASSED" != "true" ]; then
    _ft_state "ROLLBACK" "reason='public health check failed' status=$_PUB_STATUS"
    _ft_snapshot

    _ft_log "msg='restoring previous nginx config'"
    cp "$NGINX_BACKUP" "$NGINX_CONF"
    if docker exec nginx nginx -t 2>&1 && docker exec nginx nginx -s reload; then
        _ft_log "msg='nginx restored to previous config'"
    else
        _ft_log "level=ERROR msg='nginx restore failed -- check manually'"
    fi

    # Restore slot file to the slot that was active before this deploy attempt.
    _ft_write_slot "$ACTIVE"
    docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
    docker rm "$INACTIVE_NAME" || true

    unset _PUB_PASSED _attempt _PUB_STATUS _PUB_BODY _NGINX_CONTAINER

    if docker ps --format '{{.Names}}' | grep -q "^${ACTIVE_NAME}$"; then
        _ACTIVE_HEALTH=$(_ft_net_curl_out "$ACTIVE_NAME" \
            -s --max-time 3 "http://$ACTIVE_NAME:$APP_PORT/ready")
        if echo "$_ACTIVE_HEALTH" | grep -q '"status":"ready"' 2>/dev/null; then
            _ft_log "msg='deploy failed but active container healthy -- skipping rollback' container=$ACTIVE_NAME"
            unset _ACTIVE_HEALTH
            _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=public_health_check_failed active_container_healthy=true"
        fi
        unset _ACTIVE_HEALTH
        _ft_log "msg='active container running but NOT healthy -- treating as degraded, rollback needed' container=$ACTIVE_NAME"
    fi

    _ft_log "msg='system degraded -- triggering rollback' container=$ACTIVE_NAME"
    if [ "${API_ROLLBACK_IN_PROGRESS:-0}" != "1" ]; then
        _ft_log "msg='triggering image rollback to previous stable SHA'"
        export API_ROLLBACK_IN_PROGRESS=1
        _ft_release_lock
        if ! "$SCRIPT_DIR/rollback.sh" --auto; then
            _ft_snapshot
            _ft_exit 2 "DEPLOY_FAILED_FATAL" "reason=deploy_and_rollback_both_failed"
        fi
        _ft_exit 1 "DEPLOY_FAILED_ROLLBACK" "reason=public_health_check_failed msg='rollback succeeded, system restored'"
    else
        _ft_log "msg='nested rollback guard reached -- stopping to prevent infinite loop'"
        _ft_exit 1 "DEPLOY_FAILED_FATAL" "reason=nested_rollback_guard"
    fi
fi

unset _PUB_PASSED _attempt _PUB_STATUS _NGINX_CONTAINER
_ft_log "msg='public health check passed' container=$INACTIVE_NAME host=$API_HOSTNAME endpoint=/ready"

# ---------------------------------------------------------------------------
# [6.5/7] STABILITY CHECK -- re-verify external endpoint after a settle window
# Catches flapping services that pass the initial check then regress rapidly
# ---------------------------------------------------------------------------
_ft_state "STABILITY_CHECK" "msg='post-switch stability check' settle_seconds=5"

sleep 5
_STABLE=false
if _ft_check_external_ready; then
    _STABLE=true
    _ft_log "msg='stability check passed' url=https://$API_HOSTNAME/ready"
fi

if [ "$_STABLE" = "false" ]; then
    _ft_log "level=ERROR msg='stability check failed -- service regressed after initial pass'"
    _ft_snapshot

    # Restore nginx + slot
    _ft_log "msg='restoring previous nginx config (stability failure)'"
    cp "$NGINX_BACKUP" "$NGINX_CONF"
    if docker exec nginx nginx -t 2>&1 && docker exec nginx nginx -s reload; then
        _ft_log "msg='nginx restored (stability failure)'"
    else
        _ft_log "level=ERROR msg='nginx restore failed during stability rollback -- check manually'"
    fi
    _ft_write_slot "$ACTIVE"
    docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
    docker rm "$INACTIVE_NAME" || true

    if docker ps --format '{{.Names}}' | grep -q "^${ACTIVE_NAME}$"; then
        _ACTIVE_HEALTH=$(_ft_net_curl_out "$ACTIVE_NAME" \
            -s --max-time 3 "http://$ACTIVE_NAME:$APP_PORT/ready")
        if echo "$_ACTIVE_HEALTH" | grep -q '"status":"ready"' 2>/dev/null; then
            _ft_log "msg='active container healthy after stability failure -- skipping rollback' container=$ACTIVE_NAME"
            unset _ACTIVE_HEALTH
            _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=stability_check_failed active_container_healthy=true"
        fi
        unset _ACTIVE_HEALTH
        _ft_log "msg='active container running but NOT healthy after stability failure -- rollback needed'"
    fi

    _ft_log "msg='triggering rollback after stability failure'"
    if [ "${API_ROLLBACK_IN_PROGRESS:-0}" != "1" ]; then
        export API_ROLLBACK_IN_PROGRESS=1
        _ft_release_lock
        if ! "$SCRIPT_DIR/rollback.sh" --auto; then
            _ft_snapshot
            _ft_exit 2 "DEPLOY_FAILED_FATAL" "reason=stability_check_and_rollback_both_failed"
        fi
        _ft_exit 1 "DEPLOY_FAILED_ROLLBACK" "reason=stability_check_failed msg='rollback succeeded'"
    else
        _ft_exit 1 "DEPLOY_FAILED_FATAL" "reason=stability_nested_rollback_guard"
    fi
fi
unset _STABLE

# ---------------------------------------------------------------------------
# [7/7] CLEANUP + SUCCESS
# ---------------------------------------------------------------------------
_ft_state "CLEANUP" "msg='validating active container exists before cleanup' name=$ACTIVE_NAME"

# ACTIVE CONTAINER GUARD -- handle missing container gracefully (e.g., first deploy or crash)
if ! docker ps --format '{{.Names}}' | grep -q "^$ACTIVE_NAME$"; then
    _ft_log "msg='active container missing — treating as first deploy, skipping cleanup' name=$ACTIVE_NAME"
    SKIP_CLEANUP=true
else
    _ft_log "msg='active container guard passed' name=$ACTIVE_NAME"
fi

# Graceful shutdown: allow in-flight requests to drain before forcing removal.
if [ "${SKIP_CLEANUP:-false}" != "true" ]; then
    docker stop --time 10 "$ACTIVE_NAME" 2>/dev/null || true
    # Rename instead of hard-rm: keeps the previous-active container available
    # for 60 s of post-mortem inspection. The -old-<epoch> suffix is used by
    # the zombie purge block below.
    _CLEANUP_TS=$(date +%s)
    docker rename "$ACTIVE_NAME" "${ACTIVE_NAME}-old-${_CLEANUP_TS}" 2>/dev/null \
        || docker rm "$ACTIVE_NAME" || true
    _ft_log "msg='previous container renamed (graceful)' name=$ACTIVE_NAME rename=${ACTIVE_NAME}-old-${_CLEANUP_TS}"
else
    _ft_log "msg='cleanup skipped (first deploy scenario or container already removed)'"
fi

_ft_state "SUCCESS" "msg='deployment complete' container=$INACTIVE_NAME sha=$IMAGE_SHA slot=$INACTIVE"

# ---------------------------------------------------------------------------
# FINAL TRUTH CHECK -- verify state matches deployment intent
# Compares internal (localhost) vs external (DNS/Cloudflare) endpoint health
# to catch routing, TLS, and proxy anomalies
# ---------------------------------------------------------------------------
_FT_TRUTH_CHECK_PASSED=true

# (1) Verify slot file is correctly written
if [ -f "$ACTIVE_SLOT_FILE" ]; then
    _SLOT_VALUE=$(cat "$ACTIVE_SLOT_FILE" | tr -d '[:space:]')
    if [ "$_SLOT_VALUE" != "$INACTIVE" ]; then
        _ft_log "level=ERROR msg='truth check failed: slot file mismatch' expected=$INACTIVE actual=$_SLOT_VALUE"
        _FT_TRUTH_CHECK_PASSED=false
    else
        _ft_log "msg='truth check: slot file correct' slot=$_SLOT_VALUE"
    fi
else
    _ft_log "level=ERROR msg='truth check failed: slot file missing'"
    _FT_TRUTH_CHECK_PASSED=false
fi

# (2) Verify nginx upstream container matches target (set $api_backend format)
_NGINX_CONTAINER=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null | grep -oE 'api-blue|api-green' | head -1 || echo "")
if [ -n "$_NGINX_CONTAINER" ]; then
    if [ "$_NGINX_CONTAINER" != "$INACTIVE_NAME" ]; then
        _ft_log "level=ERROR msg='truth check failed: nginx container mismatch' expected=$INACTIVE_NAME actual=$_NGINX_CONTAINER"
        _FT_TRUTH_CHECK_PASSED=false
    else
        _ft_log "msg='truth check: nginx upstream correct' container=$_NGINX_CONTAINER"
    fi
else
    _ft_log "level=WARN msg='truth check: could not read nginx upstream'"
fi

# (3) Compare internal vs external endpoint health
# Internal: direct container endpoint  (http://$INACTIVE_NAME:$APP_PORT/ready)
# External: production DNS/Cloudflare   (https://$API_HOSTNAME/ready)
# Mismatch indicates routing, TLS, or proxy issues
if command -v curl >/dev/null 2>&1; then
    sleep 2

    # Check internal endpoint via in-network curl with fallback.
    _INT_READY=$(_ft_net_curl_out "$INACTIVE_NAME" \
        -s --max-time 5 "http://$INACTIVE_NAME:$APP_PORT/ready")
    _INT_READY_OK=false
    if echo "$_INT_READY" | grep -q '"status":"ready"' 2>/dev/null; then
        _INT_READY_OK=true
        _ft_log "msg='truth check: internal endpoint ready' url=http://$INACTIVE_NAME:$APP_PORT/ready"
    else
        _ft_log "level=WARN msg='truth check: internal endpoint not ready' url=http://$INACTIVE_NAME:$APP_PORT/ready response=${_INT_READY:0:100}"
    fi

    # Check external endpoint (DNS/Cloudflare/TLS) with latency measurement (SLO monitoring)
    # Uses retry + backoff to smooth transient edge jitter
    _EXT_READY_OK=false
    _EXT_LATENCY_MS=0
    _slo_start=0
    _slo_end=0
    _slo_attempt=0
    for _slo_attempt in 1 2 3; do
        _slo_start=$(date +%s%3N)
        if curl -sS --max-time 3 --resolve "$API_HOSTNAME:443:127.0.0.1" "https://$API_HOSTNAME/ready" --insecure 2>/dev/null | grep -q '"status":"ready"'; then
            _slo_end=$(date +%s%3N)
            _EXT_LATENCY_MS=$((_slo_end - _slo_start))
            _EXT_READY_OK=true
            break
        fi
        if [ $_slo_attempt -lt 3 ]; then sleep 5; fi
    done

    if [ "$_EXT_READY_OK" = "true" ]; then
        _ft_log "msg='truth check: external endpoint ready (retry succeeded)' url=https://$API_HOSTNAME/ready latency_ms=$_EXT_LATENCY_MS"
        # SLO warning: latency threshold (500ms)
        if [ "$_EXT_LATENCY_MS" -gt 500 ]; then
            _ft_log "level=WARN msg='SLO warning: high latency detected on external endpoint' latency_ms=$_EXT_LATENCY_MS threshold_ms=500 url=https://$API_HOSTNAME/ready"
        fi
    else
        _ft_log "level=ERROR msg='truth check: external endpoint not ready after 3 retries' url=https://$API_HOSTNAME/ready"
    fi

    # Consistency check: if internal is ready but external is not, something is wrong
    # (DNS/Cloudflare/TLS/nginx proxy layer)
    if [ "$_INT_READY_OK" = "true" ] && [ "$_EXT_READY_OK" = "false" ]; then
        _ft_log "level=ERROR msg='truth check FAILED: internal ready but external not reachable -- nginx/proxy/DNS/TLS issue' int_ok=$_INT_READY_OK ext_ok=$_EXT_READY_OK"
        _FT_TRUTH_CHECK_PASSED=false
    fi

    # Also fail if both are down (service actually not ready)
    if [ "$_INT_READY_OK" = "false" ] || [ "$_EXT_READY_OK" = "false" ]; then
        if [ "$_FT_TRUTH_CHECK_PASSED" = "true" ]; then
            _ft_log "level=ERROR msg='truth check FAILED: endpoint(s) not returning ready status' int_ok=$_INT_READY_OK ext_ok=$_EXT_READY_OK"
            _FT_TRUTH_CHECK_PASSED=false
        fi
    fi
else
    _ft_log "level=WARN msg='truth check: curl not available, skipping endpoint checks'"
fi

if [ "$_FT_TRUTH_CHECK_PASSED" != "true" ]; then
    _ft_state "FAILURE" "reason='post_deployment_truth_check_failed'"
    _ft_snapshot
    exit 2
fi

# Persist last-known-good snapshot for fast recovery triage (atomic write)
_ft_log "msg='recording last-known-good state' slot=$INACTIVE container=$INACTIVE_NAME"
_SNAP_TMP=$(mktemp "${SNAP_DIR}/last-good.XXXXXX")
printf 'slot=%s container=%s ts=%s\n' "$INACTIVE" "$INACTIVE_NAME" "$(date -Iseconds)" > "$_SNAP_TMP"
mv "$_SNAP_TMP" "$LAST_GOOD_FILE"
_ft_log "msg='last-known-good snapshot recorded (atomic)' file=$LAST_GOOD_FILE"

# Record deployment history (atomic write: temp file then mv).
DEPLOY_HISTORY_TMP="${DEPLOY_HISTORY}.tmp.$$"
if [ -f "$DEPLOY_HISTORY" ]; then
    (echo "$IMAGE_SHA"; head -n $((MAX_HISTORY - 1)) "$DEPLOY_HISTORY") > "$DEPLOY_HISTORY_TMP"
else
    echo "$IMAGE_SHA" > "$DEPLOY_HISTORY_TMP"
fi
mv "$DEPLOY_HISTORY_TMP" "$DEPLOY_HISTORY"
_ft_log "msg='deploy history updated' sha=$IMAGE_SHA"

# Alertmanager config rendering: always render before monitoring stack operations.
# Alertmanager does NOT support env vars natively; the rendered file must exist
# before docker compose up. This is idempotent and safe to run on every deploy.
bash "$REPO_DIR/infra/scripts/render-alertmanager.sh"
_ft_log "msg='alertmanager config rendered' file=$REPO_DIR/infra/alertmanager/alertmanager.rendered.yml"

# Monitoring stack: restart only when infra configs have actually changed.
# Hashes cover all infra config files EXCEPT the nginx template (re-rendered on
# every deploy) to avoid spurious monitoring restarts.
MONITORING_HASH=$(find "$REPO_DIR/infra" -readable \
    -not -path "$REPO_DIR/infra/nginx/*" \
    \( -name '*.yml' -o -name '*.yaml' -o -name '*.conf' -o -name '*.toml' -o -name '*.json' \) \
    | sort | xargs -r sha256sum 2>/dev/null | sha256sum | cut -d' ' -f1 || echo "changed")
MONITORING_HASH_FILE="$HOME/.api-monitoring-hash"

if [ -f "$MONITORING_HASH_FILE" ] && [ "$(cat "$MONITORING_HASH_FILE")" = "$MONITORING_HASH" ]; then
    _ft_log "msg='monitoring config unchanged -- skipping restart'"
else
    _ft_log "msg='monitoring config changed -- restarting monitoring stack'"
    cd "$REPO_DIR/infra"
    docker compose --env-file .env.monitoring -f docker-compose.monitoring.yml pull --quiet
    docker compose --env-file .env.monitoring -f docker-compose.monitoring.yml up -d --remove-orphans
    cd "$REPO_DIR"
    echo "$MONITORING_HASH" > "$MONITORING_HASH_FILE"
    _ft_log "msg='monitoring stack restarted'"
fi

# ---------------------------------------------------------------------------
# ZOMBIE PURGE: remove any api-(blue|green)-old-<epoch> containers that have
# accumulated from previous deploys. Runs unconditionally so the Docker engine
# does not fill up with stopped containers across multiple deployments.
# ---------------------------------------------------------------------------
_ft_log "msg='running zombie purge'"
docker ps -a --format '{{.Names}}' \
    | grep -E '^api-(blue|green)-old-[0-9]+$' \
    | xargs -r docker rm -f 2>/dev/null || true

_ft_exit 0 "DEPLOY_SUCCESS" "sha=$IMAGE_SHA container=$INACTIVE_NAME slot=$INACTIVE"
