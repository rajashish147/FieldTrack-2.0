#!/usr/bin/env bash
# =============================================================================
# validate-env.sh — FieldTrack 2.0 environment contract validator
#
# Run before any deployment to catch configuration drift early.
# SELF-SUFFICIENT: sources load-env.sh internally, does NOT depend on caller env.
#
# Usage:
#   bash apps/api/scripts/validate-env.sh
#   bash apps/api/scripts/validate-env.sh --check-monitoring
#
# Options:
#   --check-monitoring        Also validate infra/.env.monitoring and
#                             cross-check API_HOSTNAME + METRICS_SCRAPE_TOKEN.
#   --env-file <path>         Override default apps/api/.env path.
#   --monitoring-env <path>   Override default infra/.env.monitoring path.
#
# ENV CONTRACT:
#   APP layer   → API_BASE_URL  (full URL:      https://api.example.com)
#   INFRA layer → API_HOSTNAME  (hostname only: api.example.com)
#                 Derived at deploy-time from API_BASE_URL by load-env.sh.
#                 Set explicitly in infra/.env.monitoring (Docker Compose reads it).
#                 Must NOT be set in apps/api/.env.
#
# Forbidden variable:
#   API_DOMAIN  — fully removed; using it is a hard error.
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed
# =============================================================================
set -euo pipefail

# ── Colour helpers ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BOLD='\033[1m'; NC='\033[0m'
pass()   { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn()   { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
fail()   { printf "${RED}✗${NC} %s\n" "$1" >&2; ERRORS=$((ERRORS + 1)); }
header() { printf "\n${BOLD}── %s ──${NC}\n" "$1"; }

ERRORS=0

# ── Argument parsing ───────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_ENV_FILE="$REPO_ROOT/apps/api/.env"
MONITORING_ENV_FILE="$REPO_ROOT/infra/.env.monitoring"
CHECK_MONITORING=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --check-monitoring)   CHECK_MONITORING=true;            shift ;;
        --env-file)           API_ENV_FILE="$2";                shift 2 ;;
        --monitoring-env)     MONITORING_ENV_FILE="$2";         shift 2 ;;
        -h|--help)
            grep '^#' "${BASH_SOURCE[0]}" | head -30 | sed 's/^# \{0,1\}//'
            exit 0 ;;
        *) printf "Unknown option: %s\n" "$1" >&2; exit 1 ;;
    esac
done

# ── Helper: read a value from a KEY=VALUE env file ─────────────────────────────
# Usage: get_val KEY /path/to/file
get_val() {
    local key="$1" file="$2"
    grep -E "^${key}=" "$file" 2>/dev/null | tail -1 | cut -d'=' -f2- \
        | sed "s/^['\"]//; s/['\"]$//"
}

DERIVED_HOSTNAME=""

# ── Load environment (self-sufficient) ────────────────────────────────────────
# Source load-env.sh to get API_HOSTNAME derived using the SAME Node logic.
# This ensures validate-env.sh uses identical parsing to deploy scripts.
# Disable trace to prevent secrets from leaking into logs.
set +x 2>/dev/null || true
source "$SCRIPT_DIR/load-env.sh"
set -x 2>/dev/null || true

# ── Banner ─────────────────────────────────────────────────────────────────────
printf "\n${BOLD}╔══════════════════════════════════════════════════════════╗${NC}\n"
printf "${BOLD}║   FieldTrack 2.0 — Environment Contract Validator        ║${NC}\n"
printf "${BOLD}╚══════════════════════════════════════════════════════════╝${NC}\n"
printf "  API env:           %s\n" "$API_ENV_FILE"
printf "  Monitoring env:    %s\n" "$MONITORING_ENV_FILE"
printf "  Check monitoring:  %s\n" "$CHECK_MONITORING"

# =============================================================================
# SECTION 0: Forbidden variable check (repository-wide)
# =============================================================================
header "Forbidden variable check (API_DOMAIN)"

# Hard error: API_DOMAIN assignment must not appear ANYWHERE in the repository.
# Repository-wide scan (excluding node_modules) to catch drift across scripts
# and generated env files, not only the two primary env files.
if grep -r "API_DOMAIN" . --exclude-dir=node_modules 2>/dev/null | grep -E "API_DOMAIN[[:space:]]*="; then
    fail "API_DOMAIN assignment found in repository — this variable has been REMOVED"
    fail "  Replace with: API_BASE_URL=https://your-domain.com (in apps/api/.env)"
    fail "                API_HOSTNAME=your-domain.com (in infra/.env.monitoring)"
