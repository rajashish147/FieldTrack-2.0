# FieldTrack Phase 24 — Load Testing

Load tests are written for [k6](https://k6.io/) — a modern open-source load testing tool.

## Prerequisites

Install k6: https://k6.io/docs/getting-started/installation/

```bash
# macOS
brew install k6

# Windows (winget)
winget install k6

# Linux (Debian/Ubuntu)
sudo gpg -k && sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

## Environment Variables

| Variable         | Description                        |
|------------------|------------------------------------|
| `BASE_URL`       | API base URL (default: prod)       |
| `ADMIN_TOKEN`    | Valid admin JWT                    |
| `EMPLOYEE_TOKEN` | Valid employee JWT                 |

## Scripts

### `dashboard-load-test.js`
Simulates **50 concurrent admins** polling `/admin/dashboard` and `/admin/sessions`.

**Targets:** dashboard p95 < 1000 ms · sessions p95 < 800 ms · error rate < 1%

> **Phase 24 note:** The dashboard now uses a single indexed `org_dashboard_snapshot` PK lookup.
> The tighter p95 < 100 ms target from Phase 22 has been replaced with a realistic 1000 ms budget
> that accounts for cold-cache misses and network latency.

```bash
k6 run dashboard-load-test.js \
  -e BASE_URL=https://api.fieldtrack.meowsician.tech \
  -e ADMIN_TOKEN=<JWT>
```

---

### `map-load-test.js`
Simulates **20 concurrent monitoring clients** polling `/admin/monitoring/map` every 30 seconds.

**Target:** p95 < 200 ms · error rate < 1%

```bash
k6 run map-load-test.js \
  -e BASE_URL=https://api.fieldtrack.meowsician.tech \
  -e ADMIN_TOKEN=<JWT>
```

---

### `expenses-load-test.js`
Simulates **100 concurrent employees** submitting expense claims and listing their expenses.

**Targets:** POST p95 < 300 ms · GET p95 < 200 ms · error rate < 1%

> **Warning:** writes real data — use a staging environment or clean up afterward.

```bash
k6 run expenses-load-test.js \
  -e BASE_URL=https://api.fieldtrack.meowsician.tech \
  -e EMPLOYEE_TOKEN=<JWT>
```

---

### `queue-impact-test.js`
Simulates a **burst of 30 concurrent checkouts** to stress the BullMQ worker queues, then monitors `/admin/queues` for 2 minutes to verify the backlog drains.

**Targets:** checkout p95 < 400 ms · analytics queue depth < 500 · DLQ < 10

```bash
k6 run queue-impact-test.js \
  -e BASE_URL=https://api.fieldtrack.meowsician.tech \
  -e EMPLOYEE_TOKEN=<JWT> \
  -e ADMIN_TOKEN=<JWT>
```

## API Response Structure

All scripts parse JSON bodies. The API always returns an envelope:

| Endpoint | Shape |
|---|---|
| `GET /admin/dashboard` | `{ success: true, data: { activeEmployeeCount, recentEmployeeCount, ... } }` |
| `GET /admin/sessions` | `{ success: true, data: SessionDTO[], pagination: { page, limit, total } }` |
| `GET /admin/monitoring/map` | `{ success: true, data: EmployeeMapMarker[] }` |
| `POST /expenses` | `{ success: true, data: { id, amount, description, ... } }` |
| `GET /expenses/my` | `{ success: true, data: Expense[], pagination: { page, limit, total } }` |
| `GET /admin/queues` | `{ success: true, queues: { analytics: { waiting, active, completed, failed, dlq }, distance: { ... } } }` |

> **Note:** `pagination` appears at the response root alongside `data`, not nested inside `data`.
> The `/admin/queues` endpoint uses a `queues` key instead of `data`.

## Metrics and Error Rate

All scripts maintain two categories of checks:

- **Correctness checks** (feed `error_rate`): HTTP status code + `success === true` + required body fields.
  A request only increments `error_rate` when the API returns the wrong status or a malformed body.
- **Latency checks** (observability only): Response time assertions inside a separate `check()` call
  that does **not** feed `error_rate`. Slow-but-correct responses do not inflate the error counter.

This means `error_rate < 0.01` measures real API failures, not congestion.

## Running All Tests Sequentially

```bash
BASE_URL=https://api.fieldtrack.meowsician.tech
ADMIN_TOKEN=<your-admin-jwt>
EMPLOYEE_TOKEN=<your-employee-jwt>

for script in dashboard-load-test.js map-load-test.js expenses-load-test.js queue-impact-test.js; do
  echo "=== Running $script ==="
  k6 run "$script" -e BASE_URL="$BASE_URL" -e ADMIN_TOKEN="$ADMIN_TOKEN" -e EMPLOYEE_TOKEN="$EMPLOYEE_TOKEN"
done
```
