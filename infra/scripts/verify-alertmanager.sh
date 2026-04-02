#!/usr/bin/env bash
# infra/scripts/verify-alertmanager.sh
#
# Verifies that the Alertmanager integration is healthy and that alert routing
# works end-to-end.
#
# Usage:
#   cd /path/to/fieldtrack/infra
#   bash scripts/verify-alertmanager.sh
#
# Requirements:
#   - Docker Compose monitoring stack must be running
#   - curl, jq must be available in PATH
#   - ALERTMANAGER_URL defaults to http://localhost:9093 (exposed by docker-compose)
#
# Exit codes:
#   0 — all checks passed
#   1 — one or more checks failed

set -euo pipefail

ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://localhost:9093}"
PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
PASS=0
FAIL=0

# ── Helper functions ──────────────────────────────────────────────────────────

log_pass() { echo "[PASS] $*"; PASS=$((PASS + 1)); }
log_fail() { echo "[FAIL] $*"; FAIL=$((FAIL + 1)); }
log_info() { echo "[INFO] $*"; }

require_cmd() {
  if ! command -v "$1" &>/dev/null; then
    echo "[ERROR] Required command '$1' not found. Install it and retry."
    exit 1
  fi
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

require_cmd curl
require_cmd jq

# ── Step 1: Alertmanager health check ─────────────────────────────────────────

log_info "Checking Alertmanager health at ${ALERTMANAGER_URL}/-/healthy"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 10 \
  "${ALERTMANAGER_URL}/-/healthy" || echo "000")

if [ "$HTTP_STATUS" = "200" ]; then
  log_pass "Alertmanager is healthy (HTTP 200)"
else
  log_fail "Alertmanager health check returned HTTP ${HTTP_STATUS} (expected 200)"
fi

# ── Step 2: Alertmanager ready check ──────────────────────────────────────────

log_info "Checking Alertmanager ready state at ${ALERTMANAGER_URL}/-/ready"

READY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  --max-time 10 \
  "${ALERTMANAGER_URL}/-/ready" || echo "000")

if [ "$READY_STATUS" = "200" ]; then
  log_pass "Alertmanager is ready (HTTP 200)"
else
  log_fail "Alertmanager ready check returned HTTP ${READY_STATUS} (expected 200)"
fi

# ── Step 3: Alertmanager API — list current alerts ────────────────────────────

log_info "Fetching current alerts from Alertmanager API"

ALERTS_RESPONSE=$(curl -s --max-time 10 \
  "${ALERTMANAGER_URL}/api/v2/alerts" \
  -H "Accept: application/json" || echo "")

if echo "$ALERTS_RESPONSE" | jq empty 2>/dev/null; then
  ALERT_COUNT=$(echo "$ALERTS_RESPONSE" | jq 'length')
  log_pass "Alertmanager API responded with valid JSON (${ALERT_COUNT} active alerts)"
else
  log_fail "Alertmanager API did not return valid JSON"
fi

# ── Step 4: Prometheus → Alertmanager connection ──────────────────────────────

log_info "Checking Prometheus alertmanager targets at ${PROMETHEUS_URL}/api/v1/alertmanagers"

PROM_AM=$(curl -s --max-time 10 \
  "${PROMETHEUS_URL}/api/v1/alertmanagers" || echo "")

if echo "$PROM_AM" | jq -e '.data.activeAlertmanagers | length > 0' &>/dev/null; then
  ACTIVE=$(echo "$PROM_AM" | jq -r '.data.activeAlertmanagers[0].url // "unknown"')
  log_pass "Prometheus is connected to Alertmanager at ${ACTIVE}"
else
  log_fail "Prometheus has no active Alertmanager targets — check prometheus.yml alerting block"
fi

# ── Step 5: Fire a test alert and verify it appears ───────────────────────────

log_info "Sending test alert to Alertmanager"

TEST_ALERT_PAYLOAD=$(cat <<'EOF'
[{
  "labels": {
    "alertname": "ApiAlertmanagerVerification",
    "severity": "warning",
    "job": "fieldtrack-api"
  },
  "annotations": {
    "summary": "Alertmanager verification test — safe to ignore",
    "description": "This alert was fired by verify-alertmanager.sh to confirm end-to-end routing. It will auto-resolve in 5 minutes."
  },
  "startsAt": "'"$(date -u +"%Y-%m-%dT%H:%M:%SZ")"'",
  "endsAt": "'"$(date -u -d "+5 minutes" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -v+5M +"%Y-%m-%dT%H:%M:%SZ")"'"
}]
EOF
)

POST_STATUS=$(curl -s -o /tmp/am_post_response.txt -w "%{http_code}" \
  --max-time 10 \
  -X POST "${ALERTMANAGER_URL}/api/v2/alerts" \
  -H "Content-Type: application/json" \
  --data "$TEST_ALERT_PAYLOAD" || echo "000")

if [ "$POST_STATUS" = "200" ]; then
  log_pass "Test alert accepted by Alertmanager (HTTP 200)"
else
  log_fail "Alertmanager rejected test alert (HTTP ${POST_STATUS})"
  cat /tmp/am_post_response.txt 2>/dev/null || true
fi

# ── Step 6: Confirm test alert is visible in active alerts ────────────────────

log_info "Waiting 2 seconds for alert to be indexed..."
sleep 2

ACTIVE_ALERTS=$(curl -s --max-time 10 \
  "${ALERTMANAGER_URL}/api/v2/alerts?filter=alertname%3DApiAlertmanagerVerification" \
  -H "Accept: application/json" || echo "[]")

if echo "$ACTIVE_ALERTS" | jq -e 'length > 0' &>/dev/null; then
  log_pass "Test alert is visible in Alertmanager active alerts list"
else
  log_fail "Test alert not found in active alerts — check Alertmanager configuration"
fi

# ── Step 7: Verify Prometheus rule files load without errors ──────────────────

log_info "Checking Prometheus rule files are loaded correctly"

RULES_RESPONSE=$(curl -s --max-time 10 \
  "${PROMETHEUS_URL}/api/v1/rules" || echo "")

if echo "$RULES_RESPONSE" | jq -e '.data.groups | length > 0' &>/dev/null; then
  GROUP_COUNT=$(echo "$RULES_RESPONSE" | jq '.data.groups | length')
  log_pass "Prometheus loaded ${GROUP_COUNT} rule group(s) from alerts.yml"
else
  log_fail "No rule groups found in Prometheus — check alerts.yml path in prometheus.yml"
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "─────────────────────────────────────"
echo " Alertmanager Verification Summary"
echo "─────────────────────────────────────"
echo " PASS: ${PASS}"
echo " FAIL: ${FAIL}"
echo "─────────────────────────────────────"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "One or more checks failed. Review the output above."
  echo ""
  echo "Common fixes:"
  echo "  • Not running? Start with:"
  echo "      docker compose -f infra/docker-compose.monitoring.yml up -d alertmanager prometheus"
  echo "  • Slack webhook missing? Add to infra/.env.monitoring:"
  echo "      ALERTMANAGER_SLACK_WEBHOOK"
  echo "  • Prometheus can't reach Alertmanager? Verify they share api_network."
  exit 1
fi

echo "All checks passed. Alertmanager is operational."
echo ""
echo "NOTE: The test alert 'ApiAlertmanagerVerification' will auto-resolve in 5 minutes."
echo "      You can silence it early via: ${ALERTMANAGER_URL}/#/silences"
exit 0