else
    pass "API_DOMAIN assignment not found in repository (correct)"
fi

# =============================================================================
# SECTION 1: Backend .env
# =============================================================================
header "Backend environment  (apps/api/.env)"

if [[ ! -f "$API_ENV_FILE" ]]; then
    fail ".env file not found: $API_ENV_FILE"
    fail "Run:  cp apps/api/.env.example apps/api/.env  and fill in values"
    printf "\n${RED}Cannot continue — .env is missing.${NC}\n\n"
    exit 1
fi
pass ".env file exists"

# Required backend variables
REQUIRED_API_VARS=(
    API_BASE_URL
    CORS_ORIGIN
    SUPABASE_URL
    SUPABASE_JWT_SECRET
    REDIS_URL
    METRICS_SCRAPE_TOKEN
)
for var in "${REQUIRED_API_VARS[@]}"; do
    val="$(get_val "$var" "$API_ENV_FILE")"
    if [[ -z "$val" ]]; then
        fail "$var is not set in apps/api/.env"
    else
        pass "$var is set"
    fi
done

# =============================================================================
# SECTION 2: API_BASE_URL format + API_HOSTNAME derivation
# =============================================================================
header "API_BASE_URL validation"

# API_BASE_URL is already loaded by load-env.sh (sourced above)
if [[ -z "$API_BASE_URL" ]]; then
    fail "API_BASE_URL is empty — skipping format checks"
