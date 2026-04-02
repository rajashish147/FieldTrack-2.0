#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${API_BASE_URL:-https://api.getfieldtrack.app}"
API="${BASE_URL}"

EMP_EMAIL="${FT_EMP_EMAIL:-}"
EMP_PASSWORD="${FT_EMP_PASSWORD:-}"
ADMIN_EMAIL="${FT_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${FT_ADMIN_PASSWORD:-}"

SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_ANON="${SUPABASE_ANON_KEY:-}"

PASS=0
FAIL=0
TMP_HEADERS=$(mktemp)
TMP_BODY=$(mktemp)

# ----------------------------------------------------------------
# Decode the payload section of a JWT (base64url → JSON string).
# Usage: decode_jwt_payload <token>
# ----------------------------------------------------------------
decode_jwt_payload() {
  local token=$1
  local payload
  payload=$(echo "$token" | cut -d'.' -f2)
  # Restore standard base64 alphabet and add required padding
  local mod=$(( ${#payload} % 4 ))
  case $mod in
    2) payload="${payload}==" ;;
    3) payload="${payload}=" ;;
  esac
  echo "$payload" | tr '_-' '/+' | base64 -d 2>/dev/null
}

# ----------------------------------------------------------------
# Assert that a JWT contains the required hook-injected claims.
# Exits with code 1 if any required claim is missing.
# Usage: assert_hook_claims <label> <token> <require_employee_id>
# ----------------------------------------------------------------
assert_hook_claims() {
  local label="$1"
  local token="$2"
  local require_employee_id="${3:-false}"

  local payload
  payload=$(decode_jwt_payload "$token")

  echo ""
  echo "Decoded JWT payload ($label):"
  echo "$payload" | jq '.' 2>/dev/null || echo "$payload"

  local role org_id employee_id
  role=$(echo "$payload"        | jq -r '.role        // empty' 2>/dev/null)
  org_id=$(echo "$payload"      | jq -r '.org_id      // empty' 2>/dev/null)
  employee_id=$(echo "$payload" | jq -r '.employee_id // empty' 2>/dev/null)

  local hook_ok=true

  if [ -z "$role" ] || [ -z "$org_id" ]; then
    echo "✗ Auth Hook Integrity ($label): JWT is missing required claims"
    echo "  role   = '${role:-<MISSING>}'"
    echo "  org_id = '${org_id:-<MISSING>}'"
    echo ""
    echo "  ╔══════════════════════════════════════════════════════════╗"
    echo "  ║  Supabase Auth Hook is NOT injecting claims.            ║"
    echo "  ║  All API calls will fail with 401.                      ║"
    echo "  ║                                                          ║"
    echo "  ║  ACTION: Supabase Dashboard → Authentication → Hooks    ║"
    echo "  ║  Enable: Customize Access Token (JWT) Claims            ║"
    echo "  ║  Hook type: Postgres                                     ║"
    echo "  ║  Schema:    public                                       ║"
    echo "  ║  Function:  custom_access_token_hook                    ║"
    echo "  ╚══════════════════════════════════════════════════════════╝"
    FAIL=$((FAIL+1))
    hook_ok=false
  fi

  if [ "$require_employee_id" = "true" ] && [ -z "$employee_id" ]; then
    echo "✗ Auth Hook Integrity ($label): JWT missing employee_id claim"
    echo "  This user may not have an employee record in public.employees."
    echo "  Verify seed data: the test employee user must exist in both"
    echo "  auth.users AND public.users AND public.employees."
    FAIL=$((FAIL+1))
    hook_ok=false
  fi

  if [ "$hook_ok" = "true" ]; then
    local emp_part=""
    if [ -n "$employee_id" ]; then
      emp_part=", employee_id=${employee_id:0:8}..."
    fi
    log_pass "Auth Hook Integrity ($label): role=$role, org_id=${org_id:0:8}...${emp_part}"
  fi

  # Fail fast — if hook claims are missing, API calls will all 401.
  # No point running the rest of the smoke suite.
  if [ "$hook_ok" = "false" ]; then
    echo ""
    echo "⛔ Aborting smoke test: JWT claims missing. Fix auth hook first."
    exit 1
  fi
}

# ----------------------------------------------------------------
# Login to Supabase and return a guaranteed-fresh access_token via
# password login → immediate token refresh.
#
# WHY:  Supabase may return a cached access_token for recent logins.
#       Forcing a refresh guarantees the Hook runs on the new token
#       so custom claims (role, org_id, employee_id) are present.
#
# Usage: login_and_refresh <email> <password>
# Outputs:  access_token string to stdout; exits 1 on failure.
# ----------------------------------------------------------------
login_and_refresh() {
  local email="$1"
  local password="$2"

  # Step 1: Password login — get access_token + refresh_token
  local auth_response
  auth_response=$(curl -s -X POST \
    -H "apikey: $SUPABASE_ANON" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$email\",\"password\":\"$password\"}" \
    "$SUPABASE_URL/auth/v1/token?grant_type=password")

  local refresh_token
  refresh_token=$(echo "$auth_response" | jq -r '.refresh_token // empty')

  if [ -z "$refresh_token" ] || [ "$refresh_token" = "null" ]; then
    echo "  ERROR: password login failed for $email" >&2
    echo "  Response: $auth_response" >&2
    return 1
  fi

  # Step 2: Force-refresh — guarantees Hook runs on the new token
  local refresh_response
  refresh_response=$(curl -s -X POST \
    -H "apikey: $SUPABASE_ANON" \
    -H "Content-Type: application/json" \
    -d "{\"refresh_token\":\"$refresh_token\"}" \
    "$SUPABASE_URL/auth/v1/token?grant_type=refresh_token")

  local access_token
  access_token=$(echo "$refresh_response" | jq -r '.access_token // empty')

  if [ -z "$access_token" ] || [ "$access_token" = "null" ]; then
    echo "  ERROR: token refresh failed for $email" >&2
    echo "  Response: $refresh_response" >&2
    return 1
  fi

  echo "$access_token"
}

cleanup() {
  rm -f "$TMP_HEADERS" "$TMP_BODY"
}

trap cleanup EXIT

log_pass() {
  echo "✓ $1"
  PASS=$((PASS+1))
}

log_fail() {
  echo "✗ $1"
  FAIL=$((FAIL+1))
}

request() {
  METHOD=$1
  URL=$2
  TOKEN=${3:-}
  MAX_RETRIES=3

  for attempt in $(seq 1 $MAX_RETRIES); do
    if [ -n "$TOKEN" ]; then
      STATUS=$(curl -L -s --max-time 15 -D "$TMP_HEADERS" -o "$TMP_BODY" -w "%{http_code}" \
        -H "Authorization: Bearer $TOKEN" \
        -X "$METHOD" "$API$URL" || echo "000")
    else
      STATUS=$(curl -L -s --max-time 15 -D "$TMP_HEADERS" -o "$TMP_BODY" -w "%{http_code}" \
        -X "$METHOD" "$API$URL" || echo "000")
    fi

    # Retry on transient gateway errors (502/503/504) from nginx during deploy
    # Also retry on 000 (connection refused / timeout) to handle slow restarts
    if [ "$STATUS" = "502" ] || [ "$STATUS" = "503" ] || [ "$STATUS" = "504" ] || [ "$STATUS" = "000" ]; then
      if [ "$attempt" -lt "$MAX_RETRIES" ]; then
        echo "  ↻ $METHOD $URL returned $STATUS, retrying ($attempt/$MAX_RETRIES)..." >&2
        sleep 3
        continue
      fi
    fi
    break
  done

  echo "$STATUS"
}

request_health() {
  STATUS=$(curl -L -s -D "$TMP_HEADERS" -o "$TMP_BODY" -w "%{http_code}" "$BASE_URL/health")
  echo "$STATUS"
}

validate_api_response() {
  ENDPOINT=$1

  if ! jq -e . "$TMP_BODY" >/dev/null 2>&1; then
    echo "Invalid JSON response for $ENDPOINT"
    return 1
  fi

  if grep -qiE "<!doctype html|<html" "$TMP_BODY"; then
    echo "Invalid response body for $ENDPOINT: received HTML"
    return 1
  fi

  return 0
}

echo "================================"
echo "FieldTrack API Smoke Test"
echo "================================"

echo "Waiting for API..."

HEALTH_OK=false
for i in {1..30}; do
  STATUS=$(curl -L -s -o /dev/null -w "%{http_code}" --max-time 5 "$BASE_URL/health" 2>/dev/null || echo "000")
  if [ "$STATUS" = "200" ]; then
    echo "API healthy (attempt $i)"
    HEALTH_OK=true
    break
  fi
  echo "  Waiting... attempt $i/30 (HTTP $STATUS)" >&2
  sleep 2
done

if [ "$HEALTH_OK" = "false" ]; then
  echo "✗ API health check timed out after 30 attempts"
  echo "  Last status: HTTP $STATUS"
  echo "  URL: $BASE_URL/health"
  echo ""
  echo "Diagnostics:"
  curl -sS -D - -o /dev/null --max-time 5 "$BASE_URL/health" 2>&1 || true
  exit 1
fi

echo ""

# ------------------------------------------------
# Health check
# ------------------------------------------------

STATUS=$(request_health)
BODY=$(cat "$TMP_BODY")

if [ "$STATUS" = "200" ] && echo "$BODY" | grep -Eq '"status":"(ok|online)"'; then
  log_pass "GET /health"
else
  log_fail "GET /health invalid ($STATUS)"
fi

# ------------------------------------------------
# Auth guard tests
# ------------------------------------------------

echo ""
echo "Auth guards"

STATUS=$(request POST "/attendance/check-in")
if validate_api_response "POST /attendance/check-in" && [ "$STATUS" = "401" ]; then
  log_pass "POST /attendance/check-in protected"
else
  log_fail "POST /attendance/check-in invalid or unprotected ($STATUS)"
fi

STATUS=$(request POST "/attendance/check-out")
if validate_api_response "POST /attendance/check-out" && [ "$STATUS" = "401" ]; then
  log_pass "POST /attendance/check-out protected"
else
  log_fail "POST /attendance/check-out invalid or unprotected ($STATUS)"
fi

STATUS=$(request GET "/attendance/my-sessions")
if validate_api_response "GET /attendance/my-sessions" && [ "$STATUS" = "401" ]; then
  log_pass "GET /attendance/my-sessions protected"
else
  log_fail "GET /attendance/my-sessions invalid or unprotected ($STATUS)"
fi

STATUS=$(request GET "/attendance/org-sessions")
if validate_api_response "GET /attendance/org-sessions" && [ "$STATUS" = "401" ]; then
  log_pass "GET /attendance/org-sessions protected"
else
  log_fail "GET /attendance/org-sessions invalid or unprotected ($STATUS)"
fi

STATUS=$(request POST "/expenses")
if validate_api_response "POST /expenses" && [ "$STATUS" = "401" ]; then
  log_pass "POST /expenses protected"
else
  log_fail "POST /expenses invalid or unprotected ($STATUS)"
fi

STATUS=$(request GET "/expenses/my")
if validate_api_response "GET /expenses/my" && [ "$STATUS" = "401" ]; then
  log_pass "GET /expenses/my protected"
else
  log_fail "GET /expenses/my invalid or unprotected ($STATUS)"
fi

STATUS=$(request GET "/admin/expenses")
if validate_api_response "GET /admin/expenses" && [ "$STATUS" = "401" ]; then
  log_pass "GET /admin/expenses protected"
else
  log_fail "GET /admin/expenses invalid or unprotected ($STATUS)"
fi

# ------------------------------------------------
# Get employee token (fresh login + refresh — never reuse)
# ------------------------------------------------

echo ""
echo "Authenticating employee (login + refresh)..."

EMP_TOKEN=$(login_and_refresh "$EMP_EMAIL" "$EMP_PASSWORD")
if [ $? -ne 0 ] || [ -z "$EMP_TOKEN" ]; then
  echo "✗ Failed to obtain employee token — check FT_EMP_EMAIL / FT_EMP_PASSWORD secrets"
  echo "  Also verify the user exists in Supabase Auth and public.users"
  exit 1
fi

# ── Auth Hook Integrity — Employee ────────────────────────────
# Validate JWT claims BEFORE making any API calls.
# If claims are missing the hook is not enabled; all calls will 401.
assert_hook_claims "employee" "$EMP_TOKEN" "true"


# ------------------------------------------------
# Employee tests
# ------------------------------------------------

STATUS=$(request GET "/attendance/my-sessions" "$EMP_TOKEN")

if validate_api_response "GET /attendance/my-sessions (employee)" && [ "$STATUS" = "200" ]; then
  log_pass "Employee access /attendance/my-sessions"
else
  log_fail "Employee access invalid or failed ($STATUS)"
fi

# ------------------------------------------------
# Get admin token (fresh login + refresh — never reuse)
# ------------------------------------------------

echo ""
echo "Authenticating admin (login + refresh)..."

ADMIN_TOKEN=$(login_and_refresh "$ADMIN_EMAIL" "$ADMIN_PASSWORD")
if [ $? -ne 0 ] || [ -z "$ADMIN_TOKEN" ]; then
  echo "✗ Failed to obtain admin token — check FT_ADMIN_EMAIL / FT_ADMIN_PASSWORD secrets"
  echo "  Also verify the user exists in Supabase Auth and public.users"
  exit 1
fi

# ── Auth Hook Integrity — Admin ───────────────────────────────
assert_hook_claims "admin" "$ADMIN_TOKEN" "false"

STATUS=$(request GET "/admin/org-summary" "$ADMIN_TOKEN")

if validate_api_response "GET /admin/org-summary (admin)" && [ "$STATUS" = "200" ]; then
  log_pass "Admin access /admin/org-summary"
else
  log_fail "Admin access /admin/org-summary invalid or failed ($STATUS)"
fi

STATUS=$(request GET "/admin/sessions?page=1&limit=2" "$ADMIN_TOKEN")

if validate_api_response "GET /admin/sessions (admin)" && [ "$STATUS" = "200" ]; then
  log_pass "Admin access /admin/sessions"
else
  log_fail "Admin access /admin/sessions invalid or failed ($STATUS) $(cat "$TMP_BODY")"
fi

STATUS=$(request GET "/admin/expenses?page=1&limit=2" "$ADMIN_TOKEN")

if validate_api_response "GET /admin/expenses (admin)" && [ "$STATUS" = "200" ]; then
  log_pass "Admin access /admin/expenses"
else
  log_fail "Admin access /admin/expenses invalid or failed ($STATUS) $(cat "$TMP_BODY")"
fi

STATUS=$(request GET "/admin/dashboard" "$ADMIN_TOKEN")

if validate_api_response "GET /admin/dashboard (admin)" && [ "$STATUS" = "200" ]; then
  log_pass "Admin access /admin/dashboard"
else
  log_fail "Admin access /admin/dashboard invalid or failed ($STATUS) $(cat "$TMP_BODY")"
fi

STATUS=$(request GET "/admin/employees?page=1&limit=5" "$ADMIN_TOKEN")

if validate_api_response "GET /admin/employees (admin)" && [ "$STATUS" = "200" ]; then
  log_pass "Admin access /admin/employees"
else
  log_fail "Admin access /admin/employees invalid or failed ($STATUS) $(cat "$TMP_BODY")"
fi

STATUS=$(request GET "/admin/expenses/export" "$ADMIN_TOKEN")

if [ "$STATUS" = "200" ]; then
  log_pass "Admin access /admin/expenses/export"
else
  log_fail "Admin access /admin/expenses/export invalid or failed ($STATUS)"
fi

# NOTE: /admin/queues is NOT tested here because it requires Redis and BullMQ,
# which are only available in production/staging (WORKERS_ENABLED=true).
# Use GET /ready on production to verify queue/worker health.

# ------------------------------------------------
# Summary
# ------------------------------------------------

echo ""
echo "==============================="
echo "Passed: $PASS"
echo "Failed: $FAIL"
echo "==============================="

cat <<EOF > smoke-report.json
{
  "passed": $PASS,
  "failed": $FAIL
}
EOF

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
