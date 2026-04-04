#!/usr/bin/env bash
# =============================================================================
# deploy.sh — FieldTrack API Deploy + Rollback (unified)
#
# Usage:
#   deploy.sh <sha>                  # deploy a specific image SHA
#   deploy.sh --rollback             # interactive rollback to previous SHA
#   deploy.sh --rollback --auto      # non-interactive rollback (CI)
#
# State machine:
#   INIT -> PRE_FLIGHT -> PULL_IMAGE -> RESOLVE_SLOT -> IDEMPOTENCY
#        -> START_INACTIVE -> HEALTH_CHECK_INTERNAL -> SWITCH_NGINX
#        -> HEALTH_CHECK_PUBLIC -> STABILITY_CHECK -> CLEANUP -> SUCCESS
#
# Deploy outcomes (via _ft_exit):
#   DEPLOY_SUCCESS          -- zero-downtime deploy completed
#   BOOTSTRAP_SUCCESS       -- first-ever deploy completed
#   DEPLOY_FAILED_SAFE      -- deploy failed, old container still serving
#   DEPLOY_FAILED_ROLLBACK  -- deploy failed, rollback succeeded (system restored)
#   DEPLOY_FAILED_FATAL     -- deploy AND rollback both failed (manual needed)
#
# Exit codes:
#   0  DEPLOY_SUCCESS / BOOTSTRAP_SUCCESS
#   1  DEPLOY_FAILED_SAFE / DEPLOY_FAILED_ROLLBACK
#   2  DEPLOY_FAILED_FATAL
#
# Invariants:
#   - Success DEPENDS ONLY ON: container start + /health=200 + nginx routing
#   - NEVER depends on: Redis, Supabase, BullMQ, monitoring stack
#   - No /ready usage anywhere in this script
#   - All nginx reloads flow through switch_nginx() — exactly once per deploy
#
# Deploy state (slot, lock, last-good):
#   - FIELDTRACK_STATE_DIR or /var/lib/fieldtrack when writable (sudo chown if needed)
#   - Otherwise $DEPLOY_ROOT/.fieldtrack; existing /var/lib/fieldtrack/* is migrated once
# =============================================================================
set -euo pipefail
if [ "${DEBUG:-false}" = "true" ]; then set -x; fi
trap '_ft_trap_err "$LINENO"' ERR

# ---------------------------------------------------------------------------
# ARGUMENT PARSING
# MODE is set before helper functions are loaded so _ft_log can reference it.
# ---------------------------------------------------------------------------
MODE="deploy"
AUTO_MODE=false
IMAGE_SHA=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --rollback) MODE="rollback"; shift ;;
        --auto)     AUTO_MODE=true;  shift ;;
        -*)
            printf '[ERROR] Unknown option: %s\n' "$1" >&2
            printf 'Usage: deploy.sh <sha> | deploy.sh --rollback [--auto]\n' >&2
            exit 2
            ;;
        *)          IMAGE_SHA="$1"; shift ;;
    esac
done

# ---------------------------------------------------------------------------
# DEPLOY ID + TIMING (set here so all functions and log lines share them)
# ---------------------------------------------------------------------------
START_TS=$(date +%s)
DEPLOY_ID=$(date +%Y%m%d_%H%M%S)_$$
PREFLIGHT_STRICT="${PREFLIGHT_STRICT:-false}"

# ---------------------------------------------------------------------------
# PHASE-AWARE DEPLOY RESULT TRACKING
# Written to /tmp/ft_deploy_result on every exit path so CI can make
# phase-aware rollback decisions.
#
# Values:
#   FAILED_PRE_SWITCH  -- deploy failed before nginx traffic was switched
#                         (no rollback needed — production was never touched)
#   SWITCHED           -- nginx upstream was reloaded to new container
#                         (CI rollback IS appropriate if health checks fail)
#   RESTORED           -- switch happened but nginx was restored to old config
#                         (deploy.sh handled recovery — CI must NOT re-rollback)
#   FAILED             -- catastrophic failure, both deploy and internal
#                         rollback failed (manual intervention required)
# ---------------------------------------------------------------------------
_FT_DEPLOY_RESULT="FAILED_PRE_SWITCH"

# Capture whether this process was launched AS a rollback subprocess by
# _trigger_internal_rollback().  Subprocess inherits API_ROLLBACK_IN_PROGRESS=1
# from the parent; capturing it here prevents the subprocess from
# overwriting the parent's result file when the parent calls _ft_exit.
_FT_IS_ROLLBACK_SUBPROCESS="${API_ROLLBACK_IN_PROGRESS:-0}"

# ---------------------------------------------------------------------------
# STRUCTURED LOGGING
# ALL logging writes to stderr so stdout is data-only (subshell returns safe).
# ---------------------------------------------------------------------------
_FT_STATE="INIT"
DEPLOY_LOG_FILE="${DEPLOY_LOG_FILE:-/var/log/api/deploy.log}"
LOG_DIR="$(dirname "$DEPLOY_LOG_FILE")"
if ! mkdir -p "$LOG_DIR" 2>/dev/null; then
    LOG_DIR="$HOME/api/logs"
    DEPLOY_LOG_FILE="$LOG_DIR/deploy.log"
    mkdir -p "$LOG_DIR"
fi

