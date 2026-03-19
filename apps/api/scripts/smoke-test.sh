#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${FT_API_BASE_URL:-https://api.getfieldtrack.app}"
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
      STATUS=$(curl -L -s -D "$TMP_HEADERS" -o "$TMP_BODY" -w "%{http_code}" \
        -H "Authorization: Bearer $TOKEN" \
        -X "$METHOD" "$API$URL")
    else
      STATUS=$(curl -L -s -D "$TMP_HEADERS" -o "$TMP_BODY" -w "%{http_code}" \
        -X "$METHOD" "$API$URL")
    fi

    # Retry on transient gateway errors (502/503/504) from nginx during deploy
    if [ "$STATUS" = "502" ] || [ "$STATUS" = "503" ] || [ "$STATUS" = "504" ]; then
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

for i in {1..30}; do
  STATUS=$(curl -L -s -o /dev/null -w "%{http_code}" "$BASE_URL/health")
  if [ "$STATUS" = "200" ]; then
    echo "API healthy"
    break
  fi
  sleep 2
done

echo ""

# ------------------------------------------------
# Health check
# ------------------------------------------------

STATUS=$(request_health)
if [ "$STATUS" = "200" ] \
  && validate_api_response "GET /health" \
  && jq -e '.status == "ok"' "$TMP_BODY" >/dev/null 2>&1; then
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
# Get employee token
# ------------------------------------------------

echo ""
echo "Authenticating employee..."

EMP_TOKEN=$(curl -L -s \
  -H "apikey: $SUPABASE_ANON" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMP_EMAIL\",\"password\":\"$EMP_PASSWORD\"}" \
  "$SUPABASE_URL/auth/v1/token?grant_type=password" | jq -r .access_token)

if [ "$EMP_TOKEN" = "null" ]; then
  echo "Failed to obtain employee token"
  exit 1
fi

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
# Get admin token
# ------------------------------------------------

echo ""
echo "Authenticating admin..."

ADMIN_TOKEN=$(curl -L -s \
  -H "apikey: $SUPABASE_ANON" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  "$SUPABASE_URL/auth/v1/token?grant_type=password" | jq -r .access_token)

if [ "$ADMIN_TOKEN" = "null" ]; then
  echo "Failed to obtain admin token"
  exit 1
fi

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

STATUS=$(request GET "/admin/queues" "$ADMIN_TOKEN")

if validate_api_response "GET /admin/queues (admin)" && [ "$STATUS" = "200" ]; then
  log_pass "Admin access /admin/queues"
else
  log_fail "Admin access /admin/queues invalid or failed ($STATUS) $(cat "$TMP_BODY")"
fi

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