else
    if [[ "$API_BASE_URL" =~ ^https:// ]]; then
        pass "API_BASE_URL uses https:// (production-safe)"
    elif [[ "$API_BASE_URL" =~ ^http:// ]]; then
        warn "API_BASE_URL uses http:// — OK for local dev only, not production"
    else
        fail "API_BASE_URL must start with https:// or http://"
    fi

    # Derive API_HOSTNAME using bash-safe parsing (no Node.js dependency)
    # Strip protocol (http:// or https://) and take first path segment
    DERIVED_HOSTNAME=$(echo "$API_BASE_URL" | sed -E 's|^https?://||' | cut -d'/' -f1)

    if [[ -z "$DERIVED_HOSTNAME" ]]; then
        fail "Cannot derive API_HOSTNAME from API_BASE_URL='$API_BASE_URL'"
    elif [[ "$DERIVED_HOSTNAME" =~ [[:space:]/@?#] ]]; then
        fail "Derived API_HOSTNAME contains invalid characters: '$DERIVED_HOSTNAME'"
        fail "  API_BASE_URL must not contain credentials (@), embedded paths (/), or query strings (?#)"
    elif [[ ! "$DERIVED_HOSTNAME" =~ \. ]]; then
        warn "API_HOSTNAME '$DERIVED_HOSTNAME' has no dot — OK for localhost only"
    else
        pass "API_HOSTNAME derived: $DERIVED_HOSTNAME"
    fi

    # Compare with API_HOSTNAME from load-env.sh (already exported)
    if [[ -n "$API_HOSTNAME" && "$API_HOSTNAME" != "$DERIVED_HOSTNAME" ]]; then
        fail "API_HOSTNAME MISMATCH between load-env.sh and validate-env.sh"
        fail "  load-env.sh:     $API_HOSTNAME"
        fail "  validate-env.sh: $DERIVED_HOSTNAME"
        fail "  This indicates a parsing inconsistency — both must use identical logic"
    else
        pass "API_HOSTNAME consistent: $DERIVED_HOSTNAME"
    fi
fi

# =============================================================================
# SECTION 3: Contract boundary — API_HOSTNAME must NOT be in apps/api/.env
# =============================================================================
header "Contract boundary check"

# STRICT: API_HOSTNAME must NOT exist in apps/api/.env
if grep -q "^API_HOSTNAME=" "$API_ENV_FILE" 2>/dev/null; then
    fail "API_HOSTNAME found in apps/api/.env — this violates the env contract"
    fail "  API_HOSTNAME is derived at deploy-time from API_BASE_URL"
    fail "  Remove API_HOSTNAME from apps/api/.env immediately"
else
    pass "API_HOSTNAME absent from apps/api/.env (correct — derived from API_BASE_URL)"
fi

# =============================================================================
# SECTION 4: Monitoring env
# =============================================================================
header "Monitoring environment  (infra/.env.monitoring)"

if [[ ! -f "$MONITORING_ENV_FILE" ]]; then
    if [[ "$CHECK_MONITORING" == "true" ]]; then
        fail ".env.monitoring not found: $MONITORING_ENV_FILE"
        fail "Run:  cp infra/.env.monitoring.example infra/.env.monitoring  and fill values"
    else
        warn ".env.monitoring not found  (use --check-monitoring to enforce this check)"
    fi
else
    pass ".env.monitoring exists"

    # Required monitoring variables
    REQUIRED_MON_VARS=(
        API_HOSTNAME
        METRICS_SCRAPE_TOKEN
        FRONTEND_DOMAIN
        GRAFANA_ADMIN_PASSWORD
    )
    for var in "${REQUIRED_MON_VARS[@]}"; do
        val="$(get_val "$var" "$MONITORING_ENV_FILE")"
        if [[ -z "$val" ]]; then
            fail "$var not set in infra/.env.monitoring"
        else
            pass "$var is set in .env.monitoring"
        fi
    done

    # Cross-check 1: API_HOSTNAME must match the hostname derived from API_BASE_URL
    MON_HOSTNAME="$(get_val "API_HOSTNAME" "$MONITORING_ENV_FILE")"
    if [[ -n "$DERIVED_HOSTNAME" && -n "$MON_HOSTNAME" ]]; then
        if [[ "$DERIVED_HOSTNAME" == "$MON_HOSTNAME" ]]; then
            pass "API_HOSTNAME is consistent: derived($DERIVED_HOSTNAME) = .env.monitoring($MON_HOSTNAME)"
        else
            fail "API_HOSTNAME MISMATCH:"
            fail "  apps/api/.env   → API_BASE_URL → $DERIVED_HOSTNAME"
            fail "  .env.monitoring → API_HOSTNAME  = $MON_HOSTNAME"
            fail "  Fix: set  API_HOSTNAME=$DERIVED_HOSTNAME  in infra/.env.monitoring"
        fi
    fi

    # Cross-check 2: METRICS_SCRAPE_TOKEN must be identical in both files
    API_MST="$(get_val "METRICS_SCRAPE_TOKEN" "$API_ENV_FILE")"
    MON_MST="$(get_val "METRICS_SCRAPE_TOKEN" "$MONITORING_ENV_FILE")"
    if [[ -n "$API_MST" && -n "$MON_MST" ]]; then
        if [[ "$API_MST" == "$MON_MST" ]]; then
            pass "METRICS_SCRAPE_TOKEN is identical in both env files"
        else
            fail "METRICS_SCRAPE_TOKEN MISMATCH between apps/api/.env and infra/.env.monitoring"
            fail "  Prometheus will receive 401s and all metric alerts will go blind"
        fi
    elif [[ -n "$API_MST" && -z "$MON_MST" ]]; then
        fail "METRICS_SCRAPE_TOKEN set in apps/api/.env but missing in infra/.env.monitoring"
    fi
fi

# =============================================================================
# Summary
# =============================================================================
printf "\n══════════════════════════════════════════════════════════\n"
if [[ $ERRORS -eq 0 ]]; then
    printf "${GREEN}${BOLD}✅ All checks passed — environment contract is valid${NC}\n\n"
    printf "  Active ENV contract:\n"
    printf "  ┌─ APP layer ─────────────────────────────────────────────\n"
    printf "  │  API_BASE_URL  = %s\n" "${API_BASE_URL:-(not set)}"
    printf "  └─ INFRA layer ──────────────────────────────────────────\n"
    printf "     API_HOSTNAME  = %s\n" "${DERIVED_HOSTNAME:-(not derivable)}"
    printf "\n"
    printf "  RULES:\n"
    printf "  • API_BASE_URL  → set in apps/api/.env  (app layer only)\n"
    printf "  • API_HOSTNAME  → set in infra/.env.monitoring, derived by load-env.sh\n"
    printf "  • API_DOMAIN    → REMOVED — do not re-add\n\n"
    exit 0
else
    printf "${RED}${BOLD}❌ %d check(s) failed — fix errors before deploying${NC}\n\n" "$ERRORS"
    printf "  ENV contract:\n"
    printf "  • API_BASE_URL  = full URL    (https://api.example.com)  → apps/api/.env\n"
    printf "  • API_HOSTNAME  = host only   (api.example.com)          → infra/.env.monitoring\n"
    printf "  • API_DOMAIN is deprecated — use API_BASE_URL instead\n\n"
    exit 1
fi