_ft_log() {
    { set +x; } 2>/dev/null
    local entry
    entry=$(printf '[DEPLOY] deploy_id=%s ts=%s state=%s %s' \
        "$DEPLOY_ID" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$*")
    printf '%s\n' "$entry" | tee -a "$DEPLOY_LOG_FILE" >&2
    if [ "${DEBUG:-false}" = "true" ]; then set -x; fi
}

_ft_state() {
    { set +x; } 2>/dev/null
    _FT_STATE="$1"; shift
    printf '[DEPLOY] deploy_id=%s ts=%s state=%s %s\n' \
        "$DEPLOY_ID" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$*" >&2
    if [ "${DEBUG:-false}" = "true" ]; then set -x; fi
}

_ft_error() {
    { set +x; } 2>/dev/null
    local entry
    entry=$(printf '[ERROR] deploy_id=%s ts=%s state=%s %s' \
        "$DEPLOY_ID" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$*")
    printf '%s\n' "$entry" | tee -a "$DEPLOY_LOG_FILE" >&2
    if [ "${DEBUG:-false}" = "true" ]; then set -x; fi
}

_ft_trap_err() {
    { set +x; } 2>/dev/null
    printf '[ERROR] deploy_id=%s ts=%s state=%s msg="unexpected failure at line %s"\n' \
        "$DEPLOY_ID" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$1" >&2
    if [ "${DEBUG:-false}" = "true" ]; then set -x; fi
}

_ft_exit() {
    local code="$1"; shift
    local duration=$(( $(date +%s) - START_TS ))
    # Write machine-readable result for CI phase-aware rollback.
    # Skip in subprocess rollbacks (parent writes the authoritative value).
    if [ "${_FT_IS_ROLLBACK_SUBPROCESS:-0}" != "1" ]; then
        printf '%s\n' "$_FT_DEPLOY_RESULT" > /tmp/ft_deploy_result 2>/dev/null || true
    fi
    _ft_state "$@" "duration_sec=$duration deploy_result=$_FT_DEPLOY_RESULT"
    exit "$code"
}

# ---------------------------------------------------------------------------
# PHASE TIMING
# ---------------------------------------------------------------------------
_ft_phase_start() { eval "_${1}_START=\$(date +%s)"; }
_ft_phase_end() {
    local phase="$1"
    local start_var="_${phase}_START"
    local start_ts=${!start_var:-0}
    if [ "$start_ts" -gt 0 ]; then
        _ft_log "msg='phase_complete' phase=$phase duration_sec=$(( $(date +%s) - start_ts ))"
    fi
}

# ---------------------------------------------------------------------------
# SYSTEM SNAPSHOT (emitted on unrecoverable failure)
# ---------------------------------------------------------------------------
_ft_snapshot() {
    { set +x; } 2>/dev/null
    printf '[DEPLOY] -- SYSTEM SNAPSHOT ----------------------------------------\n' >&2
    printf '[DEPLOY]   slot_file  = %s\n' \
        "$(cat "${ACTIVE_SLOT_FILE:-/var/lib/fieldtrack/active-slot}" 2>/dev/null || echo 'MISSING')" >&2
    printf '[DEPLOY]   backup_file = %s\n' \
        "$(cat "${SLOT_BACKUP_FILE:-/var/lib/fieldtrack/active-slot.backup}" 2>/dev/null || echo 'MISSING')" >&2
    printf '[DEPLOY]   nginx_upstream = %s\n' \
        "$(grep -oE 'http://(api-blue|api-green):3000' \
            "${NGINX_CONF:-/opt/infra/nginx/live/api.conf}" 2>/dev/null \
            | grep -oE 'api-blue|api-green' | head -1 || echo 'unreadable')" >&2
    printf '[DEPLOY]   containers =\n' >&2
    docker ps --format '[DEPLOY]     {{.Names}} -> {{.Status}} ({{.Ports}})' 1>&2 2>/dev/null \
        || printf '[DEPLOY]     (docker ps unavailable)\n' >&2
    printf '[DEPLOY] -----------------------------------------------------------\n' >&2
    if [ "${DEBUG:-false}" = "true" ]; then set -x; fi
}

# ---------------------------------------------------------------------------
# GITHUB ACTIONS SUMMARY
# ---------------------------------------------------------------------------
_ft_github_summary() {
    local status="$1" container="${2:-unknown}" image="${3:-unknown}" reason="${4:-}"
    [ -z "$GITHUB_STEP_SUMMARY" ] && return 0
    {
        echo "### 🚀 Deployment Summary"
        echo "| Field | Value |"
        echo "|-------|-------|"
        echo "| Status | **$status** |"
        echo "| Deploy ID | \`$DEPLOY_ID\` |"
        echo "| Duration | $(($(date +%s) - START_TS))s |"
        echo "| Active Container | \`$container\` |"
        echo "| Image SHA | \`${image:0:12}...\` |"
        [ -n "$reason" ] && echo "| Reason | $reason |"
        echo "| Timestamp | $(date -u +'%Y-%m-%d %H:%M:%S UTC') |"
    } >> "$GITHUB_STEP_SUMMARY"
}

_ft_final_state() {
    local active_container="$1" image_sha="$2" nginx_upstream
    nginx_upstream=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null \
        | grep -oE 'api-blue|api-green' | head -1 || echo 'unknown')
    _ft_log "msg='final_state' deploy_id=$DEPLOY_ID active=$active_container sha=${image_sha:0:12} nginx_upstream=$nginx_upstream"
}

# ---------------------------------------------------------------------------
# DOCKER HEALTH GATE
# ---------------------------------------------------------------------------
_ft_wait_docker_health() {
    local name="$1" i=1 STATUS
    while [ "$i" -le 30 ]; do
        STATUS=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo "none")
        case "$STATUS" in
            healthy)   _ft_log "msg='docker health check passed' container=$name"; return 0 ;;
            unhealthy) _ft_error "msg='docker health check failed' container=$name status=unhealthy"; return 1 ;;
            none)      _ft_error "msg='docker HEALTHCHECK not found — add HEALTHCHECK to Dockerfile; required for deploy gate' container=$name status=none"; return 1 ;;
        esac
        [ $(( i % 5 )) -eq 0 ] && _ft_log "msg='waiting for docker health' attempt=$i/30 status=$STATUS container=$name"
        sleep 2; i=$(( i + 1 ))
    done
    _ft_error "msg='docker health timeout' container=$name last_status=$STATUS"
    return 1
}

# ---------------------------------------------------------------------------
# IN-NETWORK CURL HELPERS (via curlimages/curl on api_network)
# ---------------------------------------------------------------------------
_ft_net_curl() {
    local _c="$1"; shift
    docker run --rm --network "$NETWORK" "$_FT_CURL_IMG" "$@" >/dev/null 2>&1
}

_ft_net_curl_out() {
    local _c="$1"; shift
    local _out
    _out=$(docker run --rm --network "$NETWORK" "$_FT_CURL_IMG" "$@" 2>/dev/null) || _out=""
    printf '%s' "$_out"
}

_ft_nginx_route_health_ok() {
    docker run --rm --network "$NETWORK" "$_FT_CURL_IMG" \
        -sfk --max-time 5 \
        -H "Host: $API_HOSTNAME" \
        "https://nginx/health" 2>/dev/null | grep -q '"status":"ok"'
}

_ft_check_external_ready() {
    _ft_nginx_route_health_ok
}

# ---------------------------------------------------------------------------
# ENV LOADER (inlined)
# Avoids coupling deploy.sh to auxiliary scripts.
# ---------------------------------------------------------------------------
_ft_load_env() {
    ENV_FILE="$DEPLOY_ROOT/.env"
    if [ ! -f "$ENV_FILE" ]; then
        _ft_error "msg='required .env not found' path=$ENV_FILE"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=missing_env_file"
    fi

    set +x
    set -o allexport
    # shellcheck source=/dev/null
    source "$ENV_FILE"
    set +o allexport
    if [ "${DEBUG:-false}" = "true" ]; then set -x; fi

    if [ -z "${API_BASE_URL:-}" ]; then
        _ft_error "msg='API_BASE_URL missing in .env'"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=missing_api_base_url"
    fi
    if [ -z "${CORS_ORIGIN:-}" ]; then
        _ft_error "msg='CORS_ORIGIN missing in .env'"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=missing_cors_origin"
    fi

    API_HOSTNAME=$(echo "$API_BASE_URL" | sed -E 's|^https?://||' | cut -d'/' -f1)
    if [ -z "$API_HOSTNAME" ] || printf '%s' "$API_HOSTNAME" | grep -qE '[[:space:]/@?#]'; then
        _ft_error "msg='invalid API_HOSTNAME derived from API_BASE_URL' api_base_url=$API_BASE_URL derived=$API_HOSTNAME"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=invalid_api_hostname"
    fi
    export ENV_FILE API_HOSTNAME
}

# ---------------------------------------------------------------------------
# SILENT EXECUTION WRAPPERS
# ---------------------------------------------------------------------------
run() {
    if [ "${DEBUG:-false}" = "true" ]; then
        "$@"
    else
        local _out
        if ! _out=$("$@" 2>&1); then
            printf '[ERROR] Command failed: %s\n' "$*" >&2
            printf '%s\n' "$_out" >&2
            return 1
        fi
    fi
}

# ---------------------------------------------------------------------------
# SLOT DIRECTORY AND FILE MANAGEMENT
#
# Primary state dir: FIELDTRACK_STATE_DIR or /var/lib/fieldtrack (persistent).
# If that path exists but is root-owned (common after manual/bootstrap mkdir),
# we sudo chown it for the deploy user. If we still cannot write, fall back to
# $DEPLOY_ROOT/.fieldtrack (always user-writable) and migrate slot files once.
# ---------------------------------------------------------------------------
_ft_make_state_dir_writable() {
    local d="$1"
    if [ ! -d "$d" ]; then
        sudo mkdir -p "$d" 2>/dev/null || return 1
    fi
    if [ -w "$d" ]; then
        return 0
    fi
    sudo chown "$(id -un):$(id -gn)" "$d" 2>/dev/null || return 1
    sudo chmod u+rwx "$d" 2>/dev/null || true
    [ -w "$d" ]
}

_ft_migrate_state_from_var_lib_if_needed() {
    local legacy="/var/lib/fieldtrack"
    [ "$SLOT_DIR" = "$legacy" ] && return 0
    [ -f "$ACTIVE_SLOT_FILE" ] && return 0
    [ ! -r "$legacy/active-slot" ] && return 0
    _ft_log "msg='migrating active-slot from legacy path' from=$legacy/active-slot"
    cp -a "$legacy/active-slot" "$ACTIVE_SLOT_FILE" 2>/dev/null || true
    if [ -f "$legacy/active-slot.backup" ] && [ ! -f "$SLOT_BACKUP_FILE" ]; then
        cp -a "$legacy/active-slot.backup" "$SLOT_BACKUP_FILE" 2>/dev/null || true
    fi
    if [ -f "$legacy/last-good" ] && [ ! -f "$LAST_GOOD_FILE" ]; then
        cp -a "$legacy/last-good" "$LAST_GOOD_FILE" 2>/dev/null || true
    fi
}

_ft_init_fieldtrack_state() {
    local preferred="${FIELDTRACK_STATE_DIR:-/var/lib/fieldtrack}"
    SLOT_DIR="$preferred"
    if ! _ft_make_state_dir_writable "$SLOT_DIR"; then
        SLOT_DIR="$DEPLOY_ROOT/.fieldtrack"
        mkdir -p "$SLOT_DIR"
        _ft_log "msg='preferred state dir not writable; using DEPLOY_ROOT fallback' preferred=$preferred fallback=$SLOT_DIR user=$(id -un)"
    fi
    ACTIVE_SLOT_FILE="$SLOT_DIR/active-slot"
    SLOT_BACKUP_FILE="$SLOT_DIR/active-slot.backup"
    LOCK_FILE="$SLOT_DIR/deploy.lock"
    SNAP_DIR="$SLOT_DIR"
    LAST_GOOD_FILE="$SNAP_DIR/last-good"
    _ft_migrate_state_from_var_lib_if_needed
}

_ft_ensure_slot_dir() {
    if [ ! -d "$SLOT_DIR" ]; then
        mkdir -p "$SLOT_DIR" 2>/dev/null || sudo mkdir -p "$SLOT_DIR"
        sudo chown "$(id -un):$(id -gn)" "$SLOT_DIR" 2>/dev/null || true
    fi
    if [ ! -w "$SLOT_DIR" ]; then
        _ft_log "level=ERROR msg='slot directory not writable' path=$SLOT_DIR user=$(id -un)"
        return 1
    fi
    return 0
}

_ft_ensure_slot_backup_dir() {
    local backup_dir
    backup_dir="$(dirname "$SLOT_BACKUP_FILE")"
    if [ ! -d "$backup_dir" ]; then
        sudo mkdir -p "$backup_dir" 2>/dev/null || mkdir -p "$backup_dir" || true
        sudo chown "$(id -un):$(id -gn)" "$backup_dir" 2>/dev/null || true
    fi
}

_ft_validate_slot() {
    case "$1" in
        blue|green) return 0 ;;
        *) _ft_log "level=ERROR msg='invalid slot value' slot='${1:0:80}'"; return 1 ;;
    esac
}

_ft_write_slot() {
    local slot="$1"
    _ft_validate_slot "$slot" || return 1
    _ft_ensure_slot_dir || _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=slot_dir_not_writable"
    local tmp
    tmp=$(mktemp "${SLOT_DIR}/active-slot.XXXXXX")
    printf '%s\n' "$slot" > "$tmp"
    mv "$tmp" "$ACTIVE_SLOT_FILE"
    _ft_log "msg='slot file updated (atomic)' slot=$slot"
    # Mirror to persistent backup (survives reboots — /var/run is tmpfs)
    _ft_ensure_slot_backup_dir
    local btmp
    btmp=$(mktemp "$(dirname "$SLOT_BACKUP_FILE")/slot-backup.XXXXXX")
    printf '%s\n' "$slot" > "$btmp"
    mv "$btmp" "$SLOT_BACKUP_FILE"
    _ft_log "msg='slot backup updated' slot=$slot path=$SLOT_BACKUP_FILE"
}

# ---------------------------------------------------------------------------
# DEPLOYMENT LOCK
# ---------------------------------------------------------------------------
_ft_acquire_lock() {
    _ft_ensure_slot_dir || _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=slot_dir_not_writable"
    _ft_log "msg='acquiring deployment lock' pid=$$ file=$LOCK_FILE"
    exec 200>"$LOCK_FILE"
    if ! flock -n 200; then
        _ft_log "level=ERROR msg='another deployment already in progress -- aborting' pid=$$"
        exit 1
    fi
    _ft_log "msg='deployment lock acquired' pid=$$ file=$LOCK_FILE"
    trap '_ft_release_lock' EXIT
}

_ft_release_lock() {
    { set +x; } 2>/dev/null
    printf '[DEPLOY] ts=%s state=%s msg="releasing deployment lock" pid=%s\n' \
        "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" "$_FT_STATE" "$$" >&2
    exec 200>&- 2>/dev/null || true
    if [ "${DEBUG:-false}" = "true" ]; then set -x; fi
}

# ===========================================================================
# PHASE FUNCTIONS
# ===========================================================================

# ---------------------------------------------------------------------------
# preflight — load env, validate contract, port-leak guard
# ---------------------------------------------------------------------------
preflight() {
    _ft_state "PRE_FLIGHT" "msg='loading and validating environment'"

    local last_good
    last_good=$(cat "$LAST_GOOD_FILE" 2>/dev/null || echo "none")
    _ft_log "msg='startup recovery info' last_good=$last_good"

    _ft_load_env

    DEPLOY_HISTORY="$DEPLOY_ROOT/.deploy_history"
    _ft_log "msg='environment loaded' api_hostname=$API_HOSTNAME"

    # GLOBAL PORT-LEAK GUARD — api containers MUST NOT bind host ports
    local leaks
    leaks=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null \
        | grep -E '^api-(blue|green)' \
        | grep -E '(0\.0\.0\.0:|127\.0\.0\.1:)[0-9]+->') || true
    if [ -n "${leaks:-}" ]; then
        _ft_log "level=ERROR msg='API container has host port bindings — forbidden' leaks=${leaks}"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=api_port_leak_detected"
    fi
    _ft_log "msg='port-leak guard passed'"
}

# ---------------------------------------------------------------------------
# ensure_network — create api_network if absent (idempotent)
# ---------------------------------------------------------------------------
ensure_network() {
    docker network create --driver bridge "$NETWORK" 2>/dev/null \
        && _ft_log "msg='api_network created'" \
        || _ft_log "msg='api_network already exists'"
    mkdir -p "$NGINX_LIVE_DIR" "$NGINX_BACKUP_DIR"
}

# ---------------------------------------------------------------------------
# ensure_nginx — nginx MUST exist and be on api_network; hard fail otherwise
# ---------------------------------------------------------------------------
ensure_nginx() {
    if [ ! -d "$INFRA_ROOT/nginx/live" ]; then
        _ft_error "msg='infra not initialized at expected path' infra_root=$INFRA_ROOT required=$INFRA_ROOT/nginx/live"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=infra_not_initialized"
    fi
    if [ ! -d "$INFRA_ROOT/nginx/backup" ]; then
        _ft_error "msg='infra not initialized at expected path' infra_root=$INFRA_ROOT required=$INFRA_ROOT/nginx/backup"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=infra_not_initialized"
    fi
    if [ ! -f "$INFRA_ROOT/nginx/api.conf" ]; then
        _ft_error "msg='infra template missing' path=$INFRA_ROOT/nginx/api.conf"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=infra_template_missing"
    fi

    if ! docker inspect nginx >/dev/null 2>&1; then
        _ft_error "msg='nginx container not found — nginx is managed by the infra repo' hint='docker compose -f docker-compose.nginx.yml up -d'"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_missing"
    fi
    local net
    net=$(docker inspect nginx \
        --format='{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "")
    if ! echo "$net" | grep -q "$NETWORK"; then
        _ft_error "msg='nginx not on api_network' networks=${net}"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_not_on_api_network"
    fi
    _ft_log "msg='nginx guard passed' network=$NETWORK"
}

# ---------------------------------------------------------------------------
# pull_image — explicit pull; fails fast so docker run never races a pull
# ---------------------------------------------------------------------------
pull_image() {
    _ft_state "PULL_IMAGE" "msg='pulling container image' sha=$IMAGE_SHA"
    _ft_phase_start "PULL_IMAGE"
    if ! run timeout 120 docker pull "$IMAGE"; then
        _ft_log "level=ERROR msg='image pull failed' image=$IMAGE"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=image_pull_failed image=$IMAGE"
    fi
    _ft_log "msg='image pulled' image=$IMAGE"
    _ft_phase_end "PULL_IMAGE"
}

# ---------------------------------------------------------------------------
# resolve_slot — determine ACTIVE/INACTIVE slots with full recovery
#
# Reads slot from (in precedence order):
#   1. /var/lib/fieldtrack/active-slot  (primary, persistent)
#   2. /var/lib/fieldtrack/active-slot.backup (secondary, same dir — belt-and-suspenders)
#   3. nginx config upstream          (tiebreaker when both containers run)
#   4. running containers             (recovery when slot files missing)
#   5. default "green" / inactive "blue" (first deploy)
#
# Sets globals: ACTIVE, ACTIVE_NAME, INACTIVE, INACTIVE_NAME
# ---------------------------------------------------------------------------
resolve_slot() {
    _ft_state "RESOLVE_SLOT" "msg='determining active slot'"
    _ft_ensure_slot_dir || _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=slot_dir_not_writable"

    local recovered_slot=""

    # 1. Primary slot file
    if [ -f "$ACTIVE_SLOT_FILE" ]; then
        local val
        val=$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")
        if [[ "$val" == *DEPLOY* ]] || [[ "$val" == *\[* ]]; then
            _ft_log "level=WARN msg='slot file contaminated — treating as corrupt' value=${val:0:80}"
        elif _ft_validate_slot "$val" 2>/dev/null; then
            _ft_log "msg='slot file read' slot=$val"
            recovered_slot="$val"
        fi
    fi

    # 2. Persistent backup slot file (survives /var/run tmpfs wipe on reboot)
    if [ -z "$recovered_slot" ] && [ -f "$SLOT_BACKUP_FILE" ]; then
        local bval
        bval=$(tr -d '[:space:]' < "$SLOT_BACKUP_FILE")
        if _ft_validate_slot "$bval" 2>/dev/null; then
            _ft_log "msg='recovered slot from backup file' slot=$bval file=$SLOT_BACKUP_FILE"
            recovered_slot="$bval"
        fi
    fi

    # 3. Last-known-good snapshot
    if [ -z "$recovered_slot" ] && [ -f "$LAST_GOOD_FILE" ]; then
        local lgval
        lgval=$(awk -F= '/^slot=/{print $2}' "$LAST_GOOD_FILE" 2>/dev/null | tr -d '[:space:]')
        if _ft_validate_slot "$lgval" 2>/dev/null; then
            _ft_log "msg='recovered slot from last-good snapshot' slot=$lgval"
            recovered_slot="$lgval"
        fi
    fi

    # 4+5. Container state + nginx tiebreaker
    if [ -z "$recovered_slot" ]; then
        local blue_running=false green_running=false
        docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${BLUE_NAME}$"  && blue_running=true  || true
        docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${GREEN_NAME}$" && green_running=true || true

        if   [ "$blue_running" = "true" ] && [ "$green_running" = "false" ]; then
            recovered_slot="blue"; _ft_log "msg='recovery: only blue running'"
        elif [ "$green_running" = "true" ] && [ "$blue_running" = "false" ]; then
            recovered_slot="green"; _ft_log "msg='recovery: only green running'"
        elif [ "$blue_running" = "true" ] && [ "$green_running" = "true" ]; then
            local upstream
            upstream=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null \
                | grep -oE 'api-blue|api-green' | head -1 || echo "")
            recovered_slot="${upstream#api-}"
            [ -z "$recovered_slot" ] && recovered_slot="blue"
            _ft_log "msg='recovery: both running, nginx tiebreaker' nginx_upstream=${upstream:-none} slot=$recovered_slot"
        else
            recovered_slot="green"
            _ft_log "msg='recovery: no containers running — first deploy, starting with blue' slot=green"
        fi
    fi

    _ft_validate_slot "$recovered_slot" || exit 1

    # Persist recovered value (atomic)
    local tmp
    tmp=$(mktemp "${SLOT_DIR}/active-slot.XXXXXX")
    printf '%s\n' "$recovered_slot" > "$tmp"
    mv "$tmp" "$ACTIVE_SLOT_FILE"

    ACTIVE="$recovered_slot"
    if [ "$ACTIVE" = "blue" ]; then
        ACTIVE_NAME=$BLUE_NAME; INACTIVE="green"; INACTIVE_NAME=$GREEN_NAME
    else
        ACTIVE_NAME=$GREEN_NAME; INACTIVE="blue";  INACTIVE_NAME=$BLUE_NAME
    fi

    _ft_log "msg='slot resolved' active=$ACTIVE active_name=$ACTIVE_NAME inactive=$INACTIVE inactive_name=$INACTIVE_NAME"

    # SLOT REPAIR — heal slot/container drift
    if [ "$ACTIVE" = "green" ] && ! docker inspect api-green >/dev/null 2>&1; then
        if docker inspect api-blue >/dev/null 2>&1; then
            _ft_log "msg='slot repair: green missing but blue running → switching to blue'"
            ACTIVE="blue"; ACTIVE_NAME=$BLUE_NAME; INACTIVE="green"; INACTIVE_NAME=$GREEN_NAME
            _ft_write_slot "blue"
        fi
    elif [ "$ACTIVE" = "blue" ] && ! docker inspect api-blue >/dev/null 2>&1; then
        if docker inspect api-green >/dev/null 2>&1; then
            _ft_log "msg='slot repair: blue missing but green running → switching to green'"
            ACTIVE="green"; ACTIVE_NAME=$GREEN_NAME; INACTIVE="blue"; INACTIVE_NAME=$BLUE_NAME
            _ft_write_slot "green"
        fi
    fi
    _ft_validate_slot "$ACTIVE" || exit 1
}

# ---------------------------------------------------------------------------
# idempotency_check — skip deploy if target SHA already running + healthy
# ---------------------------------------------------------------------------
idempotency_check() {
    _ft_state "IDEMPOTENCY" "msg='checking if target SHA already deployed' sha=$IMAGE_SHA"
    local running_image
    running_image=$(docker inspect --format '{{.Config.Image}}' "$ACTIVE_NAME" 2>/dev/null || echo "")
    if [ "$running_image" = "$IMAGE" ]; then
        local health
        health=$(_ft_net_curl_out "$ACTIVE_NAME" \
            -s --max-time 3 "http://$ACTIVE_NAME:$APP_PORT/health")
        if echo "$health" | grep -q '"status":"ok"' 2>/dev/null; then
            _ft_log "msg='target SHA already running and healthy — nothing to do' container=$ACTIVE_NAME"
            _ft_final_state "$ACTIVE_NAME" "$IMAGE_SHA"
            _ft_github_summary "✅ IDEMPOTENT (no change)" "$ACTIVE_NAME" "$IMAGE_SHA" "SHA already deployed"
            _ft_exit 0 "DEPLOY_SUCCESS" "reason=idempotent_noop sha=$IMAGE_SHA"
        fi
        _ft_log "msg='SHA matches but container not healthy — proceeding' container=$ACTIVE_NAME"
    else
        _ft_log "msg='SHA differs — proceeding' running=${running_image:-none} target=$IMAGE"
    fi
}

# ---------------------------------------------------------------------------
# start_inactive — start new container on api_network (no host ports)
# ---------------------------------------------------------------------------
start_inactive() {
    _ft_state "START_INACTIVE" "msg='starting inactive container' name=$INACTIVE_NAME"

    # Rename any stale container for audit trail (graceful rename→purge later)
    if docker ps -a --format '{{.Names}}' | grep -Eq "^${INACTIVE_NAME}$"; then
        _ft_log "msg='renaming stale container' name=$INACTIVE_NAME"
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        local ts
        ts=$(date +%s)
        docker rename "$INACTIVE_NAME" "${INACTIVE_NAME}-old-${ts}" 2>/dev/null \
            || docker rm "$INACTIVE_NAME"
    fi

    local cid
    cid=$(timeout 60 docker run -d \
        --name "$INACTIVE_NAME" \
        --network "$NETWORK" \
        --restart unless-stopped \
        --label "api.sha=$IMAGE_SHA" \
        --label "api.slot=$INACTIVE" \
        --label "api.deploy_id=$DEPLOY_ID" \
        --env-file "$ENV_FILE" \
        "$IMAGE" 2>&1) || {
        printf '%s\n' "$cid" >&2
        _ft_error "msg='container start failed' name=$INACTIVE_NAME"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=container_start_failed"
    }
    _ft_log "msg='container started' name=$INACTIVE_NAME"

    # Image immutability check
    local actual
    actual=$(docker inspect --format '{{.Config.Image}}' "$INACTIVE_NAME" 2>/dev/null || echo "")
    if [ "$actual" != "$IMAGE" ]; then
        _ft_log "level=ERROR msg='image immutability check failed' expected=$IMAGE actual=${actual:-unknown}"
        docker logs "$INACTIVE_NAME" --tail 50 >&2 || true
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=image_immutability_check_failed"
    fi
    _ft_log "msg='image immutability check passed'"
}

# ---------------------------------------------------------------------------
# health_check_internal — wait for /health=200 via in-network curl
# NO /ready usage. NO Redis/Supabase dependency.
# ---------------------------------------------------------------------------
health_check_internal() {
    _ft_state "HEALTH_CHECK_INTERNAL" "msg='waiting for container readiness'"
    _ft_phase_start "HEALTH_CHECK_INTERNAL"
    sleep 5

    # Connectivity pre-check (5 short probes before main loop)
    local conn_ok=false conn_attempts=0
    while [ "$conn_attempts" -lt 5 ]; do
        conn_attempts=$(( conn_attempts + 1 ))
        if _ft_net_curl "$INACTIVE_NAME" \
               -sf --max-time 3 "http://$INACTIVE_NAME:$APP_PORT/health"; then
            conn_ok=true; break
        fi
        sleep 2
    done

    if [ "$conn_ok" = "false" ]; then
        _ft_log "level=ERROR msg='container not reachable after connectivity pre-check' container=$INACTIVE_NAME"
        docker logs "$INACTIVE_NAME" --tail 100 >&2 || true
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=container_not_reachable"
    fi
    _ft_log "msg='connectivity pre-check passed' container=$INACTIVE_NAME"

    # Main readiness loop — waits for HTTP 200 on /health
    local attempt=0
    until true; do
        attempt=$(( attempt + 1 ))
        local status
        status=$(_ft_net_curl_out "$INACTIVE_NAME" \
            --max-time 4 -s -o /dev/null -w "%{http_code}" \
            "http://$INACTIVE_NAME:$APP_PORT/health" || echo "000")

        if [ "$status" = "200" ]; then
            _ft_log "msg='health check passed' endpoint=/health attempts=$attempt"
            break
        fi

        if ! docker ps --format '{{.Names}}' | grep -q "^${INACTIVE_NAME}$"; then
            _ft_log "level=ERROR msg='container exited unexpectedly' name=$INACTIVE_NAME"
            docker logs "$INACTIVE_NAME" --tail 100 >&2 || true
            docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
            docker rm "$INACTIVE_NAME" || true
            _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=new_container_crashed"
        fi

        if [ "$attempt" -ge "$MAX_HEALTH_ATTEMPTS" ]; then
            _ft_log "level=ERROR msg='health check timed out' attempts=$attempt status=$status"
            docker logs "$INACTIVE_NAME" --tail 100 >&2 || true
            docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
            docker rm "$INACTIVE_NAME" || true
            _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=health_timeout attempts=$attempt"
        fi

        [ $(( attempt % 10 )) -eq 0 ] && _ft_log "msg='still waiting' attempt=$attempt/$MAX_HEALTH_ATTEMPTS status=$status"
        sleep $(( HEALTH_INTERVAL + RANDOM % 3 ))
    done

    _ft_phase_end "HEALTH_CHECK_INTERNAL"

    # Docker HEALTHCHECK gate (must be healthy, not just starting)
    if ! _ft_wait_docker_health "$INACTIVE_NAME"; then
        docker logs "$INACTIVE_NAME" --tail 50 >&2 || true
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=docker_health_failed"
    fi

    sleep 3  # brief stabilization after healthcheck gate

    # Pre-switch final connectivity check (fresh curl invocation, same net path as nginx)
    if ! docker run --rm --network "$NETWORK" "$_FT_CURL_IMG" \
           -sf --max-time 5 "http://$INACTIVE_NAME:$APP_PORT/health" >/dev/null 2>&1; then
        _ft_error "msg='pre-switch connectivity check failed' container=$INACTIVE_NAME"
        docker logs "$INACTIVE_NAME" --tail 50 >&2 || true
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=pre_switch_connectivity_failed"
    fi
    _ft_log "msg='pre-switch connectivity check passed' container=$INACTIVE_NAME"
}

# ---------------------------------------------------------------------------
# switch_nginx — render config, test, reload ONCE; write slot file after reload
# ---------------------------------------------------------------------------
switch_nginx() {
    _ft_state "SWITCH_NGINX" "msg='switching nginx upstream' container=$INACTIVE_NAME"
    sleep 2  # brief stabilization window before touching nginx

    mkdir -p "$NGINX_BACKUP_DIR"
    local backup tmp
    backup="$NGINX_BACKUP_DIR/api.conf.bak.$(date +%s)"
    tmp="$(mktemp /tmp/api-nginx.XXXXXX.conf)"

    # Pre-reload gate — one final health probe before writing nginx config
    if ! _ft_net_curl "$INACTIVE_NAME" \
           -sf --max-time 4 "http://$INACTIVE_NAME:$APP_PORT/health"; then
        _ft_log "level=ERROR msg='pre-reload gate failed' container=$INACTIVE_NAME"
        docker logs "$INACTIVE_NAME" --tail 50 >&2 || true
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=pre_reload_gate_failed"
    fi

    sed \
        -e "s|__ACTIVE_CONTAINER__|$INACTIVE_NAME|g" \
        -e "s|__API_HOSTNAME__|$API_HOSTNAME|g" \
        "$NGINX_TEMPLATE" > "$tmp"

    cp "$NGINX_CONF" "$backup"
    cp "$tmp" "$NGINX_CONF"
    rm -f "$tmp"
    ls -1t "$NGINX_BACKUP_DIR"/api.conf.bak.* 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true

    # nginx network guard before every reload
    local net
    net=$(docker inspect nginx \
        --format='{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "")
    if ! echo "$net" | grep -q "$NETWORK"; then
        _ft_log "level=ERROR msg='nginx not on api_network at reload time' networks=${net}"
        cp "$backup" "$NGINX_CONF"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_network_mismatch"
    fi

    local test_out
    test_out=$(docker exec nginx nginx -t 2>&1) || {
        printf '%s\n' "$test_out" >&2
        _ft_log "level=ERROR msg='nginx config test failed — restoring backup'"
        cp "$backup" "$NGINX_CONF"
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_config_test_failed"
    }

    # === SINGLE nginx reload per deploy ===
    docker exec nginx nginx -s reload >/dev/null 2>&1 \
        || { cp "$backup" "$NGINX_CONF"; _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_reload_failed"; }
    _ft_log "msg='nginx reloaded (once)' upstream=$INACTIVE_NAME:$APP_PORT"

    # Upstream sanity: live config must match INACTIVE_NAME
    local actual_upstream
    actual_upstream=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null \
        | grep -oE 'api-blue|api-green' | head -1 || echo "")
    if [ "$actual_upstream" != "$INACTIVE_NAME" ]; then
        _ft_log "level=ERROR msg='nginx upstream sanity failed' expected=$INACTIVE_NAME actual=${actual_upstream:-unreadable}"
        cp "$backup" "$NGINX_CONF"
        docker exec nginx nginx -t >/dev/null 2>&1 && docker exec nginx nginx -s reload >/dev/null 2>&1 || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_upstream_mismatch"
    fi
    _ft_log "msg='nginx upstream sanity passed' container=$INACTIVE_NAME"

    # Write slot AFTER nginx reload — slot always reflects what nginx serves
    _ft_write_slot "$INACTIVE"
    # Mark SWITCHED: from this point forward the new container is live.
    # CI rollback is appropriate if post-deploy health checks fail.
    _FT_DEPLOY_RESULT="SWITCHED"
    _ft_log "msg='TRAFFIC_SWITCH' active=$INACTIVE_NAME sha=$IMAGE_SHA deploy_id=$DEPLOY_ID deploy_result=SWITCHED"
    _ft_phase_end "SWITCH_NGINX"

    # Store backup path in global for rollback use in verify_routing / stability
    NGINX_BACKUP="$backup"
}

# ---------------------------------------------------------------------------
# verify_routing — validate nginx→backend end-to-end via api_network
# Rolls back (with rollback logic inline) on failure.
# ---------------------------------------------------------------------------
verify_routing() {
    _ft_state "HEALTH_CHECK_PUBLIC" "msg='validating nginx routing + backend health'"
    sleep $(( RANDOM % 3 + 5 ))  # nginx warm-up

    # Post-switch routing verification (5 retries)
    local ps_ok=false
    for _ps in 1 2 3 4 5; do
        if _ft_nginx_route_health_ok; then
            ps_ok=true; break
        fi
        sleep $(( RANDOM % 2 + 2 ))
    done
    if [ "$ps_ok" != "true" ]; then
        _ft_error "msg='post-switch routing verification failed'"
        _ft_snapshot
        _restore_nginx_and_slot "$ACTIVE"
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=post_switch_routing_failed"
    fi
    _ft_log "msg='post-switch routing verification passed'"

    # Post-switch upstream verification (direct container probe)
    if ! docker run --rm --network "$NETWORK" "$_FT_CURL_IMG" \
           -sf --max-time 5 "http://$INACTIVE_NAME:$APP_PORT/health" >/dev/null 2>&1; then
        _ft_error "msg='post-switch upstream verification failed' container=$INACTIVE_NAME"
        _ft_snapshot
        _restore_nginx_and_slot "$ACTIVE"
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true
        _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=post_switch_upstream_failed"
    fi
    _ft_log "msg='post-switch upstream verified' container=$INACTIVE_NAME"

    # Public health check via nginx
    local pub_passed=false
    if _ft_nginx_route_health_ok; then
        pub_passed=true
        _ft_log "msg='public health check passed' container=$INACTIVE_NAME"
    else
        _ft_log "msg='public health check failed' container=$INACTIVE_NAME"
    fi

    # Container alignment check
    local nginx_container
    nginx_container=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null \
        | grep -oE 'api-blue|api-green' | head -1 || echo "")
    if [ -n "$nginx_container" ] && [ "$nginx_container" != "$INACTIVE_NAME" ]; then
        _ft_log "level=ERROR msg='nginx container mismatch' expected=$INACTIVE_NAME actual=$nginx_container"
        pub_passed=false
    fi

    if [ "$pub_passed" != "true" ]; then
        _ft_state "ROLLBACK" "reason='public health check failed'"
        _ft_snapshot
        _restore_nginx_and_slot "$ACTIVE"
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true

        # If ACTIVE_NAME still healthy, no need for image rollback
        if docker ps --format '{{.Names}}' | grep -q "^${ACTIVE_NAME}$"; then
            local ah
            ah=$(_ft_net_curl_out "$ACTIVE_NAME" \
                -s --max-time 3 "http://$ACTIVE_NAME:$APP_PORT/health")
            if echo "$ah" | grep -q '"status":"ok"' 2>/dev/null; then
                _ft_log "msg='active container still healthy — no image rollback needed' container=$ACTIVE_NAME"
                _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=public_health_check_failed active_healthy=true"
            fi
        fi

        _ft_log "msg='system degraded — triggering image rollback'"
        _trigger_internal_rollback "public_health_check_failed"
    fi

    # Stability check (post-switch settle verification)
    _ft_state "STABILITY_CHECK" "msg='post-switch stability check'"
    _ft_phase_start "STABILITY_CHECK"
    sleep 5

    if _ft_check_external_ready; then
        _ft_log "msg='stability check passed' url=https://$API_HOSTNAME/health"
        _ft_phase_end "STABILITY_CHECK"
    else
        _ft_log "level=ERROR msg='stability check failed — service regressed after initial pass'"
        _ft_snapshot
        _restore_nginx_and_slot "$ACTIVE"
        docker stop --time 10 "$INACTIVE_NAME" 2>/dev/null || true
        docker rm "$INACTIVE_NAME" || true

        if docker ps --format '{{.Names}}' | grep -q "^${ACTIVE_NAME}$"; then
            local ah
            ah=$(_ft_net_curl_out "$ACTIVE_NAME" \
                -s --max-time 3 "http://$ACTIVE_NAME:$APP_PORT/health")
            if echo "$ah" | grep -q '"status":"ok"' 2>/dev/null; then
                _ft_log "msg='active container healthy after stability failure' container=$ACTIVE_NAME"
                _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=stability_check_failed active_healthy=true"
            fi
        fi
        _trigger_internal_rollback "stability_check_failed"
    fi
}

# Restore nginx to backup config and write the previous slot.
# Called from verify_routing on route/stability failure.
_restore_nginx_and_slot() {
    local prev_slot="$1"
    # Nginx was switched to new container, now being restored to old one.
    # Mark RESTORED so CI knows the traffic switch was undone by this script
    # and must NOT trigger an additional external rollback.
    _FT_DEPLOY_RESULT="RESTORED"
    _ft_log "msg='restoring previous nginx config' slot=$prev_slot"
    cp "$NGINX_BACKUP" "$NGINX_CONF"
    if docker exec nginx nginx -t >/dev/null 2>&1 && docker exec nginx nginx -s reload >/dev/null 2>&1; then
        _ft_log "msg='nginx restored'"
    else
        _ft_log "level=ERROR msg='nginx restore failed — check manually'"
    fi
    _ft_write_slot "$prev_slot"
}

# Release lock and exec deploy.sh --rollback --auto as a subprocess.
# This is the internal failure path — separate from the user-facing rollback().
_trigger_internal_rollback() {
    local reason="$1"
    if [ "${API_ROLLBACK_IN_PROGRESS:-0}" != "1" ]; then
        _ft_error "msg='ROLLBACK triggered' reason=$reason"
        # RESTORED: nginx was switched then this script restored it.
        # Set before launching subprocess so the subprocess (with
        # API_ROLLBACK_IN_PROGRESS=1) will not overwrite the result file.
        _FT_DEPLOY_RESULT="RESTORED"
        export API_ROLLBACK_IN_PROGRESS=1
        _ft_release_lock
        if ! "$SCRIPT_DIR/deploy.sh" --rollback --auto; then
            _FT_DEPLOY_RESULT="FAILED"
            _ft_snapshot
            _ft_exit 2 "DEPLOY_FAILED_FATAL" "reason=${reason}_and_rollback_failed"
        fi
        _ft_exit 1 "DEPLOY_FAILED_ROLLBACK" "reason=$reason msg='rollback succeeded'"
    else
        _ft_log "msg='nested rollback guard reached — stopping'"
        _ft_exit 1 "DEPLOY_FAILED_FATAL" "reason=nested_rollback_guard"
    fi
}

# ---------------------------------------------------------------------------
# cleanup_old — gracefully stop and rename the previously-active container
# ---------------------------------------------------------------------------
cleanup_old() {
    _ft_state "CLEANUP" "msg='stopping previous container' name=$ACTIVE_NAME"

    if ! docker ps --format '{{.Names}}' | grep -q "^$ACTIVE_NAME$"; then
        _ft_log "msg='previous container already gone — skipping cleanup' name=$ACTIVE_NAME"
        return 0
    fi

    docker stop --time 10 "$ACTIVE_NAME" 2>/dev/null || true
    local ts
    ts=$(date +%s)
    docker rename "$ACTIVE_NAME" "${ACTIVE_NAME}-old-${ts}" 2>/dev/null \
        || docker rm "$ACTIVE_NAME" || true
    _ft_log "msg='previous container stopped + renamed' name=$ACTIVE_NAME rename=${ACTIVE_NAME}-old-${ts}"
}

# ---------------------------------------------------------------------------
# success — truth check, last-known-good snapshot, deploy history
# ---------------------------------------------------------------------------
success() {
    _ft_state "SUCCESS" "msg='deployment complete' container=$INACTIVE_NAME sha=$IMAGE_SHA slot=$INACTIVE"

    # Truth check
    local truth_ok=true

    # 1. Slot file
    if [ -f "$ACTIVE_SLOT_FILE" ]; then
        local sv
        sv=$(tr -d '[:space:]' < "$ACTIVE_SLOT_FILE")
        if [ "$sv" != "$INACTIVE" ]; then
            _ft_log "level=ERROR msg='truth check: slot mismatch' expected=$INACTIVE actual=$sv"
            truth_ok=false
        else
            _ft_log "msg='truth check: slot correct' slot=$sv"
        fi
    else
        _ft_log "level=ERROR msg='truth check: slot file missing'"
        truth_ok=false
    fi

    # 2. nginx upstream
    local nginx_up
    nginx_up=$(grep -oE 'http://(api-blue|api-green):3000' "$NGINX_CONF" 2>/dev/null \
        | grep -oE 'api-blue|api-green' | head -1 || echo "")
    if [ -n "$nginx_up" ] && [ "$nginx_up" != "$INACTIVE_NAME" ]; then
        _ft_log "level=ERROR msg='truth check: nginx upstream mismatch' expected=$INACTIVE_NAME actual=$nginx_up"
        truth_ok=false
    else
        _ft_log "msg='truth check: nginx upstream correct' container=${nginx_up:-unknown}"
    fi

    # 3. Internal + external endpoint health
    sleep 2
    local int_ok=false ext_ok=false

    local int_resp
    int_resp=$(_ft_net_curl_out "$INACTIVE_NAME" \
        -s --max-time 5 "http://$INACTIVE_NAME:$APP_PORT/health")
    echo "$int_resp" | grep -q '"status":"ok"' 2>/dev/null && int_ok=true
    _ft_log "msg='truth check: internal endpoint' ok=$int_ok url=http://$INACTIVE_NAME:$APP_PORT/health"

    local ext_latency_ms=0
    for _sa in 1 2 3; do
        local t0 t1
        t0=$(date +%s%3N)
        if _ft_nginx_route_health_ok; then
            t1=$(date +%s%3N)
            ext_latency_ms=$(( t1 - t0 ))
            ext_ok=true; break
        fi
        [ "$_sa" -lt 3 ] && sleep $(( RANDOM % 3 + 5 ))
    done

    _ft_log "msg='truth check: external endpoint' ok=$ext_ok latency_ms=$ext_latency_ms url=https://$API_HOSTNAME/health"
    if [ "$ext_latency_ms" -gt 500 ]; then
        _ft_log "level=WARN msg='SLO warning: high latency' latency_ms=$ext_latency_ms threshold_ms=500"
    fi

    if [ "$int_ok" = "true" ] && [ "$ext_ok" = "false" ]; then
        _ft_log "level=ERROR msg='truth check FAILED: internal ok but external unreachable (nginx/proxy/DNS/TLS issue)'"
        truth_ok=false
    fi
    if [ "$int_ok" = "false" ] || [ "$ext_ok" = "false" ]; then
        [ "$truth_ok" = "true" ] && _ft_log "level=ERROR msg='truth check FAILED: endpoint(s) not healthy' int=$int_ok ext=$ext_ok"
        truth_ok=false
    fi

    if [ "$truth_ok" != "true" ]; then
        _ft_state "FAILURE" "reason='post_deployment_truth_check_failed'"
        _ft_snapshot
        exit 2
    fi

    # Last-known-good snapshot (atomic)
    _ft_log "msg='recording last-known-good' slot=$INACTIVE container=$INACTIVE_NAME"
    local snap_tmp
    snap_tmp=$(mktemp "${SNAP_DIR}/last-good.XXXXXX")
    printf 'slot=%s container=%s ts=%s\n' "$INACTIVE" "$INACTIVE_NAME" "$(date -Iseconds)" > "$snap_tmp"
    mv "$snap_tmp" "$LAST_GOOD_FILE"

    # Deploy history (rolling, atomic)
    local hist_tmp="${DEPLOY_HISTORY}.tmp.$$"
    if [ -f "$DEPLOY_HISTORY" ]; then
        (echo "$IMAGE_SHA"; head -n $(( MAX_HISTORY - 1 )) "$DEPLOY_HISTORY") > "$hist_tmp"
    else
        echo "$IMAGE_SHA" > "$hist_tmp"
    fi
    mv "$hist_tmp" "$DEPLOY_HISTORY"
    _ft_log "msg='deploy history updated' sha=$IMAGE_SHA"

    # Zombie purge
    _ft_log "msg='running zombie purge'"
    docker ps -a --format '{{.Names}}' \
        | grep -E '^api-(blue|green)-old-[0-9]+$' \
        | xargs -r docker rm -f 2>/dev/null || true

    _ft_final_state "$INACTIVE_NAME" "$IMAGE_SHA"
    _ft_github_summary "✅ SUCCESS" "$INACTIVE_NAME" "$IMAGE_SHA"
}

# ---------------------------------------------------------------------------
# main — full blue-green deploy flow
# ---------------------------------------------------------------------------
main() {
    _ft_acquire_lock

    # Validate SHA in deploy mode (not needed for rollback — resolved before calling main)
    if [ -z "$IMAGE_SHA" ] || [ "$IMAGE_SHA" = "latest" ]; then
        printf '[DEPLOY] ts=%s state=INIT level=ERROR msg="image SHA required"\n' \
            "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" >&2
        exit 2
    fi

    IMAGE="ghcr.io/fieldtrack-tech/api:$IMAGE_SHA"
    _ft_log "msg='deploy started' mode=$MODE sha=$IMAGE_SHA deploy_id=$DEPLOY_ID pid=$$ start_ts=$START_TS"

    preflight
    ensure_network
    ensure_nginx
    pull_image

    # BOOTSTRAP: first deploy when no api containers exist
    if ! docker ps -a --format '{{.Names}}' | grep -Eq '^api-(blue|green)$'; then
        _ft_state "BOOTSTRAP" "msg='no api containers — first deploy'"
        # Initialize globals required by downstream functions
        ACTIVE="green"; ACTIVE_NAME=$GREEN_NAME; INACTIVE="blue"; INACTIVE_NAME=$BLUE_NAME
        DEPLOY_HISTORY="${DEPLOY_HISTORY:-$DEPLOY_ROOT/.deploy_history}"
        NGINX_BACKUP="$NGINX_BACKUP_DIR/api.conf.bak.$(date +%s)"

        docker rm -f api-blue 2>/dev/null || true
        start_inactive
        health_check_internal
        # Write nginx config directly for first deploy, but keep the current
        # maintenance config as a rollback target for the routed verification.
        mkdir -p "$NGINX_LIVE_DIR" "$NGINX_BACKUP_DIR"
        if [ -f "$NGINX_CONF" ]; then
            cp "$NGINX_CONF" "$NGINX_BACKUP"
        fi
        local boot_tmp; boot_tmp="$(mktemp /tmp/api-nginx-boot.XXXXXX.conf)"
        sed -e "s|__ACTIVE_CONTAINER__|$INACTIVE_NAME|g" \
            -e "s|__API_HOSTNAME__|${API_HOSTNAME}|g" \
            "$NGINX_TEMPLATE" > "$boot_tmp"
        cp "$boot_tmp" "$NGINX_CONF"
        rm -f "$boot_tmp"
        local net_check
        net_check=$(docker inspect nginx \
            --format='{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' 2>/dev/null || echo "")
        if ! echo "$net_check" | grep -q "$NETWORK"; then
            _ft_log "level=ERROR msg='bootstrap: nginx not on api_network' networks=${net_check}"
            _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_network_mismatch_bootstrap"
        fi
        local nt_out
        nt_out=$(docker exec nginx nginx -t 2>&1) || {
            printf '%s\n' "$nt_out" >&2
            _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_config_test_failed_bootstrap"
        }
        docker exec nginx nginx -s reload >/dev/null 2>&1 \
            || _ft_exit 1 "DEPLOY_FAILED_SAFE" "reason=nginx_reload_failed_bootstrap"
        _ft_log "msg='bootstrap: nginx reloaded'"
        _ft_write_slot "blue"
        # Nginx reloaded and traffic is now routing to api-blue.
        _FT_DEPLOY_RESULT="SWITCHED"
        verify_routing
        cleanup_old
        success
        _ft_exit 0 "BOOTSTRAP_SUCCESS" "slot=blue image=$IMAGE"
    fi

    # Normal deploy path
    resolve_slot
    idempotency_check
    start_inactive
    health_check_internal
    switch_nginx
    verify_routing
    cleanup_old
    success

    _ft_exit 0 "DEPLOY_SUCCESS" "sha=$IMAGE_SHA container=$INACTIVE_NAME slot=$INACTIVE"
}

# ---------------------------------------------------------------------------
# rollback — restore previous SHA from deploy history
# ---------------------------------------------------------------------------
rollback() {
    _ft_log "msg='rollback initiated' mode=${MODE} auto=$AUTO_MODE"

    if [ ! -f "$DEPLOY_HISTORY" ] || [ ! -s "$DEPLOY_HISTORY" ]; then
        printf '[ERROR] No deployment history found: %s\n' "$DEPLOY_HISTORY" >&2
        exit 1
    fi

    mapfile -t HISTORY < "$DEPLOY_HISTORY"
    if [ "${#HISTORY[@]}" -lt 2 ]; then
        printf '[ERROR] Need at least two deployments to rollback (history has %d entries)\n' \
            "${#HISTORY[@]}" >&2
        exit 1
    fi

    local current_sha="${HISTORY[0]}"
    local previous_sha="${HISTORY[1]}"

    printf '=========================================\n'
    printf 'FieldTrack Rollback\n'
    printf '=========================================\n'
    printf 'Current deployment : %s\n' "$current_sha"
    printf 'Rollback target    : %s\n' "$previous_sha"
    printf '\n'

    printf 'Validating rollback image exists...\n'
    if ! docker manifest inspect "ghcr.io/fieldtrack-tech/api:$previous_sha" >/dev/null 2>&1; then
        printf '[ERROR] Rollback image not found in registry: ghcr.io/fieldtrack-tech/api:%s\n' "$previous_sha" >&2
        exit 1
    fi
    printf '✓ Rollback image verified.\n\n'

    if [ "$AUTO_MODE" = "false" ]; then
        printf '⚠️  WARNING: This will replace the current deployment.\n'
        read -r -p "Continue with rollback? (yes/no): " REPLY
        if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
            printf 'Rollback cancelled.\n'
            exit 0
        fi
    else
        printf 'Auto rollback mode (CI).\n'
    fi

    printf '\nStarting rollback to: %s\n\n' "$previous_sha"
    export API_ROLLBACK_IN_PROGRESS=1
    IMAGE_SHA="$previous_sha"
    main

    printf '\n=========================================\n'
    printf 'Rollback completed: %s\n' "$previous_sha"
    printf '=========================================\n'
}

# ===========================================================================
# CONSTANTS (loaded after function definitions but before execution)
# ===========================================================================
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_ROOT="${DEPLOY_ROOT:-$HOME/api}"
[ -d "$DEPLOY_ROOT" ] || { printf '[ERROR] DEPLOY_ROOT not found: %s\n' "$DEPLOY_ROOT" >&2; exit 1; }
REPO_DIR="$DEPLOY_ROOT"
INFRA_ROOT="${INFRA_ROOT:-/opt/infra}"

_ft_init_fieldtrack_state

BLUE_NAME="api-blue"
GREEN_NAME="api-green"
APP_PORT=3000
NETWORK="api_network"
_FT_CURL_IMG="curlimages/curl:8.7.1"

# SLOT_DIR, ACTIVE_SLOT_FILE, LOCK_FILE, etc. — set by _ft_init_fieldtrack_state()

NGINX_CONF="$INFRA_ROOT/nginx/live/api.conf"
NGINX_LIVE_DIR="$INFRA_ROOT/nginx/live"
NGINX_BACKUP_DIR="$INFRA_ROOT/nginx/backup"
NGINX_TEMPLATE="$INFRA_ROOT/nginx/api.conf"
NGINX_BACKUP=""  # set inside switch_nginx()

MAX_HISTORY=5
MAX_HEALTH_ATTEMPTS=40
HEALTH_INTERVAL=3

# DEPLOY_HISTORY is set inside preflight() after _ft_load_env()
DEPLOY_HISTORY=""

# ACTIVE/INACTIVE are set inside resolve_slot()
ACTIVE="" ACTIVE_NAME="" INACTIVE="" INACTIVE_NAME=""

# IMAGE is set inside main()
IMAGE=""

# ===========================================================================
# ENTRY POINT
# ===========================================================================
_ft_log "msg='deploy.sh invoked' mode=$MODE auto=$AUTO_MODE sha=${IMAGE_SHA:-<none>} pid=$$"

if [ "$MODE" = "rollback" ]; then
    # For rollback we need env loaded early to find DEPLOY_HISTORY
    _ft_load_env
    DEPLOY_HISTORY="$DEPLOY_ROOT/.deploy_history"
    rollback
else
    main
fi
